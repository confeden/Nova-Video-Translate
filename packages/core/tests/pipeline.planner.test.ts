import { describe, expect, it } from 'vitest';
import {
  GEMINI_MAX_PARALLEL,
  LatencyModel,
  TIER_PRIOR_SEC,
  TranslationEngine,
  createChainState,
  jobTimeoutMs,
  planCell,
  runChain,
  upgradeDecision,
  yandexTierCap,
  type PlanTier,
} from '../src/pipeline';
import { ProviderUnavailableError, type ChunkResult } from '../src/providers/types';
import type { Settings } from '../src/types';
import { FakeCapture, FakeProvider, FakeScheduler, FakeVideo, chunk, flush, instantSleep, seg, settings } from './helpers/pipelineFakes';

const T = (live: number, std: number, gem?: number): PlanTier[] =>
  [
    { id: 'yandex-live' as const, expectedSec: live },
    { id: 'yandex' as const, expectedSec: std },
    ...(gem === undefined ? [] : [{ id: 'gemini' as const, expectedSec: gem }]),
  ];

describe('LatencyModel', () => {
  it('starts at the priors and moves with samples (EWMA)', () => {
    let t = 0;
    const m = new LatencyModel(() => t);
    expect(m.expectedSec('yandex-live')).toBe(TIER_PRIOR_SEC['yandex-live']);
    expect(m.expectedSec('gemini')).toBe(20);
    const a = m.observe('yandex', 20_000);
    expect(a).toBeCloseTo(35); // first sample: half prior, half sample
    const b = m.observe('yandex', 20_000);
    expect(b).toBeCloseTo(35 * 0.6 + 20 * 0.4);
    expect(m.expectedSec('yandex-live')).toBe(90); // tiers are independent
  });
  it('decays back to the prior when idle', () => {
    let t = 0;
    const m = new LatencyModel(() => t, undefined, 60_000);
    m.observe('gemini', 60_000);
    m.observe('gemini', 60_000);
    const hot = m.expectedSec('gemini');
    expect(hot).toBeGreaterThan(40);
    t += 60_000; // one half-life
    expect(m.expectedSec('gemini')).toBeCloseTo(20 + (hot - 20) / 2);
    t += 10 * 60_000;
    expect(m.expectedSec('gemini')).toBeCloseTo(20, 0);
  });
  it('the server remainingTime is a weak hint, only before the first sample, clipped to 0.5-2 x prior', () => {
    const m = new LatencyModel(() => 0);
    m.hint('yandex-live', 543);
    expect(m.expectedSec('yandex-live')).toBeCloseTo(90 + 0.15 * 90); // clipped to 180
    m.observe('yandex-live', 72_800);
    expect(m.expectedSec('yandex-live')).toBeLessThan(90); // real sample wins over the hint
  });
  it('D26 live policy: a server ETA R sets the floor max(prior, R + 30 s), decays slowly, and faster jobs pull it down', () => {
    let t = 0;
    const m = new LatencyModel(() => t, undefined, 60_000);
    expect(m.etaKnown('yandex-live')).toBe(false);
    m.eta('yandex-live', 600);
    expect(m.etaKnown('yandex-live')).toBe(true);
    expect(m.expectedSec('yandex-live')).toBeCloseTo(630);
    expect(m.expectedSec('yandex-live', 60)).toBeCloseTo(630);
    expect(m.expectedSec('yandex')).toBe(50);
    m.eta('yandex-live', 10); // a tiny ETA never goes below the prior
    expect(m.expectedSec('yandex-live')).toBeCloseTo(90);
    m.eta('yandex-live', 600);
    t += 60_000; // one half-life
    expect(m.expectedSec('yandex-live')).toBeCloseTo(90 + 540 / 2);
    m.observe('yandex-live', 40_000); // a job that finished in 40 s pulls the floor down
    expect(m.expectedSec('yandex-live')).toBeLessThan(90 + 540 / 2);
  });
  it('a censored sample (deadline hit) pushes the estimate above the elapsed time', () => {
    const m = new LatencyModel(() => 0);
    m.observe('yandex-live', 90_000, true);
    m.observe('yandex-live', 90_000, true);
    expect(m.expectedSec('yandex-live')).toBeGreaterThan(95);
  });
});

