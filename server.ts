import express from "express";
import path from "path";
import dotenv from "dotenv";
import fs from "fs";
import os from "os";
import crypto from "crypto";
import { GoogleGenAI, Type } from "@google/genai";
import { createServer as createViteServer } from "vite";

dotenv.config();

// Initialize Express
const app = express();
const PORT = Number(process.env.PORT) || 3000;

// Increase request size limit for base64 audio/video payloads (supporting files up to 1hr 22min)
app.use(express.json({ limit: "300mb" }));
app.use(express.urlencoded({ limit: "300mb", extended: true }));

// Initialize Gemini SDK with User-Agent header for telemetry
const apiKey = process.env.GEMINI_API_KEY;
const ai = new GoogleGenAI({
  apiKey: apiKey,
  httpOptions: {
    headers: {
      "User-Agent": "aistudio-build",
    },
    timeout: 1200000, // 20 minutes — long single-shot transcription of 60–90 min audio can exceed 5 min
  },
});

// Background transcription task map
const tasks = new Map<string, {
  id: string;
  status: "processing" | "completed" | "failed";
  progress: string;
  result?: any;
  error?: string;
}>();

// ─── Cost reporting ────────────────────────────────────────────────────────
// Official Gemini pricing (USD per 1M tokens), see ai.google.dev/gemini-api/docs/pricing
const PRICE = {
  flash: { input: 1.50, output: 9.00 },        // gemini-3.5-flash (transcribe + translate)
  tts:   { input: 1.00, audioOutput: 20.00 },  // gemini-3.1-flash-tts-preview (voiceover)
};

// Pull real token usage from a Gemini response's usageMetadata.
function extractUsage(resp: any): { input: number; output: number } {
  const u = resp?.usageMetadata ?? {};
  const input = u.promptTokenCount ?? 0;
  let output = (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0);
  if (!output && u.totalTokenCount) output = Math.max(0, u.totalTokenCount - input);
  return { input, output };
}

// USD → INR conversion for the terminal cost report. Approximate; override with
// the USD_TO_INR env var to match the live rate.
const USD_TO_INR = Number(process.env.USD_TO_INR) || 88;

const costOf = (tokens: number, ratePerM: number): number => (tokens / 1_000_000) * ratePerM;
const inr = (usdAmount: number): string => "₹" + (usdAmount * USD_TO_INR).toFixed(4);
const inrRate = (usdPerM: number): string => "₹" + (usdPerM * USD_TO_INR).toFixed(2);
const num = (n: number): string => n.toLocaleString("en-US");

// Cost of the most recent transcription+translation, so the TTS report can show
// a combined grand total for the whole run.
let lastScriptCost = 0;

// Deterministic post-AI find-and-replace. Guarantees exact terms in the final
// script regardless of what the model heard (e.g. spoken acronyms it can't
// distinguish). Rules are one per line: "wrong1, wrong2 => Correct".
function applyTermCorrections(text: string, rulesRaw?: string): string {
  if (!text || !rulesRaw || !rulesRaw.trim()) return text;
  let out = text;
  for (const line of rulesRaw.split(/\r?\n/)) {
    const m = line.match(/^(.*?)(?:=>|->|:)(.*)$/);
    if (!m) continue;
    const right = m[2].trim();
    if (!right) continue;
    const wrongs = m[1].split(",").map((s) => s.trim()).filter(Boolean);
    for (const wrong of wrongs) {
      const esc = wrong.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      try {
        // whole-word, case-insensitive
        out = out.replace(new RegExp(`\\b${esc}\\b`, "gi"), right);
      } catch { /* skip invalid rule */ }
    }
  }
  return out;
}

// ─── Audio chunking (long-video reliability) ─────────────────────────────────
// The client sends a mono PCM WAV (its own extracted audio). We can split that
// WAV into short segments server-side (no ffmpeg needed) and transcribe each one
// with a small, fast call — so long videos never hit the request timeout and the
// model never has to summarize an hour of audio in a single shot.

interface ParsedWav {
  sampleRate: number; bitsPerSample: number; numChannels: number;
  dataOffset: number; dataLength: number; buffer: Buffer; durationSec: number;
}

