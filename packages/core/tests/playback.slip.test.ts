import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DubSegment } from '../src/providers/types';
import { diag } from '../src/diag';
import { DubScheduler } from '../src/playback/scheduler';
import { decodeDubAudio } from '../src/playback/decode';

class FakeParam {
  value = 1;
  cancelScheduledValues() {}
  setValueAtTime() {}
  linearRampToValueAtTime = vi.fn();
}
class FakeGain {
  gain = new FakeParam();
  disconnected = false;
  connect() {}
  disconnect() {
    this.disconnected = true;
  }
}
class FakeSource {
  buffer: { duration: number } | null = null;
  playbackRate = { value: 1 };
  starts: Array<{ when: number; offset: number }> = [];
  stops: number[] = [];
  disconnected = false;
  connect() {}
  disconnect() {
    this.disconnected = true;
  }
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

const seg = (start: number, end: number, dur = end - start, providerId?: string): DubSegment => ({
  start,
  end,
  audio: { kind: 'encoded', mime: 'audio/test', data: new Uint8Array(Math.round(dur * 10)) },
  ...(providerId ? { providerId: providerId as DubSegment['providerId'] } : {}),
});

describe('DubScheduler slip policy (never cut the start of a phrase)', () => {
  let ctx: FakeCtx;
  let video: FakeVideo;
  let sch: DubScheduler;
  const make = (opts = {}) => {
    sch = new DubScheduler(video as unknown as HTMLVideoElement, ctx as unknown as AudioContext, opts);
    return sch;
  };
  const run = async (sec: number) => {
    for (let t = 0; t < sec - 1e-9; t += 0.1) {
      ctx.currentTime += 0.1;
      if (!video.paused) video.currentTime += 0.1 * video.playbackRate;
      await vi.advanceTimersByTimeAsync(100);
    }
  };
  const flush = () => vi.advanceTimersByTimeAsync(0);
  const fire = (type: string) => video.dispatchEvent(new Event(type));
  const calls = (ev: string) => diag.entries().filter((e) => e.ev === ev).map((e) => (e.data ?? {}) as Record<string, any>);

  beforeEach(() => {
    vi.useFakeTimers();
    ctx = new FakeCtx();
    video = new FakeVideo();
    diag.clear();
  });
  afterEach(() => {
    sch?.dispose();
    vi.useRealTimers();
  });

  it('a phrase that is 2.5 s late starts now from offset 0 and logs seg-slip', async () => {
    video.currentTime = 12.5;
    make().addSegments([seg(10, 14, 3)]);
    sch.start();
    await flush();
    expect(ctx.sources).toHaveLength(1);
    expect(ctx.sources[0]!.starts[0]!.offset).toBe(0);
    expect(ctx.sources[0]!.starts[0]!.when).toBeCloseTo(ctx.currentTime + 0.1, 1);
    const slip = calls('seg-slip');
    expect(slip).toHaveLength(1);
    expect((slip[0] as { slipSec: number }).slipSec).toBeCloseTo(2.5, 1);
  });

  it('late by more than 4 s: skipped whole, reason late-over-slip', async () => {
    video.currentTime = 14.5;
    make().addSegments([seg(10, 14, 3)]);
    sch.start();
    await flush();
    expect(ctx.sources).toHaveLength(0);
    expect(calls('seg-skip').some((e) => (e as { reason: string }).reason === 'late-over-slip')).toBe(true);
  });

  it('the slip cap is a constant 4 s: 3.9 s late still plays', async () => {
    video.currentTime = 13.9;
    make().addSegments([seg(10, 14, 3)]);
    sch.start();
    await flush();
    expect(ctx.sources).toHaveLength(1);
    expect(ctx.sources[0]!.starts[0]!.offset).toBe(0);
  });

  it('a slipped phrase borrows the following silence: next one is not cut, order is kept', async () => {
    video.currentTime = 11;
    make().addSegments([seg(10, 13, 3), seg(20, 23, 3)]);
    sch.start();
    await run(10.5);
    expect(ctx.sources).toHaveLength(2);
    expect(ctx.sources[0]!.starts[0]!.when).toBeCloseTo(0.2, 1);
    expect(ctx.sources[1]!.starts[0]!.offset).toBe(0);
  });

  it('rate compression: a slipped 4 s phrase before a close next slot is sped up (<= 1.25x) to end at the next slot', async () => {
    video.currentTime = 11; // slot 10, slip 1 s; plays 11..15 at 1x, next slot at 14 -> needs 4/3 = 1.33 > cap -> 1.25
    make().addSegments([seg(10, 14, 4), seg(14, 16, 2)]);
    sch.start();
    await flush();
    const r = ctx.sources[0]!.playbackRate.value;
    expect(r).toBeGreaterThan(1.2);
    expect(r).toBeLessThanOrEqual(1.25 + 1e-9);
    expect((calls('seg-slip')[0] as { rate: number }).rate).toBeCloseTo(r, 2);
  });

  it('chain of 3 late phrases glues: each starts right after the previous one; the one over the 4 s total slip is skipped whole', async () => {
    video.currentTime = 10; // all three arrive 0 s .. late: slots 8, 9, 10; each 2.5 s long, gap-free glue
    make({ lookaheadSec: 0.1 }).addSegments([seg(8, 9, 2.5), seg(9, 9.9, 2.5), seg(9.9, 10.9, 2.5)]);
    sch.start();
    await run(0.4);
    // 1st: slip 2, plays 10..12.5 (1x, compressed to <=1.25x to end by the 2nd slot -> 9 is behind: capped at 1.25 => 2.0 s -> ends 12)
    // 2nd: starts after the 1st (slip ~3), 3rd would start ~ at 14+ => slip > 4 -> skipped whole
    const slips = calls('seg-slip') as Array<{ start: number; slipSec: number }>;
    expect(slips.map((s) => s.start)).toEqual([8, 9]);
    expect(slips[0]!.slipSec).toBeGreaterThan(1.9);
    expect(slips[0]!.slipSec).toBeLessThan(2.5);
    expect(slips[1]!.slipSec).toBeGreaterThan(2.5);
    expect(slips[1]!.slipSec).toBeLessThanOrEqual(4);
    expect(ctx.sources).toHaveLength(2);
    const skip = calls('seg-skip').filter((e) => (e as { reason: string }).reason === 'late-over-slip');
    expect(skip).toHaveLength(1);
    expect((skip[0] as { start: number }).start).toBe(9.9);
    // nothing started mid-buffer
    for (const s of ctx.sources) expect(s.starts[0]!.offset).toBe(0);
  });

  it('Yandex cell audio is untouched: late start is still mid-buffer', async () => {
    video.currentTime = 11;
    make().addSegments([seg(10, 20, 10, 'yandex')]);
    sch.start();
    await flush();
    expect(ctx.sources[0]!.starts[0]!.offset).toBeCloseTo(1, 1);
    expect(calls('seg-slip')).toHaveLength(0);
  });

  it('ducking follows the slipped dub: not before it plays, released after it ends', async () => {
    video.currentTime = 11;
    make().addSegments([seg(10, 13, 2)]);
    sch.start();
    await flush();
    expect(ctx.sources).toHaveLength(1);
    await run(1);
    expect(video.volume).toBeCloseTo(0.3);
    await run(6);
    expect(video.volume).toBe(1);
  });

  it('rewind: seeking into a phrase joins mid-buffer; seeking back before a slipped phrase replays it at its own slot', async () => {
    make().addSegments([seg(10, 14, 4)]);
    sch.start();
    await flush();
    video.currentTime = 12;
    fire('seeking');
    fire('seeked');
    await flush();
    expect(live().at(-1)!.starts[0]!.offset).toBeCloseTo(2, 1); // a seek is not a late arrival
    ctx.sources.length = 0;
    video.currentTime = 5;
    fire('seeking');
    fire('seeked');
    await flush();
    await run(5.2);
    expect(ctx.sources.at(-1)!.starts[0]!.offset).toBe(0);
    function live() {
      return ctx.sources.filter((s) => s.stops.length === 0);
    }
  });

  it('a pause/resume in the middle of a slipped phrase resumes mid-buffer (the phrase was already heard)', async () => {
    video.currentTime = 11;
    make().addSegments([seg(10, 14, 4)]);
    sch.start();
    await flush();
    await run(1);
    video.paused = true;
    fire('pause');
    video.paused = false;
    fire('play');
    await flush();
    const last = ctx.sources.at(-1)!;
    expect(last.starts[0]!.offset).toBeGreaterThan(0.5);
  });
});