describe('planCell: choice table', () => {
  // live 90, standard 50, gemini 20, margin 5
  const table: Array<[string, number, PlanTier[], string[], string]> = [
    ['everything in time -> preferred only', 120, T(90, 50, 20), ['yandex-live'], 'preferred-in-time'],
    ['live late, standard in time -> live + standard (not Gemini)', 70, T(90, 50, 20), ['yandex-live', 'yandex'], 'preferred-late-fallback'],
    ['only Gemini in time -> live + Gemini', 50, T(90, 50, 20), ['yandex-live', 'gemini'], 'preferred-late-fallback'],
    ['live hopeless (>2x timeToSlot) -> just Gemini', 30, T(90, 50, 20).map((t) => (t.id === 'yandex-live' ? { ...t, expectedSec: 140 } : t)), ['gemini'], 'preferred-late-fallback'],
    ['nobody in time -> fastest alone (Gemini)', 10, T(90, 50, 20), ['gemini'], 'none-in-time-fastest'],
    ['nobody in time, no Gemini -> standard beats live', 0, T(90, 50), ['yandex'], 'none-in-time-fastest'],
    ['slot already past -> fastest', -20, T(90, 50, 20), ['gemini'], 'none-in-time-fastest'],
    ['margin is respected: 50 + 5 > 54', 54, T(90, 50), ['yandex-live', 'yandex'].slice(1), 'none-in-time-fastest'],
    ['exactly on the margin is in time', 55, T(90, 50), ['yandex-live', 'yandex'], 'preferred-late-fallback'],
  ];
  it.each(table)('%s', (_n, tts, tiers, start, reason) => {
    const p = planCell({ timeToSlot: tts, tiers });
    expect(p.start).toEqual(start);
    expect(p.reason).toBe(reason);
  });
  it('Gemini first in the user order is the preferred tier (no quota discipline against the user order)', () => {
    const tiers: PlanTier[] = [
      { id: 'gemini', expectedSec: 20 },
      { id: 'yandex', expectedSec: 50 },
    ];
    expect(planCell({ timeToSlot: 40, tiers }).start).toEqual(['gemini']);
  });
  it('one usable tier: always that tier', () => {
    expect(planCell({ timeToSlot: -5, tiers: [{ id: 'yandex', expectedSec: 50 }] })).toMatchObject({ start: ['yandex'], reason: 'single', late: true });
  });
  it('no tier: nothing to start', () => {
    expect(planCell({ timeToSlot: 10, tiers: [] }).start).toEqual([]);
  });
});

describe('caps, timeouts, upgrade rules', () => {
  it('in-flight cap per Yandex tier = clamp(ceil(maxLatency/chunkSec)+3, 5, 10)', () => {
    expect(yandexTierCap(20, 15)).toBe(5); // 2+3 = 5
    expect(yandexTierCap(50, 15)).toBe(7); // 4+3
    expect(yandexTierCap(90, 15)).toBe(9); // 6+3
    expect(yandexTierCap(180, 15)).toBe(10); // 15 -> clamped
    expect(yandexTierCap(5, 15)).toBe(5); // floor
  });
  it('job deadline = max(60 s, min(180 s, timeToSlot + 20 s)); rewind-only jobs get the longest', () => {
    expect(jobTimeoutMs(10, false)).toBe(60_000);
    expect(jobTimeoutMs(100, false)).toBe(120_000);
    expect(jobTimeoutMs(500, false)).toBe(180_000);
    expect(jobTimeoutMs(-30, true)).toBe(180_000);
  });
  it('a tier expected to need 90 s is never given less than 1.4 x that', () => {
    expect(jobTimeoutMs(10, false, 90)).toBe(126_000);
    expect(jobTimeoutMs(10, false, 200)).toBe(180_000);
  });
  it('upgrade >= 3 s before the slot, silent swap after the slot, deferred while it plays or is imminent', () => {
    expect(upgradeDecision(100, 115, 90)).toBe('upgrade');
    expect(upgradeDecision(100, 115, 97)).toBe('upgrade'); // exactly 3 s
    expect(upgradeDecision(100, 115, 97.5)).toBe('defer');
    expect(upgradeDecision(100, 115, 105)).toBe('defer');
    expect(upgradeDecision(100, 115, 120)).toBe('swap-now');
  });
});

