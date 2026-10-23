/**
 * Pure TypeScript port of the Silero v5_ru text front-end (multi_acc_v3_package.py + models/accentor.py + models/homosolver.py +
 * custom_tokenizers/bert_tokenizer.py of v5_ru.pt), apply_tts(put_accent=True, put_stress_homo=True, put_yo=True, put_yo_homo=True,
 * stress_single_vowel=True), plain text (no SSML). The two neural parts (n-gram accentor MLP, BERT homograph solver) are injected
 * as async predictors so this file stays dependency-free and unit-testable; the extension backend runs them with onnxruntime-web.
 * Deviations from Python are only where Python would crash or merge words: see normalizeForSilero.
 */
import { SILERO_EOS, SILERO_MAX_CHUNK_CHARS, SILERO_SOS, SILERO_SYMBOLS } from './constants';

const VOWELS = 'аоуыэиеяёю';
const STRESS = '+';
const STOP_WORDS = ['то'];
const SYMBOL_ID = new Map<string, number>(Array.from(SILERO_SYMBOLS, (c, i) => [c, i] as [string, number]));
/** chars kept by prepare_text_input: symbols[3:] plus '^' */
const KEEP = new Set<string>([...Array.from(SILERO_SYMBOLS.slice(3)), '^']);

// ------------------------------------------------------------------------------------------------ prepare_text_input

/** prepare_text_input + clean_star_text: lowercase, dashes, drop every char outside the symbol table (digits, Latin, quotes...) */
export function prepareSileroText(text: string): { sentence: string; hasText: boolean } {
  let t = text.toLowerCase().replaceAll('—', '–').replaceAll('‑', '-');
  t = Array.from(t)
    .filter((c) => KEEP.has(c))
    .join('');
  t = t.replaceAll('^', ' ^');
  t = t.replace(/\s+/g, ' ').trim();
  t = t.replaceAll('^ ', '^');
  t = t.replace(/\^+/g, '^').trim();
  if (t.length && t.endsWith('^')) t = t.slice(0, -1).trim();
  const clean = t.replace(/[^а-я\- ]/g, '');
  return { sentence: t, hasText: clean.replace(/ /g, '').length > 0 };
}

/**
 * Our own pre-step before prepare (not in Python): NFC, every whitespace run -> one space (Python's filter would DELETE '\n'/'\t'
 * and glue the neighbouring words), '^' -> space (v5_ru has no '^' symbol: Python raises KeyError on it), '«»' etc. are left to
 * prepare (it drops them).
 */
export function normalizeForSilero(text: string): string {
  return text.normalize('NFC').replace(/\^/g, ' ').replace(/\s+/g, ' ').trim();
}

/** '|' + text + '~' -> symbol ids (preprocess_tacotron); chars outside the table are skipped (Python would raise) */
export function sileroSequence(accented: string): number[] {
  const ids: number[] = [];
  for (const c of SILERO_SOS + accented + SILERO_EOS) {
    const id = SYMBOL_ID.get(c);
    if (id !== undefined) ids.push(id);
  }
  return ids;
}

// ------------------------------------------------------------------------------------------------ n-gram accentor

export interface SileroWordPred {
  /** argmax of the stress head = vowel ordinal (from 0) */
  stressIdx: number;
  stressProb: number;
  /** argmax of the yo head: ordinal (from 1) of the 'е' that becomes 'ё', 0 = none */
  yoIdx: number;
  yoProb: number;
}

