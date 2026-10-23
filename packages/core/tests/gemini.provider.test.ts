import { describe, expect, it } from 'vitest';
import { KeyPool } from '../src/keypool';
import { GeminiClient, parseRetryAfterMs, responseText } from '../src/providers/gemini/client';
import {
  GeminiProvider,
  TRANSLATE_PREFERENCES,
  TTS_PREFERENCES,
} from '../src/providers/gemini/provider';
import {
  encodeWav,
  mergeShortSegments,
  resampleInt16,
  parseTranslation,
} from '../src/providers/gemini/translate';
import { synthesize, synthesizeAll } from '../src/providers/gemini/tts';
import { pickModel } from '../src/models';
import { ProviderUnavailableError, type AudioChunk } from '../src/providers/types';

const json = (obj: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(obj), { status, headers });

const b64 = (pcm: Int16Array) => {
  let s = '';
  const u = new Uint8Array(pcm.buffer);
  for (const b of u) s += String.fromCharCode(b);
  return btoa(s);
};
const audioResp = (samples: number) =>
  json({
    candidates: [
      {
        content: {
          parts: [
            { inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: b64(new Int16Array(samples).fill(100)) } },
          ],
        },
      },
    ],
  });
const textResp = (text: string) => json({ candidates: [{ content: { parts: [{ text }] } }] });

const MODELS = [
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-3.8-flash-lite-tts',
  'gemini-3.1-flash-tts-preview',
  'gemini-3.5-live-translate-preview',
].map((n) => ({ name: `models/${n}`, supportedGenerationMethods: ['generateContent'] }));

describe('model preferences', () => {
  const ids = MODELS.map((m) => m.name.replace('models/', ''));
  it('tts picks 3.1-flash-tts, translate picks flash-lite', () => {
    expect(pickModel(ids, TTS_PREFERENCES)).toBe('gemini-3.1-flash-tts-preview');
    expect(pickModel(ids, TRANSLATE_PREFERENCES)).toBe('gemini-3.5-flash-lite');
    expect(pickModel(['x-flash', 'y-flash-lite-z'], TRANSLATE_PREFERENCES)).toBe('y-flash-lite-z');
    expect(pickModel(['m-tts'], TTS_PREFERENCES)).toBe('m-tts');
  });
});

describe('GeminiClient key rotation', () => {
  it('rotates on 429 and succeeds with the next key', async () => {
    const used: string[] = [];
    const fetchFn = async (_u: string, init?: RequestInit) => {
      const key = (init!.headers as Record<string, string>)['x-goog-api-key']!;
      used.push(key);
      return key === 'a' ? json({ error: { status: 'RESOURCE_EXHAUSTED' } }, 429, { 'retry-after': '30' }) : textResp('ok');
    };
    const pool = new KeyPool(['a', 'b']);
    const c = new GeminiClient({ keys: pool, fetch: fetchFn });
    const r = await c.generateContent('m', {});
    expect(responseText(r)).toBe('ok');
    expect(used).toEqual(['a', 'b']);
    expect(pool.current()).toBe('b');
  });

  it('throws quota ProviderUnavailableError when all keys are exhausted', async () => {
    const c = new GeminiClient({
      keys: new KeyPool(['a', 'b']),
      fetch: async () => json({ error: { status: 'RESOURCE_EXHAUSTED' } }, 429),
    });
    const err = await c.generateContent('m', {}).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderUnavailableError);
    expect(err.kind).toBe('quota');
    expect(err.retryAfterMs).toBe(60_000);
  });

  it('5xx is a network-kind error and does not mark the key', async () => {
    const pool = new KeyPool(['a']);
    const c = new GeminiClient({ keys: pool, fetch: async () => json({}, 503) });
    const err = await c.generateContent('m', {}).catch((e) => e);
    expect(err.kind).toBe('network');
    expect(pool.current()).toBe('a');
  });

  it('parses retry delay', () => {
    expect(parseRetryAfterMs('12', '')).toBe(12000);
    expect(parseRetryAfterMs(null, '{"retryDelay": "34s"}')).toBe(34000);
    expect(parseRetryAfterMs(null, 'PerDay')).toBe(3_600_000);
  });
});

