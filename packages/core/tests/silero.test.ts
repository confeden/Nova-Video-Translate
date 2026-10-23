/**
 * Silero v5_ru front-end / DSP / speed port. Expected strings and model decisions come from the REAL Python pipeline of v5_ru.pt
 * (research/silero_onnx/convert_frontend.py + dump_dsp_fixture.py write tests/fixtures/silero_*.json); the predictors here replay
 * the Python model decisions, so the tests check the pure TS logic exactly, without ONNX.
 */
import { describe, expect, it } from 'vitest';
import {
  SILERO_DEFAULT_VOICE,
  SILERO_FILES,
  SILERO_MAX_CHUNK_CHARS,
  SILERO_SPEED_MAX,
  SILERO_SPEED_MIN,
  SILERO_SYMBOLS,
  SILERO_VOICES,
  SileroBertTokenizer,
  SileroNgramIndex,
  accentuateSilero,
  applySileroAccents,
  applySileroHomographs,
  chunkForSilero,
  findSileroHomographs,
  normalizeForSilero,
  prepareSileroText,
  roundHalfEven,
  sileroChunkInput,
  sileroFramesAt,
  sileroIstft,
  sileroPqmf24k,
  sileroPredsFromLogits,
  sileroSamples24k,
  sileroSequence,
  sileroToInt16,
  sileroTotalSec,
  sileroWordNgrams,
  planSileroRates,
  tokenizeForAccentor,
  type SileroFrontendData,
  type SileroPredictors,
  type SileroWordPred,
} from '../src/localtts/silero';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function node(spec: string): Promise<any> {
  return import(/* @vite-ignore */ spec);
}
const fs = await node('node:fs');
const path = await node('node:path');
const url = await node('node:url');
const dir: string = path.join(path.dirname(url.fileURLToPath(import.meta.url)), 'fixtures');
interface Case {
  input: string;
  prepared: string;
  has_text: boolean;
  after_homo?: string;
  accented?: string;
  accented_no_homo?: string;
  sequence?: number[];
  preds?: Record<string, [number, number, number, number]>;
  homo?: { word: string; ids: number[]; pred: number }[];
}
const FX = JSON.parse(fs.readFileSync(path.join(dir, 'silero_frontend.json'), 'utf8')) as {
  cases: Case[];
  featurize: Record<string, number[]>;
  ngrams: Record<string, number>;
  exceptions: Record<string, [number, number]>;
  homodict: Record<string, string[]>;
  vocab: Record<string, number>;
};
const exceptions = new Map(Object.entries(FX.exceptions));
const tokenizer = new SileroBertTokenizer(FX.vocab);
const predOf = (c: Case) => (w: string): SileroWordPred => {
  const p = c.preds![w];
  if (!p) throw new Error(`no python prediction for "${w}"`);
  return { stressIdx: p[0], stressProb: p[1], yoIdx: p[2], yoProb: p[3] };
};
const texts = FX.cases.filter((c) => c.has_text);

