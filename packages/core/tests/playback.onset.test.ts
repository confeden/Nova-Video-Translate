import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DubSegment } from '../src/providers/types';
import { diag } from '../src/diag';
import { DubScheduler, ONSET_MAX_WAIT_SEC } from '../src/playback/scheduler';

class FakeParam {
  value = 1;
  cancelScheduledValues() {}
  setValueAtTime() {}
  linearRampToValueAtTime = vi.fn();
}
class FakeGain {
  gain = new FakeParam();
  connect() {}
  disconnect() {}
}
class FakeSource {
  buffer: { duration: number } | null = null;
  playbackRate = { value: 1 };
  starts: Array<{ when: number; offset: number }> = [];
  stops: number[] = [];
  connect() {}
  disconnect() {}
  start(when: number, offset = 0) {
    this.starts.push({ when, offset });
  }
  stop(when: number) {
    this.stops.push(when);
  }
}
class FakeCtx {
  currentTime = 0;
  state = 'running';
  destination = {};
  sources: FakeSource[] = [];
  createGain() {
    return new FakeGain();
  }
  createBufferSource() {
    const s = new FakeSource();
    this.sources.push(s);
    return s;
  }
  createBuffer(_ch: number, length: number, sampleRate: number) {
    const data = new Float32Array(length);
    return { duration: length / sampleRate, getChannelData: () => data };
  }
  /** test encoding: 10 bytes per second of audio */
  async decodeAudioData(buf: ArrayBuffer) {
    return { duration: buf.byteLength / 10 };
  }
}
class FakeVideo extends EventTarget {
  currentTime = 0;
  paused = false;
  ended = false;
  playbackRate = 1;
  volume = 1;
  muted = false;
}

const seg = (start: number, end: number, extra: Record<string, unknown> = {}): DubSegment =>
  ({
    start,
    end,
    audio: { kind: 'encoded', mime: 'audio/test', data: new Uint8Array(Math.round((end - start) * 10)) },
    ...extra,
  }) as DubSegment;