describe('tts', () => {
  const noSleep = async () => {};
  it('decodes PCM and measures duration', async () => {
    const c = new GeminiClient({ keys: new KeyPool(['a']), fetch: async () => audioResp(48000) });
    const r = await synthesize(c, 'm', 'привет');
    expect(r.sampleRate).toBe(24000);
    expect(r.seconds).toBe(2);
    expect(r.pcm[0]).toBe(100);
  });

  it('retries transient failures', async () => {
    let n = 0;
    const c = new GeminiClient({
      keys: new KeyPool(['a']),
      fetch: async () => (++n < 3 ? json({}, 500) : audioResp(24000)),
    });
    const r = await synthesize(c, 'm', 'x', { sleep: noSleep });
    expect(n).toBe(3);
    expect(r.seconds).toBe(1);
  });

  it('retries empty audio, then gives up', async () => {
    let n = 0;
    const c = new GeminiClient({
      keys: new KeyPool(['a']),
      fetch: async () => (n++, json({ candidates: [{ content: { parts: [] } }] })),
    });
    await expect(synthesize(c, 'm', 'x', { sleep: noSleep })).rejects.toThrow('empty audio');
    expect(n).toBe(3);
  });

  it('limits concurrency and preserves order', async () => {
    let active = 0;
    let peak = 0;
    const c = new GeminiClient({
      keys: new KeyPool(['a']),
      fetch: async (_u: string, init?: RequestInit) => {
        active++;
        peak = Math.max(peak, active);
        const text = JSON.parse(init!.body as string).contents[0].parts[0].text as string;
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return audioResp(text.endsWith('a') ? 24000 : 48000);
      },
    });
    const out = await synthesizeAll(c, 'm', ['a', 'b', 'a', 'b', 'a', 'b', 'a'], { concurrency: 3 });
    expect(peak).toBe(3);
    expect(out.map((r) => r.seconds)).toEqual([1, 2, 1, 2, 1, 2, 1]);
  });
});

describe('translate helpers', () => {
  it('encodes a valid WAV header', () => {
    const w = encodeWav(new Int16Array([1, -2, 3]), 16000);
    const v = new DataView(w.buffer);
    expect(String.fromCharCode(...w.subarray(0, 4))).toBe('RIFF');
    expect(v.getUint32(24, true)).toBe(16000);
    expect(v.getUint32(40, true)).toBe(6);
    expect(v.getInt16(46, true)).toBe(-2);
    expect(w.length).toBe(50);
  });

  it('resamples length proportionally', () => {
    const pcm = new Int16Array(48000).fill(1000);
    const out = resampleInt16(pcm, 48000, 16000);
    expect(out.length).toBe(16000);
    expect(out[100]).toBe(1000);
    expect(resampleInt16(new Int16Array(8000), 8000, 16000).length).toBe(16000);
  });

  it('merges short segments into neighbours', () => {
    const s = (start: number, end: number, ru: string) => ({ start, end, src: ru, ru });
    const out = mergeShortSegments([s(0, 1, 'a'), s(1, 2, 'b'), s(2, 6, 'c'), s(6, 7, 'd')]);
    expect(out).toEqual([
      { start: 0, end: 2, src: 'a b', ru: 'a b' },
      expect.objectContaining({ start: 2, end: 7, ru: 'c d' }),
    ]);
    expect(mergeShortSegments([s(0, 1, 'x')])).toHaveLength(1);
  });

  it('parses and clamps model JSON', () => {
    const r = parseTranslation(
      JSON.stringify({ source_lang: 'EN', segments: [{ start: 5, end: 99, src: 'b', ru: 'б' }, { start: -1, end: 2, src: 'a', ru: 'а' }] }),
      10,
    );
    expect(r.sourceLang).toBe('en');
    expect(r.segments.map((x) => [x.start, x.end])).toEqual([[0, 2], [5, 10]]);
    expect(() => parseTranslation('nope', 10)).toThrow(ProviderUnavailableError);
  });
});

