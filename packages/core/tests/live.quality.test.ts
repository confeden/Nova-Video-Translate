import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { diag } from '../src/diag';
import { TranslationEngine } from '../src/pipeline';
import { localReasons } from '../src/localasr';
import { normalizeSettings, withSiteOverride } from '../src/settings';
import { DEFAULT_SETTINGS } from '../src/types';
import {
  LIVE_YANDEX_BACKOFF_MS,
  LIVE_YANDEX_PROBE_RESULTS,
  YandexLiveGate,
  qualityDelayCapSec,
  qualityDelaySec,
  qualityExtraJumpSec,
} from '../src/live/liveQuality';
import type { ChunkResult } from '../src/providers/types';
import { FakeCapture, FakeProvider, FakeScheduler, flush, instantSleep, seg, settings } from './helpers/pipelineFakes';

const ranges = (...r: Array<[number, number]>) => ({ length: r.length, start: (i: number) => r[i]![0], end: (i: number) => r[i]![1] });

class LiveVideo extends EventTarget {
  volume = 1;
  paused = false;
  ended = false;
  duration = Infinity;
  seekable = ranges([0, 1073741824]);
  buffered = ranges([0, 400]);
  seeks: number[] = [];
  private _ct: number;
  constructor(ct: number) {
    super();
    this._ct = ct;
  }
  get currentTime(): number {
    return this._ct;
  }
  set currentTime(x: number) {
    this._ct = x;
    this.seeks.push(x);
  }
  /** playback moves on without a seek */
  play(to: number): void {
    this._ct = to;
  }
}

const ev = (name: string) => diag.entries().filter((x) => x.ev === name);
const chunk = (startSec: number, durationSec = 8) => ({ startSec, durationSec, sampleRate: 16000, pcm: new Int16Array(8) });

function deferred(): { p: Promise<ChunkResult>; ok: (r?: ChunkResult) => void; fail: (e: Error) => void } {
  let ok!: (r?: ChunkResult) => void;
  let fail!: (e: Error) => void;
  const p = new Promise<ChunkResult>((res, rej) => {
    ok = (r) => res(r ?? { segments: [seg(0)], sourceLang: 'en' });
    fail = rej;
  });
  return { p, ok, fail };
}

interface SetupOpts {
  host?: string;
  ct?: number;
  mode?: 'fast' | 'quality';
  kind?: 'hls' | 'mse';
  withYandex?: boolean;
}

async function setup({ host = 'www.twitch.tv', ct = 90, mode = 'quality', kind = 'hls', withYandex = true }: SetupOpts = {}) {
  const video = new LiveVideo(ct);
  const local = new FakeProvider('local');
  const yandex = new FakeProvider('yandex');
  const sched: FakeScheduler[] = [];
  let cap!: FakeCapture;
  const providers = withYandex ? [yandex, local] : [local];
  const engine = new TranslationEngine({
    video: video as unknown as HTMLVideoElement,
    audioCtx: {} as AudioContext,
    providers,
    settings: settings({ liveMode: mode, liveDelaySec: -1, dubLagSec: 1, voiceEnabled: { ...DEFAULT_SETTINGS.voiceEnabled, 'yandex-live': false, yandex: true, local: true } }),
    host,
    createCapture: (async () => {
      cap = new FakeCapture();
      cap.kind = kind;
      return cap;
    }) as never,
    createScheduler: ((_v: unknown, _c: unknown, o: any) => {
      const s = new FakeScheduler(o);
      sched.push(s);
      return s;
    }) as never,
    now: () => 1_000_000,
    sleep: instantSleep(),
    dupTimer: (_ms: number, signal: AbortSignal) => new Promise<void>((_, rej) => signal.addEventListener('abort', () => rej(new Error('x')), { once: true })),
    retryDelayMs: 10,
    hlsProbeEveryMs: 3_600_000,
    watchdogMs: 3_600_000,
  });
  await engine.start();
  await flush();
  return { engine, e: engine as any, video, local, yandex, sched, cap: () => cap };
}

