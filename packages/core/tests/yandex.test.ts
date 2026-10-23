import { describe, expect, it } from 'vitest';
import type { Transport } from '../src/providers/types';
import { ProviderUnavailableError } from '../src/providers/types';
import {
  YandexClient,
  YandexLiveProvider,
  YandexProvider,
  buildAuthUrl,
  concat,
  createCodeChallenge,
  createCodeVerifier,
  decode,
  decodeTranslateReply,
  encodeTranslateRequest,
  exchangeCode,
  fBytes,
  fDbl,
  fStr,
  fVar,
  getNum,
  getStr,
  hmacSha256Hex,
  pcmToWav,
} from '../src/providers/yandex';

const td = new TextDecoder();
const te = new TextEncoder();
const reply = (status: number, extra: Uint8Array[] = []) => concat(fVar(4, status), ...extra);

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: Uint8Array;
}

/** Fake Yandex backend. `script` gives the translate replies in order. */
function fakeBackend(script: Uint8Array[], opts: { sessionStatus?: number } = {}) {
  const calls: Call[] = [];
  let i = 0;
  const transport: Transport = async (req) => {
    calls.push({ url: req.url, method: req.method, headers: req.headers, body: req.body });
    const u = new URL(req.url);
    const ok = (body: Uint8Array) => ({ status: 200, headers: {}, body });
    if (u.pathname === '/session/create') {
      if (opts.sessionStatus) return { status: opts.sessionStatus, headers: {}, body: new Uint8Array() };
      return ok(concat(fStr(1, 'SECRET'), fVar(2, 3600)));
    }
    if (u.pathname === '/video-translation/translate') return ok(script[Math.min(i++, script.length - 1)]!);
    if (u.pathname === '/video-translation/audio') return ok(fVar(1, 2));
    if (u.host === 'cdn.example') return ok(new Uint8Array([1, 2, 3]));
    return { status: 404, headers: {}, body: new Uint8Array() };
  };
  return { transport, calls };
}

const fast = { sleep: async () => {}, random: () => 0.5 };
const finished = reply(1, [fStr(1, 'https://cdn.example/a.mp3')]);

describe('protobuf', () => {
  it('round-trips varint, string, double and bytes', () => {
    const m = decode(concat(fStr(3, 'привет'), fVar(4, 300), fDbl(6, 12.5), fBytes(7, new Uint8Array([9, 8]))));
    expect(getStr(m, 3)).toBe('привет');
    expect(getNum(m, 4)).toBe(300);
    expect(m[6]![0]).toBe(12.5);
    expect(Array.from(m[7]![0] as Uint8Array)).toEqual([9, 8]);
  });

  it('encodes the translate request like the probe (lively adds field 18)', () => {
    const base = { url: 'https://youtu.be/x', durationSec: 2, sourceLang: 'auto', targetLang: 'ru', firstRequest: true };
    const plain = decode(encodeTranslateRequest({ ...base, lively: false }));
    const live = decode(encodeTranslateRequest({ ...base, lively: true }));
    expect(getStr(plain, 3)).toBe('https://youtu.be/x');
    expect(getNum(plain, 5)).toBe(1);
    expect(plain[18]).toBeUndefined();
    expect(getNum(live, 18)).toBe(1);
    expect(decodeTranslateReply(reply(6, [fStr(7, 'tid')]))).toMatchObject({ status: 6, translationId: 'tid' });
  });
});

describe('crypto and wav', () => {
  it('HMAC-SHA256 matches the RFC 4231-style known vector', async () => {
    expect(await hmacSha256Hex('key', te.encode('The quick brown fox jumps over the lazy dog'))).toBe(
       'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8',
    );
  });

  it('builds a valid mono 16-bit wav header', () => {
    const w = pcmToWav(new Int16Array([1, -1, 2]), 24000);
    expect(td.decode(w.subarray(0, 4))).toBe('RIFF');
    expect(td.decode(w.subarray(8, 12))).toBe('WAVE');
    const dv = new DataView(w.buffer);
    expect(dv.getUint32(24, true)).toBe(24000);
    expect(dv.getUint32(40, true)).toBe(6);
    expect(w.length).toBe(50);
    expect(dv.getInt16(46, true)).toBe(-1);
  });
});

