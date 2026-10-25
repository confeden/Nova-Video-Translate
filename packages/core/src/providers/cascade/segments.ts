/** Pure helpers shared by the Groq / local tiers: ASR phrases -> dubbing sentences, budgets, language names. */
import { CHARS_PER_SEC, MIN_SEGMENT_SEC } from '../gemini/translate';

/** A piece of source speech on the VIDEO timeline (seconds). */
export interface SourceSegment {
  start: number;
  end: number;
  text: string;
  /** confirmed class of the original speaker, set by the cascade after ASR (see audio/speakerGender) */
  gender?: 'm' | 'f';
}

const SENTENCE_END = /[.!?…。！？]["')\]»”]*$/;
/** pause between two phrases (s) that always starts a new sentence */
export const SENTENCE_PAUSE_SEC = 0.5;
/** hard cap of words in one dubbing sentence */
export const MAX_SENTENCE_WORDS = 20;

export const wordCount = (t: string): number => t.trim().split(/\s+/).filter(Boolean).length;

/**
 * ASR phrases (Whisper segments are phrase-level, often mid-sentence) -> sentence-level slots: phrases are joined until
 * the text ends a sentence and the slot is at least MIN_SEGMENT_SEC long, a pause > SENTENCE_PAUSE_SEC follows, or the cap
 * of words is hit; a short tail is merged into its neighbour (very short slots overshoot when spoken, D10).
 */
export function groupPhrases(phrases: readonly SourceSegment[], minSec = MIN_SEGMENT_SEC): SourceSegment[] {
  const clean = phrases
    .map((p) => ({ start: p.start, end: Math.max(p.end, p.start), text: p.text.replace(/\s+/g, ' ').trim() }))
    .filter((p) => p.text && Number.isFinite(p.start) && Number.isFinite(p.end))
    .sort((a, b) => a.start - b.start);
  const out: SourceSegment[] = [];
  let cur: SourceSegment | undefined;
  const flush = (): void => {
    if (cur) out.push(cur);
    cur = undefined;
  };
  for (const p of clean) {
    if (cur && p.start - cur.end > SENTENCE_PAUSE_SEC && cur.end - cur.start >= minSec * 0.5) flush();
    cur = cur ? { start: cur.start, end: Math.max(cur.end, p.end), text: `${cur.text} ${p.text}` } : { ...p };
    if ((SENTENCE_END.test(cur.text) && cur.end - cur.start >= minSec) || wordCount(cur.text) >= MAX_SENTENCE_WORDS) flush();
  }
  flush();
  // merge a short tail into the previous slot
  if (out.length >= 2) {
    const last = out[out.length - 1]!;
    if (last.end - last.start < minSec) {
      const prev = out[out.length - 2]!;
      out.splice(out.length - 2, 2, { start: prev.start, end: Math.max(prev.end, last.end), text: `${prev.text} ${last.text}` });
    }
  }
  return out;
}

/** Russian character budget of a slot (D10, same law as the Gemini prompt) */
export function budgetFor(sec: number): number {
  return Math.max(8, Math.round(sec * CHARS_PER_SEC));
}

const LANG_NAMES: Record<string, string> = {
  english: 'en', russian: 'ru', spanish: 'es', german: 'de', french: 'fr', italian: 'it', portuguese: 'pt', japanese: 'ja',
  korean: 'ko', chinese: 'zh', ukrainian: 'uk', polish: 'pl', turkish: 'tr', dutch: 'nl', arabic: 'ar', hindi: 'hi',
  czech: 'cs', swedish: 'sv', finnish: 'fi', greek: 'el', hebrew: 'he', hungarian: 'hu', indonesian: 'id', vietnamese: 'vi',
  thai: 'th', romanian: 'ro', bulgarian: 'bg', belarusian: 'be', kazakh: 'kk',
};

/** 'english' | 'en' | 'en-US' -> 'en'; unknown -> ''. */
export function isoLang(v: unknown): string {
  if (typeof v !== 'string') return '';
  const s = v.trim().toLowerCase();
  if (/^[a-z]{2,3}(-[a-z0-9]+)?$/.test(s)) return s.split('-')[0]!;
  return LANG_NAMES[s] ?? '';
}

// ---------- sequential layout (owner: local speech must not be cut or squeezed: shift it instead) ----------
export interface LayoutInput {
  /** source slot on the video timeline */
  start: number;
  end: number;
  /** length of the synthesized speech at rate 1 */
  sec: number;
}
export interface LayoutPlacement {
  start: number;
  end: number;
  rate: number;
  /** start - source start (s): how far behind the source this segment begins */
  drift: number;
}
export interface LayoutOptions {
  /** silence between two consecutive segments (default 0.15) */
  gap?: number;
  /** tolerated end delay vs the source end before speeding up (default 4) */
  maxDrift?: number;
  /** speed-up ceiling used against drift (default 1.3) */
  maxRate?: number;
  /** end of the previous chunk's last segment, when known */
  prevEnd?: number;
}

/**
 * Segments in order; each starts at max(its source start, previous end + gap). A gap in the captions larger than the
 * accumulated delay re-syncs to the source automatically (max). Speech is played whole at rate 1; only when a segment would end
 * more than `maxDrift` behind its source end is it sped up (<= maxRate). Nothing is trimmed or dropped.
 */
export function layoutSequential(items: readonly LayoutInput[], o: LayoutOptions = {}): LayoutPlacement[] {
  const gap = o.gap ?? 0.15;
  const maxDrift = o.maxDrift ?? 4;
  const maxRate = o.maxRate ?? 1.3;
  let prevEnd = o.prevEnd ?? Number.NEGATIVE_INFINITY;
  return items.map((it) => {
    const start = Math.max(it.start, prevEnd + gap);
    let rate = 1;
    const allowedEnd = it.end + maxDrift;
    if (start + it.sec > allowedEnd) {
      const room = Math.max(allowedEnd - start, 0.1);
      rate = Math.min(maxRate, Math.max(1, it.sec / room));
    }
    const end = start + it.sec / rate;
    prevEnd = end;
    return { start, end, rate, drift: start - it.start };
  });
}