describe('GeminiProvider', () => {
  const chunk: AudioChunk = { startSec: 100, durationSec: 12, sampleRate: 48000, pcm: new Int16Array(48000 * 12) };
  const ctx = (wantSubtitles: boolean) => ({
    signal: new AbortController().signal,
    targetLang: 'ru' as const,
    wantSubtitles,
  });

  function mockFetch(translateJson: unknown, ttsSamples: number[]) {
    const calls: { url: string; body: any }[] = [];
    let ttsIdx = 0;
    const fetchFn = async (url: string, init?: RequestInit) => {
      if (url.includes('/models?')) return json({ models: MODELS });
      const body = JSON.parse(init!.body as string);
      calls.push({ url, body });
      if (url.includes('flash-tts')) return audioResp(ttsSamples[ttsIdx++]!);
      return textResp(JSON.stringify(translateJson));
    };
    return { fetchFn, calls };
  }

  it('isConfigured reflects keys', () => {
    expect(new GeminiProvider({ keys: [] }).isConfigured()).toBe(false);
    expect(new GeminiProvider({ keys: ['k'] }).isConfigured()).toBe(true);
  });

  it('runs translate -> tts -> fit and offsets to video time', async () => {
    const { fetchFn, calls } = mockFetch(
      {
        source_lang: 'en',
        segments: [
          { start: 0, end: 4, src: 'Hello there everyone', ru: 'Всем привет' },
          { start: 4, end: 8, src: 'Second', ru: 'Второе' },
        ],
      },
      [24000 * 5, 24000 * 3],
    );
    const p = new GeminiProvider({ keys: ['k'], fetch: fetchFn, tts: { guard: false }, chunkCalls: false });
    const res = await p.translateChunk(chunk, ctx(false));
    expect(res.sourceLang).toBe('en');
    expect(res.subtitles).toBeUndefined();
    expect(res.segments).toHaveLength(2);
    const [a, b] = res.segments;
    expect(a!.start).toBe(100);
    expect(a!.rate).toBeCloseTo(1.25, 6); // no room before next (4 -> 4), 5/4 = 1.25
    expect(a!.audio).toMatchObject({ kind: 'pcm', sampleRate: 24000 });
    expect(a!.text).toBe('Всем привет');
    expect(b!.start).toBe(104);
    expect(b!.rate).toBe(1);
    // translate call carries wav + schema, resolved models come from ListModels
    const tr = calls.find((c) => !c.url.includes('tts'))!;
    expect(tr.url).toContain('gemini-3.5-flash-lite:');
    expect(tr.body.contents[0].parts[1].inlineData.mimeType).toBe('audio/wav');
    expect(tr.body.generationConfig.responseSchema.required).toContain('segments');
    expect(calls.filter((c) => c.url.includes('flash-tts'))).toHaveLength(2);
  });

  it('returns subtitles only when wanted', async () => {
    const t = { source_lang: 'en', segments: [{ start: 0, end: 5, src: 's', ru: 'р' }] };
    const m = mockFetch(t, [24000]);
    const p = new GeminiProvider({ keys: ['k'], fetch: m.fetchFn });
    const res = await p.translateChunk(chunk, ctx(true));
    expect(res.subtitles).toEqual([{ start: 100, end: 105, src: 's', text: 'р' }]);
  });

  it('russian source yields no segments and no TTS calls', async () => {
    const m = mockFetch({ source_lang: 'ru', segments: [{ start: 0, end: 5, src: 'privet', ru: '' }] }, []);
    const p = new GeminiProvider({ keys: ['k'], fetch: m.fetchFn });
    const res = await p.translateChunk(chunk, ctx(false));
    expect(res).toEqual({ segments: [], sourceLang: 'ru' });
    expect(m.calls).toHaveLength(1);
  });

  it('user override skips ListModels', async () => {
    let listed = false;
    const calls: string[] = [];
    const p = new GeminiProvider({
      keys: ['k'],
      models: () => ({ translate: 'my-translate', tts: 'my-tts' }),
      fetch: async (url: string) => {
        if (url.includes('/models?')) listed = true;
        calls.push(url);
        return url.includes('my-tts')
          ? audioResp(24000 * 2)
          : textResp(JSON.stringify({ source_lang: 'de', segments: [{ start: 0, end: 4, src: 'a', ru: 'б' }] }));
      },
    });
    const res = await p.translateChunk(chunk, ctx(false));
    expect(listed).toBe(false);
    expect(res.segments).toHaveLength(1);
    expect(calls.some((u) => u.includes('my-translate:'))).toBe(true);
  });

  it('no matching model -> unsupported error', async () => {
    const p = new GeminiProvider({
      keys: ['k'],
      fetch: async () => json({ models: [{ name: 'models/foo', supportedGenerationMethods: ['generateContent'] }] }),
    });
    const err = await p.translateChunk(chunk, ctx(false)).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderUnavailableError);
    expect(err.kind).toBe('unsupported');
  });
});

