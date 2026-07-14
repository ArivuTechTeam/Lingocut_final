/**
 * Off-main-thread WSOLA time-stretch. Keeps the UI responsive while fitting a
 * long voiceover (e.g. a multi-minute clip) to the original length.
 */
import { timeStretch } from "./timeStretch";

self.onmessage = (e: MessageEvent) => {
  const { samples, factor, sampleRate } = e.data as {
    samples: Float32Array;
    factor: number;
    sampleRate: number;
  };
  const out = timeStretch(samples, factor, sampleRate);
  // Transfer the result buffer back to avoid a copy.
  (self as unknown as Worker).postMessage({ samples: out }, [out.buffer]);
};
