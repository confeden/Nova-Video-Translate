/**
 * Clock alignment between the HLS audio (PTS timeline) and the playing <video> (currentTime): cross-correlation of 20 Hz RMS
 * envelopes. Pure and node-testable. Convention: pts = videoTime + offsetSec, so videoTime = pts - offsetSec.
 */

export const ENV_RATE = 20;

/** Sparse RMS envelope, 1/ENV_RATE s bins, addressed by time in its own clock. */
export class Envelope {
  private readonly e = new Map<number, number>();
  private readonly n = new Map<number, number>();
  constructor(
    private readonly maxBins = ENV_RATE * 180,
    readonly rate = ENV_RATE,
  ) {}

  /** adds a block of samples whose first sample sits at time t0 (sub-blocks of ~10 ms go to their own bin) */
  add(samples: Float32Array, sampleRate: number, t0: number): void {
    const step = Math.max(1, Math.round(sampleRate / 100));
    for (let i = 0; i < samples.length; i += step) {
      const end = Math.min(samples.length, i + step);
      let s = 0;
      for (let k = i; k < end; k++) s += samples[k]! * samples[k]!;
      const bin = Math.floor((t0 + (i + (end - i) / 2) / sampleRate) * this.rate);
      this.e.set(bin, (this.e.get(bin) ?? 0) + s);
      this.n.set(bin, (this.n.get(bin) ?? 0) + (end - i));
    }
    this.prune();
  }

  private prune(): void {
    if (this.e.size <= this.maxBins * 1.2) return;
    const keys = [...this.e.keys()].sort((a, b) => a - b);
    for (const k of keys.slice(0, keys.length - this.maxBins)) {
      this.e.delete(k);
      this.n.delete(k);
    }
  }

  /** RMS at a bin, NaN when nothing was recorded there */
  at(bin: number): number {
    const n = this.n.get(bin);
    return n ? Math.sqrt(this.e.get(bin)! / n) : NaN;
  }
  get size(): number {
    return this.e.size;
  }
  /** bins recorded in [fromSec, toSec] */
  count(fromSec: number, toSec: number): number {
    const b0 = Math.floor(fromSec * this.rate);
    const b1 = Math.floor(toSec * this.rate);
    let c = 0;
    for (const k of this.e.keys()) if (k >= b0 && k <= b1) c++;
    return c;
  }
  /** [firstBin, lastBin] recorded, or undefined */
  span(): [number, number] | undefined {
    if (this.e.size === 0) return undefined;
    let lo = Infinity;
    let hi = -Infinity;
    for (const k of this.e.keys()) {
      if (k < lo) lo = k;
      if (k > hi) hi = k;
    }
    return [lo, hi];
  }
  clear(): void {
    this.e.clear();
    this.n.clear();
  }
  /** forgets every bin at or after time `sec` (the playhead jumped back there: the replayed audio is recorded afresh) */
  clearFrom(sec: number): void {
    const b0 = Math.floor(sec * this.rate);
    for (const k of [...this.e.keys()]) {
      if (k >= b0) {
        this.e.delete(k);
        this.n.delete(k);
      }
    }
  }
}

/** shortest clean video overlap (s) the incremental search starts with */
export const ALIGN_MIN_CLEAN_SEC = 5;
/** windows shorter than this (s) need the stricter acceptance */
export const ALIGN_SHORT_WINDOW_SEC = 12;
export const ALIGN_SHORT_PEAK = 0.6;
export const ALIGN_SHORT_RATIO = 2.0;
/** a near-perfect peak is accepted with the long-window ratio even on a short window (report 2026-10-25: peak .99, second .66, ratio 1.5 was rejected for 25 s) */
export const ALIGN_STRONG_PEAK = 0.9;
export const ALIGN_STRONG_RATIO = 1.4;
/** the second-best candidate is searched outside +-this around the main peak (and outside the peak's own lobe, see correlateEnvelopes) */
export const ALIGN_SIDELOBE_SEC = 1.5;

/**
 * Acceptance thresholds by the length of the clean video window: 5-12 s => peak >= 0.6 and ratio >= 2.0 (strict absolute
 * path disabled), >= 12 s => the long-window rules (strict 0.55/+0.15, or relaxed peak 0.4 and ratio 1.4).
 */
export function alignAcceptance(windowSec: number): Pick<AlignOptions, 'minPeak' | 'minMargin' | 'relaxedPeak' | 'minRatio' | 'strongPeak' | 'strongRatio'> {
  const strong = { strongPeak: ALIGN_STRONG_PEAK, strongRatio: ALIGN_STRONG_RATIO };
  if (windowSec < ALIGN_SHORT_WINDOW_SEC) return { minPeak: 2, relaxedPeak: ALIGN_SHORT_PEAK, minRatio: ALIGN_SHORT_RATIO, ...strong };
  return { relaxedPeak: 0.4, minRatio: 1.4, ...strong };
}

export interface AlignResult {
  ok: boolean;
  offsetSec: number;
  /** Pearson correlation at the best offset */
  peak: number;
  /** best correlation outside the main peak's lobe and +-1.5 s of it (a clear match stands well above it) */
  second: number;
  overlapBins: number;
  /** peak / second (second floored at 0.01) */
  ratio: number;
}

