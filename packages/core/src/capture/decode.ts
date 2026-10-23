/** Browser-side decoding: container bytes -> mono Int16 @16 kHz via decodeAudioData. */
import { TARGET_RATE, toMono16k } from './audio';

export type Decoder = (bytes: Uint8Array) => Promise<Int16Array>;

function toArrayBuffer(b: Uint8Array): ArrayBuffer {
  if (b.byteOffset === 0 && b.byteLength === b.buffer.byteLength && b.buffer instanceof ArrayBuffer) return b.buffer;
  return b.slice().buffer as ArrayBuffer;
}

/**
 * Uses an OfflineAudioContext @16 kHz so the browser's own (high quality) resampler does the rate conversion;
 * `toMono16k` then only downmixes (and resamples if the engine ignored the requested rate).
 * NOTE: decodeAudioData detaches the input buffer, so a copy is made when `b` is a view.
 */
export const decodeToPcm16k: Decoder = async (bytes) => {
  const Ctx = (globalThis as { OfflineAudioContext?: typeof OfflineAudioContext }).OfflineAudioContext;
  if (!Ctx) throw new Error('OfflineAudioContext unavailable');
  const ctx = new Ctx(1, 1, TARGET_RATE);
  const buf = await ctx.decodeAudioData(toArrayBuffer(bytes));
  const chans: Float32Array[] = [];
  for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
  return toMono16k(chans, buf.sampleRate);
};

export function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