describe('per-(key, model) quota fallback', () => {
  const exhausted = () => json({ error: { status: 'RESOURCE_EXHAUSTED' } }, 429, { 'retry-after': '30' });
  const noSleep = async () => {};

  function setup(dead: (model: string, key: string) => boolean, keys = ['k1', 'k2']) {
    let now = 0;
    const calls: string[] = [];
    const deadSet = { fn: dead };
    const fetchFn = async (url: string, init?: RequestInit) => {
      const model = /models\/([^:]+):/.exec(url)![1]!;
      const key = (init!.headers as Record<string, string>)['x-goog-api-key']!;
      calls.push(`${model}/${key}`);
      return deadSet.fn(model, key) ? exhausted() : audioResp(24000);
    };
    const pool = new KeyPool(keys, { now: () => now });
    const client = new GeminiClient({ keys: pool, fetch: fetchFn });
    return { client, pool, calls, deadSet, advance: (ms: number) => (now += ms) };
  }

  it('429 on model A key1 -> key2 of the same model', async () => {
    const s = setup((m, k) => m === 'A' && k === 'k1');
    const r = await synthesize(s.client, ['A', 'B'], 'x', { sleep: noSleep });
    expect(r.seconds).toBe(1);
    expect(s.calls).toEqual(['A/k1', 'A/k2']);
    // key1 is dead only for A: it is still usable for B
    expect(s.pool.current('B')).toBeDefined();
    expect(s.pool.current('A')).toBe('k2');
  });

  it('all keys of A exhausted -> model B', async () => {
    const s = setup((m) => m === 'A');
    await synthesize(s.client, ['A', 'B'], 'x', { sleep: noSleep });
    expect(s.calls.slice(0, 2).sort()).toEqual(['A/k1', 'A/k2']);
    expect(s.calls).toHaveLength(3);
    expect(s.calls[2]).toMatch(/^B\//);
    expect(s.pool.current()).toBeDefined();
  });

  it('every pair dead -> quota error with the shortest retryAfter', async () => {
    const s = setup(() => true);
    const err = await synthesize(s.client, ['A', 'B'], 'x', { sleep: noSleep }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderUnavailableError);
    expect(err.kind).toBe('quota');
    expect(err.retryAfterMs).toBe(30_000);
    expect(s.calls).toHaveLength(4);
  });

  it('remembers exhaustion: next call skips A without a request, recovers after retryAfter', async () => {
    const s = setup((m) => m === 'A');
    await synthesize(s.client, ['A', 'B'], 'x', { sleep: noSleep });
    s.calls.length = 0;
    await synthesize(s.client, ['A', 'B'], 'x', { sleep: noSleep });
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]).toMatch(/^B\//);
    s.calls.length = 0;
    s.advance(29_999);
    await synthesize(s.client, ['A', 'B'], 'x', { sleep: noSleep });
    expect(s.calls.every((c) => c.startsWith('B/'))).toBe(true);
    s.deadSet.fn = () => false;
    s.calls.length = 0;
    s.advance(1);
    await synthesize(s.client, ['A', 'B'], 'x', { sleep: noSleep });
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]).toMatch(/^A\//);
  });

  it('retryAfter on a fully remembered exhaustion comes from the pool clock', async () => {
    const s = setup(() => true);
    await synthesize(s.client, ['A'], 'x', { sleep: noSleep }).catch(() => {});
    s.calls.length = 0;
    s.advance(10_000);
    const err = await synthesize(s.client, ['A'], 'x', { sleep: noSleep }).catch((e) => e);
    expect(s.calls).toEqual([]);
    expect(err.kind).toBe('quota');
    expect(err.retryAfterMs).toBe(20_000);
  });

  it('translate model falls back flash-lite -> flash', async () => {
    const calls: string[] = [];
    const p = new GeminiProvider({
      keys: ['k'],
      fetch: async (url: string) => {
        if (url.includes('/models?')) {
          return json({
            models: ['gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-tts-preview'].map((n) => ({
              name: `models/${n}`,
              supportedGenerationMethods: ['generateContent'],
            })),
          });
        }
        calls.push(url);
        if (url.includes('flash-lite:')) return exhausted();
        if (url.includes('tts')) return audioResp(24000);
        return textResp(JSON.stringify({ source_lang: 'en', segments: [{ start: 0, end: 4, src: 'a', ru: 'б' }] }));
      },
    });
    const chunk: AudioChunk = { startSec: 0, durationSec: 12, sampleRate: 48000, pcm: new Int16Array(48000 * 12) };
    const res = await p.translateChunk(chunk, { signal: new AbortController().signal, targetLang: 'ru', wantSubtitles: false });
    expect(res.segments).toHaveLength(1);
    expect(calls[0]).toContain('3.5-flash-lite:');
    expect(calls[1]).toContain('3.5-flash:');
  });

  it('provider orders TTS candidates and keeps pro last', async () => {
    const names = ['gemini-3.5-pro-tts', 'gemini-2.5-flash-preview-tts', 'gemini-3.8-flash-lite-tts', 'gemini-3.8-flash-tts', 'gemini-3.1-flash-tts-preview'];
    const p = new GeminiProvider({
      keys: ['k'],
      fetch: async () => json({ models: names.map((n) => ({ name: `models/${n}`, supportedGenerationMethods: ['generateContent'] })) }),
    });
    expect(await p.resolveModels('tts')).toEqual([
      'gemini-3.1-flash-tts-preview',
      'gemini-3.8-flash-tts',
      'gemini-2.5-flash-preview-tts',
      'gemini-3.5-pro-tts',
      'gemini-3.8-flash-lite-tts',
    ]);
  });
});
