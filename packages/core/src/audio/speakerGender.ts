/**
 * Source-speaker gender from the ORIGINAL audio (owner v0.2.43: a post-synthesis pitch check cannot tell what the ear hears,
 * so the TTS voice is chosen by who SPEAKS). Per sentence: median f0 of the voiced 40 ms frames (hop 10 ms, 8 kHz
 * autocorrelation, 70-400 Hz) inside the sentence span -> 'male' (< 155 Hz) | 'female_or_child' (> 185 Hz) | 'unknown', plus a
 * second cue: the spectral tilt (energy 1-3 kHz vs 0.1-1 kHz, dB). A high pitch with a DARK spectrum is not trusted as female
 * (a man with a high voice), a bright one is. SpeakerTracker keeps a session state with hysteresis and starts as 'male' (the
 * safe default: the owner heard a childlike voice for borderline pitch, v0.2.45). Pure, no I/O.
 */

export type SourceGender = 'male' | 'female_or_child' | 'unknown';
/** confirmed speaker class of the session */
export type SpeakerClass = 'male' | 'female_or_child';

export const MALE_MAX_HZ = 155;
export const FEMALE_MIN_HZ = 185;
/** less voiced audio than this => 'unknown' (no vote) */
export const MIN_SPAN_VOICED_SEC = 1.0;
/** one phrase switches the state alone only with this much voiced audio ... */
export const STRONG_VOICED_SEC = 2.5;
/** ... and this far (Hz) beyond the decision threshold of its class */
export const STRONG_MARGIN_HZ = 40;
/** a switch also needs the voiced-weighted median f0 of the last this many seconds of the stream to agree */
export const MEDIAN_WINDOW_SEC = 8;
/** between FEMALE_MIN_HZ and this the spectral tilt decides; a higher f0 is female (child) whatever the tilt */
export const FEMALE_CLEAR_HZ = 235;
/** tilt (dB, 1-3 kHz over 0.1-1 kHz) below this = dark spectrum: a high-pitched man, not a woman. Not calibrated on real voices (unverified) */
export const TILT_DARK_DB = -13;

const FRAME_SEC = 0.04;
const HOP_SEC = 0.01;
const TARGET_RATE = 8000;
const MIN_HZ = 70;
const MAX_HZ = 400;
const VOICED_PEAK = 0.5;
/** a run of >= TONE_RUN voiced frames whose f0 moves < TONE_REL and peak > TONE_PEAK is a steady tone (music), not speech */
const TONE_RUN = 50;
const TONE_REL = 0.0025;
const TONE_PEAK = 0.95;

export interface SpanPitch {
  /** median f0 of the voiced frames, Hz (0 = none) */
  f0: number;
  voicedSec: number;
  /** spectral tilt of the voiced frames, dB (1-3 kHz energy over 0.1-1 kHz energy); absent when nothing voiced */
  tilt?: number;
}

type Biquad = readonly [number, number, number, number, number];

/** RBJ 2nd-order Butterworth low / high pass */
function biquad(kind: 'lp' | 'hp', fc: number, rate: number): Biquad {
  const w = (2 * Math.PI * fc) / rate;
  const cs = Math.cos(w);
  const al = Math.sin(w) / (2 * Math.SQRT1_2);
  const a0 = 1 + al;
  const b = kind === 'lp' ? [(1 - cs) / 2, 1 - cs, (1 - cs) / 2] : [(1 + cs) / 2, -(1 + cs), (1 + cs) / 2];
  return [b[0]! / a0, b[1]! / a0, b[2]! / a0, (-2 * cs) / a0, (1 - al) / a0];
}

function filt(x: Float32Array, [b0, b1, b2, a1, a2]: Biquad): Float32Array {
  const y = new Float32Array(x.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i]!;
    const o = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = v;
    y2 = y1;
    y1 = o;
    y[i] = o;
  }
  return y;
}

function prefixSq(x: Float32Array): Float64Array {
  const p = new Float64Array(x.length + 1);
  for (let i = 0; i < x.length; i++) p[i + 1] = p[i]! + x[i]! * x[i]!;
  return p;
}