describe('runChain: planned race', () => {
  const mk = () => {
    const live = new FakeProvider('yandex-live');
    const std = new FakeProvider('yandex');
    const gem = new FakeProvider('gemini');
    const state = createChainState();
    const late: string[] = [];
    let t = 0;
    const run = (plan: Array<'yandex-live' | 'yandex' | 'gemini'>, over: object = {}, s: Settings = settings()) =>
      runChain(
        chunk(30),
        [live, std, gem],
        s,
        { signal: new AbortController().signal, now: () => t, sleep: async () => {}, warn: () => {}, plan, onLate: (w) => late.push(w.providerId), ...over },
        state,
      );
    return { live, std, gem, state, late, run, advance: (ms: number) => (t += ms) };
  };
  const slow = (r: { release?: () => void }): (() => Promise<ChunkResult>) => () =>
    new Promise((res) => {
      r.release = () => res({ segments: [seg(30)], sourceLang: 'en' });
    });

  it('starts both planned tiers at once; the fast fallback is delivered and the slow preferred one reports late', async () => {
    const h = mk();
    const gate: { release?: () => void } = {};
    h.live.script = [slow(gate)];
    const out = await h.run(['yandex-live', 'yandex']);
    expect(out).toMatchObject({ ok: true, providerId: 'yandex' });
    expect(h.live.calls).toHaveLength(1); // started immediately, not after a hedge delay
    expect(h.std.calls).toHaveLength(1);
    expect(h.late).toEqual([]);
    gate.release!();
    await flush();
    expect(h.late).toEqual(['yandex-live']);
  });
  it('a higher-priority win cancels the lower-priority racer and nothing is reported late', async () => {
    const h = mk();
    const gate: { release?: () => void } = {};
    h.std.script = [slow(gate)];
    const out = await h.run(['yandex-live', 'yandex']);
    expect(out).toMatchObject({ providerId: 'yandex-live' });
    expect(h.std.calls[0]!.ctx.signal.aborted).toBe(true);
    expect(h.late).toEqual([]);
  });
  it('if the racers all fail the chain falls through to the remaining tiers', async () => {
    const h = mk();
    h.live.fallback = new ProviderUnavailableError('x', 'yandex-live', 'declined');
    h.std.fallback = new ProviderUnavailableError('x', 'yandex', 'quota');
    const out = await h.run(['yandex-live', 'yandex']);
    expect(out).toMatchObject({ ok: true, providerId: 'gemini' });
  });
  it('a single planned tier goes first even when it is not the preferred one', async () => {
    const h = mk();
    const out = await h.run(['gemini']);
    expect(out).toMatchObject({ providerId: 'gemini' });
    expect(h.live.calls).toHaveLength(0);
  });
  it('passes the dynamic deadline and the remainingTime hook to the provider', async () => {
    const h = mk();
    const hints: number[] = [];
    await h.run(['yandex'], { deadlineMs: (id: string) => (id === 'yandex' ? 77_000 : undefined), onHint: (_i: string, s: number) => hints.push(s) });
    expect(h.std.calls[0]!.ctx.deadlineMs).toBe(77_000);
    h.std.calls[0]!.ctx.onHint?.(55);
    expect(hints).toEqual([55]);
  });
  it('a job-level timeout shorter than its dynamic deadline is not counted toward the cooldown; one past it is', async () => {
    const h = mk();
    const timeout = (id: 'yandex-live' | 'yandex') => new ProviderUnavailableError('job: timeout after 90000 ms', id, 'network', undefined, true);
    let now = 0;
    const clock = { now: () => now };
    // the provider "ran" only 10 s of a 120 s deadline: not counted
    h.live.script = [
      async () => {
        now += 10_000;
        throw timeout('yandex-live');
      },
      async () => {
        now += 10_000;
        throw timeout('yandex-live');
      },
    ];
    await h.run(['yandex-live'], { now: clock.now, deadlineMs: () => 120_000 }, settings({ voiceEnabled: { 'yandex-live': true, yandex: false, gemini: false } }));
    expect(h.state.cooldownUntil.get('yandex-live') ?? 0).toBe(0);
    // standard tier ran the whole deadline twice: counted, cooldown
    h.std.script = [
      async () => {
        now += 120_000;
        throw timeout('yandex');
      },
      async () => {
        now += 120_000;
        throw timeout('yandex');
      },
    ];
    await h.run(['yandex'], { now: clock.now, deadlineMs: () => 120_000 }, settings({ voiceEnabled: { 'yandex-live': false, yandex: true, gemini: false } }));
    expect(h.state.cooldownUntil.get('yandex') ?? 0).toBeGreaterThan(0);
  });
  it('D26 live policy: a live job that outlives its deadline is never retried, never cooled down and never warned about', async () => {
    const h = mk();
    let now = 0;
    const warns: string[] = [];
    const timeout = new ProviderUnavailableError('job: timeout after 144900 ms', 'yandex-live', 'network', undefined, true);
    h.live.script = [
      async () => {
        now += 145_000;
        throw timeout;
      },
      async () => {
        now += 145_000;
        throw timeout;
      },
      async () => {
        now += 145_000;
        throw timeout;
      },
    ];
    for (let i = 0; i < 3; i++) {
      await h.run(['yandex-live'], { now: () => now, deadlineMs: () => 145_000, warn: (w: { kind: string }) => warns.push(w.kind) }, settings({ voiceEnabled: { 'yandex-live': true, yandex: false, gemini: false } }));
    }
    expect(h.live.calls).toHaveLength(3); // one attempt per chunk, no retry
    expect(h.state.cooldownUntil.get('yandex-live') ?? 0).toBe(0);
    expect(h.state.timeouts.get('yandex-live') ?? 0).toBe(0);
    expect(warns).not.toContain('provider-failed');
  });
  it('a skipped tier is never started, not even as the fall-through', async () => {
    const h = mk();
    const out = await h.run(['yandex'], { skip: ['yandex-live'] });
    expect(out).toMatchObject({ ok: true, providerId: 'yandex' });
    expect(h.live.calls).toHaveLength(0);
  });
});

