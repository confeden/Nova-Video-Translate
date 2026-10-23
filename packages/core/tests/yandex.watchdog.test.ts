import { beforeEach, describe, expect, it } from 'vitest';
import { diag } from '../src/diag';
import { COOLDOWN_MS, createChainState, runChain, type EngineWarning } from '../src/pipeline';
import type { Transport } from '../src/providers/types';
import { ProviderUnavailableError } from '../src/providers/types';
import { YandexClient, YandexError, YandexProvider, concat, fStr, fVar } from '../src/providers/yandex';
import { FakeProvider, chunk, seg, settings } from './helpers/pipelineFakes';

const reply = (status: number, extra: Uint8Array[] = []) => concat(fVar(4, status), ...extra);
const pcm = new Int16Array(16000);

interface Fake {
  transport: Transport;
  paths: string[];
  aborted: string[];
}

/** Fake backend whose stages can hang (until the request signal aborts). */
function backend(hang: Partial<Record<'session' | 'translate' | 'audio' | 'mp3', boolean>>, script: Uint8Array[] = []): Fake {
  const paths: string[] = [];
  const aborted: string[] = [];
  let i = 0;
  const wait = (name: string, signal?: AbortSignal) =>
    new Promise<never>((_, rej) =>
      signal?.addEventListener('abort', () => {
        aborted.push(name);
        rej(new DOMException('aborted', 'AbortError'));
      }),
    );
  const transport: Transport = async (req) => {
    const u = new URL(req.url);
    const ok = (body: Uint8Array) => ({ status: 200, headers: {}, body });
    if (u.pathname === '/session/create') {
      paths.push('session');
      if (hang.session) return wait('session', req.signal);
      return ok(concat(fStr(1, 'SECRETKEYVALUE'), fVar(2, 3600)));
    }
    if (u.pathname === '/video-translation/translate') {
      paths.push('translate');
      if (hang.translate) return wait('translate', req.signal);
      return ok(script[Math.min(i++, script.length - 1)] ?? reply(2));
    }
    if (u.pathname === '/video-translation/audio') {
      paths.push('audio');
      if (hang.audio) return wait('audio', req.signal);
      return ok(fVar(1, 2));
    }
    paths.push('mp3');
    if (hang.mp3) return wait('mp3', req.signal);
    return ok(new Uint8Array([1, 2, 3]));
  };
  return { transport, paths, aborted };
}

const FAST = { sessionMs: 40, translateMs: 40, uploadMs: 40, fetchMs: 40, jobMs: 5000 };
const mk = (f: Fake, extra: Record<string, unknown> = {}) =>
  new YandexClient(f.transport, { sleep: async () => {}, random: () => 0.5, timeouts: FAST, ...extra });

async function failure(p: Promise<unknown>): Promise<YandexError> {
  try {
    await p;
  } catch (e) {
    return e as YandexError;
  }
  throw new Error('expected a failure');
}

beforeEach(() => diag.clear());

describe('Yandex job deadline follows the server ETA (D26 live policy)', () => {
  const r2 = reply(2, [fVar(5, 1)]); // processing, remainingTime 1 s
  const done = reply(1, [fStr(1, 'https://cdn.example/a.mp3'), fStr(7, 'translation-id-123456')]);
  const script = [r2, r2, r2, r2, r2, r2, done];
  const realSleep = () => new Promise<void>((r) => setTimeout(r, 40));

  it('without etaMarginMs the job is cut off at its deadline', async () => {
    const e = await failure(mk(backend({}, script), { sleep: realSleep }).translatePcm(pcm, 16000, { jobMs: 120 }));
    expect(e).toMatchObject({ kind: 'network', timedOut: true });
  });

  it('with etaMarginMs the deadline and the poll limit stretch to remainingTime + margin and the job finishes late', async () => {
    const hints: number[] = [];
    const out = await mk(backend({}, script), { sleep: realSleep, maxPollMs: 100 }).translatePcm(pcm, 16000, { jobMs: 120, etaMarginMs: 600, onHint: (s) => hints.push(s) });
    expect(Array.from(out)).toEqual([1, 2, 3]);
    expect(hints).toEqual([1]);
  });
});

