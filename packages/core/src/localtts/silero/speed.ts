/**
 * Duration fitting for Silero. The acoustic ONNX returns per-symbol frame durations, and speed enters only through the per-symbol
 * input durs_rate (durs = round(durs / rate) in float32, then fixed clamps of the first / last symbols), so the length at ANY rate
 * vector is exactly predictable from the natural-speed durations. A uniform rate gives a step function of the length (many symbols
 * share a duration, e.g. every 3-frame symbol flips at 1.2), so the plan uses two adjacent float32 rates and gives the slower one to
 * just enough symbols, spread evenly over the text: the result lands within one 12.5 ms frame of the target.
 * One natural pass -> plan -> at most one corrective acoustic pass.
 */
import { SILERO_CHUNK_GAP_SEC, SILERO_FIT_TOLERANCE, SILERO_HOP_24K, SILERO_SAMPLE_RATE, SILERO_SPEED_MAX, SILERO_SPEED_MIN } from './constants';
import { sileroSamples24k } from './dsp';

const f32 = Math.fround;

/** ONNX Round: half to even */
export function roundHalfEven(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

export function clampSileroSpeed(v: number): number {
  return Math.min(SILERO_SPEED_MAX, Math.max(SILERO_SPEED_MIN, v));
}

/** frames of symbol i (of T) at `rate`, from its natural-speed duration (mirrors Acoustic.durations, float32 division) */
function symFrames(nat: number, i: number, T: number, rate: number): number {
  let d = roundHalfEven(f32(f32(nat) / f32(rate)));
  if (i === 0) d = Math.min(d, 5);
  if (i === T - 1) d = Math.min(d, 7);
  if (i === T - 2) d = 13;
  if (i === T - 3) d = Math.min(d, 13);
  return d;
}

/** predicted frames of one chunk at a uniform rate */
export function sileroFramesAt(natural: readonly number[], rate: number): number {
  let f = 0;
  for (let i = 0; i < natural.length; i++) f += symFrames(natural[i]!, i, natural.length, rate);
  return f;
}

/** total seconds of a request (chunks + gaps) at a uniform rate */
export function sileroTotalSec(naturalDurs: readonly (readonly number[])[], rate: number, gapSec: number = SILERO_CHUNK_GAP_SEC): number {
  let samples = 0;
  for (const d of naturalDurs) samples += sileroSamples24k(sileroFramesAt(d, rate));
  return samples / SILERO_SAMPLE_RATE + Math.max(0, naturalDurs.length - 1) * gapSec;
}

export interface SileroRatePlan {
  /** representative speed (the uniform rate of the plan; 1 = natural) */
  speed: number;
  /** per chunk, per symbol durs_rate; null = keep the natural pass */
  rates: Float32Array[] | null;
  /** predicted total seconds with these rates */
  predictedSec: number;
}

/** evenly spread visiting order of n items (golden-ratio sequence) */
function spreadOrder(n: number): number[] {
  const g = 0.6180339887498949;
  return Array.from({ length: n }, (_, k) => k)
    .map((k) => [((k + 0.5) * g) % 1, k] as const)
    .sort((a, b) => a[0] - b[0])
    .map(([, k]) => k);
}

/** rate plan for `targetSec` from the natural-speed durations of every chunk */
export function planSileroRates(naturalDurs: readonly (readonly number[])[], targetSec: number | undefined, gapSec: number = SILERO_CHUNK_GAP_SEC): SileroRatePlan {
  const natSec = sileroTotalSec(naturalDurs, 1, gapSec);
  const natural: SileroRatePlan = { speed: 1, rates: null, predictedSec: natSec };
  if (!targetSec || !(targetSec > 0) || !naturalDurs.length) return natural;
  if (Math.abs(natSec - targetSec) / targetSec <= SILERO_FIT_TOLERANCE) return natural;
  const uniform = (r: number): SileroRatePlan => ({
    speed: r,
    rates: naturalDurs.map((d) => new Float32Array(d.length).fill(r)),
    predictedSec: sileroTotalSec(naturalDurs, r, gapSec),
  });
  const gaps = Math.max(0, naturalDurs.length - 1) * gapSec;
  const frameTarget = Math.round(((targetSec - gaps) * SILERO_SAMPLE_RATE) / SILERO_HOP_24K);
  const frames = (r: number): number => naturalDurs.reduce((a, d) => a + sileroFramesAt(d, r), 0);
  const hiCap = f32(SILERO_SPEED_MAX);
  const loCap = f32(SILERO_SPEED_MIN);
  if (frames(hiCap) >= frameTarget) return uniform(hiCap);
  if (frames(loCap) <= frameTarget) return uniform(loCap);
  // bisection over float32 rates: frames(lo) > target >= frames(hi), until lo / hi are adjacent float32 values
  let lo = loCap;
  let hi = hiCap;
  for (let it = 0; it < 80; it++) {
    const mid = f32((lo + hi) / 2);
    if (mid === lo || mid === hi) break;
    if (frames(mid) > frameTarget) lo = mid;
    else hi = mid;
  }
  let have = frames(hi);
  const rates = naturalDurs.map((d) => new Float32Array(d.length).fill(hi));
  // symbols that gain frames at the slower rate lo, visited in an evenly spread order
  const flips: [number, number, number][] = [];
  naturalDurs.forEach((d, c) =>
    d.forEach((n, i) => {
      const gain = symFrames(n, i, d.length, lo) - symFrames(n, i, d.length, hi);
      if (gain > 0) flips.push([c, i, gain]);
    }),
  );
  for (const k of spreadOrder(flips.length)) {
    const [c, i, gain] = flips[k]!;
    if (have + gain > frameTarget) continue;
    rates[c]![i] = lo;
    have += gain;
    if (have === frameTarget) break;
  }
  let samples = 0;
  naturalDurs.forEach((d, c) => {
    let f = 0;
    for (let i = 0; i < d.length; i++) f += symFrames(d[i]!, i, d.length, rates[c]![i]!);
    samples += sileroSamples24k(f);
  });
  return { speed: hi, rates, predictedSec: samples / SILERO_SAMPLE_RATE + gaps };
}
