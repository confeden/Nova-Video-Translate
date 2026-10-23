/** Text side of the Supertonic pipeline: sentence splitting for the model and the model's own preprocessing. Pure. */
import { MAX_CHUNK_CHARS } from './constants';

/** words after which a full stop does NOT end a sentence (lowercase, no dots) */
const ABBR = new Set(['г', 'гг', 'т', 'д', 'е', 'п', 'ул', 'им', 'см', 'рис', 'стр', 'руб', 'тыс', 'млн', 'млрд', 'др', 'пр', 'проф', 'акад', 'св', 'mr', 'mrs', 'ms', 'dr', 'vs', 'etc', 'inc', 'ltd', 'co', 'st']);

/** Splits at sentence ends (. ! ? … followed by whitespace) unless the stop belongs to an abbreviation or the next letter is lowercase. */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  const re = /[.!?…]+["'»”)\]]*\s+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const end = m.index + m[0].length;
    const before = text.slice(start, m.index + 1).trimEnd();
    const next = text.charAt(end);
    const lastWord = (/(\p{L}+)\.$/u.exec(before)?.[1] ?? '').toLowerCase();
    const plainDot = m[0].startsWith('.') && !m[0].startsWith('..');
    const initial = lastWord.length === 1 && /\p{Lu}/u.test(before.slice(-2, -1));
    const nextLower = !!next && /\p{Ll}/u.test(next);
    if (plainDot && (ABBR.has(lastWord) || initial || nextLower)) continue;
    out.push(text.slice(start, end).trim());
    start = end;
  }
  const rest = text.slice(start).trim();
  if (rest) out.push(rest);
  return out.filter(Boolean);
}

/** Breaks one over-long sentence at commas/semicolons/colons/dashes, then at spaces, then hard. */
function breakLong(s: string, max: number): string[] {
  if (s.length <= max) return [s];
  const parts: string[] = [];
  let cur = '';
  const flush = (): void => {
    if (cur.trim()) parts.push(cur.trim());
    cur = '';
  };
  for (const piece of s.split(/(?<=[,;:—–])\s+/)) {
    if (cur && cur.length + piece.length + 1 > max) flush();
    if (piece.length > max) {
      flush();
      let w = '';
      for (const word of piece.split(/\s+/)) {
        if (w && w.length + word.length + 1 > max) {
          parts.push(w);
          w = '';
        }
        w = w ? `${w} ${word}` : word;
        while (w.length > max) {
          parts.push(w.slice(0, max));
          w = w.slice(max);
        }
      }
      cur = w;
    } else cur = cur ? `${cur} ${piece}` : piece;
  }
  flush();
  return parts;
}

/** Text -> chunks of at most `max` chars: sentences packed greedily, over-long ones broken at punctuation. */
export function splitForTts(text: string, max: number = MAX_CHUNK_CHARS): string[] {
  const chunks: string[] = [];
  for (const para of text.trim().split(/\n\s*\n+/)) {
    const flat = para.replace(/\s+/g, ' ').trim();
    if (!flat) continue;
    let cur = '';
    for (const sent of splitSentences(flat).flatMap((s) => breakLong(s, max))) {
      if (cur && cur.length + sent.length + 1 > max) {
        chunks.push(cur);
        cur = '';
      }
      cur = cur ? `${cur} ${sent}` : sent;
    }
    if (cur) chunks.push(cur);
  }
  return chunks;
}

const EMOJI = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]+/gu;
const REPL: Array<[string, string]> = [
  ['–', '-'], ['‑', '-'], ['—', '-'], ['_', ' '], ['“', '"'], ['”', '"'], ['‘', "'"], ['’', "'"], ['´', "'"], ['`', "'"],
  ['[', ' '], [']', ' '], ['|', ' '], ['/', ' '], ['#', ' '], ['→', ' '], ['←', ' '],
];

/** Port of the reference UnicodeProcessor.preprocessText: normalisation + the <lang> tags the model was trained with. */
export function preprocessForModel(input: string, lang = 'ru'): string {
  let t = input.normalize('NFKD').replace(EMOJI, '');
  for (const [k, v] of REPL) t = t.replaceAll(k, v);
  t = t.replace(/[♥☆♡©\\]/g, '');
  t = t.replaceAll('@', ' at ').replaceAll('e.g.,', 'for example, ').replaceAll('i.e.,', 'that is, ');
  t = t.replace(/ ,/g, ',').replace(/ \./g, '.').replace(/ !/g, '!').replace(/ \?/g, '?').replace(/ ;/g, ';').replace(/ :/g, ':').replace(/ '/g, "'");
  while (t.includes('""')) t = t.replace('""', '"');
  while (t.includes("''")) t = t.replace("''", "'");
  while (t.includes('``')) t = t.replace('``', '`');
  t = t.replace(/\s+/g, ' ').trim();
  if (!/[.!?;:,'")\]}…。」』】〉》›»]$/.test(t)) t += '.';
  return `<${lang}>${t}</${lang}>`;
}

/** Text -> token ids via the model's unicode_indexer (indexed by UTF-16 unit like the reference; unknown = -1). */
export function textToIds(processed: string, indexer: ArrayLike<number>): BigInt64Array {
  const ids = new BigInt64Array(processed.length);
  for (let j = 0; j < processed.length; j++) {
    const cp = processed.codePointAt(j)!;
    ids[j] = BigInt(cp < indexer.length ? indexer[cp]! : -1);
  }
  return ids;
}