describe('silero constants', () => {
  it('voices: eugene first (default), xenia', () => {
    expect(SILERO_VOICES.map((v) => v.id)).toEqual(['eugene', 'xenia']);
    expect(SILERO_VOICES.map((v) => v.gender)).toEqual(['m', 'f']);
    expect(SILERO_DEFAULT_VOICE).toBe('eugene');
  });
  it('files have size + sha256', () => {
    expect(SILERO_FILES.length).toBe(8);
    for (const f of SILERO_FILES) expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
  it('symbol table is the model one', () => expect(SILERO_SYMBOLS.length).toBe(47));
});

describe('silero prepare_text_input', () => {
  it.each(FX.cases.map((c) => [c.input, c] as const))('%s', (_, c) => {
    const r = prepareSileroText(c.input);
    expect(r.sentence).toBe(c.prepared);
    expect(r.hasText).toBe(c.has_text);
  });
  it('numbers and Latin are dropped (left to the caller), empty input has no text', () => {
    expect(prepareSileroText('В 2024 году').sentence).toBe('в году');
    expect(prepareSileroText('').hasText).toBe(false);
    expect(prepareSileroText('123 abc').hasText).toBe(false);
  });
  it('normalizeForSilero keeps words apart across newlines and removes ^', () => {
    expect(normalizeForSilero('раз\nдва\t три^ ')).toBe('раз два три');
    expect(prepareSileroText(normalizeForSilero('раз\nдва')).sentence).toBe('раз два');
  });
});

describe('silero accentor (n-gram) port', () => {
  it('n-gram featurisation equals NewFastTextEmbeddingBag', () => {
    const idx = new SileroNgramIndex(FX.ngrams);
    for (const [w, ids] of Object.entries(FX.featurize)) expect([...idx.ids(w)].sort((a, b) => a - b)).toEqual(ids);
    expect(sileroWordNgrams('')).toEqual(['<', '>', '<>', '']);
    expect(sileroWordNgrams('ab')).toContain('<ab>');
  });
  it('padded batch layout', () => {
    const b = new SileroNgramIndex(FX.ngrams).batch(['замок', 'qq']);
    expect(b.n).toBe(2);
    expect(b.ids.length).toBe(2 * b.k);
    expect(b.mask.slice(b.k).filter((x) => x === 1).length).toBe(FX.featurize.qq!.length); // only '<' and '>' are known
    expect(new SileroNgramIndex({ UNK: 7 }).ids('zz')).toEqual([7]);
  });
  it('softmax/argmax of logits', () => {
    const p = sileroPredsFromLogits([0, 5, 0], 3, [1, 1], 2, 1)[0]!;
    expect(p.stressIdx).toBe(1);
    expect(p.stressProb).toBeGreaterThan(0.98);
    expect(p.yoIdx).toBe(0);
    expect(p.yoProb).toBeCloseTo(0.5, 9);
  });
  it.each(texts.map((c) => [c.input, c] as const))('homosolver output -> accented: %s', (_, c) => {
    expect(applySileroAccents(tokenizeForAccentor(c.after_homo!), predOf(c), exceptions)).toBe(c.accented);
  });
  it.each(texts.map((c) => [c.input, c] as const))('without homosolver: %s', (_, c) => {
    expect(applySileroAccents(tokenizeForAccentor(c.prepared), predOf(c), exceptions)).toBe(c.accented_no_homo);
  });
  it('stop word "то" after a hyphen is not sent to the model', () => {
    const t = tokenizeForAccentor('кто-то где');
    expect(t.raw).toEqual(['кто-', 'то', ' ', 'где']);
    expect(t.mask).toEqual([true, false, false, true]);
  });
});

describe('silero homograph solver port', () => {
  it.each(texts.map((c) => [c.input, c] as const))('BERT tokens + replacement: %s', (_, c) => {
    const cands = findSileroHomographs(c.prepared, FX.homodict, tokenizer);
    expect(cands.map((x) => x.word)).toEqual(c.homo!.map((h) => h.word));
    expect(cands.map((x) => x.ids)).toEqual(c.homo!.map((h) => h.ids));
    for (const x of cands) expect(x.ids[x.homoStart]).toBe(tokenizer.homoStart);
    expect(applySileroHomographs(c.prepared, cands, c.homo!.map((h) => h.pred), FX.homodict)).toBe(c.after_homo);
  });
});

describe('silero full front-end (replayed model decisions)', () => {
  it.each(texts.map((c) => [c.input, c] as const))('%s', async (_, c) => {
    const data: SileroFrontendData = { ngrams: new SileroNgramIndex(FX.ngrams), exceptions, homo: { dict: FX.homodict, tokenizer } };
    const homoPred = new Map(c.homo!.map((h) => [h.ids.join(','), h.pred]));
    let accentWords: string[] = [];
    const pred: SileroPredictors = {
      homo: async (cands) => cands.map((x) => homoPred.get(x.ids.join(','))!),
      accent: async (b) => {
        // the batch carries n-gram ids only; replay by word (order of `need` in accentuateSilero)
        const tok = tokenizeForAccentor(c.after_homo!);
        accentWords = [...new Set(tok.clean.filter((w, i) => tok.mask[i] && !exceptions.has(w)))];
        expect(accentWords.length).toBe(b.n);
        return accentWords.map(predOf(c));
      },
    };
    expect(await accentuateSilero(c.prepared, data, pred)).toBe(c.accented);
    const inp = await sileroChunkInput(c.input, data, pred);
    expect(inp!.ids).toEqual(c.sequence);
    expect(sileroSequence(c.accented!)).toEqual(c.sequence);
  });
  it('empty / unspeakable input gives null', async () => {
    const data: SileroFrontendData = { ngrams: new SileroNgramIndex(FX.ngrams), exceptions };
    const pred: SileroPredictors = { accent: async () => [] };
    expect(await sileroChunkInput('   ', data, pred)).toBeNull();
    expect(await sileroChunkInput('2024 hello', data, pred)).toBeNull();
  });
});

describe('silero chunking', () => {
  it('short text = one chunk, unchanged', () => {
    expect(chunkForSilero('Привет! Как дела?')).toEqual(['Привет! Как дела?']);
  });
  it('empty and unspeakable', () => {
    expect(chunkForSilero('')).toEqual([]);
    expect(chunkForSilero(' 123 ... ')).toEqual([]);
  });
  it('very long text: chunks <= max (+ final dot), all words kept, sentence/comma boundaries', () => {
    const sent = 'Батарея хранит энергию, а двигатель превращает её в движение, и машина едет вперёд по дороге';
    const text = Array.from({ length: 30 }, (_, i) => `${sent} номер ${i}.`).join(' ') + ' ' + 'оченьдлинноеслово'.repeat(20);
    const chunks = chunkForSilero(text);
    expect(chunks.length).toBeGreaterThan(10);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(SILERO_MAX_CHUNK_CHARS + 1);
    const words = (s: string) => s.replace(/[.,]/g, '').split(/\s+/).join('');
    expect(words(chunks.join(' '))).toBe(words(text));
    for (const c of chunks) expect(prepareSileroText(c).sentence).toMatch(/[.!?…,;:–]$/);
  });
});

const f32 = (b64: string): Float32Array => new Float32Array(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer);

describe('silero DSP (iSTFT + PQMF)', () => {
  const D = JSON.parse(fs.readFileSync(path.join(dir, 'silero_dsp.json'), 'utf8')) as { frames: number; re: string; im: string; wav48: string; wav24: string };
  it('iSTFT equals the package ISTFT (float64 reference)', () => {
    const w = sileroIstft(f32(D.re), f32(D.im), D.frames);
    const ref = f32(D.wav48);
    expect(w.length).toBe(ref.length);
    let mx = 0;
    for (let i = 0; i < w.length; i++) mx = Math.max(mx, Math.abs(w[i]! - ref[i]!));
    expect(mx).toBeLessThan(1e-6);
  });
  it('PQMF band 0 equals pqmf_2(...)[:, :1]', () => {
    const w24 = sileroPqmf24k(f32(D.wav48));
    const ref = f32(D.wav24);
    expect(w24.length).toBe(ref.length);
    expect(sileroSamples24k(D.frames)).toBe(ref.length);
    let mx = 0;
    for (let i = 0; i < ref.length; i++) mx = Math.max(mx, Math.abs(w24[i]! - ref[i]!));
    expect(mx).toBeLessThan(1e-6);
  });
  it('tanh guard and int16', () => {
    const loud = new Float64Array(4000).map((_, i) => 3 * Math.sin(i / 7));
    for (const v of sileroPqmf24k(loud)) expect(Math.abs(v)).toBeLessThan(1);
    expect([...sileroToInt16([0, 1, -1, 0.5, 2])]).toEqual([0, 32767, -32767, 16383, 32767]);
  });
});

describe('silero speed fitting', () => {
  const nat = [[5, 3, 4, 6, 2, 8, 7, 9, 13, 7]];
  it('round half to even like ONNX', () => {
    expect([0.5, 1.5, 2.5, -0.5, 2.4, 2.6].map(roundHalfEven)).toEqual([0, 2, 2, -0, 2, 3]);
  });
  it('frames at speed 1 equal the given durations', () => {
    expect(sileroFramesAt(nat[0]!, 1)).toBe(nat[0]!.reduce((a, b) => a + b, 0));
  });
  it('natural when no target / within tolerance, clamped uniform rate outside the range', () => {
    expect(planSileroRates(nat, undefined).rates).toBeNull();
    const t1 = sileroTotalSec(nat, 1);
    expect(planSileroRates(nat, t1).rates).toBeNull();
    const fast = planSileroRates(nat, t1 / 10);
    expect(fast.speed).toBeCloseTo(SILERO_SPEED_MAX, 6);
    expect([...new Set(fast.rates![0])]).toEqual([Math.fround(SILERO_SPEED_MAX)]);
    expect(planSileroRates(nat, t1 * 10).speed).toBeCloseTo(SILERO_SPEED_MIN, 6);
  });
  it('mixed adjacent rates hit the target within one frame despite the uniform-rate step function', () => {
    // 60 symbols of 3 frames: a uniform rate jumps from 180 to 120 frames at 1.2 (3/1.2 = 2.5 -> 2, half to even)
    const d = [[4, ...new Array(60).fill(3), 5, 13, 6]];
    expect(sileroFramesAt(d[0]!, 1.19)).toBeGreaterThan(sileroFramesAt(d[0]!, 1.21) + 50);
    for (const k of [0.75, 0.8, 0.85, 0.9]) {
      const target = sileroTotalSec(d, 1) * k;
      const p = planSileroRates(d, target);
      expect(Math.abs(p.predictedSec - target)).toBeLessThanOrEqual(0.0125 + 1e-9);
      const used = new Set(p.rates![0]);
      expect(used.size).toBeLessThanOrEqual(2);
    }
  });
});