describe('DubScheduler onset gate (onsetProbe)', () => {
  let ctx: FakeCtx;
  let video: FakeVideo;
  let sch: DubScheduler;
  let log: ReturnType<typeof vi.spyOn>;
  const run = async (sec: number) => {
    for (let t = 0; t < sec - 1e-9; t += 0.1) {
      ctx.currentTime += 0.1;
      if (!video.paused) video.currentTime += 0.1 * video.playbackRate;
      await vi.advanceTimersByTimeAsync(100);
    }
  };
  const flush = () => vi.advanceTimersByTimeAsync(0);
  const calls = (name: string) => log.mock.calls.filter((c: unknown[]) => c[0] === name).map((c: unknown[]) => c[1] as Record<string, any>);
  const make = (opts = {}) => (sch = new DubScheduler(video as unknown as HTMLVideoElement, ctx as unknown as AudioContext, { lookaheadSec: 3, duckAttackMs: 0, ...opts }));
  /** video time at which a source starts = its ctx start + the constant video/ctx offset */
  let offsetVC = 0;
  const startVt = (s: FakeSource) => s.starts[0]!.when + offsetVC;
  const begin = async (vt0: number) => {
    video.currentTime = vt0;
    offsetVC = vt0 - ctx.currentTime;
    sch.start();
    await flush();
  };
  const SILENT = { speaking: false, silentForSec: 5 };
  const SPEAKING = { speaking: true, silentForSec: 0 };

  beforeEach(() => {
    vi.useFakeTimers();
    ctx = new FakeCtx();
    video = new FakeVideo();
    log = vi.spyOn(diag, 'log');
  });
  afterEach(() => {
    sch?.dispose();
    log.mockRestore();
    vi.useRealTimers();
  });

  it('speech already present at the slot: starts at the slot, no onset-gate diag', async () => {
    make({ onsetProbe: () => SPEAKING }).addSegments([seg(5, 7)]);
    await begin(4);
    await run(1.5);
    expect(ctx.sources).toHaveLength(1);
    expect(startVt(ctx.sources[0]!)).toBeCloseTo(5, 1);
    expect(calls('onset-gate')).toHaveLength(0);
    expect(calls('seg-play')[0]!.gated).toBeUndefined();
  });

  it('silent original, speech 0.8 s after the slot: starts ~0.8 s later (why=speech)', async () => {
    make({ onsetProbe: (vt: number) => (vt >= 5.8 ? SPEAKING : SILENT) }).addSegments([seg(5, 7)]);
    await begin(4);
    await run(1.5); // vt 5.5: still held
    expect(ctx.sources).toHaveLength(0);
    await run(1.5);
    expect(ctx.sources).toHaveLength(1);
    expect(startVt(ctx.sources[0]!)).toBeGreaterThan(5.7);
    expect(startVt(ctx.sources[0]!)).toBeLessThan(6.0);
    const g = calls('onset-gate');
    expect(g).toHaveLength(1);
    expect(g[0]!.why).toBe('speech');
    expect(g[0]!.slot).toBe(5);
    expect(g[0]!.waitedSec).toBeGreaterThan(0.7);
    expect(g[0]!.waitedSec).toBeLessThan(1.0);
    expect(calls('seg-play')[0]!.gated).toBeCloseTo(g[0]!.waitedSec, 5);
  });

  it('silent forever: starts after ONSET_MAX_WAIT_SEC (why=timeout)', async () => {
    expect(ONSET_MAX_WAIT_SEC).toBe(2.5);
    make({ onsetProbe: () => SILENT }).addSegments([seg(5, 9)]);
    await begin(4);
    await run(2.5); // vt 6.5, waited 1.5
    expect(ctx.sources).toHaveLength(0);
    await run(2); // vt 8.5
    expect(ctx.sources).toHaveLength(1);
    expect(startVt(ctx.sources[0]!)).toBeGreaterThan(7.4);
    expect(startVt(ctx.sources[0]!)).toBeLessThan(7.7);
    const g = calls('onset-gate');
    expect(g).toHaveLength(1);
    expect(g[0]!.why).toBe('timeout');
    expect(g[0]!.waitedSec).toBeGreaterThanOrEqual(2.5);
    expect(g[0]!.waitedSec).toBeLessThan(2.8);
  });

  it('probe returns undefined: no wait', async () => {
    make({ onsetProbe: () => undefined }).addSegments([seg(5, 7)]);
    await begin(4);
    await run(1.5);
    expect(ctx.sources).toHaveLength(1);
    expect(startVt(ctx.sources[0]!)).toBeCloseTo(5, 1);
    expect(calls('onset-gate')).toHaveLength(0);
  });

  it('slot already late on arrival: no gate, starts now from offset 0 (slip)', async () => {
    const probe = vi.fn(() => SILENT);
    make({ onsetProbe: probe }).addSegments([seg(5, 9)]);
    await begin(6);
    expect(ctx.sources).toHaveLength(1);
    expect(ctx.sources[0]!.starts[0]!.offset).toBe(0);
    expect(probe).not.toHaveBeenCalled();
    expect(calls('onset-gate')).toHaveLength(0);
  });

  it.each(['yandex', 'yandex-live'])('providerId %s is never gated', async (providerId) => {
    const probe = vi.fn(() => SILENT);
    make({ onsetProbe: probe }).addSegments([seg(5, 7, { providerId })]);
    await begin(4);
    await run(1.5);
    expect(ctx.sources).toHaveLength(1);
    expect(startVt(ctx.sources[0]!)).toBeCloseTo(5, 1);
    expect(probe).not.toHaveBeenCalled();
    expect(calls('onset-gate')).toHaveLength(0);
  });

  it('without the probe option nothing changes', async () => {
    make().addSegments([seg(5, 7)]);
    await begin(4);
    await run(1.5);
    expect(ctx.sources).toHaveLength(1);
    expect(startVt(ctx.sources[0]!)).toBeCloseTo(5, 1);
    expect(calls('onset-gate')).toHaveLength(0);
  });

  it('does not duck the original while the start is held, ducks after the shifted start', async () => {
    make({ onsetProbe: (vt: number) => (vt >= 6.0 ? SPEAKING : SILENT) }).addSegments([seg(5, 8)]);
    await begin(4);
    await run(1.8); // vt 5.8: slot passed, still held
    expect(ctx.sources).toHaveLength(0);
    expect(video.volume).toBeCloseTo(1, 2);
    expect(calls('duck').filter((d: Record<string, unknown>) => d.on)).toHaveLength(0);
    await run(0.8); // vt 6.6: voice has started
    expect(ctx.sources).toHaveLength(1);
    expect(video.volume).toBeLessThan(1);
  });

  it('a seek back judges a gated entry afresh', async () => {
    make({ onsetProbe: (vt: number) => (vt >= 5.5 && vt < 9 ? SPEAKING : SILENT) }).addSegments([seg(5, 7)]);
    await begin(4);
    await run(2); // vt 6: started after waiting ~0.5
    expect(calls('onset-gate')).toHaveLength(1);
    expect(ctx.sources).toHaveLength(1);
    video.currentTime = 3;
    video.dispatchEvent(new Event('seeking'));
    video.dispatchEvent(new Event('seeked'));
    await flush();
    await run(3); // vt 6 again
    const g = calls('onset-gate');
    expect(g).toHaveLength(2);
    expect(g[1]!.why).toBe('speech');
    expect(g[1]!.waitedSec).toBeGreaterThan(0.3);
    expect(g[1]!.waitedSec).toBeLessThan(0.8);
    expect(ctx.sources.length).toBeGreaterThanOrEqual(2);
    expect(calls('seg-play').at(-1)!.gated).toBeGreaterThan(0.3);
  });
});