function parseWavBase64(base64: string): ParsedWav | null {
  let buf: Buffer;
  try { buf = Buffer.from(base64, "base64"); } catch { return null; }
  if (buf.length < 44) return null;
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") return null;

  let numChannels = 1, sampleRate = 16000, bitsPerSample = 16;
  let dataOffset = -1, dataLength = 0;
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === "fmt ") {
      numChannels   = buf.readUInt16LE(offset + 8 + 2);
      sampleRate    = buf.readUInt32LE(offset + 8 + 4);
      bitsPerSample = buf.readUInt16LE(offset + 8 + 14);
    } else if (id === "data") {
      dataOffset = offset + 8;
      dataLength = Math.min(size, buf.length - dataOffset);
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (dataOffset < 0 || bitsPerSample === 0 || sampleRate === 0) return null;
  const bytesPerSec = sampleRate * numChannels * (bitsPerSample / 8);
  const durationSec = bytesPerSec > 0 ? dataLength / bytesPerSec : 0;
  return { sampleRate, bitsPerSample, numChannels, dataOffset, dataLength, buffer: buf, durationSec };
}

function buildWavBase64(pcm: Buffer, sampleRate: number, bitsPerSample: number, numChannels: number): string {
  const bytesPerSample = bitsPerSample / 8;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * numChannels * bytesPerSample, 28);
  header.writeUInt16LE(numChannels * bytesPerSample, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]).toString("base64");
}

// Split a parsed WAV into base64 WAV segments of ~chunkSeconds each.
function splitWavIntoChunks(p: ParsedWav, chunkSeconds: number): string[] {
  const bytesPerSample = p.bitsPerSample / 8;
  const bytesPerSec = p.sampleRate * p.numChannels * bytesPerSample;
  const align = p.numChannels * bytesPerSample;
  let chunkBytes = Math.max(align, Math.floor(bytesPerSec * chunkSeconds));
  chunkBytes -= chunkBytes % align; // keep sample alignment
  const out: string[] = [];
  for (let start = 0; start < p.dataLength; start += chunkBytes) {
    const end = Math.min(start + chunkBytes, p.dataLength);
    const pcm = p.buffer.subarray(p.dataOffset + start, p.dataOffset + end);
    out.push(buildWavBase64(pcm, p.sampleRate, p.bitsPerSample, p.numChannels));
  }
  return out;
}

// Transcribe one short audio segment inline (temp 0), with rate-limit retry.
async function transcribeChunkInline(
  base64Wav: string, systemPrompt: string, userPrompt: string, attempt = 1, maxAttempts = 3
): Promise<{ detectedLanguage: string; transcript: string; usage: { input: number; output: number } }> {
  try {
    const resp = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: [
        { inlineData: { mimeType: "audio/wav", data: base64Wav } },
        { text: userPrompt },
      ],
      config: {
        systemInstruction: systemPrompt,
        maxOutputTokens: 65536,
        temperature: 0,
        topP: 0.5,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            detectedLanguage: { type: Type.STRING, description: "Language(s) actually spoken." },
            transcript: { type: Type.STRING, description: "Verbatim Latin/Romanized transcript of exactly what is spoken." },
          },
          required: ["detectedLanguage", "transcript"],
        },
      },
    });
    const text = resp.text;
    if (!text) throw new Error("Empty transcription response for segment");
    const data = JSON.parse(text);
    return {
      detectedLanguage: data.detectedLanguage || "Unknown",
      transcript: (data.transcript || "").trim(),
      usage: extractUsage(resp),
    };
  } catch (err: any) {
    const isRateLimit = err?.status === 429 ||
      (err?.message && /429|quota|rate limit|resource_exhausted/i.test(err.message));
    if (attempt < maxAttempts && isRateLimit) {
      await new Promise((r) => setTimeout(r, 4000 * attempt));
      return transcribeChunkInline(base64Wav, systemPrompt, userPrompt, attempt + 1, maxAttempts);
    }
    throw err;
  }
}