export interface AlignOptions {
  /** video-time window to match [fromSec, toSec] */
  fromSec: number;
  toSec: number;
  /** centre and half-width of the offset search (pts - videoTime), seconds */
  centerSec: number;
  rangeSec: number;
  minPeak?: number;
  minMargin?: number;
  /**
   * relaxed acceptance for noisy (music-heavy) streams: a peak >= relaxedPeak that stands out of the second-best by at
   * least minRatio (peak / second) is accepted even when the absolute margin is too small
   */
  relaxedPeak?: number;
  minRatio?: number;
  /** a peak >= strongPeak is accepted when peak / second >= strongRatio (independent of the window-length rules) */
  strongPeak?: number;
  strongRatio?: number;
  /** smallest number of video bins (in seconds) the window must hold; default 6 */
  minOverlapSec?: number;
}

/** Correlates video envelope bins in [from,to] against the hls envelope shifted by candidate offsets (sqrt-compressed RMS). */
export function correlateEnvelopes(video: Envelope, hls: Envelope, o: AlignOptions): AlignResult {
  const r = video.rate;
  const b0 = Math.floor(o.fromSec * r);
  const b1 = Math.floor(o.toSec * r);
  const vi: number[] = [];
  const vv: number[] = [];
  for (let b = b0; b <= b1; b++) {
    const x = video.at(b);
    if (!Number.isNaN(x)) {
      vi.push(b);
      vv.push(Math.sqrt(x));
    }
  }
  const fail: AlignResult = { ok: false, offsetSec: o.centerSec, peak: 0, second: 0, overlapBins: vi.length, ratio: 0 };
  const minBins = r * (o.minOverlapSec ?? 6);
  if (vi.length < minBins) return fail;
  const vMean = vv.reduce((a, b) => a + b, 0) / vv.length;
  let vVar = 0;
  for (const x of vv) vVar += (x - vMean) ** 2;
  if (vVar < 1e-6) return fail; // flat (silence)

  const candidates: Array<{ off: number; c: number }> = [];
  const lo = Math.round((o.centerSec - o.rangeSec) * r);
  const hi = Math.round((o.centerSec + o.rangeSec) * r);
  for (let d = lo; d <= hi; d++) {
    // video bin b <-> hls bin b + d
    let n = 0;
    let sh = 0;
    let shh = 0;
    let shv = 0;
    let sv = 0;
    let svv = 0;
    for (let k = 0; k < vi.length; k++) {
      const h = hls.at(vi[k]! + d);
      if (Number.isNaN(h)) continue;
      const hs = Math.sqrt(h);
      const v = vv[k]!;
      n++;
      sh += hs;
      shh += hs * hs;
      shv += hs * v;
      sv += v;
      svv += v * v;
    }
    if (n < vi.length * 0.8 || n < minBins) continue;
    const cov = shv - (sh * sv) / n;
    const vh = shh - (sh * sh) / n;
    const vvv = svv - (sv * sv) / n;
    if (vh < 1e-9 || vvv < 1e-9) continue;
    candidates.push({ off: d / r, c: cov / Math.sqrt(vh * vvv) });
  }
  if (candidates.length === 0) return fail;
  let best = candidates[0]!;
  for (const c of candidates) if (c.c > best.c) best = c;
  // The runner-up must be an INDEPENDENT candidate: the main peak's own lobe (speech envelopes autocorrelate, the correlation decays
  // slowly on both sides) and +-ALIGN_SIDELOBE_SEC around it are excluded, otherwise the ratio measures the lobe's width, not ambiguity.
  const bi = candidates.indexOf(best);
  let loEnd = bi;
  while (loEnd > 0 && candidates[loEnd - 1]!.c <= candidates[loEnd]!.c + 0.005) loEnd--;
  let hiEnd = bi;
  while (hiEnd < candidates.length - 1 && candidates[hiEnd + 1]!.c <= candidates[hiEnd]!.c + 0.005) hiEnd++;
  const exLo = Math.min(best.off - ALIGN_SIDELOBE_SEC, candidates[loEnd]!.off);
  const exHi = Math.max(best.off + ALIGN_SIDELOBE_SEC, candidates[hiEnd]!.off);
  let second = -1;
  for (const c of candidates) if ((c.off < exLo || c.off > exHi) && c.c > second) second = c.c;
  const minPeak = o.minPeak ?? 0.55;
  const minMargin = o.minMargin ?? 0.15;
  const sec = Math.max(0, second);
  const ratio = best.c / Math.max(sec, 0.01);
  const strict = best.c >= minPeak && best.c - sec >= minMargin;
  const relaxed = o.relaxedPeak !== undefined && o.minRatio !== undefined && best.c >= o.relaxedPeak && ratio >= o.minRatio;
  const strong = o.strongPeak !== undefined && o.strongRatio !== undefined && best.c >= o.strongPeak && ratio >= o.strongRatio;
  return { ok: strict || relaxed || strong, offsetSec: best.off, peak: best.c, second: sec, overlapBins: vi.length, ratio };
}
