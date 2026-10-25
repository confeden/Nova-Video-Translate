/**
 * Text helpers of the local ASR stage (dependency-free): non-speech tag filter and the word-level de-duplication of
 * overlapping chunks. Placement of text on the timeline lives in whisperText.ts, not here.
 */

/** [query], [MUSIC], (dramatic music), *laughs*, music notes: Whisper's descriptions of sound, not speech. Profanity is untouched. */
const TAGS = /\[[^\]\n]{0,60}\]|\([^)\n]{0,60}\)|\*[^*\n]{1,40}\*|[♪♫♬\u{1F3B5}\u{1F3B6}]+/gu;

/** removes non-speech tags; '' when nothing but tags was there */
export function stripNonSpeech(text: string): string {
  return text.replace(TAGS, ' ').replace(/\s+/g, ' ').replace(/\s+([,.!?;:])/g, '$1').replace(/^[\s,.\-–—]+(?=\S)/, '').trim().replace(/^[,.\-–—\s]+$/, '');
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
