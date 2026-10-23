import { afterEach, describe, expect, it, vi } from 'vitest';
import { KeyPool } from '../src/keypool';
import { runChain, createChainState } from '../src/pipeline';
import { GeminiClient } from '../src/providers/gemini/client';
import { TTS_TIMEOUT_MS, synthesize, ttsMaxBytes } from '../src/providers/gemini/tts';
import { TRANSLATE_TIMEOUT_MS, translateChunkAudio } from '../src/providers/gemini/translate';
import { ProviderUnavailableError } from '../src/providers/types';
import { FakeProvider, chunk, settings } from './helpers/pipelineFakes';

const b64 = (pcm: Int16Array): string => {
  const u = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
};
const speech = (sec: number): Int16Array => {
  const o = new Int16Array(Math.round(sec * 24000));
  for (let i = 0; i < o.length; i++) o[i] = Math.round(9000 * Math.sin((2 * Math.PI * 150 * i) / 24000) * (0.6 + 0.4 * Math.sin((2 * Math.PI * 4 * i) / 24000)));
  return o;
};
const ttsResp = (pcm: Int16Array): Response =>
  new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;rate=24000', data: b64(pcm) } }] } }] }), { status: 200 });
/** fetch that never answers until its signal aborts (like a stalled service-worker transport after sw-abort) */
const hang = (seen: { aborted: number }) => (_u: string, init?: RequestInit) =>
  new Promise<Response>((_res, rej) => {
    init?.signal?.addEventListener('abort', () => {
      seen.aborted++;
      rej(new DOMException('aborted', 'AbortError'));
    });
  });

afterEach(() => vi.useRealTimers());

describe('Gemini TTS guards (D26/S27: runaway generations)', () => {
  it('ttsMaxBytes: ~3x the expected audio, base64-adjusted, hard cap 4 MB', () => {
    const t = 'я'.repeat(100); // expected 7 s
    const b = ttsMaxBytes(t);
    expect(b).toBeGreaterThan(7 * 3 * 48000);
    expect(b).toBeLessThan(7 * 3 * 48000 * 1.4);
    expect(ttsMaxBytes('я'.repeat(330))).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(ttsMaxBytes('я'.repeat(5000))).toBe(4 * 1024 * 1024);
  });

  it('a TTS request is aborted after 45 s and surfaces as a timedOut network error, not retried', async () => {
    vi.useFakeTimers();
    const seen = { aborted: 0 };
    let calls = 0;
    const f = hang(seen);
    const c = new GeminiClient({ keys: new KeyPool(['k']), fetch: (u, i) => (calls++, f(u, i)) });
    const p = synthesize(c, 'm', 'Привет, мир.');
    const out = p.catch((e) => e);
    await vi.advanceTimersByTimeAsync(TTS_TIMEOUT_MS + 10);
    const e = await out;
    expect(e).toBeInstanceOf(ProviderUnavailableError);
    expect(e).toMatchObject({ kind: 'network', timedOut: true });
    expect(seen.aborted).toBe(1);
    expect(calls).toBe(1);
  });

  it('a response far longer than 3x the expected audio is rejected without being decoded', async () => {
    const c = new GeminiClient({ keys: new KeyPool(['k']), fetch: async () => ttsResp(speech(60)) }); // 60 s for a 12-char text
    const e = await synthesize(c, 'm', 'Привет, мир.').catch((x) => x);
    expect(e).toBeInstanceOf(ProviderUnavailableError);
    expect((e as Error).message).toContain('too large');
    expect(e).toMatchObject({ kind: 'failed', timedOut: false });
  });

  it('a normal response passes the cap', async () => {
    const c = new GeminiClient({ keys: new KeyPool(['k']), fetch: async () => ttsResp(speech(1.5)) });
    const r = await synthesize(c, 'm', 'Привет, мир.');
    expect(r.seconds).toBeGreaterThan(1);
  });

  it('a content-length above the cap is rejected before the body is read', async () => {
    const big = new Response('{}', { status: 200, headers: { 'content-length': String(50 * 1024 * 1024) } });
    const spy = vi.spyOn(big, 'arrayBuffer');
    const c = new GeminiClient({ keys: new KeyPool(['k']), fetch: async () => big });
    await expect(synthesize(c, 'm', 'Привет, мир.')).rejects.toThrow(/too large/);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('Gemini translate wall-clock guard', () => {
  it('a translate request is aborted after 60 s', async () => {
    vi.useFakeTimers();
    const seen = { aborted: 0 };
    const c = new GeminiClient({ keys: new KeyPool(['k']), fetch: hang(seen) });
    const ch = chunk(0);
    const out = translateChunkAudio(c, 'm', ch, { sleep: async () => {} }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(TRANSLATE_TIMEOUT_MS + 10);
    const e = await out;
    expect(e).toMatchObject({ kind: 'network', timedOut: true });
    expect(seen.aborted).toBe(1);
  });

  it('a user abort stays an AbortError (not reported as a timeout)', async () => {
    const ac = new AbortController();
    const seen = { aborted: 0 };
    const c = new GeminiClient({ keys: new KeyPool(['k']), fetch: hang(seen) });
    const p = c.generateContent('m', {}, ac.signal, { timeoutMs: 60_000 }).catch((e) => e);
    ac.abort();
    const e = await p;
    expect(e).not.toBeInstanceOf(ProviderUnavailableError);
    expect((e as Error).name).toBe('AbortError');
  });
});

describe('chain: Gemini wall-clock timeouts', () => {
  it('never retry, never cool the tier down, no provider-failed warning', async () => {
    const g = new FakeProvider('gemini');
    const err = new ProviderUnavailableError('Gemini request timeout after 45000 ms', 'gemini', 'network', undefined, true);
    g.script = [async () => { throw err; }, async () => { throw err; }, async () => { throw err; }];
    const state = createChainState();
    const warns: string[] = [];
    for (let i = 0; i < 3; i++) {
      await runChain(chunk(i * 15), [g], settings({ voiceEnabled: { 'yandex-live': false, yandex: false, gemini: true } }), {
        signal: new AbortController().signal,
        now: () => 0,
        sleep: async () => {},
        warn: (w) => warns.push(w.kind),
      }, state);
    }
    expect(g.calls).toHaveLength(3);
    expect(state.cooldownUntil.get('gemini') ?? 0).toBe(0);
    expect(warns).not.toContain('provider-failed');
  });
});