beforeEach(() => diag.clear());
afterEach(() => localReasons.clearAll());

describe('liveMode setting', () => {
  it('defaults to fast and normalizes anything else to fast', () => {
    expect(DEFAULT_SETTINGS.liveMode).toBe('fast');
    expect(normalizeSettings(undefined).liveMode).toBe('fast');
    expect(normalizeSettings({ liveMode: 'bogus' }).liveMode).toBe('fast');
    expect(normalizeSettings({ liveMode: 'quality' }).liveMode).toBe('quality');
  });

  it('fast: a live video (also on Twitch) is local only; quality: yandex > yandex-live order kept, local forced on, groq/gemini off', () => {
    const fast = withSiteOverride(DEFAULT_SETTINGS, 'www.twitch.tv', true);
    expect(fast.voiceEnabled).toMatchObject({ 'yandex-live': false, yandex: false, local: true });
    const q = withSiteOverride({ ...DEFAULT_SETTINGS, liveMode: 'quality' }, 'www.twitch.tv', true);
    expect(q.voiceOrder.slice(0, 3)).toEqual(['yandex-live', 'yandex', 'local']);
    expect(q.voiceEnabled).toMatchObject({ 'yandex-live': true, yandex: true, local: true, groq: false, gemini: false });
    // a tier the user switched off stays off; a non-live Twitch video keeps the host rule
    const off = withSiteOverride({ ...DEFAULT_SETTINGS, liveMode: 'quality', voiceEnabled: { ...DEFAULT_SETTINGS.voiceEnabled, yandex: false } }, 'youtube.com', true);
    expect(off.voiceEnabled.yandex).toBe(false);
    expect(withSiteOverride({ ...DEFAULT_SETTINGS, liveMode: 'quality' }, 'www.twitch.tv', false).voiceEnabled.yandex).toBe(false);
  });
});

describe('quality delay helpers', () => {
  it('cap 28 s on twitch.tv, 60 s elsewhere; target = min(back-buffer - 1, cap)', () => {
    expect(qualityDelayCapSec('www.twitch.tv')).toBe(28);
    expect(qualityDelayCapSec('m.twitch.tv')).toBe(28);
    expect(qualityDelayCapSec('youtube.com')).toBe(60);
    expect(qualityDelaySec(60, 'twitch.tv')).toBe(28);
    expect(qualityDelaySec(60, 'youtube.com')).toBe(59);
    expect(qualityDelaySec(500, 'youtube.com')).toBe(60);
    expect(qualityDelaySec(20, 'twitch.tv')).toBe(19);
    expect(qualityDelaySec(3, 'twitch.tv')).toBe(0);
  });

  it('the extra jump replays at most 8 s and needs >= 3 s', () => {
    expect(qualityExtraJumpSec(30, 20, 'twitch.tv')).toBe(8);
    expect(qualityExtraJumpSec(30, 26, 'twitch.tv')).toBe(0); // 2 s left to the cap
    expect(qualityExtraJumpSec(5, 10, 'twitch.tv')).toBe(4);
    expect(qualityExtraJumpSec(3, 10, 'twitch.tv')).toBe(0);
  });
});

