/**
 * Anchors sentences (text only) to REAL speech bursts of the chunk (see vad.ts): every sentence consumes speech DURATION
 * (expected words * 0.35 s as the prior, normalised to the speech actually present), walking through the bursts, so a
 * sentence starts where its share of the speech begins - not where its share of the whole chunk (silence included) begins.
 * Pure. The dub lag (dubLagSec) is added once, in the scheduler (DubScheduler.lag), never here.
 */
import type { SpeechBurst } from './vad';

const WORD_SEC = 0.35;
/** a sentence whose start is this close (speech seconds) to a burst boundary starts at that burst's onset */
const SNAP_SEC = 0.4;

export interface AnchoredSentence {
  start: number;
  end: number;
  text: string;
}

export interface AnchorOptions {
  /** seconds at the clip start that are only overlap context: bursts there are excluded */
  contextSec?: number;
}

const wordsOf = (t: string): number => t.trim().split(/\s+/).filter(Boolean).length;

/**
 * Returns [] when there is no sentence or no speech burst after the context (caller: 'chunk-no-speech').
 * Result is monotonic: start_i <= end_i <= start_{i+1}, all inside [0, durationSec].
 */
export function anchorSentences(texts: string[], bursts: readonly SpeechBurst[], durationSec: number, o: AnchorOptions = {}): AnchoredSentence[] {
  const parts = texts.map((t) => t.trim()).filter(Boolean);
  const ctx = Math.max(0, o.contextSec ?? 0);
  const bs: Array<{ a: number; b: number; cum: number }> = [];
  let T = 0;
  for (const x of bursts) {
    const a = Math.max(x.start, ctx);
    const b = Math.min(x.end, durationSec);
    if (b - a < 0.05) continue;
    bs.push({ a, b, cum: T });
    T += b - a;
  }
  if (parts.length === 0 || bs.length === 0) return [];
  // speech-time -> clip time; `endSide` maps a boundary shared by two bursts to the end of the earlier one
  const toClip = (s: number, endSide: boolean): number => {
    for (let k = 0; k < bs.length; k++) {
      const x = bs[k]!;
      const len = x.b - x.a;
      if (s < x.cum + len - 1e-9 || (endSide && s <= x.cum + len + 1e-9) || k === bs.length - 1) return x.a + Math.max(0, Math.min(len, s - x.cum));
    }
    return bs[bs.length - 1]!.b;
  };
  const w = parts.map((p) => Math.max(1, wordsOf(p)) * WORD_SEC);
  const wSum = w.reduce((a, b) => a + b, 0);
  const lastEnd = bs[bs.length - 1]!.b;
  const out: AnchoredSentence[] = [];
  let cum = 0;
  let prevStart = 0;
  for (let i = 0; i < parts.length; i++) {
    const share = (w[i]! / wSum) * T;
    let sStart = cum;
    for (const x of bs) {
      if (Math.abs(sStart - x.cum) <= SNAP_SEC) {
        sStart = x.cum;
        break;
      }
    }
    const start = Math.max(toClip(sStart, false), prevStart);
    const end = Math.max(start, Math.min(toClip(Math.max(sStart, cum + share), true), lastEnd));
    out.push({ start, end, text: parts[i]! });
    prevStart = start;
    cum += share;
  }
  for (let i = 0; i < out.length - 1; i++) out[i]!.end = Math.max(out[i]!.start, Math.min(out[i]!.end, out[i + 1]!.start));
  return out;
}
