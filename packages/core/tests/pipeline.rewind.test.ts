import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { diag } from '../src/diag';
import { TranslationEngine, STALL_RESTART_GAP_MS, STALL_NO_CHUNK_SEC, HEALTH_EVERY_MS } from '../src/pipeline';
import { localReasons } from '../src/localasr';
import type { CaptureOptions } from '../src/capture';
import type { DubSegment } from '../src/providers/types';
import { FakeCapture, FakeProvider, FakeScheduler, flush, instantSleep, seg, settings } from './helpers/pipelineFakes';

const ranges = (...r: Array<[number, number]>) => ({ length: r.length, start: (i: number) => r[i]![0], end: (i: number) => r[i]![1] });

class LiveVideo extends EventTarget {
  volume = 1;
  paused = false;
  ended = false;
  duration = Infinity;
  seekable = ranges([0, 1073741824]);
  buffered = ranges([0, 41]);
  seeks: number[] = [];
  private _ct = 37;
  get currentTime(): number {
    return this._ct;
  }
  set currentTime(x: number) {
    this._ct = x;
    this.seeks.push(x);
  }
}

type Cap = FakeCapture & {
  adEnd: number | undefined;
  opts: CaptureOptions;
  inGap: () => boolean;
  gapCount: () => number;
  softRestart: ReturnType<typeof vi.fn>;
  state: () => { aligned: boolean };
};

interface SetupOpts {
  kind?: 'hls' | 'realtime' | 'mse';
  over?: Partial<ReturnType<typeof settings>>;
}

async function setup({ kind = 'hls', over = {} }: SetupOpts = {}) {
  const video = new LiveVideo();
  const provider = new FakeProvider('local');
  provider.fallback = { segments: [seg(24.14, 29.6)], sourceLang: 'en' };
  const sched: FakeScheduler[] = [];
  const caps: Cap[] = [];
  const gap = { v: false };
  let clock = 1_000_000;
  const engine = new TranslationEngine({
    video: video as unknown as HTMLVideoElement,
    audioCtx: {} as AudioContext,
    providers: [provider],
    settings: settings({ voiceOrder: ['local'], voiceEnabled: { local: true }, liveDelaySec: -1, dubLagSec: 1, ...over }),
    host: 'www.twitch.tv',
    createCapture: (async (_v: unknown, o: CaptureOptions = {}) => {
      const c = Object.assign(new FakeCapture(), {
        opts: o,
        adEnd: 28 as number | undefined,
        inGap: () => gap.v,
        gapCount: () => 2,
        softRestart: vi.fn(),
        state: () => ({ aligned: true }),
      }) as unknown as Cap;
      c.kind = caps.length === 0 ? kind : 'realtime';
      (c as unknown as { adEndSec: () => number | undefined }).adEndSec = () => c.adEnd;
      caps.push(c);
      return c;
    }) as never,
    createScheduler: ((_v: unknown, _c: unknown, o: any) => {
      const s = new FakeScheduler(o);
      s.onStarve = o.onStarve;
      sched.push(s);
      return s;
    }) as never,
    now: () => clock,
    sleep: instantSleep(),
    retryDelayMs: 10,
    hlsProbeEveryMs: 3_600_000,
    watchdogMs: 3_600_000, // the tests call watchdogTick() themselves
  });
  await engine.start();
  const e = engine as any;
  return { engine, e, video, caps, provider, sched, gap, advance: (ms: number) => (clock += ms), now: () => clock };
}

const lateChunk = (startSec: number) => ({ startSec, durationSec: 8, sampleRate: 16000, pcm: new Int16Array(8) });
const ev = (name: string) => diag.entries().filter((x) => x.ev === name);

beforeEach(() => diag.clear());
afterEach(() => localReasons.clearAll());