async function runTranscriptionInBackground(
  taskId: string,
  fileData: string,
  mimeType: string,
  targetStyle: string,
  additionalPrompt?: string,
  termCorrections?: string
) {
  let tempFilePath: string | null = null;
  let uploadedFileRef: any = null;

  try {
    const updateTask = (progress: string) => {
      const task = tasks.get(taskId);
      if (task) {
        task.progress = progress;
        tasks.set(taskId, task);
      }
    };

    // ── PASS 1 prompt: faithful, verbatim transcription ONLY (no translation) ──
    const transcriptionSystemPrompt = `You are an expert multilingual speech transcriber. Your ONLY job is to produce a faithful, complete, VERBATIM transcript of exactly what is spoken in the provided audio/video. You do NOT translate or restyle — you capture the real words.

RULES:
1. Transcribe EVERY spoken sentence from beginning to end. Do NOT summarize, paraphrase, shorten, condense, or skip anything (including repeated words and filler). Cover the entire timeline continuously; the transcript length must be proportional to how long the person actually speaks (N minutes of speech = N minutes worth of words).
2. Write ONLY in the Latin/Roman alphabet. If the speech is Tamil, Hindi, Telugu, etc., write it phonetically in Latin letters exactly as pronounced (natural Tanglish/Hinglish as actually spoken). Do NOT use Tamil, Devanagari, or any non-Latin script.
3. Transcribe ONLY what is truly said. NEVER invent, guess, or add words. Keep every proper noun, brand/product/course name, number, abbreviation, and technical term EXACTLY as spoken; never replace one with a similar-sounding word (e.g. never turn "CMA India" into "CMA Inter"). Do NOT insert words from a language the speaker did not use (e.g. no Hindi "yaani" in a Tamil transcript).
4. Preserve the speaker's real wording and code-mixing. Do NOT rewrite into a smoother or more casual style — that happens in a later step. This must be the literal transcript of what was said.
5. If a portion is unclear or inaudible, transcribe the closest faithful phonetic match of what was said. Do NOT fabricate plausible content to fill gaps. When unsure, stay literal and minimal.

DOMAIN CONTEXT (think like an experienced commerce faculty / founder at ArivuPro Academy):
This audio is from ArivuPro Academy, an Indian commerce & professional-education coaching institute. The speech typically covers professional courses and their governing bodies — CA (ICAI), CS (ICSI), CMA / CMA India (ICMAI), ACCA — along with levels and terms such as Foundation, CSEET, Executive / Inter, Professional / Final, articleship, registration & exam fees, exemptions, set-off benefit, and orientation / training programmes (e.g. ICSI's ODOP, EDP, MSOP). Use this domain knowledge to correctly RECOGNISE such acronyms and technical terms when the speaker actually says them, instead of writing a random guess.
CRITICAL — recognition, NOT correction: This context is only to help you hear domain words clearly. If the speaker clearly says a specific institute term or acronym, transcribe THEIR EXACT word. NEVER replace a spoken term with a more famous similar-sounding one (for example, do not change a spoken "GDOP" into the better-known "ODOP"). The authoritative glossary provided by the user always wins over your assumptions.`;

    // ── PASS 2 prompt: restyle the transcript into colloquial target style ──
    const translationSystemPrompt = `You are an expert localizer. You are given a faithful, verbatim transcript of a video's speech. Rewrite it into a natural, casual, highly colloquial street-style dialogue in the user's requested target style, ready for text-to-speech.

RULES:
1. PRESERVE ALL CONTENT: keep every point, sentence, detail, number, and proper noun from the transcript. Do NOT summarize, drop, merge, or add information. The output must cover the same content from start to end, at a similar length (never shorter in meaning).
2. Only change the PHRASING and STYLE into natural everyday colloquial speech — smoothly blend local grammar with common English professional/technical terms (Tanglish, Hinglish, Singlish, etc.). NEVER formal, textbook, or academic language (e.g. no "Ilakkiya Tamil" or textbook Hindi).
3. Write ONLY in the Latin/Roman alphabet. No Tamil, Devanagari, or other non-Latin scripts.
4. Keep every proper noun, brand/product/course name, number, and technical term EXACTLY as it appears in the transcript (e.g. "CMA India" stays "CMA India"). Never substitute a similar-sounding word, and never add words from another language that are not in the transcript.
5. Do NOT invent content that is not present in the transcript.

DOMAIN: This is commerce & professional-education content from ArivuPro Academy (CA/ICAI, CS/ICSI, CMA/ICMAI, ACCA, CSEET, Foundation/Executive/Professional levels, articleship, set-off, ODOP/EDP/MSOP, fees, exemptions, etc.). Keep every such course name, body, acronym, level, and number EXACTLY as written in the transcript — never "correct" or swap them for a similar-sounding term.`;

    const transcribeUserPrompt = `Produce a COMPLETE, faithful, verbatim transcript of everything spoken in this audio, from start to end.
${additionalPrompt ? `AUTHORITATIVE GLOSSARY — correct verified spellings of proper nouns / brand / course / technical terms that appear in this audio. Whenever you hear any of them, spell them EXACTLY like this and never substitute a similar-sounding word: ${additionalPrompt}` : ""}
Return purely the valid JSON string, no markdown.`;

    // ── PASS 1: Faithful transcription (temperature 0) ──
    // Long audio is split into short segments transcribed one-by-one, so a 1-hour
    // video can't time out or get summarized. Non-WAV fallbacks use the File API.
    let detectedLanguage = "Unknown";
    let rawTranscript = "";
    let p1Usage = { input: 0, output: 0 };

    const parsedWav = parseWavBase64(fileData);
    const CHUNK_SECONDS = 360; // 6-minute segments (keeps each inline call small & fast)

    if (parsedWav) {
      // ── Chunked, inline transcription (robust for any length) ──
      const segments = parsedWav.durationSec > CHUNK_SECONDS
        ? splitWavIntoChunks(parsedWav, CHUNK_SECONDS)
        : [fileData];

      const parts: string[] = [];
      for (let i = 0; i < segments.length; i++) {
        updateTask(`Transcribing segment ${i + 1} of ${segments.length}...`);
        try {
          const r = await transcribeChunkInline(segments[i], transcriptionSystemPrompt, transcribeUserPrompt);
          if (i === 0 && r.detectedLanguage) detectedLanguage = r.detectedLanguage;
          if (r.transcript) parts.push(r.transcript);
          p1Usage.input += r.usage.input;
          p1Usage.output += r.usage.output;
        } catch (segErr: any) {
          // Skip a failed segment rather than fail the whole transcription.
          console.warn(`[Transcribe] Segment ${i + 1}/${segments.length} failed, skipping: ${segErr?.message}`);
        }
      }
      rawTranscript = parts.join(" ").trim();
      if (!rawTranscript) {
        throw new Error("Transcription came back empty for every segment. Please ensure the file has clear, audible speech.");
      }
    } else {
      // ── Fallback: non-WAV original file → single-shot via Gemini File API ──
      const tempDir = os.tmpdir();
      const uniqueId = crypto.randomBytes(8).toString("hex");
      let fileExt = "bin";
      if (mimeType.includes("mp3")) fileExt = "mp3";
      else if (mimeType.includes("wav")) fileExt = "wav";
      else if (mimeType.includes("m4a")) fileExt = "m4a";
      else if (mimeType.includes("aac")) fileExt = "aac";
      else if (mimeType.includes("ogg")) fileExt = "ogg";
      else if (mimeType.includes("mp4")) fileExt = "mp4";
      else if (mimeType.includes("webm")) fileExt = "webm";

      tempFilePath = path.join(tempDir, `lingocut_${uniqueId}_${Date.now()}.${fileExt}`);
      updateTask("Writing media stream to server storage...");
      fs.writeFileSync(tempFilePath, Buffer.from(fileData, "base64"));

      updateTask("Uploading media stream to Google Gemini Files API...");
      uploadedFileRef = await ai.files.upload({ file: tempFilePath, config: { mimeType } });

      let fileState = await ai.files.get({ name: uploadedFileRef.name });
      let attempts = 0;
      while (fileState.state === "PROCESSING" && attempts < 90) {
        updateTask(`Gemini server processing media track... (Attempt ${attempts + 1}/90)`);
        await new Promise((resolve) => setTimeout(resolve, 2000));
        fileState = await ai.files.get({ name: uploadedFileRef.name });
        attempts++;
      }
      if (fileState.state === "FAILED") {
        throw new Error("Google Gemini file processing failed. Please ensure the file has a valid audio track.");
      }

      updateTask("Transcribing speech faithfully (pass 1 of 2)...");
      const transcriptionResponse = await ai.models.generateContent({
        model: "gemini-3.5-flash",
        contents: [
          { fileData: { fileUri: uploadedFileRef.uri, mimeType: uploadedFileRef.mimeType } },
          { text: transcribeUserPrompt },
        ],
        config: {
          systemInstruction: transcriptionSystemPrompt,
          maxOutputTokens: 65536,
          temperature: 0,
          topP: 0.5,
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              detectedLanguage: { type: Type.STRING, description: "The language(s) actually spoken in the media." },
              transcript: { type: Type.STRING, description: "Complete verbatim Latin/Romanized transcript of exactly what is spoken." },
            },
            required: ["detectedLanguage", "transcript"],
          },
        },
      });
      const transcriptionText = transcriptionResponse.text;
      if (!transcriptionText) throw new Error("No transcription response received from Gemini (pass 1).");
      const transcriptionData = JSON.parse(transcriptionText);
      detectedLanguage = transcriptionData.detectedLanguage || "Unknown";
      rawTranscript = (transcriptionData.transcript || "").trim();
      if (!rawTranscript) {
        throw new Error("The transcription came back empty. Please ensure the file has clear, audible speech.");
      }
      p1Usage = extractUsage(transcriptionResponse);
    }

    // ── PASS 2: Restyle the transcript into colloquial target style (text-only) ──
    updateTask("Translating into colloquial style (pass 2 of 2)...");

    const translateUserPrompt = `Target street-style colloquial style: ${targetStyle}
${additionalPrompt ? `AUTHORITATIVE GLOSSARY — keep these exact spellings whenever they appear: ${additionalPrompt}` : ""}

Here is the faithful transcript to rewrite. Preserve ALL content and every proper noun; only make the phrasing natural colloquial ${targetStyle}. Do not summarize, drop, or add anything:
"""
${rawTranscript}
"""

Return purely the valid JSON string, no markdown.`;

    const translationResponse = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      // Text-only call — it cannot mishear the audio, so no new transcription-level
      // hallucinations are introduced at this stage.
      contents: [{ text: translateUserPrompt }],
      config: {
        systemInstruction: translationSystemPrompt,
        maxOutputTokens: 65536,
        // A little warmth for natural colloquial phrasing, but content stays faithful
        // because the source is fixed text, not audio.
        temperature: 0.35,
        topP: 0.9,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            translatedScript: {
              type: Type.STRING,
              description: "The complete colloquial Romanized rewrite of the transcript, TTS-ready."
            }
          },
          required: ["translatedScript"]
        }
      }
    });

    const translationText = translationResponse.text;
    if (!translationText) {
      throw new Error("No translation response received from Gemini (pass 2).");
    }
    const translationData = JSON.parse(translationText);
    let translatedScript: string = (translationData.translatedScript || "").trim();
    if (!translatedScript) {
      throw new Error("The translation came back empty.");
    }

    // Deterministic guaranteed corrections (e.g. force "TDOP"/"ODOP" -> "GDOP").
    translatedScript = applyTermCorrections(translatedScript, termCorrections);

    // ─── Cost report (terminal) ───
    const p1 = p1Usage;
    const p2 = extractUsage(translationResponse);
    const p1InCost  = costOf(p1.input,  PRICE.flash.input);
    const p1OutCost = costOf(p1.output, PRICE.flash.output);
    const p2InCost  = costOf(p2.input,  PRICE.flash.input);
    const p2OutCost = costOf(p2.output, PRICE.flash.output);
    const scriptTotal = p1InCost + p1OutCost + p2InCost + p2OutCost;

    console.log(`
╔══════════════════════════════════════════════════════════════╗
║  LingoCut — COST REPORT · Transcription + Translation         ║
╠══════════════════════════════════════════════════════════════╣
║  Model: gemini-3.5-flash  (in ${inrRate(PRICE.flash.input)}/1M · out ${inrRate(PRICE.flash.output)}/1M) · rate ₹${USD_TO_INR}/$
║
║  PASS 1 — Transcription
║    Input  tokens : ${num(p1.input).padStart(12)}  →  ${inr(p1InCost)}
║    Output tokens : ${num(p1.output).padStart(12)}  →  ${inr(p1OutCost)}
║    Subtotal      : ${inr(p1InCost + p1OutCost)}
║
║  PASS 2 — Translation
║    Input  tokens : ${num(p2.input).padStart(12)}  →  ${inr(p2InCost)}
║    Output tokens : ${num(p2.output).padStart(12)}  →  ${inr(p2OutCost)}
║    Subtotal      : ${inr(p2InCost + p2OutCost)}
║
║  ── Totals ──
║    Input  tokens : ${num(p1.input + p2.input).padStart(12)}  →  ${inr(p1InCost + p2InCost)}
║    Output tokens : ${num(p1.output + p2.output).padStart(12)}  →  ${inr(p1OutCost + p2OutCost)}
║    SCRIPT TOTAL  : ${inr(scriptTotal)}
║    (add the Voiceover/TTS report below when you generate audio)
╚══════════════════════════════════════════════════════════════╝`);

    lastScriptCost = scriptTotal;

    const parsedData = {
      detectedLanguage,
      targetStyle,
      translatedScript,
    };

    // Save success result
    tasks.set(taskId, {
      id: taskId,
      status: "completed",
      progress: "Success!",
      result: parsedData,
    });

  } catch (error: any) {
    console.error(`Background task failed: ${taskId}`, error);
    tasks.set(taskId, {
      id: taskId,
      status: "failed",
      progress: "Failed",
      error: error.message || "An unexpected error occurred during transcription processing.",
    });
  } finally {
    // Perform cleanup of local temp file and Gemini File API record
    try {
      if (tempFilePath && fs.existsSync(tempFilePath)) {
        fs.unlinkSync(tempFilePath);
        console.log(`Cleaned up local temp file: ${tempFilePath}`);
      }
    } catch (cleanupErr) {
      console.error("Error cleaning up local file:", cleanupErr);
    }

    try {
      if (uploadedFileRef) {
        await ai.files.delete({ name: uploadedFileRef.name });
        console.log(`Cleaned up Gemini File API record: ${uploadedFileRef.name}`);
      }
    } catch (apiCleanupErr) {
      console.error("Error cleaning up Gemini File API record:", apiCleanupErr);
    }
  }
}

