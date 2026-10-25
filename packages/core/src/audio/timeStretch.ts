/**
 * Pitch-preserving time stretch (WSOLA: waveform-similarity overlap-add). Pure and environment-neutral.
 * Used instead of AudioBufferSourceNode.playbackRate for dub compression: playbackRate also shifts the pitch (+4 semitones
 * at 1.25x), which turns male voices childlike.
 */

/** frame length, seconds (a few pitch periods of any voice); hop between output frames is half of it (Hann at 50% sums to 1) */
const FRAME_SEC = 0.03;
/** how far a frame may slide from its nominal analysis position to find the best join, seconds */
const SEARCH_SEC = 0.01;
/** the coarse search runs on a signal decimated to about this rate */
const COARSE_RATE = 6000;

export const STRETCH_MIN = 1;
export const STRETCH_MAX = 1.5;

/**
 * Speed `samples` up by `factor` (> 1 = faster, output length ~ length / factor) without changing the pitch.
 * factor is clamped to 1..1.5; |factor - 1| < 0.01 returns the input unchanged.
 */
export function timeStretch(samples: Float32Array, sampleRate: number, factor: number): Float32Array {
  const len = samples.length;
  if (!(factor > 0) || !(sampleRate > 0) || Math.abs(factor - 1) < 0.01 || len === 0) return samples;
  const f = Math.min(STRETCH_MAX, Math.max(STRETCH_MIN, factor));
  if (f - 1 < 0.01) return samples;

  const half = Math.max(8, Math.round((sampleRate * FRAME_SEC) / 2));
  const N = half * 2;
  const tol = Math.max(2, Math.round(sampleRate * SEARCH_SEC));
  const D = Math.max(1, Math.round(sampleRate / COARSE_RATE));
  const outLen = Math.max(1, Math.round(len / f));

  // the input is padded with silence so the last frames (and the search window beyond the end) can be read safely
  const padLen = len + 2 * N + tol;
  const x = new Float32Array(padLen);
  x.set(samples);
  // box-averaged decimation: the coarse correlation search works on this cheap copy
  const dLen = Math.floor(padLen / D);
  const xd = new Float32Array(dLen);
  for (let j = 0; j < dLen; j++) {
    let s = 0;
    for (let k = 0; k < D; k++) s += x[j * D + k]!;
    xd[j] = s / D;
  }

  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N); // periodic Hann: win[i] + win[i + half] = 1
  const y = new Float32Array(outLen + 2 * N);
  const ha = half * f; // analysis hop (fractional)
  const maxPos = padLen - N;

  let prev = 0; // analysis position of the previous frame
  for (let k = 0, s = 0; s < outLen + half; k++, s += half) {
    let p = 0;
    if (k > 0) {
      const nominal = Math.round(k * ha);
      const lo = Math.max(0, nominal - tol);
      const hi = Math.min(maxPos, nominal + tol);
      const tpl = prev + half; // what the previous frame's second half continues with naturally
      p = Math.min(Math.max(nominal, lo), hi);
      if (hi > lo && tpl + half <= padLen) {
        // coarse: normalized cross-correlation of the overlap region on the decimated signal
        const td = Math.round(tpl / D);
        const len2 = Math.max(4, Math.floor(half / D));
        let tplE = 0;
        for (let i = 0; i < len2; i++) tplE += xd[td + i]! * xd[td + i]!;
        let best = -Infinity;
        let bestD = Math.round(p / D);
        for (let pd = Math.ceil(lo / D); pd <= Math.floor(hi / D); pd++) {
          let dot = 0;
          let e = 0;
          for (let i = 0; i < len2; i++) {
            const v = xd[pd + i]!;
            dot += v * xd[td + i]!;
            e += v * v;
          }
          const score = dot / Math.sqrt(e * tplE + 1e-12);
          if (score > best) {
            best = score;
            bestD = pd;
          }
        }
        // fine: full-rate search around the coarse winner
        const c = bestD * D;
        let fBest = -Infinity;
        let fPos = Math.min(Math.max(c, lo), hi);
        for (let q = Math.max(lo, c - D); q <= Math.min(hi, c + D); q++) {
          let dot = 0;
          let e = 0;
          let te = 0;
          for (let i = 0; i < half; i++) {
            const v = x[q + i]!;
            const t = x[tpl + i]!;
            dot += v * t;
            e += v * v;
            te += t * t;
          }
          const score = dot / Math.sqrt(e * te + 1e-12);
          if (score > fBest) {
            fBest = score;
            fPos = q;
          }
        }
        p = fPos;
      }
    }
    // the very first frame keeps its start un-faded; every later start overlaps the previous frame's fade-out
    for (let i = 0; i < N; i++) y[s + i] = (y[s + i] ?? 0) + x[p + i]! *(k === 0 && i < half ? 1 : win[i]!);
    prev = p;
  }
  return y.slice(0, outLen);
}