/** logits rows -> predictions (softmax + argmax, as _get_model_preds) */
export function sileroPredsFromLogits(stress: ArrayLike<number>, stressDim: number, yo: ArrayLike<number>, yoDim: number, n: number): SileroWordPred[] {
  const arg = (a: ArrayLike<number>, off: number, dim: number): [number, number] => {
    let mx = -Infinity;
    let im = 0;
    for (let j = 0; j < dim; j++) {
      const v = a[off + j]!;
      if (v > mx) {
        mx = v;
        im = j;
      }
    }
    let s = 0;
    for (let j = 0; j < dim; j++) s += Math.exp(a[off + j]! - mx);
    return [im, 1 / s];
  };
  const out: SileroWordPred[] = [];
  for (let i = 0; i < n; i++) {
    const [si, sp] = arg(stress, i * stressDim, stressDim);
    const [yi, yp] = arg(yo, i * yoDim, yoDim);
    out.push({ stressIdx: si, stressProb: sp, yoIdx: yi, yoProb: yp });
  }
  return out;
}

/** word_ngrams(word, 1, len+3) of NewFastTextEmbeddingBag: all substrings of '<word>' of length 1..len+3 ('' also yields '') */
export function sileroWordNgrams(word: string): string[] {
  const t = `<${word}>`;
  const out: string[] = [];
  for (let n = 1; n <= word.length + 3; n++) for (let i = 0; i + n <= t.length; i++) out.push(t.slice(i, i + n));
  if (word.length < 1) out.push(word);
  return out;
}

/** n-gram -> embedding row; build from the newline-separated silero_v5_ngrams.txt (line number = id) */
export class SileroNgramIndex {
  private readonly map: Map<string, number>;
  private readonly unk: number;
  constructor(src: string | ReadonlyMap<string, number> | Readonly<Record<string, number>>) {
    if (typeof src === 'string') {
      this.map = new Map();
      src.split('\n').forEach((g, i) => this.map.set(g, i));
    } else this.map = src instanceof Map ? new Map(src) : new Map(Object.entries(src));
    const u = this.map.get('UNK');
    if (u === undefined) throw new Error('Silero: n-gram table has no UNK');
    this.unk = u;
  }
  /** embedding-bag rows (duplicates kept, unknown n-grams skipped, UNK when nothing matched) */
  ids(word: string): number[] {
    const r: number[] = [];
    for (const g of sileroWordNgrams(word)) {
      const id = this.map.get(g);
      if (id !== undefined) r.push(id);
    }
    return r.length ? r : [this.unk];
  }
  /** padded batch for the accentor ONNX: ids[N*K] (0-padded) + mask[N*K] (1 = real) */
  batch(words: readonly string[]): { ids: number[]; mask: number[]; n: number; k: number } {
    const rows = words.map((w) => this.ids(w));
    const k = Math.max(1, ...rows.map((r) => r.length));
    const ids = new Array<number>(rows.length * k).fill(0);
    const mask = new Array<number>(rows.length * k).fill(0);
    rows.forEach((r, i) => r.forEach((id, j) => ((ids[i * k + j] = id), (mask[i * k + j] = 1))));
    return { ids, mask, n: rows.length, k };
  }
}

/** exceptions.gz lines 'word stressCharIdx yoCharIdx' */
export function parseSileroExceptions(text: string): Map<string, [number, number]> {
  const m = new Map<string, [number, number]>();
  for (const line of text.split('\n')) {
    const p = line.trim().split(/\s+/);
    if (p.length >= 3 && p[0]) m.set(p[0], [Number(p[1]), Number(p[2])]);
  }
  return m;
}

/** AccentorNgram._tokenize: whitespace kept as tokens, hyphen parts become 'part-' tokens, stop word 'то' after a hyphen skipped */
export function tokenizeForAccentor(sentence: string): { raw: string[]; clean: string[]; mask: boolean[] } {
  const raw: string[] = [];
  const clean: string[] = [];
  const mask: boolean[] = [];
  for (const word of sentence.split(/(\s+)/)) {
    const parts = word.split('-');
    let toks: string[];
    let pm: boolean[];
    if (parts.length === 1) {
      toks = parts;
      pm = [true];
    } else {
      toks = [...parts.slice(0, -1).map((p) => p + '-'), parts[parts.length - 1]!];
      pm = [...parts.slice(0, -1).map(() => true), !STOP_WORDS.includes(parts[parts.length - 1]!)];
    }
    toks.forEach((t, i) => {
      const c = t.toLowerCase().replace(/[^А-Яа-яёЁ]/g, '');
      raw.push(t);
      clean.push(c);
      mask.push(c.length > 0 && pm[i]!);
    });
  }
  return { raw, clean, mask };
}