// Endpoint: Transcribe & script formatting (Asynchronous Task Queue Initiator)
app.post("/api/transcribe-script", async (req, res) => {
  try {
    const { fileData, mimeType, targetStyle, additionalPrompt, termCorrections } = req.body;

    if (!fileData || !mimeType || !targetStyle) {
      return res.status(400).json({ error: "Missing required parameters (fileData, mimeType, targetStyle)" });
    }

    if (!apiKey) {
      return res.status(500).json({ error: "GEMINI_API_KEY environment variable is not configured." });
    }

    const taskId = crypto.randomBytes(8).toString("hex");

    // Initialize the task
    tasks.set(taskId, {
      id: taskId,
      status: "processing",
      progress: "Queued task...",
    });

    // Return the taskId immediately
    res.json({ taskId });

    // Kick off background execution (without await!)
    runTranscriptionInBackground(taskId, fileData, mimeType, targetStyle, additionalPrompt, termCorrections);

  } catch (error: any) {
    console.error("Transcription service error:", error);
    res.status(500).json({ error: error.message || "An unexpected error occurred during transcription task creation." });
  }
});

// Endpoint: Check transcription task status
app.get("/api/tasks/:taskId", (req, res) => {
  const { taskId } = req.params;
  const task = tasks.get(taskId);
  if (!task) {
    return res.status(404).json({ error: "Task not found." });
  }

  // If task limit grows, we can periodically prune but keeping it in memory is super lightweight
  res.json(task);
});

