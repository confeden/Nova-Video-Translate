import { isNonSpeech } from '../lang/speechText';
import type { SubtitleCue } from '../providers/types';

/** A phrase stops growing after one of these at its end (sentence end). */
const SENTENCE_END = /[.!?…]["')\]]?$/;

export interface PhraseOptions {
  /** longest phrase on screen (s) */
  maxSec?: number;
  /** longest pause between two cues that still belong to one phrase (s) */
  maxGapSec?: number;
  /** most words in one phrase */
  maxWords?: number;
}

const normWord = (w: string): string => w.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/**
 * Drops from `text` what the recent output already says: a head that repeats the tail of `hist` (overlapping or rolling cues),
 * or the whole text when it already sits inside that tail (the same cue twice, from two sources or two fetches).
 * `hist` holds normalized words of everything emitted so far (kept short); returns the fresh part, possibly ''.
 */
function dropRepeat(hist: string[], text: string): string {
  const words = text.split(/\s+/).filter(Boolean);
  const norm = words.map(normWord);
  const tail = hist.slice(-40);
  if (tail.length === 0 || words.length === 0) return text;
  if (norm.length >= 3) {
    for (let i = 0; i + norm.length <= tail.length; i++) {
      if (norm.every((w, j) => w === tail[i + j])) return '';
    }
  }
  for (let k = Math.min(tail.length, norm.length, 24); k >= 2; k--) {
    let ok = true;
    for (let j = 0; j < k && ok; j++) ok = tail[tail.length - k + j] === norm[j];
    if (ok) return words.slice(k).join(' ');
  }
  return text;
}

/** a lone "So" is what a recogniser makes of a breath or of a sentence cut by the chunk border: never a cue of its own */
const LONE_FILLERS = new Set(['so', 'uh', 'um', 'hmm', 'ah', 'eh']);
/** "...my God. So" : a sentence-opening "So" left dangling at the end of a cue */
const DANGLING_SO = /(?<=\S)[\s,]+so[,.!?…]*$/i;
const DANGLING_SO_RU = /(?<=\S)[\s,]+(?:так|итак)[,.!?…]*$/iu;

function trimDangling(c: SubtitleCue): SubtitleCue {
  const text = c.text.replace(DANGLING_SO_RU, '');
  const src = c.src === undefined ? undefined : c.src.replace(DANGLING_SO, '');
  return text === c.text && src === c.src ? c : { ...c, text, ...(src !== undefined ? { src } : {}) };
}

const isLoneFiller = (c: SubtitleCue): boolean => c.end - c.start < 1.5 && LONE_FILLERS.has(normWord(c.src ?? c.text));

/**
 * Joins short caption cues into phrases (0.3.5: the owner saw 1-2 word fragments). Rolling auto-captions repeat the
 * previous line at the start of the next cue: the repeated part is dropped. Pure: input is not modified.
 */
export function mergeCuesToPhrases(cues: readonly SubtitleCue[], opt: PhraseOptions = {}): SubtitleCue[] {
  const maxSec = opt.maxSec ?? 8;
  const maxGap = opt.maxGapSec ?? 0.8;
  const maxWords = opt.maxWords ?? 16;
  const sorted = [...cues]
    .map(trimDangling)
    .filter((c) => !isLoneFiller(c))
    .filter((c) => Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start && c.text.trim() && !isNonSpeech(c.text) && !(c.src && isNonSpeech(c.src)))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const out: SubtitleCue[] = [];
  const histT: string[] = [];
  const histS: string[] = [];
  const remember = (hist: string[], t: string): void => {
    for (const w of t.split(/\s+/)) {
      const n = normWord(w);
      if (n) hist.push(n);
    }
    if (hist.length > 80) hist.splice(0, hist.length - 80);
  };
  let cur: { start: number; end: number; text: string; src?: string; last: string; lastSrc: string; words: number } | undefined;
  const flush = (): void => {
    if (!cur) return;
    out.push({ start: cur.start, end: cur.end, text: cur.text, ...(cur.src !== undefined ? { src: cur.src } : {}) });
    cur = undefined;
  };
  for (const c of sorted) {
    const full = c.text.trim();
    // the part of the cue not already on screen (rolling captions, overlapping or duplicated cues)
    const text = dropRepeat(histT, full);
    if (!text) {
      if (cur) cur.end = Math.max(cur.end, c.end);
      continue;
    }
    if (cur) {
      // rolling caption: the next cue starts with the previous line
      const fresh = text.startsWith(cur.last) && cur.last.length > 0 ? text.slice(cur.last.length).trim() : text;
      const words = fresh ? fresh.split(/\s+/).length : 0;
      const fits = c.end - cur.start <= maxSec && cur.words + words <= maxWords && c.start - cur.end <= maxGap && !SENTENCE_END.test(cur.text);
      if (fits) {
        if (fresh) {
          cur.text = `${cur.text} ${fresh}`;
          cur.words += words;
        }
        cur.end = Math.max(cur.end, c.end);
        cur.last = text;
        // the original line rolls the same way: only its new part is added (else it doubles)
        const srcText = dropRepeat(histS, c.src?.trim() ?? '');
        const freshSrc = cur.lastSrc && srcText.startsWith(cur.lastSrc) ? srcText.slice(cur.lastSrc.length).trim() : srcText;
        if (freshSrc) cur.src = cur.src ? `${cur.src} ${freshSrc}` : freshSrc;
        cur.lastSrc = srcText;
        remember(histT, fresh);
        remember(histS, freshSrc);
        continue;
      }
      flush();
    }
    const srcText = dropRepeat(histS, c.src?.trim() ?? '');
    remember(histT, text);
    remember(histS, srcText);
    cur = { start: c.start, end: c.end, text, src: srcText || undefined, last: text, lastSrc: srcText, words: text.split(/\s+/).length };
  }
  flush();
  return out;
}