// ---- engine: planning, upgrade, discard, no double dub ----

function engineSetup(over: Partial<Settings> = {}, priors?: Partial<Record<'yandex-live' | 'yandex' | 'gemini', number>>) {
  const video = new FakeVideo();
  const providers = [new FakeProvider('yandex-live'), new FakeProvider('yandex'), new FakeProvider('gemini')];
  const caps: FakeCapture[] = [];
  const scheds: FakeScheduler[] = [];
  const voices: string[] = [];
  const clock = { t: 0 };
  const engine = new TranslationEngine({
    video: video as unknown as HTMLVideoElement,
    audioCtx: { state: 'running' } as AudioContext,
    yandexSuperCells: 1,
    providers,
    settings: settings({ voiceOrder: ['yandex-live', 'yandex', 'gemini'], ...over }),
    events: { onVoice: (v) => voices.push(v.providerId) },
    createCapture: (async () => {
      const c = new FakeCapture();
      caps.push(c);
      return c;
    }) as never,
    createScheduler: ((_v: unknown, _c: unknown, o: any) => {
      const s = new FakeScheduler(o);
      scheds.push(s);
      return s;
    }) as never,
    now: () => clock.t,
    sleep: instantSleep(),
    retryDelayMs: 10,
    latencyPriors: priors,
  });
  const by = (id: string) => providers.find((p) => p.id === id)!;
  return { video, engine, by, caps, scheds, voices, clock };
}
const gated = (r: { release?: () => void }, start: number) => (): Promise<ChunkResult> =>
  new Promise((res) => {
    r.release = () => res({ segments: [seg(start)], sourceLang: 'en' });
  });