// Helper to split and group text into readable chunks to prevent timeouts and ignore symbol-only formulas
// We use a larger chunk size (2,000 - 3,200 characters) to keep the total number of API requests very small.
function splitAndGroupText(text: string, minLength = 2000, maxLength = 3200): string[] {
  const rawSentences = text.match(/[^.!?]+[.!?]+(?:\s+|$)/g) || [text];
  const chunks: string[] = [];
  let currentChunk = "";

  for (const rawSentence of rawSentences) {
    const trimmed = rawSentence.trim();
    if (trimmed.length === 0) continue;

    // Check if the sentence has any alphabetic or numeric characters
    const hasAlphanumeric = /[a-zA-Z0-9]/.test(trimmed);
    if (!hasAlphanumeric) {
      // If it's a pure symbol/math format (e.g. ")^1/n."), append it to the current chunk instead of a standalone request
      if (currentChunk) {
        currentChunk += " " + trimmed;
      } else {
        currentChunk = trimmed;
      }
      continue;
    }

    // If adding this sentence would exceed maxLength, push the current chunk and start a new one
    if (currentChunk && currentChunk.length + trimmed.length > maxLength) {
      chunks.push(currentChunk);
      currentChunk = trimmed;
    } else {
      if (currentChunk) {
        currentChunk += " " + trimmed;
      } else {
        currentChunk = trimmed;
      }
    }

    // If the chunk reaches minLength, we push it to be processed
    if (currentChunk.length >= minLength) {
      chunks.push(currentChunk);
      currentChunk = "";
    }
  }

  // Handle any remaining text in currentChunk
  if (currentChunk.trim().length > 0) {
    const trimmedRemaining = currentChunk.trim();
    if (chunks.length > 0 && chunks[chunks.length - 1].length + trimmedRemaining.length <= maxLength) {
      chunks[chunks.length - 1] += " " + trimmedRemaining;
    } else {
      chunks.push(trimmedRemaining);
    }
  }

  // Filter out any chunk that doesn't contain at least one alphanumeric character
  return chunks.filter(c => /[a-zA-Z0-9]/.test(c));
}

