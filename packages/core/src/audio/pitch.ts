/**
 * Fundamental-frequency (f0) estimation by normalized autocorrelation, for choosing a TTS voice whose pitch class
 * matches the original speaker. Pure, environment-neutral, no allocations per sample beyond one decimated copy.
 */

export interface F0Options {
  /** lowest / highest f0 searched, Hz (defaults 60 / 400) */
  minHz?: number;
  maxHz?: number;
  /** analysis frame / hop, seconds (defaults 0.04 / 0.02) */
  frameSec?: number;
  hopSec?: number;
  /** minimum normalized autocorrelation peak for a frame to count as voiced (default 0.5) */
  minPeak?: number;
  /** frames quieter than this fraction of the loudest frame RMS are skipped (default 0.1) */
  minLevel?: number;
  /** [startSec, endSec] ranges of `pcm` to analyze (default: all) */
  ranges?: [number, number][];
}

export interface F0Result {
  /** median f0 over voiced frames, Hz; 0 when fewer than `MIN_VOICED_FRAMES` voiced frames were found */
  f0: number;
  voicedFrames: number;
  totalFrames: number;
}

/** About 0.3 s of voiced speech is needed for a trustworthy median. */
export const MIN_VOICED_FRAMES = 15;
const TARGET_RATE = 12000;

function decimate(pcm: Int16Array, rate: number): { x: Float32Array; rate: number } {
  const f = Math.max(1, Math.floor(rate / TARGET_RATE));
  if (f === 1) {
    const x = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) x[i] = pcm[i]!;
    return { x, rate };
  }
  const n = Math.floor(pcm.length / f);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < f; j++) s += pcm[i * f + j]!;
    x[i] = s / f; // box filter = crude anti-alias, plenty for f0 < 400 Hz
  }
  return { x, rate: rate / f };
}

/** Median f0 of the voiced frames of `pcm` (or of `opts.ranges`). */
export function estimateF0(pcm: Int16Array, sampleRate: number, opts: F0Options = {}): F0Result {
  const minHz = opts.minHz ?? 60;
  const maxHz = opts.maxHz ?? 400;
  const { x, rate } = decimate(pcm, sampleRate);
  const frame = Math.round((opts.frameSec ?? 0.04) * rate);
  const hop = Math.max(1, Math.round((opts.hopSec ?? 0.02) * rate));
  const minLag = Math.max(2, Math.floor(rate / maxHz));
  const maxLag = Math.min(frame - 2, Math.ceil(rate / minHz));
  const ranges = opts.ranges ?? [[0, x.length / rate]];

  // frame RMS first, to get the loudness reference
  const starts: number[] = [];
  for (const [a, b] of ranges) {
    const lo = Math.max(0, Math.floor(a * rate));
    const hi = Math.min(x.length, Math.floor(b * rate));
    for (let s = lo; s + frame <= hi; s += hop) starts.push(s);
  }
  const rmsOf = (s: number): number => {
    let e = 0;
    for (let i = 0; i < frame; i++) e += x[s + i]! * x[s + i]!;
    return Math.sqrt(e / frame);
  };
  let ref = 0;
  const rms = starts.map((s) => {
    const r = rmsOf(s);
    if (r > ref) ref = r;
    return r;
  });
  if (ref < 20) return { f0: 0, voicedFrames: 0, totalFrames: starts.length };
  const minPeak = opts.minPeak ?? 0.5;
  const minLevel = (opts.minLevel ?? 0.1) * ref;

  const f0s: number[] = [];
  const r = new Float64Array(maxLag + 2);
  for (let k = 0; k < starts.length; k++) {
    if (rms[k]! < minLevel) continue;
    const s = starts[k]!;
    // remove the frame mean (DC)
    let mean = 0;
    for (let i = s; i < s + frame; i++) mean += x[i]!;
    mean /= frame;
    let e0 = 0;
    for (let i = s; i < s + frame; i++) e0 += (x[i]! - mean) ** 2;
    if (e0 <= 0) continue;
    r.fill(0);
    let best = -1;
    for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
      if (s + frame + lag > x.length) break;
      let c = 0;
      let e1 = 0;
      for (let i = 0; i < frame; i++) {
        const a = x[s + i]! - mean;
        const b = x[s + i + lag]! - mean;
        c += a * b;
        e1 += b * b;
      }
      r[lag] = e1 > 0 ? c / Math.sqrt(e0 * e1) : 0;
    }
    // first local maximum within 0.9 of the global one (smallest lag wins: avoids octave-down errors)
    let gmax = 0;
    for (let lag = minLag; lag <= maxLag; lag++) if (r[lag]! > gmax) gmax = r[lag]!;
    if (gmax < minPeak) continue;
    for (let lag = minLag; lag <= maxLag; lag++) {
      const v = r[lag]!;
      if (v >= 0.9 * gmax && v >= r[lag - 1]! && v >= r[lag + 1]!) {
        best = lag;
        break;
      }
    }
    if (best < 0) continue;
    // parabolic interpolation around the peak
    const y0 = r[best - 1]!;
    const y1 = r[best]!;
    const y2 = r[best + 1]!;
    const den = y0 - 2 * y1 + y2;
    const shift = den < 0 ? (0.5 * (y0 - y2)) / den : 0;
    f0s.push(rate / (best + shift));
  }
  if (f0s.length < MIN_VOICED_FRAMES) return { f0: 0, voicedFrames: f0s.length, totalFrames: starts.length };
  f0s.sort((a, b) => a - b);
  const mid = f0s.length >> 1;
  const f0 = f0s.length % 2 ? f0s[mid]! : (f0s[mid - 1]! + f0s[mid]!) / 2;
  return { f0, voicedFrames: f0s.length, totalFrames: starts.length };
}