const isVowel = (c: string): boolean => VOWELS.includes(c);
const insertAt = (s: string, i: number, ins: string): string => s.slice(0, i) + ins + s.slice(i);
const setYo = (s: string, i: number): string => s.slice(0, i) + (s[i] === s[i]!.toLowerCase() && s[i] !== s[i]!.toUpperCase() ? 'ё' : 'Ё') + s.slice(i + 1);

function accentuateException(raw: string, haveStress: boolean, exc: [number, number]): string {
  const [excStress, excYo] = exc;
  if (haveStress) {
    const pos: number[] = [];
    Array.from(raw).forEach((c, i) => c === STRESS && pos.push(i));
    let w = raw.replaceAll(STRESS, '');
    if (excYo !== -1 && pos.includes(excYo + 1)) w = setYo(w, excYo);
    for (const p of pos) w = insertAt(w, p, STRESS);
    return w;
  }
  let w = raw;
  if (excYo !== -1) w = setYo(w, excYo);
  return insertAt(w, excStress, STRESS);
}

/**
 * AccentorNgram.__call__ (put_stress = put_yo = stress_single_vowel = True, no skip lists) on a tokenized sentence.
 * `preds` gives the model output per clean token (only consulted for tokens that reach the model branch).
 */
export function applySileroAccents(
  tok: { raw: readonly string[]; clean: readonly string[]; mask: readonly boolean[] },
  preds: (cleanWord: string) => SileroWordPred,
  exceptions: ReadonlyMap<string, readonly [number, number]>,
): string {
  const out: string[] = [];
  tok.raw.forEach((rawWord, idx) => {
    let raw = rawWord;
    const clean = tok.clean[idx]!;
    if (!tok.mask[idx]) return void out.push(raw);
    const lower = raw.toLowerCase();
    const haveStress = lower.includes(STRESS);
    const haveYo = lower.includes('ё');
    if (haveStress && haveYo) return void out.push(raw);
    if (!haveStress && haveYo) {
      const yoPos: number[] = [];
      Array.from(lower).forEach((c, i) => c === 'ё' && yoPos.push(i));
      yoPos.forEach((p, i) => (raw = insertAt(raw, p + i, STRESS)));
      return void out.push(raw);
    }
    const exc = exceptions.get(clean);
    if (exc) return void out.push(accentuateException(raw, haveStress, [exc[0], exc[1]]));

    const pr = preds(clean);
    let stressIds = [pr.stressIdx];
    let setStress = pr.stressProb > 0.5 && !haveStress;
    const yoIds = [pr.yoIdx];
    const doYo = pr.yoProb > 0.5;
    if (haveStress) stressIds = lower.split(STRESS).map((part) => Array.from(part).filter(isVowel).length);

    const chars = Array.from(lower);
    const vowelIds = chars.flatMap((c, i) => (isVowel(c) ? [i] : []));
    const yeIds = chars.flatMap((c, i) => (c === 'е' ? [i] : []));
    let stressPos = stressIds.filter((i) => i < vowelIds.length && vowelIds.length > 0).map((i) => vowelIds[i]!);
    const yoPositions = yoIds.filter((i) => i > 0 && i - 1 < yeIds.length && yeIds.length > 0).map((i) => yeIds[i - 1]!);
    if (vowelIds.length === 0) return void out.push(raw);
    for (const yp of yoPositions) if (stressPos.includes(yp) && doYo && lower[yp] === 'е') raw = setYo(raw, yp);
    if (vowelIds.length === 1) {
      stressPos = [vowelIds[0]!];
      setStress = true;
    }
    if (!haveStress && setStress) stressPos.forEach((p, i) => (raw = insertAt(raw, p + i, STRESS)));
    out.push(raw);
  });
  return out.join('');
}