describe('Yandex watchdog: per-stage deadlines', () => {
  const finished = reply(1, [fStr(1, 'https://cdn.example/a.mp3'), fStr(7, 'translation-id-123456')]);
  const audioReq = reply(6, [fStr(7, 'translation-id-123456')]);

  it('session/create that never answers -> timedOut network error and the transport is aborted', async () => {
    const f = backend({ session: true });
    const e = await failure(mk(f).translatePcm(pcm, 16000));
    expect(e).toBeInstanceOf(YandexError);
    expect(e).toMatchObject({ kind: 'network', timedOut: true });
    expect(e.message).toContain('session/create');
    expect(f.aborted).toContain('session');
  });

  it('translate request that never answers', async () => {
    const f = backend({ translate: true });
    const e = await failure(mk(f).translatePcm(pcm, 16000));
    expect(e).toMatchObject({ kind: 'network', timedOut: true });
    expect(e.message).toContain('translate');
    expect(f.aborted).toEqual(['translate']);
  });

  it('audio upload that never answers', async () => {
    const f = backend({ audio: true }, [audioReq, audioReq]);
    const e = await failure(mk(f).translatePcm(pcm, 16000));
    expect(e).toMatchObject({ kind: 'network', timedOut: true });
    expect(e.message).toContain('upload');
    expect(f.aborted).toEqual(['audio']);
  });

  it('mp3 download that never answers', async () => {
    const f = backend({ mp3: true }, [finished]);
    const e = await failure(mk(f).translatePcm(pcm, 16000));
    expect(e).toMatchObject({ kind: 'network', timedOut: true });
    expect(e.message).toContain('mp3');
  });

  it('a poll that never answers is a translate-stage timeout', async () => {
    const f = backend({}, [reply(2)]);
    let calls = 0;
    const t: Transport = (req) => {
      if (new URL(req.url).pathname === '/video-translation/translate' && ++calls === 2) {
        return new Promise((_, rej) => req.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))));
      }
      return f.transport(req);
    };
    const e = await failure(new YandexClient(t, { sleep: async () => {}, random: () => 0.5, timeouts: FAST }).translatePcm(pcm, 16000));
    expect(e).toMatchObject({ kind: 'network', timedOut: true });
    expect(e.message).toContain('translate');
  });

  it('whole-job deadline: server answers "waiting" forever', async () => {
    const f = backend({}, [reply(2, [fVar(5, 5)])]);
    const c = new YandexClient(f.transport, {
      sleep: (ms) => new Promise((r) => setTimeout(r, 5)),
      random: () => 0.5,
      timeouts: { ...FAST, jobMs: 120, translateMs: 1000 },
      maxPollMs: 10 * 60_000,
    });
    const e = await failure(c.translatePcm(pcm, 16000));
    expect(e).toMatchObject({ kind: 'network', timedOut: true });
    expect(e.message).toContain('job');
    const log = diag.report();
    expect(log).toContain('yandex-job-fail');
    expect(log).toContain('"timeout":true');
  });

  it('a caller abort is an AbortError, not a timeout', async () => {
    const f = backend({ translate: true });
    const ac = new AbortController();
    const p = mk(f).translatePcm(pcm, 16000, { signal: ac.signal });
    setTimeout(() => ac.abort(), 5);
    const e = await failure(p);
    expect(e.name).toBe('AbortError');
    expect(diag.report()).toContain('yandex-job-abort');
  });

  it('one hung session/create does not poison the other jobs: both time out on their own', async () => {
    const f = backend({ session: true });
    const c = mk(f);
    const [a, b] = await Promise.all([failure(c.translatePcm(pcm, 16000)), failure(c.translatePcm(pcm, 16000))]);
    expect(a.timedOut).toBe(true);
    expect(b.timedOut).toBe(true);
    expect(f.paths.filter((p) => p === 'session')).toHaveLength(1); // the creation was shared
  });

  it('provider maps a watchdog timeout to ProviderUnavailableError(network, timedOut)', async () => {
    const f = backend({ translate: true });
    const p = new YandexProvider(f.transport, { sleep: async () => {}, random: () => 0.5, timeouts: FAST });
    const e = await p
      .translateChunk({ startSec: 0, durationSec: 1, sampleRate: 16000, pcm }, { signal: new AbortController().signal, targetLang: 'ru', wantSubtitles: false })
      .catch((x) => x);
    expect(e).toBeInstanceOf(ProviderUnavailableError);
    expect(e).toMatchObject({ kind: 'network', timedOut: true });
  });
});