describe('YandexLiveGate', () => {
  const tier = (id: 'yandex' | 'yandex-live', expectedSec: number) => ({ id, expectedSec });

  it('probes with every free slot until 6 results, then judges by the model; backs off for 5 min when even the best tier cannot fit the budget', () => {
    let t = 0;
    const g = new YandexLiveGate(() => t);
    for (let i = 0; i < LIVE_YANDEX_PROBE_RESULTS; i++) {
      expect(g.decide({ ttsSec: 5, budgetSec: 28, tiers: [tier('yandex', 50)] }).reason).toBe('probe');
      g.record();
    }
    const d = g.decide({ ttsSec: 20, budgetSec: 28, tiers: [tier('yandex', 40)] });
    expect(d.reason).toBe('backoff-start');
    expect(d.send).toEqual([]);
    expect(d.backoff).toMatchObject({ results: 6, bestExpectedSec: 40, budgetSec: 28 });
    t += LIVE_YANDEX_BACKOFF_MS - 1;
    expect(g.decide({ ttsSec: 20, budgetSec: 28, tiers: [tier('yandex', 5)] }).reason).toBe('backoff');
    t += 2;
    expect(g.decide({ ttsSec: 20, budgetSec: 28, tiers: [tier('yandex', 40)] }).reason).toBe('probe'); // re-probe after the backoff
  });

  it('after the probe a fast tier is used per cell; a cell that is too early for it is skipped without a backoff', () => {
    const g = new YandexLiveGate(() => 0);
    for (let i = 0; i < 6; i++) g.record();
    expect(g.decide({ ttsSec: 25, budgetSec: 28, tiers: [tier('yandex', 15)] })).toMatchObject({ reason: 'in-time', send: ['yandex'] });
    expect(g.decide({ ttsSec: 12, budgetSec: 28, tiers: [tier('yandex', 15)] })).toMatchObject({ reason: 'late', send: [] });
    expect(g.inBackoff()).toBe(false);
  });
});