/**
 * Spectral tilt (dB) of the frames starting at `starts` (each `frame` samples long) in x (rate Hz): 10 log10 of the energy in
 * 1-3 kHz over the energy in 0.1-1 kHz. High for a bright voice (women, children), low for a dark one. Pure.
 */
export function bandTilt(x: Float32Array, rate: number, starts: readonly number[], frame: number): number | undefined {
  if (starts.length === 0 || rate < 7000) return undefined;
  const lo = prefixSq(filt(filt(x, biquad('hp', 100, rate)), biquad('lp', 1000, rate)));
  const hi = prefixSq(filt(filt(x, biquad('hp', 1000, rate)), biquad('lp', 3000, rate)));
  let el = 0;
  let eh = 0;
  for (const s of starts) {
    el += lo[s + frame]! - lo[s]!;
    eh += hi[s + frame]! - hi[s]!;
  }
  if (!(el > 0) || !(eh >= 0)) return undefined;
  return Math.round(10 * Math.log10((eh + 1e-9 * el) / el) * 10) / 10;
}

/** tilt of a whole signal (frames above a quarter of the loudest frame energy); callers without a pitch track, tests */
export function spectralTilt(pcm: Int16Array, sampleRate: number): number | undefined {
  const { x, rate } = prepare(pcm, sampleRate);
  const frame = Math.round(FRAME_SEC * rate);
  const hop = Math.max(1, Math.round(HOP_SEC * rate));
  const sq = prefixSq(x);
  let ref = 0;
  for (let s = 0; s + frame <= x.length; s += hop) ref = Math.max(ref, sq[s + frame]! - sq[s]!);
  const starts: number[] = [];
  for (let s = 0; s + frame <= x.length; s += hop) if (sq[s + frame]! - sq[s]! > 0.25 * ref) starts.push(s);
  return bandTilt(x, rate, starts, frame);
}

/** box-filter decimation to ~8 kHz, plus DC blocking (cheap high-pass, removes rumble) */
function prepare(pcm: Int16Array, rate: number): { x: Float32Array; rate: number } {
  const f = Math.max(1, Math.floor(rate / TARGET_RATE));
  const n = Math.floor(pcm.length / f);
  const x = new Float32Array(n);
  let px = 0;
  let py = 0;
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < f; j++) s += pcm[i * f + j]!;
    const v = s / f;
    py = v - px + 0.995 * py;
    px = v;
    x[i] = py;
  }
  return { x, rate: rate / f };
}

/**
 * Median f0 of the voiced frames inside `ranges` (seconds on the pcm timeline; default all). ~3-5 ms per second of speech:
 * quiet frames are skipped before any autocorrelation, 8 kHz, frame energies come from a prefix sum.
 */