describe('engine: ONE rewind per session part (hls)', () => {
  it('after the first rewind the wanted total equals the applied delay: no raise, no second seek, health shows rewinds / gaps', async () => {
    const { engine, e, video, caps, advance } = await setup();
    await flush();
    caps[0]!.emit(lateChunk(24));
    await flush(30);
    expect(video.seeks).toEqual([30]);
    expect(e.liveDelay.appliedSec()).toBe(7);
    expect(e.liveDelayWantedSec()).toBe(e.liveDelay.appliedSec());

    for (let i = 0; i < 4; i++) {
      advance(4000);
      e.ensureLiveDelay();
      await flush(5);
    }
    expect(e.liveDelayWantedSec()).toBe(e.liveDelay.appliedSec());
    expect(video.seeks).toEqual([30]);
    expect(ev('live-delay-raise')).toHaveLength(0);

    e.wd.lastHealthAt = 0;
    engine.watchdogTick();
    const h = ev('health');
    expect(h).toHaveLength(1);
    expect(h[0]!.data).toMatchObject({ rewinds: 1, gaps: 2 });
    expect(typeof (h[0]!.data as any).rewinds).toBe('number');
    expect(typeof (h[0]!.data as any).gaps).toBe('number');
    engine.stop();
  });
});

describe('engine: extra jump gate (maybeExtraRewind)', () => {
  // state after the first rewind: applied 7 s, lastRewindAt = now
  async function afterFirstRewind() {
    const s = await setup();
    s.caps[0]!.emit(lateChunk(24));
    await flush(30);
    expect(s.video.seeks).toEqual([30]);
    s.e.effectiveLiveDelaySec = () => 16; // the measured pipeline wants much more
    // keep the ad floor so that a requested jump itself cannot seek (lets us look at the wanted total)
    return s;
  }
  const lateDub = (e: any) => e.maybeRewindForDub([{ start: 5, end: 6 } as DubSegment]);

  it('no extra jump when lateRun < 3', async () => {
    const { engine, e, advance } = await afterFirstRewind();
    advance(61_000);
    e.lateRun = 2;
    lateDub(e);
    expect(ev('rewind-extra')).toHaveLength(0);
    expect(e.liveDelayWantedSec()).toBe(e.liveDelay.appliedSec());
    engine.stop();
  });

  it('no extra jump less than 60 s after the last seek', async () => {
    const { engine, e, advance } = await afterFirstRewind();
    advance(30_000);
    e.lateRun = 5;
    lateDub(e);
    expect(ev('rewind-extra')).toHaveLength(0);
    expect(e.liveDelayWantedSec()).toBe(e.liveDelay.appliedSec());
    engine.stop();
  });

  it('no extra jump when the effective delay exceeds the applied one by less than 3 s', async () => {
    const { engine, e } = await afterFirstRewind();
    e.effectiveLiveDelaySec = () => 9; // applied 7 -> only 2 s more
    e.lateRun = 3;
    e.lastRewindAt = Date.now() - 61_000;
    e.nowMs = () => Date.now();
    lateDub(e);
    expect(ev('rewind-extra')).toHaveLength(0);
    engine.stop();
  });

  it('lateRun >= 3, >= 60 s since the last seek, gain >= 3 s: an extra jump of at most 6 s is requested', async () => {
    const { engine, e, advance, now } = await afterFirstRewind();
    advance(61_000);
    e.lateRun = 3;
    expect(now() - e.lastRewindAt).toBeGreaterThanOrEqual(60_000);
    const applied = e.liveDelay.appliedSec();
    lateDub(e);
    const x = ev('rewind-extra');
    expect(x).toHaveLength(1);
    const sec = (x[0]!.data as { sec: number }).sec;
    expect(sec).toBeLessThanOrEqual(6);
    expect(sec).toBeGreaterThanOrEqual(3);
    expect(e.liveDelayWantedSec()).toBeCloseTo(applied + e.extraRewindSec, 6);
    expect(e.extraRewindSec).toBeCloseTo(sec, 0);
    engine.stop();
  });

  it('an extra jump is reachable through a further late dub arriving (lastRewindAt set explicitly)', async () => {
    const { engine, e, caps, video, advance } = await afterFirstRewind();
    advance(61_000);
    video.currentTime = 40; // playback went on; the next cell is already late again
    e.lateRun = 2; // the next late dub makes it 3
    e.lastRewindAt = e.nowMs() - 61_000;
    caps[0]!.emit(lateChunk(32));
    await flush(30);
    expect(ev('chunk-voiced').length).toBeGreaterThan(1);
    expect(e.lateRun).toBeGreaterThanOrEqual(3);
    expect(ev('rewind-extra')).toHaveLength(1);
    engine.stop();
  });

  it('after a player reset rewindSlot is cleared and the next late dub rewinds again (first-style)', async () => {
    const { engine, e, video, caps, advance } = await setup();
    caps[0]!.emit(lateChunk(24));
    await flush(30);
    expect(video.seeks).toEqual([30]);
    expect(e.rewindSlot).toBeDefined();
    expect(ev('rewind-ready')).toHaveLength(1);
    // the own seek completes, the guard window passes
    video.dispatchEvent(new Event('seeked'));
    await flush(5);
    advance(4000);
    // the player rebuilds its timeline: currentTime drops from > 20 to < 2
    video.currentTime = 1;
    video.dispatchEvent(new Event('seeking'));
    video.dispatchEvent(new Event('seeked'));
    await flush(5);
    expect(ev('timeline-reset')).toHaveLength(1);
    expect(e.rewindSlot).toBeUndefined();
    expect(e.liveDelay.appliedSec()).toBe(0);
    // playback goes on, and a late dub arrives again
    video.currentTime = 40;
    const seeksBefore = video.seeks.length;
    caps[0]!.emit(lateChunk(24));
    await flush(30);
    expect(ev('rewind-ready')).toHaveLength(2);
    expect(video.seeks.length).toBe(seeksBefore + 1);
    expect(video.seeks.at(-1)).toBeLessThan(40);
    engine.stop();
  });
});