describe('Yandex diagnostics', () => {
  it('per-step lines carry timings and statuses but no secrets, URLs or full ids', async () => {
    const full = 'translation-id-ABCDEFGH';
    const f = backend({}, [
      reply(6, [fStr(7, full), fVar(5, 20)]),
      reply(2, [fVar(5, 7), fStr(7, full)]),
      reply(1, [fStr(1, 'https://cdn.example/a.mp3?sig=SIGNATURE'), fStr(7, full), fVar(10, 1)]),
    ]);
    const c = new YandexClient(f.transport, { sleep: async () => {}, random: () => 0.5, timeouts: FAST, getToken: () => 'OAUTHTOKENVALUE' });
    await c.translatePcm(pcm, 16000, { lively: true, sourceLang: 'en' });
    const r = diag.report();
    for (const ev of ['yandex-job-start', 'yandex-session', 'yandex-translate', 'yandex-upload', 'yandex-poll', 'yandex-mp3', 'yandex-job-ok']) expect(r).toContain(ev);
    expect(r).toContain('"tid":"EFGH"');
    expect(r).toMatch(/"status":6/);
    expect(r).toMatch(/"remaining":7/);
    expect(r).toMatch(/"bytes":32044/); // 1 s of 16 kHz mono wav
    for (const secret of ['OAUTHTOKENVALUE', 'SECRETKEYVALUE', full, 'SIGNATURE', 'youtu.be', 'cdn.example', 'https://']) expect(r).not.toContain(secret);
  });

  it('heartbeat lists in-flight jobs with age and last stage, only when one is old', async () => {
    const f = backend({ translate: true });
    let t = 1_000_000;
    const c = new YandexClient(f.transport, { sleep: async () => {}, random: () => 0.5, timeouts: { ...FAST, translateMs: 60_000, jobMs: 120_000 }, now: () => t });
    const ac = new AbortController();
    const p = c.translatePcm(pcm, 16000, { signal: ac.signal }).catch(() => {});
    await new Promise((r) => setTimeout(r, 10));
    expect(c.heartbeat()).toBe(false); // young job: silent
    t += 45_000;
    expect(c.heartbeat()).toBe(true);
    const line = diag.entries().find((e) => e.ev === 'yandex-inflight')!;
    expect(line.data).toMatchObject({ n: 1 });
    const jobs = line.data!.jobs as Array<Record<string, unknown>>;
    expect(jobs[0]).toMatchObject({ j: 1, ageS: 45, stage: 'translate', polls: 0, lively: false });
    expect(Object.keys(jobs[0]!).sort()).toEqual(['ageS', 'j', 'lively', 'polls', 'stage', 'stageS'].sort());
    expect(diag.report()).toContain('yandex-inflight');
    ac.abort();
    await p;
    expect(c.inflightSnapshot()).toEqual([]);
  });
});

