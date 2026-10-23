/**
 * Pure, dependency-free text / id / PCM helpers of the Piper engine: normalisation, sentence + comma chunking, phoneme -> id mapping
 * with the voice's phoneme_id_map, speed fitting and PCM assembly. The phonemizer (espeak-ng WASM) and onnxruntime live in the extension.
 */
import { PIPER_CHARS_PER_SEC, PIPER_CHUNK_GAP_SEC, PIPER_FIT_TOLERANCE, PIPER_MAX_CHUNK_CHARS, PIPER_SPEED_MAX, PIPER_SPEED_MIN } from './constants';

const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}]+/gu;
const CONTROL = new RegExp('[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029\ufeff]', 'g');
const REPL: Array<[RegExp, string]> = [
  [/[“”«»„]/g, '"'],
  [/[‘’´`]/g, "'"],
  [/\s[—–-]+\s/g, ', '], // a spaced dash is a pause
  [/[—–‑]/g, '-'],
  [/…/g, '.'],
  [/[[\]{}|\\/#*_~^<>=+@]/g, ' '],
  [/[→←↑↓•·]/g, ' '],
];

/** Cleans text for espeak: no emoji / control chars / markup symbols, single spaces, always ends with punctuation. '' stays ''. */
export function normalizePiperText(input: string): string {
  let t = input.normalize('NFC').replace(EMOJI, ' ').replace(CONTROL, ' ');
  for (const [re, to] of REPL) t = t.replace(re, to);
  t = t.replace(/\s+([,.!?;:])/g, '$1').replace(/([,.!?;:]){2,}/g, (m) => (m.includes('?') ? '?' : m.includes('!') ? '!' : m[0]!));
  t = t.replace(/\s+/g, ' ').trim();
  if (!/[\p{L}\p{N}]/u.test(t)) return ''; // nothing speakable
  if (!/[.!?;:,]["')\]]*$/.test(t)) t += '.';
  return t;
}

/** words after which a full stop does NOT end a sentence (lowercase, no dots) */
const ABBR = new Set(['г', 'гг', 'т', 'д', 'е', 'п', 'ул', 'им', 'см', 'рис', 'стр', 'руб', 'тыс', 'млн', 'млрд', 'др', 'пр', 'проф', 'акад', 'св', 'мин', 'сек', 'кв', 'коп']);

/** Splits at sentence ends (. ! ? followed by whitespace) unless the stop belongs to an abbreviation / initial or the next letter is lowercase. */
export function splitSentencesPiper(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  const re = /[.!?]+["')\]]*\s+/g;
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

/** breaks one over-long sentence at commas / semicolons / colons, then at spaces, then hard */
function breakLong(s: string, max: number): string[] {
  if (s.length <= max) return [s];
  const parts: string[] = [];
  let cur = '';
  const flush = (): void => {
    if (cur.trim()) parts.push(cur.trim());
    cur = '';
  };
  for (const piece of s.split(/(?<=[,;:])\s+/)) {
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

/**
 * Text -> chunks of at most `max` chars: ONE sentence per chunk (like piper, which synthesises sentence by sentence with its own
 * BOS/EOS), over-long sentences broken at commas. Each chunk is normalised; empty / unspeakable input gives []. A chunk that ends on a
 * comma break gets a '.' (clause-end prosody).
 */
export function chunkForPiper(text: string, max: number = PIPER_MAX_CHUNK_CHARS): string[] {
  const chunks: string[] = [];
  for (const para of text.split(/\n\s*\n+/)) {
    const flat = normalizePiperText(para);
    if (!flat) continue;
    for (const sent of splitSentencesPiper(flat)) chunks.push(...breakLong(sent, max));
  }
  return chunks.map((c) => (/[.!?]["')\]]*$/.test(c) ? c : c.replace(/[,;:]+$/, '') + '.')).filter((c) => /[\p{L}\p{N}]/u.test(c));
}

export type PiperPhonemeIdMap = Record<string, number[]>;

/**
 * Piper's phoneme ids: BOS, PAD, then every phoneme followed by PAD, then EOS (phonemize_codepoints of piper). Phonemes missing from the
 * voice's map are dropped (like piper). `phonemes` are the single code points espeak returned.
 */
export function piperPhonemesToIds(phonemes: readonly string[], map: PiperPhonemeIdMap): number[] {
  const bos = map['^'] ?? [1];
  const eos = map['$'] ?? [2];
  const pad = map['_'] ?? [0];
  const ids: number[] = [...bos, ...pad];
  for (const p of phonemes) {
    const m = map[p];
    if (m) ids.push(...m, ...pad);
  }
  ids.push(...eos);
  return ids;
}

/** extracts the phoneme list from the piper-phonemize stdout (one JSON object per call, possibly several lines) */
export function parsePiperPhonemes(lines: readonly string[]): string[] {
  const phonemes: string[] = [];
  for (const line of lines) {
    const s = line.trim();
    if (!s.startsWith('{')) continue;
    const j = JSON.parse(s) as { phonemes?: unknown };
    if (Array.isArray(j.phonemes)) phonemes.push(...j.phonemes.filter((x): x is string => typeof x === 'string'));
  }
  return phonemes;
}

export function clampPiperSpeed(v: number): number {
  return Math.min(PIPER_SPEED_MAX, Math.max(PIPER_SPEED_MIN, v));
}

/** gap time inside a request of n chunks */
export function piperGapSec(chunks: number, gap: number = PIPER_CHUNK_GAP_SEC): number {
  return Math.max(0, chunks - 1) * gap;
}

/** first-pass speed: estimated natural speech time of `chars` against the speech budget (targetSec minus gaps); natural when no target */
export function piperFirstPassSpeed(chars: number, chunks: number, targetSec: number | undefined): number {
  if (!targetSec || !(targetSec > 0)) return 1;
  const budget = targetSec - piperGapSec(chunks);
  if (budget <= 0.2) return PIPER_SPEED_MAX;
  return clampPiperSpeed(chars / PIPER_CHARS_PER_SEC / budget);
}

/** true when the total duration misses the target by more than the tolerance and the clamp leaves room to move */
export function piperNeedsCorrection(totalSec: number, targetSec: number | undefined, speed: number): boolean {
  if (!targetSec || !(targetSec > 0)) return false;
  const rel = (totalSec - targetSec) / targetSec;
  if (Math.abs(rel) <= PIPER_FIT_TOLERANCE) return false;
  if (rel > 0 && speed >= PIPER_SPEED_MAX - 1e-6) return false; // too long but already at the cap
  if (rel < 0 && speed <= PIPER_SPEED_MIN + 1e-6) return false; // too short but already at the floor
  return true;
}

/** corrective-pass speed from the measured speech time of the previous pass (speech time scales ~ 1/speed) */
export function refinePiperSpeed(speed: number, speechSec: number, chunks: number, targetSec: number): number {
  const budget = targetSec - piperGapSec(chunks);
  if (budget <= 0.2 || speechSec <= 0) return speed;
  return clampPiperSpeed(speed * (speechSec / budget));
}

/**
 * Chunks (float PCM in -1..1) -> one Int16 buffer with `gapSec` of silence between chunks. Peak-normalised over the WHOLE request
 * (piper's own 32767 / max(0.01, peak), but one factor for all chunks so they keep their relative loudness).
 */
export function assemblePiperPcm(chunks: readonly Float32Array[], sampleRate: number, gapSec: number = PIPER_CHUNK_GAP_SEC): Int16Array {
  const gap = Math.round(gapSec * sampleRate);
  let total = 0;
  let peak = 0;
  for (const c of chunks) {
    total += c.length;
    for (let i = 0; i < c.length; i++) {
      const a = Math.abs(c[i]!);
      if (a > peak) peak = a;
    }
  }
  total += Math.max(0, chunks.length - 1) * gap;
  const out = new Int16Array(total);
  const k = (32767 * 0.97) / Math.max(0.01, peak);
  let pos = 0;
  chunks.forEach((c, n) => {
    if (n > 0) pos += gap;
    for (let i = 0; i < c.length; i++) out[pos + i] = Math.max(-32768, Math.min(32767, Math.round(c[i]! * k)));
    pos += c.length;
  });
  return out;
}
