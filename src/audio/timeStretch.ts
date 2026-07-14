/**
 * WSOLA time-stretch: change audio duration by `factor` (>1 = longer/slower,
 * <1 = shorter/faster) while preserving pitch. Overlap-adds windowed grains
 * with a small correlation search to keep the waveform phase continuous, which
 * avoids the "chipmunk"/echo artefacts of naive resampling or plain OLA.
 *
 * Operates on mono Float32 samples in [-1, 1]. Runs on the main thread or inside
 * a Web Worker (see ttsStretch.worker.ts).
 */
export function timeStretch(input: Float32Array, factor: number, sampleRate: number): Float32Array {
  if (input.length === 0 || Math.abs(factor - 1) < 0.02) return input;

  const N = Math.max(256, Math.round(sampleRate * 0.05)); // ~50ms frame
  const Hs = Math.floor(N / 2);                            // synthesis hop (50% overlap)
  const Ha = Math.max(1, Math.round(Hs / factor));         // analysis hop
  const maxSearch = Math.round(sampleRate * 0.01);         // ±10ms alignment search
  const corrStep = 4;                                      // subsample correlation for speed

  // Hann window
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));

  const outLen = Math.round(input.length * factor) + N;
  const out = new Float32Array(outLen);
  const winSum = new Float32Array(outLen);

  let outPos = 0;
  let anaPos = 0;
  let template = input.subarray(0, N); // correlation target for the next grain

  while (anaPos + N + maxSearch < input.length && outPos + N < outLen) {
    // Find the offset (within ±maxSearch) whose grain best matches the template.
    let bestDelta = 0;
    let bestCorr = -Infinity;
    const lo = Math.max(-maxSearch, -anaPos);
    for (let d = lo; d <= maxSearch; d++) {
      let corr = 0;
      for (let i = 0; i < N; i += corrStep) corr += input[anaPos + d + i] * template[i];
      if (corr > bestCorr) { bestCorr = corr; bestDelta = d; }
    }
    const grainStart = anaPos + bestDelta;

    // Overlap-add the windowed grain
    for (let i = 0; i < N; i++) {
      out[outPos + i] += input[grainStart + i] * win[i];
      winSum[outPos + i] += win[i];
    }

    // Next template = samples that naturally follow this grain in the input
    const natStart = grainStart + Hs;
    if (natStart + N > input.length) break;
    template = input.subarray(natStart, natStart + N);

    outPos += Hs;
    anaPos += Ha;
  }

  // Normalize by accumulated window energy to remove amplitude ripple
  const finalLen = Math.min(out.length, outPos + N);
  const result = new Float32Array(finalLen);
  for (let i = 0; i < finalLen; i++) {
    result[i] = winSum[i] > 1e-6 ? out[i] / winSum[i] : out[i];
  }
  return result;
}
