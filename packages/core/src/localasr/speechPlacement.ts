/**
 * Where inside a chunk the speech really is. Whisper without timestamps (return_timestamps:false) gives only text, so the
 * sentences used to be spread over the WHOLE chunk in proportion to their length: a chunk that starts with 3 s of music /
 * silence put the first sentence 3 s before the speaker said it => the dub led the original. This module measures the
 * speech span (first onset .. last offset) and the silence valleys from the PCM energy and places the sentences inside it.
 * Pure and node-testable.
 */

export const FRAME_SEC = 0.02;
/** a pause at least this long between two voiced stretches is a valley (a candidate sentence boundary) */
const VALLEY_MIN_SEC = 0.25;
/** voiced stretches closer than this are one stretch (inter-word gaps) */
const BRIDGE_SEC = 0.2;
/** voiced stretches shorter than this are clicks / noise, not speech */
const MIN_VOICED_SEC = 0.12;
/** below this level (dBFS, RMS of a 20 ms frame) nothing counts as speech */
const ABS_FLOOR_DB = -58;
/** speech must stand out of the noise floor by at least this (dB), else the clip has no usable structure */
const MIN_DYNAMIC_DB = 8;
/** interior sentence boundaries snap to a valley within this distance */
export const SNAP_SEC = 0.6;

export interface SpeechAnalysis {
  /** first voiced instant, seconds from the clip start */
  onset: number;
  /** end of the last voiced stretch */
  offset: number;
  /** silent gaps strictly inside [onset, offset] (>= 0.25 s), start/end in clip seconds */
  valleys: Array<{ start: number; end: number }>;
  /** the energy had a speech/silence structure (false = flat: constant sound or nothing measurable; onset 0, offset = duration) */
  structured: boolean;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return -120;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[i]!;
}

/** 20 ms RMS frames in dBFS */
export function frameLevelsDb(pcm: Int16Array | Float32Array, sampleRate: number): number[] {
  const n = Math.max(1, Math.round(sampleRate * FRAME_SEC));
  const scale = pcm instanceof Int16Array ? 1 / 32768 : 1;
  const out: number[] = [];
  for (let i = 0; i + n <= pcm.length; i += n) {
    let s = 0;
    for (let k = i; k < i + n; k++) {
      const v = pcm[k]! * scale;
      s += v * v;
    }
    out.push(20 * Math.log10(Math.sqrt(s / n) + 1e-6));
  }
  return out;
}

/**
 * Speech span and valleys of a clip, or undefined when there is no audible speech at all (silence). A clip without a
 * speech/silence contrast (speech throughout, or a constant bed) returns the whole clip with `structured: false`.
 */
export function analyzeSpeech(pcm: Int16Array | Float32Array, sampleRate = 16000): SpeechAnalysis | undefined {
  const db = frameLevelsDb(pcm, sampleRate);
  const dur = pcm.length / sampleRate;
  if (db.length < 5) return undefined;
  const sorted = [...db].sort((a, b) => a - b);
  const noise = percentile(sorted, 0.1);
  const peak = percentile(sorted, 0.95);
  if (peak < ABS_FLOOR_DB) return undefined;
  if (peak - noise < MIN_DYNAMIC_DB) return { onset: 0, offset: dur, valleys: [], structured: false };
  const thr = Math.max(ABS_FLOOR_DB, noise + Math.max(6, 0.3 * (peak - noise)));

  // voiced runs (frame indices), gaps shorter than BRIDGE_SEC bridged
  const bridge = Math.round(BRIDGE_SEC / FRAME_SEC);
  const runs: Array<[number, number]> = [];
  for (let i = 0; i < db.length; i++) {
    if (db[i]! <= thr) continue;
    const last = runs[runs.length - 1];
    if (last && i - last[1] <= bridge) last[1] = i + 1;
    else runs.push([i, i + 1]);
  }
  const minLen = Math.round(MIN_VOICED_SEC / FRAME_SEC);
  const kept = runs.filter(([a, b]) => b - a >= minLen);
  if (kept.length === 0) return undefined;
  const valleys: Array<{ start: number; end: number }> = [];
  for (let k = 1; k < kept.length; k++) {
    const s = kept[k - 1]![1] * FRAME_SEC;
    const e = kept[k]![0] * FRAME_SEC;
    if (e - s >= VALLEY_MIN_SEC) valleys.push({ start: s, end: e });
  }
  return { onset: kept[0]![0] * FRAME_SEC, offset: Math.min(dur, kept[kept.length - 1]![1] * FRAME_SEC), valleys, structured: true };
}

export interface PlacedSentence {
  start: number;
  end: number;
  text: string;
}

/**
 * Places sentences (in order) on a clip of `durationSec`: the first starts at the speech onset, the last ends at the
 * speech offset, interior boundaries are proportional to the character counts inside [onset, offset] and snap to the
 * nearest silence valley within SNAP_SEC (the next sentence then starts where the valley ends). Without speech
 * information (analysis undefined) the whole clip is used, as before.
 */
export function placeSentences(texts: string[], durationSec: number, analysis: SpeechAnalysis | undefined): PlacedSentence[] {
  const parts = texts.map((t) => t.trim()).filter(Boolean);
  if (parts.length === 0) return [];
  const a = analysis ?? { onset: 0, offset: durationSec, valleys: [], structured: false };
  const onset = Math.max(0, Math.min(a.onset, durationSec));
  const offset = Math.max(onset, Math.min(a.offset, durationSec));
  const total = parts.reduce((n, p) => n + p.length, 0) || 1;
  const span = offset - onset;

  // boundary i sits between sentence i and i+1
  const starts: number[] = [onset];
  const ends: number[] = [];
  let cum = 0;
  let prevEnd = onset;
  for (let i = 0; i < parts.length - 1; i++) {
    cum += parts[i]!.length;
    const b = onset + (span * cum) / total;
    let bEnd = b;
    let bStart = b;
    let best = SNAP_SEC;
    for (const v of a.valleys) {
      const d = Math.abs((v.start + v.end) / 2 - b);
      if (d <= best && v.start >= prevEnd - 1e-9) {
        best = d;
        bEnd = v.start;
        bStart = v.end;
      }
    }
    bEnd = Math.max(prevEnd, Math.min(bEnd, offset));
    bStart = Math.max(bEnd, Math.min(bStart, offset));
    ends.push(bEnd);
    starts.push(bStart);
    prevEnd = bStart;
  }
  ends.push(offset);
  return parts.map((text, i) => ({ start: starts[i]!, end: Math.max(starts[i]!, ends[i]!), text }));
}

/** earliest sensible start (clip seconds) for any dub of this clip: the speech onset (0 when unknown / unstructured) */
export function speechOnsetSec(pcm: Int16Array | Float32Array, sampleRate = 16000): number {
  const a = analyzeSpeech(pcm, sampleRate);
  return a && a.structured ? a.onset : 0;
}
