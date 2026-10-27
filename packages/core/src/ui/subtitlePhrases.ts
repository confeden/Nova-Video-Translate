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

/**
 * Joins short caption cues into phrases (0.3.5: the owner saw 1-2 word fragments). Rolling auto-captions repeat the
 * previous line at the start of the next cue: the repeated part is dropped. Pure: input is not modified.
 */
export function mergeCuesToPhrases(cues: readonly SubtitleCue[], opt: PhraseOptions = {}): SubtitleCue[] {
  const maxSec = opt.maxSec ?? 8;
  const maxGap = opt.maxGapSec ?? 0.8;
  const maxWords = opt.maxWords ?? 16;
  const sorted = [...cues]
    .filter((c) => Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start && c.text.trim())
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const out: SubtitleCue[] = [];
  let cur: { start: number; end: number; text: string; src?: string; last: string; lastSrc: string; words: number } | undefined;
  const flush = (): void => {
    if (!cur) return;
    out.push({ start: cur.start, end: cur.end, text: cur.text, ...(cur.src !== undefined ? { src: cur.src } : {}) });
    cur = undefined;
  };
  for (const c of sorted) {
    const text = c.text.trim();
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
        const srcText = c.src?.trim() ?? '';
        const freshSrc = cur.lastSrc && srcText.startsWith(cur.lastSrc) ? srcText.slice(cur.lastSrc.length).trim() : srcText;
        if (freshSrc) cur.src = cur.src ? `${cur.src} ${freshSrc}` : freshSrc;
        cur.lastSrc = srcText;
        continue;
      }
      flush();
    }
    const srcText = c.src?.trim() ?? '';
    cur = { start: c.start, end: c.end, text, src: srcText || undefined, last: text, lastSrc: srcText, words: text.split(/\s+/).length };
  }
  flush();
  return out;
}
