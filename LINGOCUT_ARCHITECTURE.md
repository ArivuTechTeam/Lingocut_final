# LingoCut — Tech Stack, Workflow, Architecture & API Costing

**Product:** Multi-lingual Video/Audio Transcriber & Street-Colloquial Modeller.
Upload a recorded video/audio → get a faithful transcript → translated into casual
Romanized colloquial style (Tanglish/Hinglish/etc.) → generate a downloadable AI
voiceover fitted to the original clip length.

_Last updated: 2026-07-13_

---

## 1. Tech Stack

### Frontend
| Area | Technology |
|---|---|
| UI framework | **React 19** + **TypeScript** |
| Build tool | **Vite 6** |
| Styling | **Tailwind CSS 4** (`@tailwindcss/vite`) |
| Icons | **lucide-react** |
| Animation | **motion** (Framer Motion) |
| Audio (client) | **Web Audio API** (extraction/downsampling, PCM↔WAV), **Web Workers** (WSOLA time-stretch) |

### Backend
| Area | Technology |
|---|---|
| Runtime | **Node.js** (ESM) |
| Server | **Express 4** |
| Language | **TypeScript** (dev via **tsx**, prod bundled via **esbuild**) |
| Dev serving | **Vite middleware** (SPA served through the same Express process) |
| AI SDK | **@google/genai** (`^2.4.0`) |
| Config | **dotenv** (`GEMINI_API_KEY`, `APP_URL`) |

### AI Models (Google Gemini)
| Stage | Model |
|---|---|
| Transcription (Pass 1) | `gemini-3.5-flash` |
| Translation (Pass 2) | `gemini-3.5-flash` |
| Voiceover / TTS | `gemini-3.1-flash-tts-preview` |

### Scripts
| Command | Purpose |
|---|---|
| `npm run dev` | `tsx server.ts` — dev server (API + Vite SPA) |
| `npm run build` | `vite build` + `esbuild` bundle server → `dist/server.cjs` |
| `npm run start` | `node dist/server.cjs` — production |
| `npm run lint` | `tsc --noEmit` — type check |

---

## 2. Architecture

Single **monolith** Node/Express process that serves both the REST API and the
React SPA (Vite middleware in dev, static `dist/` in prod). Long tasks run as
**in-memory background jobs** polled by the client.

```
┌─────────────────────────────────────────────────────────────────────┐
│                          Browser (React SPA)                         │
│                                                                      │
│  Upload/Mic/Sample ─► Web Audio extract+downsample ─► base64 WAV     │
│         │                                                            │
│         │  POST /api/transcribe-script  ──────────────►             │
│         │  GET  /api/tasks/:taskId  (poll)  ◄──────────             │
│         │  POST /api/generate-tts  ──────────────────►              │
│         ▼                                                            │
│  Web Worker: WSOLA time-stretch → WAV blob → <audio> + download     │
└───────────────────────────────┬─────────────────────────────────────┘
                                 │ HTTP (JSON, base64 payloads)
┌───────────────────────────────▼─────────────────────────────────────┐
│                    Node / Express (server.ts)                        │
│                                                                      │
│  In-memory  tasks: Map<taskId, {status, progress, result}>          │
│                                                                      │
│  /api/transcribe-script ─► background task:                         │
│       1. write temp file → Gemini File API upload → poll ready      │
│       2. PASS 1  gemini-3.5-flash (temp 0)   → verbatim transcript  │
│       3. PASS 2  gemini-3.5-flash (temp .35) → colloquial script    │
│       4. applyTermCorrections() deterministic find/replace          │
│       5. cost report → terminal                                     │
│                                                                      │
│  /api/generate-tts ─► split script into 2–3.2k-char chunks →        │
│       gemini-3.1-flash-tts-preview per chunk (voice pinned,         │
│       batches of 2, retry+backoff, skip-on-fail) → merge PCM →      │
│       cost report → terminal                                        │
└───────────────────────────────┬─────────────────────────────────────┘
                                 │
                        Google Gemini API
             (File API · 3.5-flash · 3.1-flash-tts-preview)
```

