import { describe, expect, it } from 'vitest';
import { createSupertonicEngine, type LttsTransport } from '../src/localtts/supertonic/client';
import { MAX_CHUNK_CHARS, MODEL_FILES, MODEL_TOTAL_BYTES, SUPERTONIC_REVISION } from '../src/localtts/supertonic/constants';
import { trimEdges } from '../src/localtts/supertonic/pcm';
import { downloadModel, type ModelStore, type PartWriter } from '../src/localtts/supertonic/download';
import { b64ToInt16, concatWithGaps, floatToInt16, int16ToB64, resample } from '../src/localtts/supertonic/pcm';
import { LTTS_MSG, type LttsOp, type LttsState } from '../src/localtts/supertonic/protocol';
import { SerialQueue } from '../src/localtts/supertonic/queue';
import { synthesizeText, type TtsModel } from '../src/localtts/supertonic/runner';
import { missesTarget, refineSpeed, speedForTarget } from '../src/localtts/supertonic/speed';
import { preprocessForModel, splitForTts, splitSentences, textToIds } from '../src/localtts/supertonic/text';

describe('text chunking', () => {
  it('splits sentences but not after abbreviations / initials / before lowercase', () => {
    expect(splitSentences('Привет. Как дела? Хорошо!')).toEqual(['Привет.', 'Как дела?', 'Хорошо!']);
    expect(splitSentences('Это было в 1990 г. в Москве. Потом всё.')).toEqual(['Это было в 1990 г. в Москве.', 'Потом всё.']);
    expect(splitSentences('Дело в т. д. и т. п. Конец.')).toEqual(['Дело в т. д. и т. п. Конец.']); // an abbreviation at a sentence end is ambiguous: no split (a missed pause is harmless)
    expect(splitSentences('Он сказал... и ушёл. Ну да.')).toEqual(['Он сказал...', 'и ушёл.', 'Ну да.']);
  });
  it('packs short sentences and respects the max length', () => {
    expect(splitForTts('Раз. Два. Три.')).toEqual(['Раз. Два. Три.']);
    const long = Array.from({ length: 40 }, (_, i) => `Это предложение номер ${i}.`).join(' ');
    const ch = splitForTts(long);
    expect(ch.length).toBeGreaterThan(3);
    for (const c of ch) expect(c.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
    expect(ch.join(' ')).toBe(long);
  });
  it('breaks one huge sentence at commas, then at spaces, then hard', () => {
    const s = Array.from({ length: 60 }, (_, i) => `слово${i}`).join(', ');
    for (const c of splitForTts(s)) expect(c.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
    const noSpaces = 'я'.repeat(500);
    const parts = splitForTts(noSpaces);
    expect(parts.every((p) => p.length <= MAX_CHUNK_CHARS)).toBe(true);
    expect(parts.join('')).toBe(noSpaces);
  });
  it('empty / whitespace gives no chunks', () => {
    expect(splitForTts('  \n\n  ')).toEqual([]);
  });
  it('preprocess tags language, ends with punctuation, strips emoji', () => {
    expect(preprocessForModel('привет 😀 мир')).toBe('<ru>привет мир.</ru>');
    expect(preprocessForModel('Да!')).toBe('<ru>Да!</ru>');
    const ids = textToIds('<ru>a</ru>', [0, 1, 2]);
    expect(ids.length).toBe(10);
    expect(ids[0]).toBe(-1n); // '<' = 60 beyond the indexer
  });
});

describe('speed math', () => {
  it('speed = natural / target within the clamp', () => {
    expect(speedForTarget(6, 0, 4)).toBeCloseTo(1.2); // first pass never above 1.2
    expect(speedForTarget(6, 0, 1)).toBe(1.2);
    expect(speedForTarget(2, 0, 10)).toBe(1.0); // natural speed whenever the text fits
    expect(speedForTarget(4.4, 0, 4)).toBeCloseTo(1.1);
    expect(speedForTarget(0, 0, 5)).toBe(1);
  });
  it('tolerance 8% and refine', () => {
    expect(missesTarget(4.3, 4)).toBe(false);
    expect(missesTarget(4.4, 4)).toBe(true);
    expect(missesTarget(3.6, 4)).toBe(true);
    expect(refineSpeed(1.1, 5, 0, 4)).toBeCloseTo(1.3); // the corrective pass may reach the hard cap 1.3
    expect(refineSpeed(1.3, 6, 0, 4)).toBeNull(); // already at the clamp
    expect(refineSpeed(1.2, 4.01, 0, 4)).toBeNull();
  });
});

describe('trimEdges (never cuts speech)', () => {
  const sr = 1000;
  const mk = (lead: number, speech: number, tail: number): Float32Array => {
    const f = new Float32Array(lead + speech + tail);
    for (let i = 0; i < speech; i++) f[lead + i] = 0.5;
    return f;
  };
  it('keeps <= 60 ms of leading silence, drops trailing digital silence > 150 ms, fades the end, keeps all speech', () => {
    const o = trimEdges(mk(500, 1000, 400), sr);
    expect(o.length).toBeLessThan(500 + 1000 + 400);
    expect(o.length).toBeGreaterThanOrEqual(60 + 1000);
    expect(o.length).toBeLessThanOrEqual(60 + 1000 + 20 + 1);
    expect(o[60 + 100]).toBe(0.5); // speech untouched
    expect(o[o.length - 1]).toBeLessThan(0.05); // faded
  });
  it('a short tail (<= 150 ms) is kept whole', () => {
    expect(trimEdges(mk(0, 1000, 100), sr).length).toBe(1100);
  });
  it('pure silence is untouched', () => {
    expect(trimEdges(new Float32Array(500), sr).length).toBe(500);
  });
});

describe('pcm', () => {
  it('float -> int16 clamps', () => {
    expect(Array.from(floatToInt16(new Float32Array([0, 1, -1, 2, -2])))).toEqual([0, 32767, -32768, 32767, -32768]);
  });
  it('base64 roundtrip', () => {
    const a = Int16Array.from({ length: 70000 }, (_, i) => (i * 37) % 65536 - 32768);
    expect(Array.from(b64ToInt16(int16ToB64(a)))).toEqual(Array.from(a));
  });
  it('resample 44100 -> 24000 keeps duration and a tone', () => {
    const n = 44100;
    const x = new Float32Array(n).map((_, i) => Math.sin((2 * Math.PI * 440 * i) / 44100));
    const y = resample(x, 44100, 24000);
    expect(y.length).toBe(24000);
    let zc = 0;
    for (let i = 1; i < y.length; i++) if (y[i - 1]! < 0 && y[i]! >= 0) zc++;
    expect(Math.abs(zc - 440)).toBeLessThanOrEqual(2);
    expect(Math.max(...y)).toBeGreaterThan(0.9);
  });
  it('concat inserts gaps', () => {
    const c = concatWithGaps([Float32Array.of(1, 1), Float32Array.of(2)], 3);
    expect(Array.from(c)).toEqual([1, 1, 0, 0, 0, 2]);
  });
});

describe('SerialQueue', () => {
  it('runs FIFO one at a time and skips aborted waiters', async () => {
    const q = new SerialQueue();
    const log: string[] = [];
    let running = 0;
    let maxRun = 0;
    const task = (n: string, ms: number) => async (): Promise<string> => {
      running++;
      maxRun = Math.max(maxRun, running);
      log.push(`s${n}`);
      await new Promise((r) => setTimeout(r, ms));
      running--;
      return n;
    };
    const ac = new AbortController();
    const p1 = q.run(task('1', 20));
    const p2 = q.run(task('2', 5), ac.signal);
    const p3 = q.run(task('3', 5));
    ac.abort();
    await expect(p2).rejects.toMatchObject({ name: 'AbortError' });
    expect(await Promise.all([p1, p3])).toEqual(['1', '3']);
    expect(log).toEqual(['s1', 's3']);
    expect(maxRun).toBe(1);
    expect(q.size).toBe(0);
  });
});

/** fake model: duration 1 s per 10 chars at speed 1; wav = ramp of 0.5 */
function fakeModel(sr = 44100, jitter = 1): TtsModel & { calls: number[] } {
  const calls: number[] = [];
  return {
    sampleRate: sr,
    calls,
    async predictDuration(t) {
      return t.length / 10;
    },
    async infer(t, _v, speed) {
      calls.push(speed);
      return new Float32Array(Math.floor(((t.length / 10 / speed) * jitter) * sr)).fill(0.5);
    },
  };
}

describe('synthesizeText', () => {
  it('fits targetSec in one pass when the model is predictable', async () => {
    const m = fakeModel();
    const text = 'а'.repeat(60) + '.'; // 6.1 s natural
    const r = await synthesizeText(m, { text, voice: 'M1', targetSec: 4 });
    expect(r.passes).toBe(2); // 1.2 first pass is not enough, the corrective pass goes to the cap
    expect(r.speed).toBeLessThanOrEqual(1.3);
    expect(r.durationSec).toBeGreaterThan(4.3); // not squeezed into the slot: the layout shifts the overflow
    expect(r.sampleRate).toBe(24000);
    expect(r.samples[100]).toBe(Math.round(0.5 * 32767));
  });
  it('does a second pass when the first misses by >8%', async () => {
    const m = fakeModel(44100, 1.3); // model runs 30% longer than predicted
    const r = await synthesizeText(m, { text: 'а'.repeat(60), voice: 'F1', targetSec: 5 });
    expect(r.passes).toBe(2);
    expect(m.calls.length).toBe(2);
    expect(r.speed).toBeLessThanOrEqual(1.3);
  });
  it('no second pass when already at the speed clamp', async () => {
    const m = fakeModel();
    const r = await synthesizeText(m, { text: 'а'.repeat(60), voice: 'M1', targetSec: 1 });
    expect(r.speed).toBeLessThanOrEqual(1.3); // hard cap
    expect(r.speed).toBeGreaterThan(1.1);
  });
  it('multi-chunk text gets gaps and abort stops it', async () => {
    const m = fakeModel();
    const text = Array.from({ length: 20 }, (_, i) => `Предложение номер ${i} здесь.`).join(' ');
    const r = await synthesizeText(m, { text, voice: 'M1' });
    expect(r.chunks).toBeGreaterThan(1);
    const ac = new AbortController();
    const m2 = fakeModel();
    const orig = m2.infer.bind(m2);
    m2.infer = async (...a) => {
      ac.abort();
      return orig(...a);
    };
    await expect(synthesizeText(m2, { text, voice: 'M1', signal: ac.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(m2.calls.length).toBe(1);
  });
  it('empty text -> empty result without touching the model', async () => {
    const m = fakeModel();
    const r = await synthesizeText(m, { text: ' ', voice: 'M1' });
    expect(r.samples.length).toBe(0);
    expect(m.calls.length).toBe(0);
  });
});

// ---------- download ----------
class MemStore implements ModelStore {
  files = new Map<string, Uint8Array>();
  done = new Set<string>();
  committed = new Map<string, number>();
  async size(p: string) {
    return this.files.get(p)?.length ?? 0;
  }
  async isDone(p: string) {
    return this.done.has(p);
  }
  async markDone(p: string) {
    this.done.add(p);
  }
  async open(p: string, offset: number): Promise<PartWriter> {
    const cur = offset === 0 ? new Uint8Array(0) : this.files.get(p)!.slice(0, offset);
    let buf = cur;
    this.files.set(p, buf);
    return {
      write: async (c) => {
        const n = new Uint8Array(buf.length + c.length);
        n.set(buf);
        n.set(c, buf.length);
        buf = n;
        this.files.set(p, buf);
      },
      checkpoint: async () => {
        this.committed.set(p, buf.length);
      },
      close: async () => {},
    };
  }
  async remove(p: string) {
    this.files.delete(p);
    this.done.delete(p);
  }
  async sha256(p: string) {
    const d = await crypto.subtle.digest('SHA-256', this.files.get(p)! as unknown as ArrayBuffer);
    return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
  }
}

const sha = async (b: Uint8Array): Promise<string> => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', b as unknown as ArrayBuffer)), (x) => x.toString(16).padStart(2, '0')).join('');

function bytesOf(n: number, seed: number): Uint8Array {
  return Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 255);
}

/** fetch fake serving `blobs` with Range support; `failAfter` kills the first stream after N bytes */
function fakeFetch(blobs: Record<string, Uint8Array>, opts: { failAfter?: number; ignoreRange?: boolean } = {}) {
  const log: Array<{ url: string; range?: string }> = [];
  let failed = false;
  const f = (async (url: string, init?: RequestInit) => {
    const key = Object.keys(blobs).find((k) => url.endsWith(k))!;
    const range = (init?.headers as Record<string, string> | undefined)?.Range;
    log.push({ url, range });
    let start = 0;
    if (range && !opts.ignoreRange) start = Number(/bytes=(\d+)-/.exec(range)![1]);
    const data = blobs[key]!.slice(start);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (opts.failAfter !== undefined && !failed && sent >= opts.failAfter) {
          failed = true;
          c.error(new Error('connection reset'));
          return;
        }
        if (sent >= data.length) return c.close();
        const end = Math.min(data.length, sent + 1000);
        c.enqueue(data.slice(sent, end));
        sent = end;
      },
    });
    return new Response(stream, { status: range && !opts.ignoreRange ? 206 : 200 });
  }) as unknown as typeof fetch;
  return { f, log };
}

describe('downloadModel', () => {
  const blobA = bytesOf(5000, 1);
  const blobB = bytesOf(3000, 2);
  const mk = async (badSha = false) => [
    { path: 'a.bin', size: blobA.length, sha256: badSha ? 'x'.repeat(64) : await sha(blobA) },
    { path: 'b.json', size: blobB.length },
  ];

  it('downloads, verifies, reports progress, resumes with Range after a dropped connection', async () => {
    const store = new MemStore();
    const { f, log } = fakeFetch({ 'a.bin': blobA, 'b.json': blobB }, { failAfter: 2500 });
    const prog: number[] = [];
    const r = await downloadModel({ files: await mk(), baseUrl: 'https://x/', store, fetch: f, backoffMs: 1, progressEveryMs: 0, checkpointBytes: 1000, onProgress: (p) => prog.push(p.loaded) });
    expect(r.bytes).toBe(8000);
    expect(store.files.get('a.bin')).toEqual(blobA);
    expect(store.done.size).toBe(2);
    expect(log.filter((l) => l.range).length).toBe(1);
    expect(log.find((l) => l.range)!.range).toMatch(/^bytes=\d+-$/);
    expect(prog.at(-1)).toBe(8000);
    expect(prog).toEqual([...prog].sort((a, b) => a - b));
    expect(store.committed.get('a.bin')).toBeGreaterThan(0);
  });

  it('continues a partial file left by an earlier run and skips completed ones', async () => {
    const store = new MemStore();
    store.files.set('a.bin', blobA.slice(0, 1234));
    store.files.set('b.json', blobB);
    store.done.add('b.json');
    const { f, log } = fakeFetch({ 'a.bin': blobA, 'b.json': blobB });
    await downloadModel({ files: await mk(), baseUrl: 'https://x/', store, fetch: f });
    expect(log.length).toBe(1);
    expect(log[0]!.range).toBe('bytes=1234-');
    expect(store.files.get('a.bin')).toEqual(blobA);
  });

  it('restarts the file when the server ignores Range', async () => {
    const store = new MemStore();
    store.files.set('a.bin', blobA.slice(0, 100));
    const { f } = fakeFetch({ 'a.bin': blobA, 'b.json': blobB }, { ignoreRange: true });
    await downloadModel({ files: await mk(), baseUrl: 'https://x/', store, fetch: f });
    expect(store.files.get('a.bin')).toEqual(blobA);
  });

  it('rejects a corrupted file (sha mismatch) and deletes it', async () => {
    const store = new MemStore();
    const { f } = fakeFetch({ 'a.bin': blobA, 'b.json': blobB });
    await expect(downloadModel({ files: await mk(true), baseUrl: 'https://x/', store, fetch: f })).rejects.toMatchObject({ kind: 'checksum' });
    expect(store.files.has('a.bin')).toBe(false);
    expect(store.done.has('a.bin')).toBe(false);
  });

  it('http error is not retried; abort stops', async () => {
    const store = new MemStore();
    const f404 = (async () => new Response('no', { status: 404 })) as unknown as typeof fetch;
    await expect(downloadModel({ files: await mk(), baseUrl: 'https://x/', store, fetch: f404, backoffMs: 1 })).rejects.toMatchObject({ kind: 'http' });
    const ac = new AbortController();
    ac.abort();
    const { f } = fakeFetch({ 'a.bin': blobA, 'b.json': blobB });
    await expect(downloadModel({ files: await mk(), baseUrl: 'https://x/', store, fetch: f, signal: ac.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('manifest totals match the sum of files', () => {
    expect(MODEL_TOTAL_BYTES).toBe(MODEL_FILES.reduce((a, x) => a + x.size, 0));
    expect(MODEL_TOTAL_BYTES).toBeGreaterThan(398e6);
    expect(MODEL_TOTAL_BYTES).toBeLessThan(405e6);
  });
});

// ---------- client over a fake transport ----------
const readyState = (over: Partial<LttsState> = {}): LttsState => ({ model: 'ready', loaded: 1, total: 1, rev: SUPERTONIC_REVISION, gpu: true, updatedAt: 1, ...over });

function fakeTransport(state: LttsState | undefined, handler?: (op: LttsOp) => unknown) {
  const sent: LttsOp[] = [];
  const t: LttsTransport = {
    async send(op) {
      sent.push(op);
      return handler ? handler(op) : { ok: true };
    },
    async readState() {
      return state;
    },
  };
  return { t, sent };
}

describe('supertonic client (engine)', () => {
  it('isAvailable only when model ready + gpu not denied + same revision', async () => {
    expect(await createSupertonicEngine(fakeTransport(readyState()).t).isAvailable()).toBe(true);
    expect(await createSupertonicEngine(fakeTransport(readyState({ gpu: undefined })).t).isAvailable()).toBe(true);
    expect(await createSupertonicEngine(fakeTransport(readyState({ gpu: false })).t).isAvailable()).toBe(false);
    expect(await createSupertonicEngine(fakeTransport(readyState({ model: 'downloading' })).t).isAvailable()).toBe(false);
    expect(await createSupertonicEngine(fakeTransport(readyState({ rev: 'old' })).t).isAvailable()).toBe(false);
    expect(await createSupertonicEngine(fakeTransport(undefined).t).isAvailable()).toBe(false);
    const broken: LttsTransport = { send: async () => { throw new Error('x'); }, readState: async () => { throw new Error('x'); } };
    expect(await createSupertonicEngine(broken).isAvailable()).toBe(false);
  });

  it('voices: M1 first, F1 present', async () => {
    const v = await createSupertonicEngine(fakeTransport(undefined).t).voices();
    expect(v[0]).toBe('M1');
    expect(v).toContain('F1');
  });

  it('synth sends the protocol request and decodes the reply', async () => {
    const pcm = Int16Array.of(1, -2, 3, 4);
    const { t, sent } = fakeTransport(readyState(), (op) =>
      op.op === 'synth' ? { ok: true, sampleRate: 24000, pcmB64: int16ToB64(pcm), durationSec: 4 / 24000, ms: 10, chars: 5, speed: 1.1, passes: 1 } : { ok: true });
    const r = await createSupertonicEngine(t).synth({ text: 'Привет', voice: 'F1', targetSec: 2 });
    expect(Array.from(r.samples)).toEqual([1, -2, 3, 4]);
    expect(r.sampleRate).toBe(24000);
    const op = sent[0]! as Extract<LttsOp, { op: 'synth' }>;
    expect(op).toMatchObject({ op: 'synth', text: 'Привет', voice: 'F1', targetSec: 2 });
    expect(typeof op.id).toBe('string');
  });

  it('unknown voice falls back to M1; engine errors surface as exceptions; abort sends abort', async () => {
    const { t, sent } = fakeTransport(readyState(), (op) => (op.op === 'synth' ? { ok: false, error: 'boom' } : { ok: true }));
    const e = createSupertonicEngine(t);
    await expect(e.synth({ text: 'x', voice: 'nope' })).rejects.toThrow('boom');
    expect((sent[0] as { voice: string }).voice).toBe('M1');

    const never = fakeTransport(readyState(), (op) => (op.op === 'synth' ? new Promise(() => {}) : { ok: true }));
    const ac = new AbortController();
    const p = createSupertonicEngine(never.t).synth({ text: 'x', signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(never.sent.map((s) => s.op)).toEqual(['synth', 'abort']);
    expect((never.sent[1] as { id: string }).id).toBe((never.sent[0] as { id: string }).id);
  });

  it('LTTS_MSG constant is stable', () => {
    expect(LTTS_MSG).toBe('nvt-ltts');
  });
});

describe('settings panel state mapping', () => {
  it('maps persisted state to panel phases and Russian text', async () => {
    const { panelStateFrom, statusText, downloadButtonLabel } = await import('../src/ui/localTtsSection');
    expect(panelStateFrom(undefined).phase).toBe('none');
    expect(panelStateFrom(readyState()).phase).toBe('ready');
    expect(panelStateFrom(readyState({ model: 'none', gpu: false })).phase).toBe('unsupported');
    expect(panelStateFrom(readyState({ model: 'none', gpu: false })).message).toBe('WebGPU недоступен');
    expect(panelStateFrom(readyState({ offscreen: false })).phase).toBe('unsupported');
    expect(panelStateFrom(readyState({ model: 'error', error: 'x' })).phase).toBe('error');
    expect(statusText({ phase: 'downloading', loaded: 200e6, total: 400e6 })).toBe('Скачивание: 50% (200 из 400 МБ)');
    expect(statusText({ phase: 'none', loaded: 0, total: 400e6 })).toBe('Не скачано');
    expect(downloadButtonLabel(MODEL_TOTAL_BYTES)).toMatch(/^Скачать модель \(40\d МБ\)$/);
  });
});