describe('YandexClient flow', () => {
  it('session -> translate(6) -> upload -> poll -> mp3, with the probe headers', async () => {
    const { transport, calls } = fakeBackend([reply(6, [fStr(7, 'tid')]), reply(2, [fVar(5, 5)]), finished]);
    const c = new YandexClient(transport, fast);
    const mp3 = await c.translatePcm(new Int16Array(2400), 24000);
    expect(Array.from(mp3)).toEqual([1, 2, 3]);
    expect(calls.map((x) => x.method + ' ' + new URL(x.url).pathname)).toEqual([
      'POST /session/create',
      'POST /video-translation/translate',
      'PUT /video-translation/audio',
      'POST /video-translation/translate',
      'POST /video-translation/translate',
      'GET /a.mp3',
    ]);
    const t = calls[1]!;
    expect(t.headers['Sec-Fetch-Mode']).toBe('no-cors');
    expect(t.headers.Origin).toBeUndefined();
    expect(t.headers['Sec-Vtrans-Sk']).toBe('SECRET');
    expect(t.headers['Vtrans-Signature']).toBe(await hmacSha256Hex('bt8xH3VOlb4mqf0nqAibnDOoiPlXsisf', t.body!));
    expect(t.headers['Sec-Vtrans-Token']).toMatch(/^[0-9a-f]{64}:[0-9A-F]{32}:\/video-translation\/translate:/);
    expect(t.headers.Authorization).toBeUndefined();
    // audio upload carries the WAV
    const up = decode(calls[2]!.body!);
    expect(getStr(up, 1)).toBe('tid');
    const info = decode(up[6]![0] as Uint8Array);
    expect(td.decode((info[2]![0] as Uint8Array).subarray(0, 4))).toBe('RIFF');
    // first request flag true, polls false
    expect(getNum(decode(calls[1]!.body!), 5)).toBe(1);
    expect(getNum(decode(calls[3]!.body!), 5) ?? 0).toBe(0);
  });

  it('caches the session until expiry', async () => {
    const { transport, calls } = fakeBackend([finished]);
    let now = 0;
    const c = new YandexClient(transport, { ...fast, now: () => now });
    await c.translatePcm(new Int16Array(100), 24000);
    await c.translatePcm(new Int16Array(100), 24000);
    expect(calls.filter((x) => x.url.endsWith('/session/create')).length).toBe(1);
    now = 3600_000;
    await c.translatePcm(new Int16Array(100), 24000);
    expect(calls.filter((x) => x.url.endsWith('/session/create')).length).toBe(2);
  });

  it('times out when polling never finishes', async () => {
    const { transport } = fakeBackend([reply(2)]);
    let now = 0;
    const c = new YandexClient(transport, { ...fast, now: () => now, sleep: async (ms) => void (now += ms), maxPollMs: 20_000 });
    await expect(c.translatePcm(new Int16Array(100), 24000)).rejects.toThrow(/timed out/);
  });

  it('aborts while sleeping', async () => {
    const { transport } = fakeBackend([reply(2)]);
    const ac = new AbortController();
    const c = new YandexClient(transport, { random: () => 0.5 });
    const p = c.translatePcm(new Int16Array(100), 24000, { signal: ac.signal });
    setTimeout(() => ac.abort(), 20);
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('providers', () => {
  const chunk = { startSec: 10, durationSec: 0.1, sampleRate: 24000, pcm: new Int16Array(2400) };
  const ctx = { signal: new AbortController().signal, targetLang: 'ru' as const, wantSubtitles: false };

  it('yandex returns one encoded segment on the video timeline', async () => {
    const { transport } = fakeBackend([finished]);
    const p = new YandexProvider(transport, fast);
    expect(p.isConfigured()).toBe(true);
    const r = await p.translateChunk(chunk, ctx);
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0]).toMatchObject({ start: 10, end: 10.1, audio: { kind: 'encoded', mime: 'audio/mpeg' } });
    expect(r.subtitles).toBeUndefined();
  });

  it('yandex-live needs a token, sends lively + Authorization', async () => {
    const { transport, calls } = fakeBackend([finished]);
    let token: string | undefined;
    const p = new YandexLiveProvider(transport, { ...fast, getToken: () => token });
    expect(p.isConfigured()).toBe(false);
    token = 'tok';
    expect(p.isConfigured()).toBe(true);
    await p.translateChunk(chunk, ctx);
    const t = calls.find((x) => x.url.endsWith('/translate'))!;
    expect(t.headers.Authorization).toBe('OAuth tok');
    expect(getNum(decode(t.body!), 18)).toBe(1);
  });

  it('maps failures to ProviderUnavailableError kinds', async () => {
    const run = async (script: Uint8Array[], sessionStatus?: number) => {
      const { transport } = fakeBackend(script, { sessionStatus });
      return new YandexProvider(transport, fast).translateChunk(chunk, ctx).catch((e) => e);
    };
    const e402 = await run([finished], 402);
    expect(e402).toBeInstanceOf(ProviderUnavailableError);
    expect(e402).toMatchObject({ providerId: 'yandex', kind: 'failed' });
    expect(await run([finished], 401)).toMatchObject({ kind: 'auth' });
    expect(await run([finished], 429)).toMatchObject({ kind: 'quota' });
    expect(await run([reply(0, [fStr(9, 'bad')])])).toMatchObject({ kind: 'unsupported', message: 'bad' });
  });
});

describe('oauth', () => {
  it('PKCE challenge matches RFC 7636 example', async () => {
    expect(await createCodeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    const v = createCodeVerifier();
    expect(v).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('buildAuthUrl carries PKCE params and honours clientId', async () => {
    const u = new URL(await buildAuthUrl({ verifier: 'v', state: 'st', clientId: 'mine', now: 5 }));
    expect(u.origin + u.pathname).toBe('https://oauth.yandex.ru/authorize');
    expect(u.searchParams.get('client_id')).toBe('mine');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('state')).toBe('st');
    expect(u.searchParams.get('redirect_uri')).toBe('https://oauth.yandex.ru/verification_code');
    expect(u.searchParams.get('response_type')).toBe('code');
  });

  it('exchangeCode posts a form and parses the token', async () => {
    let seen: Parameters<Transport>[0] | undefined;
    const transport: Transport = async (req) => {
      seen = req;
      return { status: 200, headers: {}, body: te.encode(JSON.stringify({ access_token: 'AT', expires_in: 100, refresh_token: 'RT' })) };
    };
    const tok = await exchangeCode('CODE', 'VER', transport, { now: () => 1000 });
    expect(tok).toEqual({ accessToken: 'AT', expiresAt: 101_000, refreshToken: 'RT' });
    expect(seen!.url).toBe('https://oauth.yandex.ru/token');
    const form = new URLSearchParams(td.decode(seen!.body));
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code')).toBe('CODE');
    expect(form.get('code_verifier')).toBe('VER');
  });

  it('exchangeCode surfaces an OAuth error', async () => {
    const transport: Transport = async () => ({
      status: 400,
      headers: {},
      body: te.encode(JSON.stringify({ error: 'invalid_grant', error_description: 'Code has expired' })),
    });
    await expect(exchangeCode('c', 'v', transport)).rejects.toMatchObject({ name: 'OAuthError', code: 'invalid_grant' });
  });
});
