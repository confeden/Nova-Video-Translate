import { describe, expect, it } from 'vitest';
import type { Transport } from '../src/providers/types';
import { ProviderUnavailableError } from '../src/providers/types';
import {
  YandexLiveProvider,
  checkYandexToken,
  concat,
  decode,
  describeLoginError,
  exchangeCode,
  fStr,
  fVar,
  getNum,
  getStr,
  isLivelyVoiceAllowed,
  livelySourceLang,
  OAuthError,
  parseOAuthCallback,
} from '../src/providers/yandex';

const te = new TextEncoder();
const reply = (status: number, extra: Uint8Array[] = []) => concat(fVar(4, status), ...extra);

function backend(script: Uint8Array[]) {
  const calls: { url: string; headers: Record<string, string>; body?: Uint8Array }[] = [];
  let i = 0;
  const transport: Transport = async (req) => {
    calls.push({ url: req.url, headers: req.headers, body: req.body });
    const p = new URL(req.url).pathname;
    const ok = (body: Uint8Array) => ({ status: 200, headers: {}, body });
    if (p === '/session/create') return ok(concat(fStr(1, 'SECRET'), fVar(2, 3600)));
    if (p === '/video-translation/translate') return ok(script[Math.min(i++, script.length - 1)]!);
    if (p === '/video-translation/audio') return ok(fVar(1, 2));
    return ok(new Uint8Array([1, 2, 3]));
  };
  return { transport, calls };
}

const fast = { sleep: async () => {}, random: () => 0.5, getToken: () => 'tok' };
const chunk = { startSec: 0, durationSec: 0.1, sampleRate: 24000, pcm: new Int16Array(2400) };
const ctx = { signal: new AbortController().signal, targetLang: 'ru' as const, wantSubtitles: false };
const finishedLively = reply(1, [fStr(1, 'https://cdn.example/a.mp3'), fVar(10, 1)]);
const finishedPlain = reply(1, [fStr(1, 'https://cdn.example/a.mp3')]);

describe('lively voices (VOT parity)', () => {
  it('allow-list: Russian output only; unknown source becomes en', () => {
    expect(livelySourceLang('auto', 'ru')).toBe('en');
    expect(livelySourceLang('de', 'ru')).toBe('de');
    expect(isLivelyVoiceAllowed('auto', 'ru')).toBe(true);
    expect(isLivelyVoiceAllowed('en', 'ru')).toBe(true);
    expect(isLivelyVoiceAllowed('en', 'en')).toBe(false);
  });

  it('request: unknown source goes out as "en", Authorization only on translate', async () => {
    const { transport, calls } = backend([reply(6, [fStr(7, 'tid')]), finishedLively]);
    const r = await new YandexLiveProvider(transport, fast).translateChunk(chunk, ctx);
    expect(r.voice).toBe('lively');
    const tr = calls.filter((c) => c.url.endsWith('/video-translation/translate'));
    expect(getStr(decode(tr[0]!.body!), 8)).toBe('en');
    expect(getNum(decode(tr[0]!.body!), 18)).toBe(1);
    for (const c of calls) {
      const isTr = c.url.endsWith('/video-translation/translate');
      expect(c.headers.Authorization !== undefined).toBe(isTr);
    }
  });

  it('a lively request answered with a standard voice is reported as standard', async () => {
    const { transport } = backend([finishedPlain]);
    const r = await new YandexLiveProvider(transport, fast).translateChunk(chunk, ctx);
    expect(r.voice).toBe('standard');
  });

  it('status 7 (token rejected) is an immediate auth error without a session retry', async () => {
    const { transport, calls } = backend([reply(7, [fVar(10, 1)])]);
    const e = await new YandexLiveProvider(transport, fast).translateChunk(chunk, ctx).catch((x) => x);
    expect(e).toBeInstanceOf(ProviderUnavailableError);
    expect(e.kind).toBe('auth');
    expect(calls.filter((c) => c.url.endsWith('/session/create'))).toHaveLength(1);
  });

  it('"обычная озвучка" message => declined (any status)', async () => {
    for (const status of [0, 2]) {
      const { transport } = backend([reply(status, [fStr(9, 'Для этого видео доступна только обычная озвучка')])]);
      const e = await new YandexLiveProvider(transport, fast).translateChunk(chunk, ctx).catch((x) => x);
      expect(e.kind).toBe('declined');
    }
  });

  it('target other than ru is declined without a network call', async () => {
    const { transport, calls } = backend([finishedLively]);
    const e = await new YandexLiveProvider(transport, fast).translateChunk(chunk, { ...ctx, targetLang: 'en' as never }).catch((x) => x);
    expect(e.kind).toBe('declined');
    expect(calls).toHaveLength(0);
  });
});

describe('oauth callback + login diagnostics', () => {
  it('parses code/state from the query (VOT) and from the fragment', () => {
    expect(parseOAuthCallback('?code=C&state=S')).toEqual({ code: 'C', state: 'S' });
    expect(parseOAuthCallback('', '#code=C&state=S')).toEqual({ code: 'C', state: 'S' });
    expect(parseOAuthCallback('?code=C')).toBeNull();
    expect(parseOAuthCallback('')).toBeNull();
  });

  it('missing expires_in means unknown (0), not "expired now"', async () => {
    const t: Transport = async () => ({ status: 200, headers: {}, body: te.encode(JSON.stringify({ access_token: 'AT' })) });
    expect((await exchangeCode('c', 'v', t, { now: () => 5000 })).expiresAt).toBe(0);
  });

  it('describeLoginError is Russian and secret-free', () => {
    expect(describeLoginError(new OAuthError('x (invalid_grant)', 'invalid_grant', 400))).toContain('устарел');
    expect(describeLoginError(new Error('boom'))).toContain('Яндексом');
  });

  it('checkYandexToken: ok / rejected / network', async () => {
    const mk = (status: number, body: unknown): Transport => async () => ({ status, headers: {}, body: te.encode(JSON.stringify(body)) });
    const ok = await checkYandexToken('t', mk(200, { login: 'ivan', default_avatar_id: 'abc' }));
    expect(ok).toEqual({ ok: true, login: 'ivan', avatarUrl: 'https://avatars.mds.yandex.net/get-yapic/abc/islands-50' });
    expect(await checkYandexToken('t', mk(401, { status: 'error', code: 'NOT_AUTHORIZED' }))).toMatchObject({ ok: false, kind: 'rejected', message: 'Токен не принят — войдите снова' });
    const down: Transport = async () => {
      throw new Error('offline');
    };
    expect(await checkYandexToken('t', down)).toMatchObject({ ok: false, kind: 'network' });
  });
});