describe('chain: hedging and timeout cooldown', () => {
  function setup() {
    const live = new FakeProvider('yandex-live');
    const std = new FakeProvider('yandex');
    const gem = new FakeProvider('gemini');
    const state = createChainState();
    const warnings: EngineWarning[] = [];
    let t = 1_000_000;
    const timers: Array<() => void> = [];
    const run = (c = chunk(0), over: Partial<Parameters<typeof runChain>[3]> = {}) =>
      runChain(
        c,
        [live, std, gem],
        settings(),
        {
          signal: new AbortController().signal,
          now: () => t,
          sleep: async () => {},
          warn: (w) => void warnings.push(w),
          hedgeAfterMs: 35_000,
          hedgeTimer: (_ms, signal) =>
            new Promise<void>((res, rej) => {
              timers.push(res);
              signal.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
            }),
          ...over,
        },
        state,
      );
    return { run, live, std, gem, state, warnings, timers, advance: (ms: number) => (t += ms) };
  }

  /** a provider call that stays pending until released; remembers whether it was aborted */
  function pending(p: FakeProvider) {
    const h: { release?: () => void; aborted: boolean } = { aborted: false };
    p.script.push(
      () =>
        new Promise((res, rej) => {
          const sig = p.calls.at(-1)!.ctx.signal;
          sig.addEventListener('abort', () => {
            h.aborted = true;
            rej(new DOMException('aborted', 'AbortError'));
          });
          h.release = () => res({ segments: [seg(0)] });
        }),
    );
    return h;
  }

  it('no hedge while the top tier answers in time', async () => {
    const s = setup();
    const o = await s.run();
    expect(o).toMatchObject({ ok: true, providerId: 'yandex-live' });
    expect(s.std.calls).toHaveLength(0);
    expect(diag.report()).not.toContain('hedge-start');
  });

  it('after the hedge delay the next tier starts; it wins and the slow primary is cancelled', async () => {
    const s = setup();
    const slow = pending(s.live);
    const p = s.run();
    await Promise.resolve();
    expect(s.std.calls).toHaveLength(0);
    s.timers[0]!();
    const o = await p;
    expect(o).toMatchObject({ ok: true, providerId: 'yandex' });
    expect(slow.aborted).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(s.state.hedges).toBe(0);
    expect(diag.report()).toContain('hedge-start');
    expect(diag.report()).toContain('hedge-win');
  });

  it('the primary answering first cancels the hedge', async () => {
    const s = setup();
    const primary = pending(s.live);
    const hedge = pending(s.std);
    const p = s.run();
    await Promise.resolve();
    s.timers[0]!();
    await new Promise((r) => setTimeout(r, 0));
    expect(s.std.calls).toHaveLength(1);
    primary.release!();
    const o = await p;
    expect(o).toMatchObject({ ok: true, providerId: 'yandex-live' });
    expect(hedge.aborted).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(s.state.hedges).toBe(0);
  });

  it('a primary failure while the hedge runs lets the hedge decide', async () => {
    const s = setup();
    s.live.script.push(() => new Promise((_, rej) => setTimeout(() => rej(new ProviderUnavailableError('boom', 'yandex-live', 'failed')), 5)));
    const hedge = pending(s.std);
    const p = s.run();
    await Promise.resolve();
    s.timers[0]!();
    await new Promise((r) => setTimeout(r, 20));
    hedge.release!();
    expect(await p).toMatchObject({ ok: true, providerId: 'yandex' });
  });

  it('at most 2 hedges run at once', async () => {
    const s = setup();
    s.live.fallback = new Error('unused');
    const hs = [pending(s.live), pending(s.live), pending(s.live)];
    const stdHs = [pending(s.std), pending(s.std), pending(s.std)];
    const runs = [s.run(chunk(0)), s.run(chunk(15)), s.run(chunk(30))];
    await Promise.resolve();
    expect(s.timers).toHaveLength(3);
    s.timers.forEach((fire) => fire());
    await new Promise((r) => setTimeout(r, 0));
    expect(s.std.calls).toHaveLength(2);
    expect(s.state.hedges).toBe(2);
    expect(diag.report()).toContain('hedge-skip');
    hs.forEach((h) => h.release?.());
    stdHs.forEach((h) => h.release?.());
    await Promise.all(runs);
    expect(s.state.hedges).toBe(0);
  });

  it('live times out twice in a row -> standard for 5 minutes, with the reason logged', async () => {
    const s = setup();
    const to = () => new ProviderUnavailableError('translate: timeout after 25000 ms', 'yandex-live', 'network', undefined, true);
    s.live.fallback = to();
    const o = await s.run(chunk(0), { hedgeAfterMs: 0 });
    expect(o).toMatchObject({ ok: true, providerId: 'yandex' });
    expect(s.live.calls).toHaveLength(2);
    expect(s.state.cooldownUntil.get('yandex-live')).toBeGreaterThan(0);
    expect(diag.report()).toContain('tier-cooldown');
    expect(diag.report()).toContain('timeouts-in-a-row');
    expect(s.warnings.some((w) => w.providerId === 'yandex-live')).toBe(true);
    await s.run(chunk(15), { hedgeAfterMs: 0 });
    expect(s.live.calls).toHaveLength(2); // cooling down
    s.advance(COOLDOWN_MS + 1);
    await s.run(chunk(30), { hedgeAfterMs: 0 });
    expect(s.live.calls.length).toBeGreaterThan(2);
  });

  it('a non-timeout failure does not trigger the timeout cooldown after one attempt, and a success resets the count', async () => {
    const s = setup();
    const to = () => new ProviderUnavailableError('timeout', 'yandex-live', 'network', undefined, true);
    s.live.script = [to(), { segments: [seg(0)] }];
    expect(await s.run(chunk(0), { hedgeAfterMs: 0 })).toMatchObject({ providerId: 'yandex-live' });
    s.live.script = [to(), { segments: [seg(0)] }];
    expect(await s.run(chunk(15), { hedgeAfterMs: 0 })).toMatchObject({ providerId: 'yandex-live' });
    expect(s.state.cooldownUntil.get('yandex-live')).toBeUndefined();
  });

  it('a cooldown set by a parallel chunk cancels the retry of this chunk on the same tier', async () => {
    const s = setup();
    s.live.script = [
      () => {
        s.state.cooldownUntil.set('yandex-live', 9_999_999_999);
        return Promise.reject(new ProviderUnavailableError('timeout', 'yandex-live', 'network', undefined, true));
      },
    ];
    const o = await s.run(chunk(0), { hedgeAfterMs: 0 });
    expect(o).toMatchObject({ ok: true, providerId: 'yandex' });
    expect(s.live.calls).toHaveLength(1);
  });
});
