import { describe, expect, it } from 'vitest';
import { COOLDOWN_MS, createChainState, runChain, type EngineWarning } from '../src/pipeline';
import { FakeProvider, chunk, seg, settings, unavailable } from './helpers/pipelineFakes';

function setup(ids: Array<'yandex-live' | 'yandex' | 'gemini'> = ['yandex-live', 'yandex', 'gemini']) {
  const providers = ids.map((i) => new FakeProvider(i));
  const state = createChainState();
  const warnings: EngineWarning[] = [];
  const sleeps: number[] = [];
  let t = 1_000_000;
  const clock = { advance: (ms: number) => (t += ms) };
  const run = (s = settings(), c = chunk(0)) =>
    runChain(
      c,
      providers,
      s,
      {
        signal: new AbortController().signal,
        now: () => t,
        sleep: async (ms) => void sleeps.push(ms),
        warn: (w) => void warnings.push(w),
      },
      state,
    );
  const by = (id: string) => providers.find((p) => p.id === id)!;
  return { providers, state, warnings, sleeps, clock, run, by };
}

describe('runChain', () => {
  it('follows voiceOrder and uses the first tier that works', async () => {
    const s = setup();
    const out = await s.run();
    expect(out).toMatchObject({ ok: true, providerId: 'yandex-live' });
    expect(s.by('yandex').calls).toHaveLength(0);
    const out2 = await s.run(settings({ voiceOrder: ['gemini', 'yandex', 'yandex-live'] }));
    expect(out2).toMatchObject({ ok: true, providerId: 'gemini' });
  });

  it('skips disabled and unconfigured tiers', async () => {
    const s = setup();
    s.by('yandex-live').configured = false;
    const out = await s.run(settings({ voiceEnabled: { 'yandex-live': true, yandex: false, gemini: true } }));
    expect(out).toMatchObject({ ok: true, providerId: 'gemini' });
    expect(s.by('yandex-live').calls).toHaveLength(0);
    expect(s.by('yandex').calls).toHaveLength(0);
  });

  it('quota: falls through without retry and warns once per minute', async () => {
    const s = setup();
    for (const p of s.providers) p.fallback = unavailable(p.id, 'quota');
    const o = await s.run();
    expect(o.ok).toBe(false);
    expect(s.by('yandex-live').calls).toHaveLength(1);
    expect(s.sleeps).toEqual([]);
    const quota = () => s.warnings.filter((w) => w.kind === 'quota-exhausted' && w.providerId === 'gemini').length;
    expect(quota()).toBe(1);
    s.state.cooldownUntil.clear();
    s.clock.advance(30_000);
    await s.run();
    expect(quota()).toBe(1);
    s.state.cooldownUntil.clear();
    s.clock.advance(31_000);
    await s.run();
    expect(quota()).toBe(2);
  });

  it('auth: warns, skips the tier for the session', async () => {
    const s = setup();
    s.by('yandex-live').script = [unavailable('yandex-live', 'auth')];
    const o = await s.run();
    expect(o).toMatchObject({ ok: true, providerId: 'yandex' });
    expect(s.warnings.map((w) => w.kind)).toEqual(['auth-required']);
    await s.run();
    expect(s.by('yandex-live').calls).toHaveLength(1);
    expect(s.state.authSkip.has('yandex-live')).toBe(true);
  });

  for (const kind of ['unsupported', 'failed', 'network'] as const) {
    it(`${kind}: retries the same tier once after 1.5 s, then falls through`, async () => {
      const s = setup();
      s.by('yandex-live').fallback = unavailable('yandex-live', kind);
      const o = await s.run();
      expect(o).toMatchObject({ ok: true, providerId: 'yandex' });
      expect(s.by('yandex-live').calls).toHaveLength(2);
      expect(s.sleeps).toEqual([1500]);
    });
  }

  it('retry on the same tier can succeed', async () => {
    const s = setup();
    s.by('yandex-live').script = [new Error('boom')];
    const o = await s.run();
    expect(o).toMatchObject({ ok: true, providerId: 'yandex-live' });
    expect(s.by('yandex-live').calls).toHaveLength(2);
  });

  it('cooldown after 2 consecutive failed chunks, expires after 5 min', async () => {
    const s = setup();
    s.by('yandex-live').fallback = unavailable('yandex-live', 'failed');
    await s.run();
    await s.run();
    expect(s.by('yandex-live').calls).toHaveLength(4);
    await s.run(); // cooling down
    expect(s.by('yandex-live').calls).toHaveLength(4);
    s.clock.advance(COOLDOWN_MS - 1);
    await s.run();
    expect(s.by('yandex-live').calls).toHaveLength(4);
    s.clock.advance(2);
    await s.run();
    expect(s.by('yandex-live').calls).toHaveLength(6);
  });

  it('a success resets the failure streak', async () => {
    const s = setup();
    const p = s.by('yandex-live');
    p.script = [new Error('a'), new Error('a'), { segments: [seg(0)] }, new Error('b'), new Error('b')];
    await s.run(); // fails (2 calls) -> falls to yandex
    await s.run(); // ok
    await s.run(); // fails again, but streak was reset => only 1 failure
    expect(s.state.cooldownUntil.get('yandex-live')).toBeUndefined();
  });

  it('all tiers failing reports ok:false with a no-provider warning', async () => {
    const s = setup(['gemini']);
    s.by('gemini').fallback = unavailable('gemini', 'network');
    expect((await s.run()).ok).toBe(false);
    expect(s.warnings.some((w) => w.kind === 'no-provider')).toBe(true);
    const none = setup([]);
    expect((await none.run()).ok).toBe(false);
  });

  it('subtitles are opt-in (I4)', async () => {
    const s = setup(['gemini']);
    await s.run();
    expect(s.by('gemini').calls[0]!.ctx.wantSubtitles).toBe(false);
    await s.run(settings({ subtitles: 'on' }));
    expect(s.by('gemini').calls[1]!.ctx.wantSubtitles).toBe(true);
  });

  it('rethrows when aborted', async () => {
    const s = setup(['gemini']);
    s.by('gemini').script = ['hang'];
    const ac = new AbortController();
    const p = runChain(chunk(0), s.providers, settings(), { signal: ac.signal, now: () => 0, sleep: async () => {}, warn: () => {} }, s.state);
    ac.abort();
    await expect(p).rejects.toThrow();
  });
});

describe('declined tier', () => {
  it('declined: no retry, tier skipped, falls through, warns once', async () => {
    const s = setup();
    s.by('yandex-live').fallback = unavailable('yandex-live', 'declined');
    const o = await s.run();
    expect(o).toMatchObject({ ok: true, providerId: 'yandex' });
    expect(s.by('yandex-live').calls).toHaveLength(1);
    expect(s.sleeps).toEqual([]);
    expect(s.warnings.map((w) => w.kind)).toEqual(['tier-declined']);
    await s.run();
    expect(s.by('yandex-live').calls).toHaveLength(1);
  });
});