describe('DubScheduler shiftSegmentsWhere maxPlayingMoveSec and seek back', () => {
  let ctx: FakeCtx;
  let video: FakeVideo;
  let sch: DubScheduler;
  let log: ReturnType<typeof vi.spyOn>;
  const run = async (sec: number) => {
    for (let t = 0; t < sec - 1e-9; t += 0.1) {
      ctx.currentTime += 0.1;
      if (!video.paused) video.currentTime += 0.1 * video.playbackRate;
      await vi.advanceTimersByTimeAsync(100);
    }
  };
  const flush = () => vi.advanceTimersByTimeAsync(0);
  const calls = (name: string) => log.mock.calls.filter((c: unknown[]) => c[0] === name).map((c: unknown[]) => c[1] as Record<string, any>);
  beforeEach(() => {
    vi.useFakeTimers();
    ctx = new FakeCtx();
    video = new FakeVideo();
    log = vi.spyOn(diag, 'log');
  });
  afterEach(() => {
    sch?.dispose();
    log.mockRestore();
    vi.useRealTimers();
  });
  const make = (opts = {}) => (sch = new DubScheduler(video as unknown as HTMLVideoElement, ctx as unknown as AudioContext, { lookaheadSec: 20, duckAttackMs: 0, ...opts }));

  it('a playing voice is not moved by a delta above maxPlayingMoveSec; the others are', async () => {
    make().addSegments([seg(0, 4), seg(10, 12)]);
    sch.start();
    await flush();
    await run(1);
    expect(ctx.sources).toHaveLength(2);
    const n = sch.shiftSegmentsWhere(() => true, 5, { maxPlayingMoveSec: 2 });
    expect(n).toBe(1);
    expect(sch.getBuffered()).toEqual([{ start: 0, end: 4 }, { start: 15, end: 17 }]);
    expect(calls('seg-stop').filter((c: Record<string, unknown>) => c.start === 0)).toHaveLength(0);
  });

  it('a delta within maxPlayingMoveSec moves the playing voice too (killed and replanned)', async () => {
    make().addSegments([seg(0, 4), seg(10, 12)]);
    sch.start();
    await flush();
    await run(1);
    const before = ctx.sources.length;
    const n = sch.shiftSegmentsWhere(() => true, 1, { maxPlayingMoveSec: 2 });
    expect(n).toBe(2);
    expect(sch.getBuffered()).toEqual([{ start: 1, end: 5 }, { start: 11, end: 13 }]);
    expect(calls('seg-stop').filter((c: Record<string, unknown>) => c.start === 0).length).toBeGreaterThan(0);
    expect(ctx.sources.length).toBeGreaterThan(before);
  });

  it('seek back (own live-delay rewind) keeps all entries and replans them at their slots', async () => {
    make().addSegments([seg(20, 22), seg(24, 26), seg(28, 30)]);
    video.currentTime = 18;
    sch.start();
    await flush();
    await run(1);
    const buffered = sch.getBuffered();
    const used = ctx.sources.length;
    log.mockClear();
    video.currentTime = 12;
    video.dispatchEvent(new Event('seeking'));
    video.dispatchEvent(new Event('seeked'));
    await flush();
    expect(calls('sched-remove')).toHaveLength(0);
    expect(calls('seg-skip')).toHaveLength(0);
    expect(sch.getBuffered()).toEqual(buffered);
    const fresh = ctx.sources.slice(used);
    expect(fresh).toHaveLength(3);
    const ins = fresh.map((s) => s.starts[0]!.when - ctx.currentTime);
    expect(ins[0]).toBeCloseTo(20 - 12, 1);
    expect(ins[1]).toBeCloseTo(24 - 12, 1);
    expect(ins[2]).toBeCloseTo(28 - 12, 1);
    const plays = calls('seg-play');
    expect(plays.map((p: Record<string, unknown>) => p.slot)).toEqual([20, 24, 28]);
    for (const p of plays) expect(p.in).toBeCloseTo(p.slot - 12, 1);
  });
});
