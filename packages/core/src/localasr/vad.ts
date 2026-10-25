/**
 * Voice activity detection for 16 kHz mono chunks (pure, node-testable, ~1 ms per 8 s chunk). 20 ms frames:
 * log-energy against an adaptive noise floor (20th percentile), plus a syllabic-modulation check (std of the frame
 * level over 0.5 s windows: speech swings 4+ dB at 2-8 Hz, a steady music / game bed does not) that is required
 * when the stream has a loud background. Hangover 150 ms, minimum burst 120 ms, gaps < 0.25 s merged.
 */

export const VAD_FRAME_SEC = 0.02;
const ABS_FLOOR_DB = -58;
/** speech must rise this far above the noise floor (dB) for the clip to have structure */
const MIN_DYNAMIC_DB = 8;
const HANGOVER_SEC = 0.15;
const MIN_BURST_SEC = 0.12;
const MERGE_GAP_SEC = 0.25;
/** window of the modulation measure (frames) = 0.5 s */
const MOD_WIN = 25;
/** std (dB) of the level inside a window that counts as syllabic modulation */
const MOD_MIN_STD_DB = 3;
/** background considered loud (needs modulation proof) when the noise floor is above this dBFS */
const LOUD_BED_DB = -42;

export interface SpeechBurst {
  /** seconds from the chunk start */
  start: number;
  end: number;
  /** 0..1: how far above the threshold and how modulated */
  confidence: number;
}

export interface VadResult {
  bursts: SpeechBurst[];
  /** summed burst length, s */
  speechSec: number;
  /** adaptive noise floor, dBFS */
  noiseFloorDb: number;
  /** the clip had no speech/silence contrast (speech throughout, or a constant bed) */
  flat: boolean;
}

/** 20 ms frame levels (dBFS) */
function levels(pcm: Int16Array | Float32Array, rate: number): Float64Array {
  const n = Math.max(1, Math.round(rate * VAD_FRAME_SEC));
  const frames = Math.floor(pcm.length / n);
  const out = new Float64Array(frames);
  const scale = pcm instanceof Int16Array ? 1 / 32768 : 1;
  for (let f = 0; f < frames; f++) {
    let s = 0;
    for (let k = f * n, e = k + n; k < e; k++) {
      const v = pcm[k]! * scale;
      s += v * v;
    }
    out[f] = 10 * Math.log10(s / n + 1e-12);
  }
  return out;
}

function pct(sorted: Float64Array, p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))]!;
}

/** std (dB) of the level over a centred 0.5 s window, per frame (running sums, O(n)) */
function modulation(db: Float64Array): Float64Array {
  const n = db.length;
  const out = new Float64Array(n);
  const ps = new Float64Array(n + 1);
  const ps2 = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    ps[i + 1] = ps[i]! + db[i]!;
    ps2[i + 1] = ps2[i]! + db[i]! * db[i]!;
  }
  const h = MOD_WIN >> 1;
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - h);
    const b = Math.min(n, i + h + 1);
    const m = b - a;
    const mean = (ps[b]! - ps[a]!) / m;
    out[i] = Math.sqrt(Math.max(0, (ps2[b]! - ps2[a]!) / m - mean * mean));
  }
  return out;
}

/** speech bursts of a 16 kHz mono clip (seconds from its start) */
export function vadBursts(pcm: Int16Array | Float32Array, sampleRate = 16000): VadResult {
  const db = levels(pcm, sampleRate);
  const n = db.length;
  if (n < 5) return { bursts: [], speechSec: 0, noiseFloorDb: -120, flat: false };
  const sorted = Float64Array.from(db).sort();
  const noise = pct(sorted, 0.2);
  const peak = pct(sorted, 0.95);
  if (peak < ABS_FLOOR_DB) return { bursts: [], speechSec: 0, noiseFloorDb: noise, flat: false };
  const mod = modulation(db);
  const needMod = noise > LOUD_BED_DB;
  const dur = n * VAD_FRAME_SEC;
  const flat = peak - noise < MIN_DYNAMIC_DB;
  if (flat) {
    // no contrast: speech throughout only if the level is modulated like syllables; a steady bed is not speech
    const sMod = Float64Array.from(mod).sort();
    if (pct(sMod, 0.5) < MOD_MIN_STD_DB) return { bursts: [], speechSec: 0, noiseFloorDb: noise, flat: true };
    return { bursts: [{ start: 0, end: dur, confidence: 0.4 }], speechSec: dur, noiseFloorDb: noise, flat: true };
  }
  const thr = Math.max(ABS_FLOOR_DB, noise + Math.max(6, 0.35 * (peak - noise)));
  const hang = Math.round(HANGOVER_SEC / VAD_FRAME_SEC);
  const minLen = Math.round(MIN_BURST_SEC / VAD_FRAME_SEC);
  const mergeGap = Math.round(MERGE_GAP_SEC / VAD_FRAME_SEC);
  // [from, to, sumConf, voicedFrames] in frames
  const raw: Array<[number, number, number, number]> = [];
  let from = -1;
  let lastVoiced = -1;
  let conf = 0;
  let cnt = 0;
  const close = (): void => {
    if (from >= 0 && cnt >= minLen) raw.push([from, Math.min(n, lastVoiced + 1 + hang), conf, cnt]);
    from = -1;
    conf = 0;
    cnt = 0;
  };
  for (let i = 0; i < n; i++) {
    const voiced = db[i]! > thr && (!needMod || mod[i]! >= MOD_MIN_STD_DB);
    if (voiced) {
      if (from < 0) from = i;
      lastVoiced = i;
      cnt++;
      conf += Math.min(1, (db[i]! - thr) / Math.max(6, peak - thr)) * 0.7 + Math.min(1, mod[i]! / 6) * 0.3;
    } else if (from >= 0 && i - lastVoiced > hang) {
      close();
    }
  }
  close();
  const merged: Array<[number, number, number, number]> = [];
  for (const r of raw) {
    const last = merged[merged.length - 1];
    if (last && r[0] - last[1] < mergeGap) {
      last[1] = r[1];
      last[2] += r[2];
      last[3] += r[3];
    } else merged.push([...r]);
  }
  const bursts: SpeechBurst[] = merged.map(([a, b, c, k]) => ({
    start: a * VAD_FRAME_SEC,
    end: Math.min(dur, b * VAD_FRAME_SEC),
    confidence: Math.round(Math.min(1, c / k) * 100) / 100,
  }));
  return { bursts, speechSec: bursts.reduce((s, b) => s + (b.end - b.start), 0), noiseFloorDb: noise, flat: false };
}