// Simple batch helper for controlled concurrency
async function runInBatches<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency: number
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
  }
  return results;
}

// Multi-attempt API call with exponential backoff on 429 quota exhaustion errors.
// Returns the audio plus real token usage (text input + audio output tokens).
async function generateContentWithRetry(chunk: string, voiceName: string, attempt = 1, maxAttempts = 4): Promise<{ audio: string; input: number; output: number }> {
  try {
    const response = await ai.models.generateContent({
      model: "gemini-3.1-flash-tts-preview",
      contents: [{ parts: [{ text: `Read this script at a natural, casual, street-smart conversational pace: ${chunk}` }] }],
      config: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            // Options: 'Puck', 'Charon', 'Kore', 'Fenrir', 'Zephyr'
            prebuiltVoiceConfig: { voiceName: voiceName },
          },
        },
      },
    });

    const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!base64Audio) {
      // Gemini sometimes returns an empty response for a chunk (transient / soft
      // safety filter). Retry a couple of times with a short delay before giving up.
      if (attempt < maxAttempts) {
        const d = 1500 * attempt;
        console.warn(`[TTS] No audio for chunk, retrying in ${d}ms (Attempt ${attempt}/${maxAttempts})...`);
        await new Promise(resolve => setTimeout(resolve, d));
        return generateContentWithRetry(chunk, voiceName, attempt + 1, maxAttempts);
      }
      throw new Error("No audio data returned from Gemini TTS");
    }
    const u = extractUsage(response);
    return { audio: base64Audio, input: u.input, output: u.output };
  } catch (err: any) {
    const isRateLimit = err.status === 429 || 
                        (err.message && (err.message.includes("429") || err.message.toLowerCase().includes("quota") || err.message.toLowerCase().includes("rate limit") || err.message.toLowerCase().includes("resource_exhausted")));
    
    if (isRateLimit && attempt < maxAttempts) {
      const retryDelay = 5000 * attempt + Math.floor(Math.random() * 1000); // 5s, 10s, 15s with minor jitter
      console.warn(`[TTS API Rate Limit (429)] Retrying chunk in ${retryDelay}ms (Attempt ${attempt}/${maxAttempts})...`);
      await new Promise(resolve => setTimeout(resolve, retryDelay));
      return generateContentWithRetry(chunk, voiceName, attempt + 1, maxAttempts);
    }
    
    throw err;
  }
}