// ------------------------------------------------------------------------------------------------ BERT homograph solver

const isPunct = (c: string): boolean => {
  const cp = c.codePointAt(0)!;
  if ((cp >= 33 && cp <= 47) || (cp >= 58 && cp <= 64) || (cp >= 91 && cp <= 96) || (cp >= 123 && cp <= 126)) return true;
  return /\p{P}/u.test(c);
};
const isCjk = (cp: number): boolean =>
  (cp >= 0x4e00 && cp <= 0x9fff) ||
  (cp >= 0x3400 && cp <= 0x4dbf) ||
  (cp >= 0x20000 && cp <= 0x2a6df) ||
  (cp >= 0x2a700 && cp <= 0x2b73f) ||
  (cp >= 0x2b740 && cp <= 0x2b81f) ||
  (cp >= 0x2b820 && cp <= 0x2ceaf) ||
  (cp >= 0xf900 && cp <= 0xfaff) ||
  (cp >= 0x2f800 && cp <= 0x2fa1f);

/** SimpleBertTokenizer (BasicTokenizer without lowercasing + WordPiece) of the homosolver; encode() adds [CLS] ... [SEP] */
export class SileroBertTokenizer {
  private readonly vocab: Map<string, number>;
  readonly homoStart: number;
  readonly homoEnd: number;
  readonly pad: number;
  private readonly unk: number;
  private readonly cls: number;
  private readonly sep: number;
  private static readonly NEVER_SPLIT = new Set(['[HOMO]', '[/HOMO]']);

  constructor(src: string | ReadonlyMap<string, number> | Readonly<Record<string, number>>) {
    if (typeof src === 'string') {
      this.vocab = new Map();
      src.split('\n').forEach((t, i) => this.vocab.set(t, i));
    } else this.vocab = src instanceof Map ? new Map(src) : new Map(Object.entries(src));
    const need = (t: string): number => {
      const id = this.vocab.get(t);
      if (id === undefined) throw new Error(`Silero: BERT vocab has no ${t}`);
      return id;
    };
    this.unk = need('[UNK]');
    this.cls = need('[CLS]');
    this.sep = need('[SEP]');
    this.pad = need('[PAD]');
    this.homoStart = need('[HOMO]');
    this.homoEnd = need('[/HOMO]');
  }

  private basic(text: string): string[] {
    let t = '';
    for (const ch of text) {
      const cp = ch.codePointAt(0)!;
      if (cp === 0 || cp === 0xfffd || (ch !== '\t' && ch !== '\n' && ch !== '\r' && /\p{C}/u.test(ch))) continue;
      t += ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || /\p{Zs}/u.test(ch) ? ' ' : ch;
    }
    let u = '';
    for (const ch of t) u += isCjk(ch.codePointAt(0)!) ? ` ${ch} ` : ch;
    const out: string[] = [];
    for (const token of u.trim().split(/\s+/).filter(Boolean)) {
      if (SileroBertTokenizer.NEVER_SPLIT.has(token)) {
        out.push(token);
        continue;
      }
      let cur: string | null = null;
      for (const ch of token) {
        if (isPunct(ch)) {
          if (cur !== null) out.push(cur);
          out.push(ch);
          cur = null;
        } else cur = (cur ?? '') + ch;
      }
      if (cur !== null) out.push(cur);
    }
    return out;
  }

  private wordpiece(token: string): string[] {
    const chars = Array.from(token);
    if (chars.length > 100) return ['[UNK]'];
    const subs: string[] = [];
    let start = 0;
    while (start < chars.length) {
      let end = chars.length;
      let cur: string | null = null;
      while (start < end) {
        let s = chars.slice(start, end).join('');
        if (start > 0) s = '##' + s;
        if (this.vocab.has(s)) {
          cur = s;
          break;
        }
        end--;
      }
      if (cur === null) return ['[UNK]'];
      subs.push(cur);
      start = end;
    }
    return subs;
  }