### API endpoints
| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/transcribe-script` | Start transcription+translation job → returns `{ taskId }` |
| `GET`  | `/api/tasks/:taskId` | Poll job status/progress/result |
| `POST` | `/api/generate-tts` | Generate voiceover from the script (synchronous) |

### Key implementation details
- **Two-pass AI pipeline** — accuracy (Pass 1, temp 0, no translation) is separated
  from style (Pass 2, temp 0.35, text-only). Prevents the creative translation from
  contaminating the transcription and inventing words.
- **`maxOutputTokens: 65536`** on both passes so long transcripts aren't summarized.
- **Domain persona + glossary** injected into prompts (commerce/ArivuPro terms) to
  reduce mishears; user glossary treated as authoritative spellings.
- **Force Corrections** — deterministic post-AI find/replace (`wrong => Right`) that
  guarantees exact terms regardless of what the model heard.
- **TTS resilience** — script chunked (2,000–3,200 chars), 2-at-a-time, exponential
  backoff on 429, empty-audio retried, failed chunk **skipped** (never fails whole run).
- **Voice pinning** — one `voiceName` for the whole request (allow-list), so the voice
  never changes mid-audio.
- **Fit-to-length** — client WSOLA time-stretch (pitch-preserved, Web Worker) matches
  the voiceover duration to the original clip; result is a downloadable/replayable WAV.
- **Cost reporting** — real `usageMetadata` token counts logged to the terminal per run.

### Current constraints / limits
| Limit | Value | Where |
|---|---|---|
| Max upload file size | 1.5 GB | client |
| HTTP body limit | 300 MB | `express.json` |
| Gemini File API processing poll | 45 × 2s = **90 s** cap | server |
| Task persistence | **in-memory Map** (lost on restart) | server |
| TTS request | **synchronous** (no polling) — long scripts risk timeout | server |
| Audio downsampling | 16 kHz default; 12 kHz/8-bit >15 min; 8 kHz/8-bit >45 min; 6 kHz/8-bit >90 min | client |
| Reliable end-to-end length | **~15–20 min** (TTS stage is the wall) | — |

---

## 3. Workflow (end to end)

### A. Script generation
1. **Select source** — Upload file / Live mic / Interactive sample.
2. **Client audio prep** — Web Audio API decodes the media, downsamples to mono WAV
   (sample rate/bit-depth tiered by duration), encodes to base64.
3. **`POST /api/transcribe-script`** with `{ fileData, mimeType, targetStyle,
   additionalPrompt (glossary), termCorrections }` → server returns `{ taskId }`.
4. **Background task:**
   - Writes temp file → uploads to **Gemini File API** → polls until `ACTIVE`.
   - **Pass 1 (transcribe):** `gemini-3.5-flash`, temperature 0 → faithful verbatim
     transcript (`detectedLanguage`, `transcript`).
   - **Pass 2 (translate):** `gemini-3.5-flash`, temperature 0.35, **text-only** →
     colloquial `translatedScript` in the target style.
   - **Force Corrections** applied deterministically.
   - **Cost report** printed to terminal.
5. **Client polls `GET /api/tasks/:taskId`** until `completed`; shows the script.

### B. Voiceover generation
6. **Select voice** (Puck/Charon/Fenrir/Orus male; Kore/Zephyr/Leda female) + fit toggle.
7. **`POST /api/generate-tts`** with `{ text, voice }`.
8. **Server:** splits script into chunks → `gemini-3.1-flash-tts-preview` per chunk
   (pinned voice, batched, retried, skip-on-fail) → merges PCM → returns base64 +
   `{ chunksTotal, chunksFailed }`. **Cost report** printed to terminal.
9. **Client:** builds a WAV; if "fit to length" is on, WSOLA-stretches (Web Worker) to
   the original clip duration; renders a native `<audio>` player + **Download WAV**.

---

## 4. API Costing

### Official Gemini rates (USD per 1M tokens)
| Model | Input | Output |
|---|---|---|
| `gemini-3.5-flash` (transcribe + translate) | **$1.50** | **$9.00** |
| `gemini-3.1-flash-tts-preview` (voiceover) | **$1.00** (text) | **$20.00** (audio) |

**Token conversion:** audio **input** = 32 tokens/sec (1,920/min); TTS audio
**output** = 25 tokens/sec (1,500/min).

**Estimate assumption:** ~150 spoken words/min ≈ ~200 text tokens/min.

### Cost per MINUTE of input video (full pipeline)
| Stage | Billed | Tokens/min | Cost/min |
|---|---|---|---|
| Pass 1 – Transcribe | audio in | 1,920 | $0.00288 |
| | transcript out | ~200 | $0.00180 |
| Pass 2 – Translate | text in | ~200 | $0.00030 |
| | script out | ~220 | $0.00198 |
| TTS – Voiceover | text in | ~220 | $0.00022 |
| | **audio out** | 1,500 | **$0.03000** |
| **TOTAL** | | | **≈ $0.037 / min** |

### Cost per HOUR of input video
| Stage | Cost/hour |
|---|---|
| Transcription (Pass 1) | ~$0.28 |
| Translation (Pass 2) | ~$0.14 |
| **TTS voiceover** | **~$1.81** |
| **TOTAL** | **≈ $2.23 / hour** |

### Quick reference
| Input length | Approx. total cost |
|---|---|
| 1 minute | ~$0.037 |
| 10 minutes | ~$0.37 |
| 30 minutes | ~$1.12 |
| 1 hour | ~$2.23 |

### Notes
- **TTS audio output dominates (~80% of cost)** — the $20/1M audio-output rate.
- **Script only** (no voiceover) ≈ **$0.007/min (~$0.42/hr)**.
- Prices are **paid tier**; a **free tier** with daily limits also exists. The TTS
  model is **preview** — its price may change.
- Costs scale with speech density (more words/min → more output tokens).
- Actual per-run spend is logged to the terminal from real `usageMetadata`.

---

## 5. Known Gaps & Scalability Notes (brief)
- **In-memory tasks** → lost on restart, single-instance only. Move to a DB.
- **Synchronous TTS + base64 audio** → timeouts and memory pressure on long content.
  Move to background job + object storage (URLs, not base64).
- **No audio chunking** → long videos summarize/drift and hit File-API/memory limits.
  Split into ~5–10 min segments processed in parallel.
- **Client-side audio assembly** → move heavy WSOLA/WAV work to the server (ffmpeg).
- For hour-long lectures at scale: consider a **dedicated ASR** (Whisper / Google STT)
  for transcription, Gemini for translation.
- Recommended scale stack: BullMQ+Redis (queue), Postgres (state), S3/R2 (storage),
  ffmpeg (audio), SSE (progress), Docker (deploy).