describe('engine: watchdog on a gap and soft restarts (hls)', () => {
  const chunk = { startSec: 0, durationSec: 15, sampleRate: 16000, pcm: new Int16Array(16) };

  it('a gap stall never restarts and is logged once; then no-chunks soft-restarts; the third restart recreates the capture', async () => {
    const { engine, e, caps, gap, advance } = await setup({ over: { liveDelaySec: 0 } });
    await flush();
    const n0 = caps.length;
    gap.v = true;
    advance((STALL_NO_CHUNK_SEC + 1) * 1000);
    for (let i = 0; i < 4; i++) {
      engine.watchdogTick();
      advance(1000);
    }
    await flush();
    const stalls = ev('stall').map((x) => (x.data as { what: string }).what);
    expect(stalls).toEqual(['gap']);
    expect(caps.length).toBe(n0);
    expect(caps[0]!.softRestart).not.toHaveBeenCalled();
    expect(caps[0]!.stopped).toBe(false);
    expect(localReasons.first()?.key).not.toBe('restart');

    // the gap is over, the stall persists
    gap.v = false;
    engine.watchdogTick();
    await flush();
    expect(ev('stall').map((x) => (x.data as { what: string }).what)).toEqual(['gap', 'no-chunks']);
    expect(caps[0]!.softRestart).toHaveBeenCalledTimes(1);
    expect(caps.length).toBe(n0);
    expect(e.wd.softRestarts).toBe(1);

    advance(STALL_RESTART_GAP_MS + 1000);
    engine.watchdogTick();
    await flush();
    expect(caps[0]!.softRestart).toHaveBeenCalledTimes(2);
    expect(caps.length).toBe(n0);

    advance(STALL_RESTART_GAP_MS + 1000);
    engine.watchdogTick();
    await flush();
    expect(caps[0]!.softRestart).toHaveBeenCalledTimes(2); // not a third soft restart
    expect(caps.length).toBe(n0 + 1); // the capture was recreated
    expect(caps[0]!.stopped).toBe(true);
    engine.stop();
  });

  it('a chunk arriving resets the soft-restart counter', async () => {
    const { engine, e, caps, advance } = await setup({ over: { liveDelaySec: 0 } });
    await flush();
    const n0 = caps.length;
    advance((STALL_NO_CHUNK_SEC + 1) * 1000);
    engine.watchdogTick();
    advance(STALL_RESTART_GAP_MS + 1000);
    engine.watchdogTick();
    await flush();
    expect(caps[0]!.softRestart).toHaveBeenCalledTimes(2);
    expect(e.wd.softRestarts).toBe(2);

    caps[0]!.emit(chunk);
    expect(e.wd.softRestarts).toBe(0);

    advance(Math.max(STALL_NO_CHUNK_SEC, STALL_RESTART_GAP_MS / 1000) * 1000 + 1000);
    engine.watchdogTick();
    await flush();
    expect(caps[0]!.softRestart).toHaveBeenCalledTimes(3); // soft again, not a recreate
    expect(caps.length).toBe(n0);
    engine.stop();
  });

  it('health line keeps working with the HEALTH_EVERY_MS cadence', async () => {
    const { engine, advance } = await setup({ over: { liveDelaySec: 0 } });
    advance(HEALTH_EVERY_MS + 1);
    engine.watchdogTick();
    expect(ev('health')).toHaveLength(1);
    engine.stop();
  });
});