export function spanPitch(pcm: Int16Array, sampleRate: number, ranges?: readonly (readonly [number, number])[]): SpanPitch {
  const { x, rate } = prepare(pcm, sampleRate);
  const frame = Math.round(FRAME_SEC * rate);
  const hop = Math.max(1, Math.round(HOP_SEC * rate));
  const minLag = Math.max(2, Math.floor(rate / MAX_HZ));
  const maxLag = Math.min(frame - 2, Math.ceil(rate / MIN_HZ));
  const rs = ranges ?? [[0, x.length / rate] as const];
  const sq = new Float64Array(x.length + 1);
  for (let i = 0; i < x.length; i++) sq[i + 1] = sq[i]! + x[i]! * x[i]!;
  const energy = (a: number, n: number): number => sq[a + n]! - sq[a]!;

  const starts: number[] = [];
  for (const [a, b] of rs) {
    const lo = Math.max(0, Math.floor(a * rate));
    const hi = Math.min(x.length, Math.floor(b * rate));
    for (let s = lo; s + frame <= hi; s += hop) starts.push(s);
  }
  let ref = 0;
  for (const s of starts) ref = Math.max(ref, energy(s, frame));
  const refRms = Math.sqrt(ref / frame);
  if (starts.length === 0 || refRms < 20) return { f0: 0, voicedSec: 0 };
  const minE = (0.1 * refRms) ** 2 * frame;

  const r = new Float64Array(maxLag + 2);
  const f0s: number[] = [];
  const peaks: number[] = [];
  const at: number[] = [];
  for (const s of starts) {
    const e0 = energy(s, frame);
    if (e0 < minE) continue;
    let gmax = 0;
    for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
      if (s + frame + lag > x.length) {
        r[lag] = 0;
        continue;
      }
      let c = 0;
      for (let i = 0; i < frame; i++) c += x[s + i]! * x[s + i + lag]!;
      const e1 = energy(s + lag, frame);
      const v = e1 > 0 ? c / Math.sqrt(e0 * e1) : 0;
      r[lag] = v;
      if (lag >= minLag && lag <= maxLag && v > gmax) gmax = v;
    }
    if (gmax < VOICED_PEAK) continue;
    let best = -1;
    // smallest lag within 0.9 of the global peak: avoids octave-down errors
    for (let lag = minLag; lag <= maxLag; lag++) {
      const v = r[lag]!;
      if (v >= 0.9 * gmax && v >= r[lag - 1]! && v >= r[lag + 1]!) {
        best = lag;
        break;
      }
    }
    if (best < 0) continue;
    const y0 = r[best - 1]!;
    const y1 = r[best]!;
    const y2 = r[best + 1]!;
    const den = y0 - 2 * y1 + y2;
    const shift = den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / den)) : 0;
    f0s.push(rate / (best + shift));
    peaks.push(gmax);
    at.push(s);
  }
  if (f0s.length === 0) return { f0: 0, voicedSec: 0 };

  // steady tones (music): long runs of consecutive frames with an almost constant, very clean f0
  const keep = new Array<boolean>(f0s.length).fill(true);
  let runStart = 0;
  const closeRun = (end: number): void => {
    if (end - runStart >= TONE_RUN) for (let k = runStart; k < end; k++) keep[k] = false;
  };
  for (let k = 1; k <= f0s.length; k++) {
    const contiguous = k < f0s.length && at[k]! - at[k - 1]! <= hop * 1.5 && Math.abs(f0s[k]! - f0s[k - 1]!) / f0s[k - 1]! < TONE_REL && peaks[k]! > TONE_PEAK && peaks[k - 1]! > TONE_PEAK;
    if (!contiguous) {
      closeRun(k);
      runStart = k;
    }
  }
  let vals = f0s.filter((_, k) => keep[k]);
  if (vals.length === 0) return { f0: 0, voicedSec: 0 };
  const med = (a: number[]): number => {
    const s = [...a].sort((p, q) => p - q);
    const m = s.length >> 1;
    return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
  };
  // octave guard: frames at ~half / ~double the median are tracking errors
  const m0 = med(vals);
  const sane = vals.filter((v) => !(v / m0 < 0.6 || (v / m0 > 1.7 && v / m0 < 2.3)));
  if (sane.length >= vals.length / 2) vals = sane;
  const tilt = bandTilt(x, rate, at.filter((_, k) => keep[k]), frame);
  return { f0: med(vals), voicedSec: vals.length * HOP_SEC, ...(tilt !== undefined ? { tilt } : {}) };
}

/**
 * f0 (+ tilt) -> class. The 155-185 Hz band and less than MIN_SPAN_VOICED_SEC of voiced audio are 'unknown'. A pitch above the
 * band with a dark spectrum (tilt < TILT_DARK_DB) below FEMALE_CLEAR_HZ is 'unknown' too (a man with a high voice keeps the
 * male state); a bright one, or any pitch from FEMALE_CLEAR_HZ up, is 'female_or_child'.
 */
export function classifyGender(f0: number, voicedSec: number, tilt?: number): SourceGender {
  if (!(f0 > 0) || voicedSec < MIN_SPAN_VOICED_SEC) return 'unknown';
  if (f0 < MALE_MAX_HZ) return 'male';
  if (f0 > FEMALE_MIN_HZ) {
    if (tilt !== undefined && Number.isFinite(tilt) && f0 < FEMALE_CLEAR_HZ && tilt < TILT_DARK_DB) return 'unknown';
    return 'female_or_child';
  }
  return 'unknown';
}