describe('engine: quality live mode', () => {
  it('fast mode never asks Yandex', async () => {
    const { engine, local, yandex, cap } = await setup({ mode: 'fast' });
    cap().emit(chunk(100));
    await flush(30);
    expect(yandex.calls).toHaveLength(0);
    expect(local.calls.length).toBeGreaterThan(0);
    engine.stop();
  });

  it('the local dub is delivered at once; a Yandex dub slower than the slot is kept out of the scheduler (no replacement)', async () => {
    const { engine, e, local, yandex, sched, video, cap } = await setup();
    const d = deferred();
    yandex.script = [() => d.p];
    cap().emit(chunk(100));
    await flush(30);
    expect(local.calls).toHaveLength(1);
    expect(yandex.calls).toHaveLength(1);
    expect(e.cellProvider.get(100)).toBe('local');
    const s = sched[0]!;
    const before = s.added.length;
    expect(before).toBeGreaterThan(0);
    // the slot (100 + 1 s lag) is 2 s away when Yandex finally answers
    video.play(99);
    d.ok({ segments: [seg(100, 108)], sourceLang: 'en' });
    await flush(30);
    expect(e.cellProvider.get(100)).toBe('local');
    expect(s.removed).toHaveLength(0);
    expect(s.added).toHaveLength(before);
    expect(ev('yandex-live-lat')).toHaveLength(1);
    expect(ev('yandex-live-lat')[0]!.data).toMatchObject({ tier: 'yandex', cells: 1, audioSec: 4, ok: true, late: true });
    engine.stop();
  });

  it('a Yandex dub that arrives 4 s before the slot replaces the local dub in the scheduler (old fades, new is added once)', async () => {
    const { engine, e, local, yandex, sched, video, cap } = await setup();
    const d = deferred();
    yandex.script = [() => d.p];
    cap().emit(chunk(100));
    await flush(30);
    const s = sched[0]!;
    expect(e.cellProvider.get(100)).toBe('local');
    video.play(97); // slot 101 is 4 s ahead
    d.ok({ segments: [seg(100, 108)], sourceLang: 'en' });
    await flush(30);
    expect(e.cellProvider.get(100)).toBe('yandex');
    expect(s.removed.some((r) => r.n > 0 && r.opts?.reason === 'tier-upgrade')).toBe(true);
    expect(s.added.every((x) => x.providerId === 'yandex')).toBe(true);
    expect(s.added).toHaveLength(1);
    expect(ev('tier-upgrade')[0]!.data).toMatchObject({ cell: 100, from: 'local', to: 'yandex', mode: 'upgrade' });
    expect(ev('yandex-live-lat')[0]!.data).toMatchObject({ ok: true, late: false });
    expect(local.calls).toHaveLength(1);
    engine.stop();
  });

  it('twitch: the delay target is capped at 28 s; the first dub triggers ONE rewind of that size', async () => {
    const { engine, e, video, cap } = await setup({ host: 'www.twitch.tv', ct: 90 });
    expect(e.effectiveLiveDelaySec()).toBe(28);
    cap().emit(chunk(100));
    await flush(30);
    expect(video.seeks).toEqual([62]);
    expect(e.liveDelay.appliedSec()).toBe(28);
    engine.stop();
  });

  it('youtube live (mse): the target is min(back-buffer - 1, 60 s)', async () => {
    const { engine, e, video, cap } = await setup({ host: 'www.youtube.com', ct: 300, kind: 'mse' });
    expect(e.effectiveLiveDelaySec()).toBe(60);
    cap().emit(chunk(310));
    await flush(30);
    expect(video.seeks).toEqual([240]);
    engine.stop();
    const s2 = await setup({ host: 'www.youtube.com', ct: 30, kind: 'mse' });
    expect(s2.e.effectiveLiveDelaySec()).toBe(29);
    s2.engine.stop();
  });

  it('one extra jump at most, replaying <= 8 s, then never again', async () => {
    let clock = 1_000_000;
    const { engine, e, video, cap } = await setup({ host: 'www.twitch.tv', ct: 90 });
    e.deps.now = () => clock;
    video.buffered = ranges([80, 400]); // only 10 s of back-buffer at the first dub
    cap().emit(chunk(100));
    await flush(30);
    expect(video.seeks).toEqual([81]); // min(10 - 1, 28)
    expect(e.liveDelay.appliedSec()).toBe(9);
    // too early after the first rewind: no jump
    video.buffered = ranges([40, 400]);
    e.maybeRewindForDub([{ start: 90, end: 91 }]);
    expect(ev('rewind-extra')).toHaveLength(0);
    clock += 30_000;
    e.maybeRewindForDub([{ start: 90, end: 91 }]);
    await flush(30);
    expect(ev('rewind-extra')).toHaveLength(1);
    expect(video.seeks).toEqual([81, 73]); // min(41 - 1, 28 - 9) = 19 -> cut to 8
    expect(e.liveDelay.appliedSec()).toBe(17);
    clock += 120_000;
    e.maybeRewindForDub([{ start: 90, end: 91 }]);
    await flush(30);
    expect(ev('rewind-extra')).toHaveLength(1);
    expect(video.seeks).toHaveLength(2);
    engine.stop();
  });

  it('Yandex unavailable: status key "quality-slow" is set and behaviour stays fast', async () => {
    const { engine, yandex, local, cap } = await setup({ withYandex: false });
    expect(localReasons.first()?.text).toBe('Яндекс не успевает, работает быстрый режим');
    cap().emit(chunk(100));
    await flush(30);
    expect(yandex.calls).toHaveLength(0);
    expect(local.calls.length).toBeGreaterThan(0);
    engine.stop();
  });

  it('after 6 slow Yandex results the engine stops sending and logs yandex-live-skip', async () => {
    const { engine, e, yandex, local, cap } = await setup();
    yandex.fallback = new Error('slow');
    for (let i = 0; i < 6; i++) e.yandexGate.record();
    // a Yandex tier that the model says needs 50 s, a cell with the whole budget of ~28 s
    cap().emit(chunk(100));
    await flush(30);
    expect(yandex.calls).toHaveLength(0);
    expect(ev('yandex-live-skip').length).toBeGreaterThan(0);
    expect(ev('yandex-live-skip')[0]!.data).toMatchObject({ why: 'too-slow', backoffMin: 5 });
    expect(local.calls).toHaveLength(1);
    expect(localReasons.first()?.text).toBe('Яндекс не успевает, работает быстрый режим');
    cap().emit(chunk(108));
    await flush(30);
    expect(yandex.calls).toHaveLength(0);
    engine.stop();
  });
});