  tokenize(text: string): string[] {
    return this.basic(text).flatMap((t) => (SileroBertTokenizer.NEVER_SPLIT.has(t) ? [t] : this.wordpiece(t)));
  }

  encode(text: string): number[] {
    return [this.cls, ...this.tokenize(text).map((t) => this.vocab.get(t) ?? this.unk), this.sep];
  }
}

export interface SileroHomoCandidate {
  start: number;
  end: number;
  word: string;
  ids: number[];
  /** index of [HOMO] / [/HOMO] in ids */
  homoStart: number;
  homoEnd: number;
}

const HOMO_WORD = /(?=.*[а-яё])[а-яё+]+/giu;

/** HomoSolver._find_and_tag_homos + tokenisation of every homograph occurrence (sentence with [HOMO] w [/HOMO] markers) */
export function findSileroHomographs(sentence: string, homodict: Readonly<Record<string, readonly string[]>>, tok: SileroBertTokenizer): SileroHomoCandidate[] {
  const out: SileroHomoCandidate[] = [];
  for (const m of sentence.matchAll(HOMO_WORD)) {
    const start = m.index!;
    const word = m[0];
    const end = start + word.length;
    if (!Object.prototype.hasOwnProperty.call(homodict, word.toLowerCase())) continue;
    const ids = tok.encode(sentence.slice(0, start) + ' [HOMO] ' + word + ' [/HOMO] ' + sentence.slice(end));
    out.push({ start, end, word, ids, homoStart: ids.indexOf(tok.homoStart), homoEnd: ids.indexOf(tok.homoEnd) });
  }
  return out;
}

/** HomoSolver.__call__ tail (put_stress = put_yo = stress_single_vowel = True): pred 0/1 picks sorted(homodict[word])[pred] */
export function applySileroHomographs(
  sentence: string,
  cands: readonly SileroHomoCandidate[],
  preds: readonly number[],
  homodict: Readonly<Record<string, readonly string[]>>,
): string {
  let s = sentence;
  let offset = 0;
  cands.forEach((c, i) => {
    const start = c.start + offset;
    const end = c.end + offset;
    let wp = [...homodict[c.word.toLowerCase()]!].sort()[preds[i]!]!;
    const stressIdx = wp.indexOf(STRESS);
    wp = wp.replaceAll(STRESS, '');
    const w = Array.from(c.word);
    const p = Array.from(wp);
    let cased = '';
    for (let k = 0; k < Math.min(w.length, p.length); k++) {
      const c1 = w[k]!;
      const lower = c1 === c1.toLowerCase() && c1 !== c1.toUpperCase();
      cased += lower ? p[k]!.toLowerCase() : p[k]!.toUpperCase();
    }
    cased = insertAt(cased, stressIdx, STRESS);
    offset += 1;
    s = s.slice(0, start) + cased + s.slice(end);
  });
  return s;
}

// ------------------------------------------------------------------------------------------------ orchestration

export interface SileroFrontendData {
  ngrams: SileroNgramIndex;
  exceptions: ReadonlyMap<string, readonly [number, number]>;
  /** absent = homograph solver disabled (homographs then go through the plain accentor) */
  homo?: { dict: Readonly<Record<string, readonly string[]>>; tokenizer: SileroBertTokenizer };
}
export interface SileroPredictors {
  /** accentor ONNX: padded n-gram batch -> per-word predictions */
  accent(batch: { ids: number[]; mask: number[]; n: number; k: number }): Promise<SileroWordPred[]>;
  /** homosolver ONNX: candidates -> 0/1 each */
  homo?(cands: readonly SileroHomoCandidate[]): Promise<number[]>;
}