describe('engine: deadline-driven tier racing', () => {
  it('start-up: the cell at the playhead goes to the fastest tier (Gemini), not the slow live tier', async () => {
    const e = engineSetup();
    await e.engine.start();
    e.caps[0]!.emit(chunk(0));
    await flush();
    expect(e.by('gemini').calls).toHaveLength(1);
    expect(e.by('yandex-live').calls).toHaveLength(0);
    expect(e.scheds[0]!.added.map((s) => s.providerId)).toEqual(['gemini']);
  });

  it('without Gemini the standard Yandex voices the first cell while live is predicted late', async () => {
    const e = engineSetup({ voiceEnabled: { 'yandex-live': true, yandex: true, gemini: false } });
    await e.engine.start();
    e.caps[0]!.emit(chunk(0));
    await flush();
    expect(e.by('yandex').calls).toHaveLength(1);
    expect(e.by('yandex-live').calls).toHaveLength(0);
  });

  it('D26 live policy: a far cell scouts live (raced with standard, ETA unknown); a mid cell never starts live (slot nearer than its latency), never Gemini while standard is in time', async () => {
    const e = engineSetup();
    e.by('yandex-live').script = ['hang', 'hang'];
    await e.engine.start();
    e.caps[0]!.emit(chunk(150));
    await flush();
    expect(e.by('yandex-live').calls.map((c) => c.chunk.startSec)).toEqual([150]);
    expect(e.by('yandex').calls.map((c) => c.chunk.startSec)).toEqual([150]); // scouting race
    e.caps[0]!.emit(chunk(75)); // live 90 > timeToSlot 75: gated out, standard 50+5 <= 75
    await flush();
    expect(e.by('yandex-live').calls.map((c) => c.chunk.startSec)).toEqual([150]);
    expect(e.by('yandex').calls.map((c) => c.chunk.startSec)).toContain(75);
    expect(e.by('gemini').calls).toHaveLength(0);
    e.engine.stop();
  });

  it('D26 live policy: the server ETA of a live job (R=600) raises live latency to R+30; live then starts nowhere nearer than that', async () => {
    const e = engineSetup({ voiceEnabled: { 'yandex-live': true, yandex: true, gemini: false } });
    e.by('yandex-live').script = ['hang', 'hang', 'hang'];
    await e.engine.start();
    e.caps[0]!.emit(chunk(150));
    await flush();
    e.by('yandex-live').calls[0]!.ctx.onHint?.(600);
    e.caps[0]!.emit(chunk(165));
    e.caps[0]!.emit(chunk(180));
    e.caps[0]!.emit(chunk(500)); // 500 < 630: still gated
    await flush();
    expect(e.by('yandex-live').calls.map((c) => c.chunk.startSec)).toEqual([150]);
    expect(e.by('yandex').calls.map((c) => c.chunk.startSec)).toEqual(expect.arrayContaining([150, 165, 180]));
    e.engine.stop();
  });

  it('D26 live policy: live in-flight cap is 1 in chunk mode (sole usable tier, no gating)', async () => {
    const e = engineSetup({ voiceEnabled: { 'yandex-live': true, yandex: false, gemini: false } });
    e.by('yandex-live').script = Array(20).fill('hang');
    await e.engine.start();
    for (let k = 0; k < 14; k++) e.caps[0]!.emit(chunk(100 + k * 15));
    await flush();
    expect(e.by('yandex-live').calls).toHaveLength(1);
    e.engine.stop();
  });

  it('upgrade: live arrives >= 3 s before the slot -> the standard dub is replaced, exactly one dub remains', async () => {
    const e = engineSetup({ voiceEnabled: { 'yandex-live': true, yandex: true, gemini: false } });
    const g: { release?: () => void } = {};
    e.by('yandex-live').script = [gated(g, 150)];
    await e.engine.start();
    e.caps[0]!.emit(chunk(150));
    await flush();
    expect(e.scheds[0]!.added.map((s) => s.providerId)).toEqual(['yandex']);
    e.video.currentTime = 100; // slot starts in 50 s
    g.release!();
    await flush();
    expect(e.scheds[0]!.added.map((s) => s.providerId)).toEqual(['yandex-live']);
    expect(e.scheds[0]!.removed.at(-1)!.n).toBe(1);
    expect(e.voices.at(-1)).toBe('yandex-live');
    e.engine.stop();
  });

  it('late higher tier while the slot plays: playback untouched (no double dub), swapped in after the slot for rewinds', async () => {
    const e = engineSetup({ voiceEnabled: { 'yandex-live': true, yandex: true, gemini: false } });
    const g: { release?: () => void } = {};
    e.by('yandex-live').script = [gated(g, 150)];
    await e.engine.start();
    e.caps[0]!.emit(chunk(150));
    await flush();
    e.video.currentTime = 155; // inside the slot
    g.release!();
    await flush();
    expect(e.scheds[0]!.added.map((s) => s.providerId)).toEqual(['yandex']); // untouched
    expect(e.scheds[0]!.removed).toHaveLength(0);
    e.video.currentTime = 166; // slot over
    e.video.dispatchEvent(new Event('timeupdate'));
    await flush();
    expect(e.scheds[0]!.added.map((s) => s.providerId)).toEqual(['yandex-live']);
    e.engine.stop();
  });

  it('a lower tier finishing after the higher one never replaces it', async () => {
    const e = engineSetup({ voiceEnabled: { 'yandex-live': true, yandex: true, gemini: false } });
    const g: { release?: () => void } = {};
    e.by('yandex').script = [gated(g, 150)];
    await e.engine.start();
    e.caps[0]!.emit(chunk(150));
    await flush();
    expect(e.scheds[0]!.added.map((s) => s.providerId)).toEqual(['yandex-live']);
    g.release?.();
    await flush();
    expect(e.scheds[0]!.added.map((s) => s.providerId)).toEqual(['yandex-live']);
  });

  it('Gemini parallelism is capped at 2 even when the fastest tier is wanted for every start-up cell', async () => {
    const e = engineSetup({ voiceEnabled: { 'yandex-live': false, yandex: false, gemini: true } });
    e.by('gemini').script = ['hang', 'hang', 'hang', 'hang'];
    await e.engine.start();
    for (const s of [0, 15, 30, 45]) e.caps[0]!.emit(chunk(s));
    await flush();
    expect(e.by('gemini').calls).toHaveLength(GEMINI_MAX_PARALLEL);
    e.engine.stop();
  });

  it('per-Yandex-tier in-flight cap follows the expected latency (standard 50 s => 7)', async () => {
    const e = engineSetup({ voiceEnabled: { 'yandex-live': false, yandex: true, gemini: false } });
    e.by('yandex').script = Array(20).fill('hang');
    await e.engine.start();
    for (let k = 0; k < 14; k++) e.caps[0]!.emit(chunk(100 + k * 15));
    await flush();
    expect(e.by('yandex').calls).toHaveLength(7);
    e.engine.stop();
  });

  it('the dynamic job deadline reaches the provider (live job 75 s ahead)', async () => {
    const e = engineSetup({ voiceEnabled: { 'yandex-live': true, yandex: false, gemini: false } });
    e.by('yandex-live').script = ['hang'];
    await e.engine.start();
    e.caps[0]!.emit(chunk(75));
    await flush();
    // max(60, min(180, 75+20)) = 95 s, but never below 1.4 x the 90 s prior = 126 s
    expect(e.by('yandex-live').calls[0]!.ctx.deadlineMs).toBe(126_000);
    e.engine.stop();
  });

  it('panel detail while preparing names the fastest tier and the later one', async () => {
    const states: Array<[string, any]> = [];
    const video = new FakeVideo();
    const caps: FakeCapture[] = [];
    const engine = new TranslationEngine({
      video: video as unknown as HTMLVideoElement,
      audioCtx: { state: 'running' } as AudioContext,
      yandexSuperCells: 1,
      providers: [new FakeProvider('yandex-live'), new FakeProvider('yandex'), new FakeProvider('gemini')].map((p) => {
        p.script = ['hang'];
        return p;
      }),
      settings: settings({ voiceOrder: ['yandex-live', 'yandex', 'gemini'] }),
      events: { onState: (s, d) => states.push([s, d]) },
      createCapture: (async () => {
        const c = new FakeCapture();
        caps.push(c);
        return c;
      }) as never,
      createScheduler: (() => new FakeScheduler()) as never,
      now: () => 0,
      sleep: instantSleep(),
    });
    await engine.start();
    caps[0]!.emit(chunk(0));
    await flush();
    const prep = states.filter(([s, d]) => s === 'starting' && d.preparing).at(-1)![1];
    expect(prep.etaProvider).toBe('gemini');
    expect(prep.later).toBe('yandex-live');
    expect(prep.etaSec).toBe(20);
    engine.stop();
  });
});