describe('engine: holdCellsToEnd is ignored with the hls capture', () => {
  async function pendingAfterStale(kind: 'hls' | 'realtime') {
    const { engine, e, caps } = await setup({ kind, over: { holdCellsToEnd: true, liveDelaySec: 0 } });
    await flush();
    const cs: number = e.cellSec();
    const ct = e.deps.video.currentTime; // 37
    const S = Math.floor(ct / cs) * cs;
    expect(S).toBeLessThan(ct);
    // the first half of a mid-stream cell, with the playhead inside that cell
    caps[0]!.emit({ startSec: S, durationSec: cs / 2, sampleRate: 16000, pcm: new Int16Array(8) });
    expect(e.rechunker.pending).toBe(1);
    e.rechunker.flushStale(Date.now() + 9000);
    const pending: number = e.rechunker.pending;
    engine.stop();
    return pending;
  }

  it('realtime capture: the partial cell is held until playback passes its end', async () => {
    expect(await pendingAfterStale('realtime')).toBe(1);
  });

  it('hls capture: the setting is ignored, the partial cell is not held', async () => {
    expect(await pendingAfterStale('hls')).toBe(0);
  });
});

describe('engine: retime passes maxPlayingMoveSec to the scheduler', () => {
  it('a retime status calls shiftSegmentsWhere with maxPlayingMoveSec: 1', async () => {
    const { engine, caps, sched, provider } = await setup();
    provider.fallback = { segments: [seg(30, 34)], sourceLang: 'en' };
    const s = sched[0]!;
    const calls: Array<{ d: number; o: any }> = [];
    (s as unknown as { shiftSegmentsWhere: (p: (x: DubSegment) => boolean, d: number, o?: any) => number }).shiftSegmentsWhere = (p, d, o) => {
      calls.push({ d, o });
      return s.added.filter(p).length;
    };
    caps[0]!.emit({ startSec: 24, durationSec: 8, sampleRate: 16000, pcm: new Int16Array(8), provisional: true });
    await flush(30);
    expect(s.added.length).toBe(1);
    caps[0]!.opts.onStatus!({ type: 'retime', shiftSec: -3 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.d).toBe(-3);
    expect(calls[0]!.o).toMatchObject({ maxPlayingMoveSec: 1 });
    engine.stop();
  });
});
