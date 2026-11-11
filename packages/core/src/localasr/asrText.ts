import { cleanSpeechText } from '../lang/speechText';

/**
 * Text helpers of the local ASR stage (dependency-free): non-speech tag filter and the word-level de-duplication of
 * overlapping chunks. Placement of text on the timeline lives in whisperText.ts, not here.
 */

/** removes non-speech tags; '' when nothing but tags was there */
export function stripNonSpeech(text: string): string {
  return cleanSpeechText(text);
}

const norm = (w: string): string => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');
const words = (t: string): string[] => t.split(/\s+/).filter(Boolean);

/**
 * Number of leading words of `next` that repeat the tail of `prev` (the audio overlap was transcribed twice): the longest
 * k <= maxK with prev's last k words == next's first k words (case / punctuation ignored). k >= 2 is required: a single equal
 * word is as likely real speech as a duplicate. Conservative (losing a first word is worse than a repeated one): the overlap audio is 1.5 s
 * (~7 words), so at most 8 words; a run of one repeated word ("okay okay") and a match that is the WHOLE new text under 3 words
 * are treated as new speech.
 */
export function overlapWords(prev: string, next: string, maxK = 8): number {
  const p = words(prev).map(norm).filter(Boolean);
  const n = words(next).map(norm);
  const lim = Math.min(maxK, p.length, n.length);
  for (let k = lim; k >= 2; k--) {
    let ok = true;
    for (let i = 0; i < k && ok; i++) ok = p[p.length - k + i] === n[i] && n[i] !== '';
    if (!ok) continue;
    const run = n.slice(0, k);
    if (run.every((w) => w === run[0]) && k <= 3) continue; // stutter / repeated word: could be real speech
    if (k === n.length && k < 3) continue;
    return k;
  }
  return 0;
}

/** drops the first `k` words from a list of segment texts (a segment emptied by it disappears) */
export function dropLeadingWords<T extends { text: string }>(segs: T[], k: number): T[] {
  let left = k;
  const out: T[] = [];
  for (const s of segs) {
    if (left <= 0) {
      out.push(s);
      continue;
    }
    const w = words(s.text);
    if (w.length <= left) {
      left -= w.length;
      continue;
    }
    out.push({ ...s, text: w.slice(left).join(' ') });
    left = 0;
  }
  return out;
}

/** least speech (s) per word that a short transcript must have under it: a word takes 0.15 s at the very least */
const MIN_SPEECH_PER_WORD_SEC = 0.12;
const MIN_SPEECH_BASE_SEC = 0.1;
/** only short texts are judged: Whisper's silence fillers ("So", "I'm going to go", "Thank you") are 1-5 words */
const WEAK_MAX_WORDS = 12;

const FILLERS = new Set(['so', 'im going to go', "i'm going to go", 'thank you', 'thanks', 'thanks for watching', 'you', 'bye', 'okay', 'oh', 'yeah', 'hmm', 'uh', 'um']);
const FILLER_MIN_SPEECH_SEC = 1;

/** seconds of `bursts` that fall inside [a, b] */
export function speechInside(bursts: readonly { start: number; end: number }[], a: number, b: number): number {
  let s = 0;
  for (const x of bursts) s += Math.max(0, Math.min(b, x.end) - Math.max(a, x.start));
  return s;
}

/**
 * Drops short segments the audio cannot hold: a transcript of up to 5 words whose span contains less speech (VAD bursts) than
 * the words need is a Whisper hallucination over silence / a music bed. Longer text is left alone. Times are in the bursts' clock.
 */
export function dropWeakSegments<T extends { start: number; end: number; text: string }>(segs: T[], bursts: readonly { start: number; end: number }[]): T[] {
  return segs.filter((s) => {
    const n = words(s.text).length;
    if (n > WEAK_MAX_WORDS) return true;
    const sp = speechInside(bursts, s.start, s.end);
    // the phrases Whisper / Gemini invent over silence need a real second of speech to be believed
    if (FILLERS.has(words(s.text).map(norm).join(' '))) return sp >= FILLER_MIN_SPEECH_SEC;
    return sp >= MIN_SPEECH_BASE_SEC + MIN_SPEECH_PER_WORD_SEC * n;
  });
}