describe('planCell: local-first (D32)', () => {
  const L = { id: 'local' as const, expectedSec: 8 };
  it('local starts with the cloud plan when a Yandex tier is preferred', () => {
    const p = planCell({ timeToSlot: 120, tiers: [{ id: 'yandex-live', expectedSec: 90 }, { id: 'yandex', expectedSec: 50 }, L], localFirst: true });
    expect(p.start).toEqual(['local', 'yandex-live']);
    expect(p.reason).toBe('local-first');
    expect(p.preferred).toBe('yandex-live');
  });
  it('local is started also when the cloud tier is late', () => {
    const p = planCell({ timeToSlot: 30, tiers: [{ id: 'yandex', expectedSec: 50 }, L], localFirst: true });
    expect(p.start[0]).toBe('local');
    expect(p.start).toContain('yandex');
  });
  it('local preferred or no local tier: plan unchanged', () => {
    const cloud = [{ id: 'yandex' as const, expectedSec: 50 }];
    expect(planCell({ timeToSlot: 120, tiers: [L, ...cloud], localFirst: true }).reason).toBe('preferred-in-time');
    expect(planCell({ timeToSlot: 120, tiers: cloud, localFirst: true }).reason).toBe('single');
  });
  it('off by default', () => {
    expect(planCell({ timeToSlot: 120, tiers: [{ id: 'yandex', expectedSec: 50 }, L] }).start).toEqual(['yandex']);
  });
});