/** f0 of an original sentence: its span (video seconds), cut to the speech bursts when they are known */
export function sentencePitch(
  pcm: Int16Array,
  sampleRate: number,
  chunkStartSec: number,
  span: { start: number; end: number },
  bursts?: readonly { start: number; end: number }[],
): SpanPitch {
  const a = span.start - chunkStartSec;
  const b = span.end - chunkStartSec;
  let ranges: [number, number][] = [[a, b]];
  if (bursts && bursts.length) {
    const cut: [number, number][] = [];
    for (const u of bursts) {
      const lo = Math.max(a, u.start - chunkStartSec);
      const hi = Math.min(b, u.end - chunkStartSec);
      if (hi > lo) cut.push([lo, hi]);
    }
    if (cut.length) ranges = cut;
  }
  return spanPitch(pcm, sampleRate, ranges);
}

export interface TrackerUpdate {
  gender: SourceGender;
  /** state after this phrase (the session starts as 'male') */
  state: SpeakerClass;
  changed: boolean;
}

interface HistEntry {
  at: number;
  f0: number;
  w: number;
}

/**
 * Session speaker state with hysteresis, starting as 'male' (the safe default before any confident phrase). A confident phrase
 * of the other class flips the state only when 2 consecutive confident phrases agree AND the voiced-weighted median f0 of the
 * last MEDIAN_WINDOW_SEC seconds agrees too; or at once for one phrase with >= STRONG_VOICED_SEC of voiced audio whose f0 is
 * >= STRONG_MARGIN_HZ beyond the decision threshold of its class. 'unknown' phrases inherit the state and neither confirm nor
 * break a pending change.
 */
export class SpeakerTracker {
  private cur: SpeakerClass = 'male';
  private pending: { g: SpeakerClass; n: number } | undefined;
  private hist: HistEntry[] = [];
  private clock = 0;

  get state(): SpeakerClass {
    return this.cur;
  }

  reset(): void {
    this.cur = 'male';
    this.pending = undefined;
    this.hist = [];
    this.clock = 0;
  }

  /** class of the voiced-weighted median f0 of the window; undefined inside the neutral band / without data */
  private windowClass(): SpeakerClass | undefined {
    if (this.hist.length === 0) return undefined;
    const s = [...this.hist].sort((a, b) => a.f0 - b.f0);
    const half = s.reduce((a, e) => a + e.w, 0) / 2;
    let acc = 0;
    let m = s[s.length - 1]!.f0;
    for (const e of s) {
      acc += e.w;
      if (acc >= half) {
        m = e.f0;
        break;
      }
    }
    return m < MALE_MAX_HZ ? 'male' : m > FEMALE_MIN_HZ ? 'female_or_child' : undefined;
  }

  /** `atSec` = media time of the phrase (monotonic seconds); absent = an internal clock advancing by the voiced time */
  update(f0: number, voicedSec: number, tilt?: number, atSec?: number): TrackerUpdate {
    const gender = classifyGender(f0, voicedSec, tilt);
    if (atSec !== undefined && Number.isFinite(atSec)) {
      if (atSec < this.clock - 1) this.hist = []; // the playhead jumped back
      this.clock = atSec;
    } else this.clock += Math.max(voicedSec, 1);
    if (f0 > 0 && voicedSec >= MIN_SPAN_VOICED_SEC) {
      this.hist.push({ at: this.clock, f0, w: voicedSec });
      this.hist = this.hist.filter((e) => e.at > this.clock - MEDIAN_WINDOW_SEC);
    }
    if (gender === 'unknown') return { gender, state: this.cur, changed: false };
    if (gender === this.cur) {
      this.pending = undefined;
      return { gender, state: this.cur, changed: false };
    }
    const margin = gender === 'male' ? MALE_MAX_HZ - f0 : f0 - FEMALE_MIN_HZ;
    const n = this.pending?.g === gender ? this.pending.n + 1 : 1;
    const strong = voicedSec >= STRONG_VOICED_SEC && margin >= STRONG_MARGIN_HZ;
    if (strong || (n >= 2 && this.windowClass() === gender)) {
      this.cur = gender;
      this.pending = undefined;
      return { gender, state: this.cur, changed: true };
    }
    this.pending = { g: gender, n };
    return { gender, state: this.cur, changed: false };
  }
}