// Voices we support. Any request is coerced to one of these so a segment can
// never fall back to a model default (which is what caused the voice/gender to
// flip mid-audio in per-segment generation).
const ALLOWED_TTS_VOICES = ["Puck", "Charon", "Fenrir", "Orus", "Kore", "Zephyr", "Leda"];

// Endpoint: Generate Text-to-Speech voiceover
app.post("/api/generate-tts", async (req, res) => {
  try {
    const { text, voice } = req.body;

    if (!apiKey) {
      return res.status(500).json({ error: "GEMINI_API_KEY environment variable is not configured." });
    }

    // Pin ONE voice for the ENTIRE request. Every chunk call below uses this
    // exact value, so the speaker identity never changes across the audio.
    const pinnedVoice = ALLOWED_TTS_VOICES.includes(voice) ? voice : "Puck";

    if (!text) {
      return res.status(400).json({ error: "Text parameter is required for speech synthesis" });
    }

    // Split and group script into chunks
    const chunks = splitAndGroupText(text);
    console.log(`Grouped script into ${chunks.length} optimized large chunks for TTS synthesis (avoiding timeout & symbol-only failures)...`);
    chunks.forEach((chunk, idx) => {
      console.log(`Chunk ${idx + 1}/${chunks.length} (${chunk.length} chars): "${chunk.substring(0, 60)}..."`);
    });

    // Call gemini-3.1-flash-tts-preview for each chunk in batches of 2 with automated
    // retry. A single chunk that keeps failing is SKIPPED (returns "") so it can't
    // take down the whole voiceover — we track how many were dropped.
    let failedChunks = 0;
    const results = await runInBatches(
      chunks,
      async (chunk) => {
        try {
          return await generateContentWithRetry(chunk, pinnedVoice);
        } catch (chunkErr: any) {
          failedChunks++;
          console.warn(`[TTS] Chunk failed after retries, skipping: ${chunkErr?.message}`);
          return { audio: "", input: 0, output: 0 };
        }
      },
      2
    );

    // Concatenate all PCM audio segments that succeeded.
    const valid = results.filter((r) => r && r.audio && r.audio.length > 0);
    if (valid.length === 0) {
      return res.status(502).json({
        error: "All voice segments failed to synthesize. This is usually a Gemini TTS rate limit or quota — wait a minute and try again.",
      });
    }

    const buffers = valid.map((r) => Buffer.from(r.audio, "base64"));
    const mergedBuffer = Buffer.concat(buffers);
    const mergedBase64 = mergedBuffer.toString("base64");

    if (failedChunks > 0) {
      console.warn(`[TTS] Completed with ${failedChunks}/${chunks.length} chunk(s) skipped.`);
    }

    // ─── Cost report (terminal) ───
    const ttsIn = results.reduce((s, r) => s + (r?.input ?? 0), 0);
    const ttsOut = results.reduce((s, r) => s + (r?.output ?? 0), 0);
    const ttsInCost = costOf(ttsIn, PRICE.tts.input);
    const ttsOutCost = costOf(ttsOut, PRICE.tts.audioOutput);
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║  LingoCut — COST REPORT · Voiceover / TTS                     ║
╠══════════════════════════════════════════════════════════════╣
║  Model: gemini-3.1-flash-tts-preview  (in ${inrRate(PRICE.tts.input)}/1M · audio-out ${inrRate(PRICE.tts.audioOutput)}/1M)
║  Voice: ${pinnedVoice}   Chunks: ${chunks.length} (${failedChunks} skipped)
║
║    Text input tokens  : ${num(ttsIn).padStart(12)}  →  ${inr(ttsInCost)}
║    Audio output tokens: ${num(ttsOut).padStart(12)}  →  ${inr(ttsOutCost)}
║    VOICEOVER TOTAL     : ${inr(ttsInCost + ttsOutCost)}
║
║  ── GRAND TOTAL (this run) ──
║    Script (transcribe + translate): ${inr(lastScriptCost)}
║    Voiceover (TTS)                 : ${inr(ttsInCost + ttsOutCost)}
║    ═══════════════════════════════════════════
║    TOTAL SPENT THIS RUN            : ${inr(lastScriptCost + ttsInCost + ttsOutCost)}
╚══════════════════════════════════════════════════════════════╝`);

    res.json({
      audioData: mergedBase64,
      mimeType: "audio/pcm",
      voice: pinnedVoice,
      chunksTotal: chunks.length,
      chunksFailed: failedChunks,
    });

  } catch (error: any) {
    console.error("Synthesizer service error:", error);
    res.status(500).json({ error: error.message || "An unexpected error occurred during audio synthesis." });
  }
});

// Handle serving SPA & Setup Vite Middleware/Static
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`LingoCut backend running on http://0.0.0.0:${PORT} in ${process.env.NODE_ENV || "development"} mode`);
  });
}

startServer();