/** SileroStress.__call__: homographs first, then the n-gram accentor ('+' before stressed vowels, 'ё' restored) */
export async function accentuateSilero(sentence: string, data: SileroFrontendData, pred: SileroPredictors): Promise<string> {
  let s = sentence;
  if (data.homo && pred.homo) {
    const cands = findSileroHomographs(s, data.homo.dict, data.homo.tokenizer);
    if (cands.length) s = applySileroHomographs(s, cands, await pred.homo(cands), data.homo.dict);
  }
  const tok = tokenizeForAccentor(s);
  const need = [...new Set(tok.clean.filter((c, i) => tok.mask[i] && !data.exceptions.has(c)))];
  const map = new Map<string, SileroWordPred>();
  if (need.length) {
    const p = await pred.accent(data.ngrams.batch(need));
    need.forEach((w, i) => map.set(w, p[i]!));
  }
  const none: SileroWordPred = { stressIdx: 0, stressProb: 0, yoIdx: 0, yoProb: 0 };
  return applySileroAccents(tok, (w) => map.get(w) ?? none, data.exceptions);
}

/** full text -> model input of one chunk: { accented text, symbol ids }, or null when nothing speakable */
export async function sileroChunkInput(chunk: string, data: SileroFrontendData, pred: SileroPredictors): Promise<{ accented: string; ids: number[] } | null> {
  const { sentence, hasText } = prepareSileroText(chunk);
  if (!hasText) return null;
  const accented = await accentuateSilero(sentence, data, pred);
  return { accented, ids: sileroSequence(accented) };
}

// ------------------------------------------------------------------------------------------------ chunking

const SENT_END = /[.!?…]+["')\]»]*\s+/g;

function breakLong(s: string, max: number): string[] {
  if (s.length <= max) return [s];
  const out: string[] = [];
  let cur = '';
  const push = (x: string): void => {
    if (x.trim()) out.push(x.trim());
  };
  for (const piece of s.split(/(?<=[,;:–])\s+/)) {
    if (cur && cur.length + 1 + piece.length > max) {
      push(cur);
      cur = '';
    }
    if (piece.length <= max) {
      cur = cur ? `${cur} ${piece}` : piece;
      continue;
    }
    push(cur);
    cur = '';
    for (const word of piece.split(' ')) {
      if (cur && cur.length + 1 + word.length > max) {
        push(cur);
        cur = '';
      }
      cur = cur ? `${cur} ${word}` : word;
      while (cur.length > max) {
        push(cur.slice(0, max));
        cur = cur.slice(max);
      }
    }
  }
  push(cur);
  return out;
}

/**
 * Text -> chunks of at most `max` chars (sentences packed together while they fit, over-long sentences broken at , ; : – then at
 * spaces). Chunks without a letter of the model alphabet are dropped; a chunk that does not end in punctuation gets '.' (the model
 * stretches the last symbol to 13 frames, which must be a pause, not a letter).
 */
export function chunkForSilero(text: string, max: number = SILERO_MAX_CHUNK_CHARS): string[] {
  const flat = normalizeForSilero(text);
  if (!flat) return [];
  const sentences: string[] = [];
  let start = 0;
  for (const m of flat.matchAll(SENT_END)) {
    const end = m.index! + m[0].length;
    sentences.push(flat.slice(start, end).trim());
    start = end;
  }
  if (start < flat.length) sentences.push(flat.slice(start).trim());
  const chunks: string[] = [];
  let cur = '';
  for (const s of sentences.flatMap((x) => breakLong(x, max))) {
    if (cur && cur.length + 1 + s.length > max) {
      chunks.push(cur);
      cur = '';
    }
    cur = cur ? `${cur} ${s}` : s;
  }
  if (cur) chunks.push(cur);
  return chunks.filter((c) => prepareSileroText(c).hasText).map((c) => (/[.!?…,;:–]$/.test(prepareSileroText(c).sentence) ? c : c + '.'));
}
