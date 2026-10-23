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

const seg = (start: number, end: number, dur = end - start): DubSegment => ({
  start,
  end,
  audio: { kind: 'encoded', mime: 'audio/test', data: new Uint8Array(Math.round(dur * 10)) },
});

describe('DubScheduler', () => {
  let ctx: FakeCtx;
  let video: FakeVideo;
  let sch: DubScheduler;

  const make = (opts = {}) => {
    sch = new DubScheduler(video as unknown as HTMLVideoElement, ctx as unknown as AudioContext, opts);
    return sch;
  };
  /** advance both clocks (video follows playbackRate unless paused) in 100 ms steps */
  const run = async (sec: number) => {
    for (let t = 0; t < sec - 1e-9; t += 0.1) {
      ctx.currentTime += 0.1;
      if (!video.paused) video.currentTime += 0.1 * video.playbackRate;
      await vi.advanceTimersByTimeAsync(100);
    }
  };
  const flush = () => vi.advanceTimersByTimeAsync(0);
  const fire = (type: string) => video.dispatchEvent(new Event(type));
  const live = () => ctx.sources.filter((s) => s.stops.length === 0);

  beforeEach(() => {
    vi.useFakeTimers();
    ctx = new FakeCtx();
    video = new FakeVideo();
  });
  afterEach(() => {
    sch?.dispose();
    vi.useRealTimers();
  });

  it('schedules segments inside the lookahead window at the right ctx time', async () => {
    make().addSegments([seg(1, 2), seg(4, 5)]);
    sch.start();
    await flush();
    expect(ctx.sources).toHaveLength(1);
    expect(ctx.sources[0]!.starts[0]!.when).toBeCloseTo(1);
    expect(ctx.sources[0]!.starts[0]!.offset).toBe(0);
    await run(2.1);
    expect(ctx.sources).toHaveLength(2);
    expect(ctx.sources[1]!.starts[0]!.when).toBeCloseTo(4, 1);
  });

  it('decodes pcm segments to a float buffer', async () => {
    const buf = await decodeDubAudio(ctx as unknown as AudioContext, {
      kind: 'pcm',
      sampleRate: 10,
      samples: new Int16Array([0, 16384, -32768]),
    });
    expect(buf.duration).toBeCloseTo(0.3);
    expect(Array.from(buf.getChannelData(0))).toEqual([0, 0.5, -1]);
  });

  it('stops with a fade on pause and resumes mid-buffer', async () => {
    make().addSegments([seg(1, 2)]);
    sch.start();
    await run(1.5);
    const first = ctx.sources[0]!;
    video.paused = true;
    fire('pause');
    expect(first.stops[0]).toBeCloseTo(ctx.currentTime + 0.03);
    await run(1); // clocks idle for the video; nothing new starts
    expect(ctx.sources).toHaveLength(1);
    expect(first.disconnected).toBe(true);
    video.paused = false;
    fire('playing');
    expect(ctx.sources).toHaveLength(2);
    const second = ctx.sources[1]!.starts[0]!;
    expect(second.offset).toBeCloseTo(0.5);
    expect(second.when).toBeCloseTo(ctx.currentTime);
  });

  it('waiting stops audio and playing re-plans', async () => {
    make().addSegments([seg(1, 3)]);
    sch.start();
    await run(1.5);
    fire('waiting');
    expect(live()).toHaveLength(0);
    await run(0.5);
    expect(ctx.sources).toHaveLength(1);
    fire('playing');
    expect(live()).toHaveLength(1);
  });

  it('follows the timeline on seek forward and back', async () => {
    make().addSegments([seg(1, 2), seg(10.5, 11.5)]);
    sch.start();
    await run(1.5);
    video.currentTime = 10;
    fire('seeking');
    expect(live()).toHaveLength(0);
    fire('seeked');
    await flush();
    const fwd = live();
    expect(fwd).toHaveLength(1);
    expect(fwd[0]!.starts[0]!.when).toBeCloseTo(ctx.currentTime + 0.5);
    video.currentTime = 0;
    fire('seeking');
    fire('seeked');
    await flush();
    const back = live();
    expect(back).toHaveLength(1);
    expect(back[0]!.starts[0]!.when).toBeCloseTo(ctx.currentTime + 1);
    expect(back[0]!.starts[0]!.offset).toBe(0);
  });

  it('seeking into a segment starts mid-buffer, unless more than 70% is gone', async () => {
    make().addSegments([seg(10, 12)]);
    sch.start();
    await flush();
    video.currentTime = 10.8;
    fire('seeking');
    fire('seeked');
    await flush();
    expect(live()).toHaveLength(1);
    expect(live()[0]!.starts[0]!.offset).toBeCloseTo(0.8);
    expect(live()[0]!.starts[0]!.when).toBeCloseTo(ctx.currentTime);
    const before = ctx.sources.length;
    video.currentTime = 11.6;
    fire('seeking');
    fire('seeked');
    await flush();
    expect(ctx.sources.length).toBe(before);
    expect(live()).toHaveLength(0);
  });

  it('ratechange 1.5x rescales ctx offsets and source rate', async () => {
    make().addSegments([seg(3, 4)]);
    video.currentTime = 1;
    sch.start();
    await flush();
    expect(ctx.sources[0]!.starts[0]!.when).toBeCloseTo(2);
    expect(ctx.sources[0]!.playbackRate.value).toBe(1);
    video.playbackRate = 1.5;
    fire('ratechange');
    await flush();
    const s = live();
    expect(s).toHaveLength(1);
    expect(s[0]!.playbackRate.value).toBeCloseTo(1.5);
    expect(s[0]!.starts[0]!.when).toBeCloseTo(2 / 1.5);
  });

  it('shifts the next segment after an overrun without overlapping', async () => {
    make().addSegments([seg(0, 2, 2.8), seg(2, 3, 1)]);
    sch.start();
    await flush();
    await flush();
    expect(ctx.sources).toHaveLength(2);
    const [a, b] = ctx.sources;
    expect(a!.playbackRate.value).toBe(1);
    expect(b!.starts[0]!.when).toBeCloseTo(2.8);
    expect(b!.starts[0]!.when).toBeGreaterThanOrEqual(a!.starts[0]!.when + 2.8 - 1e-9);
  });

  it('beyond maxLag speeds the previous segment by at most 10% and still never overlaps', async () => {
    make().addSegments([seg(0, 2, 4.5), seg(2, 3, 1)]);
    sch.start();
    await flush();
    await flush();
    const [a, b] = ctx.sources;
    expect(a!.playbackRate.value).toBeCloseTo(1.1);
    const aEnd = a!.starts[0]!.when + 4.5 / a!.playbackRate.value;
    expect(b!.starts[0]!.when).toBeGreaterThanOrEqual(aEnd - 1e-9);
    expect(b!.playbackRate.value).toBe(1);
  });

  it('re-schedules a source whose position drifted more than 0.35 s', async () => {
    make().addSegments([seg(0.2, 4)]);
    sch.start();
    await run(1);
    expect(ctx.sources).toHaveLength(1);
    video.currentTime += 0.2; // small jitter: ignored
    await run(0.2);
    expect(ctx.sources).toHaveLength(1);
    video.currentTime += 0.6; // clocks diverged
    await run(0.2);
    expect(ctx.sources[0]!.stops).toHaveLength(1);
    expect(ctx.sources).toHaveLength(2);
    expect(ctx.sources[1]!.starts[0]!.offset).toBeCloseTo(video.currentTime - 0.2, 0);
  });

  it('fires onStarve near the end of covered time, once per coverage end', async () => {
    const onStarve = vi.fn();
    make({ onStarve }).addSegments([seg(0, 4), seg(5, 10)]);
    sch.start();
    await run(3.5);
    expect(onStarve).not.toHaveBeenCalled();
    await run(1);
    expect(onStarve).toHaveBeenCalledTimes(1);
    expect(onStarve).toHaveBeenCalledWith(10);
    await run(1);
    expect(onStarve).toHaveBeenCalledTimes(1);
    sch.addSegments([seg(10, 20)]);
    expect(sch.getBuffered()).toEqual([{ start: 0, end: 20 }]);
    await run(1);
    expect(onStarve).toHaveBeenCalledTimes(1); // 20 - 5.5 > 6
    await run(9);
    expect(onStarve).toHaveBeenCalledTimes(2);
    expect(onStarve).toHaveBeenLastCalledWith(20);
  });

  it('getBuffered merges close slots and keeps real gaps', () => {
    make().addSegments([seg(0, 2), seg(2.5, 4), seg(20, 22)]);
    expect(sch.getBuffered()).toEqual([
      { start: 0, end: 4 },
      { start: 20, end: 22 },
    ]);
  });

  it('replaces overlapping duplicates from a re-requested chunk', async () => {
    make().addSegments([seg(1, 2)]);
    sch.start();
    await run(1.3);
    expect(live()).toHaveLength(1);
    sch.addSegments([seg(1.1, 2.1), seg(30, 31)]);
    expect(sch.getBuffered()).toEqual([
      { start: 1.1, end: 2.1 },
      { start: 30, end: 31 },
    ]);
    expect(ctx.sources[0]!.stops).toHaveLength(1); // the old voice was cut
    await flush();
    expect(live()).toHaveLength(1); // exactly one voice at a time
  });

  it('ducks the original and never touches muted/currentTime; setVolume drives the dub gain only', async () => {
    video.currentTime = 5;
    make({ translationVolume: 0.8 }).addSegments([seg(6, 7)]);
    sch.start();
    expect(video.volume).toBe(1); // adaptive: nothing audible yet
    sch.setVolume(0.5);
    await run(2);
    expect(video.volume).toBeCloseTo(0.3);
    expect(video.muted).toBe(false);
    expect(video.currentTime).toBeCloseTo(7);
    sch.stop();
    expect(video.volume).toBe(1);
  });

  it('dispose cleans up: sources stopped, timers and listeners gone', async () => {
    const remove = vi.spyOn(video, 'removeEventListener');
    make().addSegments([seg(0.5, 2)]);
    sch.start();
    await run(1);
    const src = ctx.sources[0]!;
    sch.dispose();
    expect(src.stops).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalled();
    expect(video.volume).toBe(1);
    const n = ctx.sources.length;
    fire('playing');
    await run(1);
    expect(ctx.sources.length).toBe(n);
  });

  it('late dub: a 15 s dub arriving at 73% still starts mid-buffer (tail >= 3 s); under 3 s left it is skipped', async () => {
    make().addSegments([seg(0, 15)]);
    video.currentTime = 11;
    sch.start();
    await flush();
    expect(live()).toHaveLength(1);
    expect(live()[0]!.starts[0]!.offset).toBeCloseTo(11);
    sch.dispose();
    ctx.sources.length = 0;
    video.currentTime = 13;
    make().addSegments([seg(0, 15)]);
    sch.start();
    await flush();
    expect(ctx.sources).toHaveLength(0);
  });

  it('a segment that has played out is retired quietly: no second seg-skip log at a vt past its end', async () => {
    diag.clear();
    make().addSegments([seg(1, 3), seg(40, 42)]);
    sch.start();
    await run(12);
    const skips = diag.entries().filter((e) => e.ev === 'seg-skip');
    expect(skips).toEqual([]);
    // rewinding into the played segment plays it again (the retirement is not permanent)
    const before = ctx.sources.length;
    video.currentTime = 1.5;
    fire('seeking');
    fire('seeked');
    await flush();
    expect(ctx.sources.length).toBe(before + 1);
    expect(ctx.sources[before]!.starts[0]!.offset).toBeCloseTo(0.5);
  });
});
