import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DubSegment } from '../src/providers/types';
import { diag } from '../src/diag';
import { DubScheduler, FADE_IN_SEC, START_AHEAD_SEC } from '../src/playback/scheduler';

const SR = 1000;
/** speech (amplitude 0.3) starts at SPEECH_AT seconds in every buffer; 10 bytes of payload per second of audio */
const SPEECH_AT = 0.1;

class FakeParam {
  value = 1;
  curves: Array<{ values: Float32Array; at: number; dur: number }> = [];
  cancelScheduledValues() {}
  setValueAtTime() {}
  linearRampToValueAtTime() {}
  setValueCurveAtTime(values: Float32Array, at: number, dur: number) {
    this.curves.push({ values, at, dur });
  }
}
class FakeGain {
  gain = new FakeParam();
  connect() {}
  disconnect() {}
}
class FakeSource {
  buffer: unknown = null;
  playbackRate = { value: 1 };
  gain?: FakeGain;
  starts: Array<{ when: number; offset: number }> = [];
  connect(g: FakeGain) {
    this.gain = g;
  }
  disconnect() {}
  start(when: number, offset = 0) {
    this.starts.push({ when, offset });
  }
  stop() {}
}
class FakeCtx {
  currentTime = 10;
  state = 'running';
  destination = {};
  sources: FakeSource[] = [];
  gains: FakeGain[] = [];
  createGain() {
    const g = new FakeGain();
    this.gains.push(g);
    return g;
  }
  createBufferSource() {
    const s = new FakeSource();
    this.sources.push(s);
    return s;
  }
  async decodeAudioData(buf: ArrayBuffer) {
    const dur = buf.byteLength / 10;
    const d = new Float32Array(Math.round(dur * SR));
    d.fill(0.3, Math.round(SPEECH_AT * SR));
    return { duration: dur, sampleRate: SR, getChannelData: () => d };
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
const seg = (start: number, end: number, providerId?: string): DubSegment =>
  ({ start, end, providerId, audio: { kind: 'encoded', mime: 'audio/test', data: new Uint8Array(Math.round((end - start) * 10)) } }) as DubSegment;

describe('DubScheduler start lead, fade-in and look-ahead ducking', () => {
  let ctx: FakeCtx;
  let video: FakeVideo;
  let sch: DubScheduler;
  let log: ReturnType<typeof vi.spyOn>;
  const run = async (sec: number) => {
    for (let t = 0; t < sec - 1e-9; t += 0.05) {
      ctx.currentTime += 0.05;
      video.currentTime += 0.05;
      await vi.advanceTimersByTimeAsync(50);
    }
  };
  const calls = (name: string) => log.mock.calls.filter((c: unknown[]) => c[0] === name).map((c: unknown[]) => c[1] as Record<string, any>);
  const begin = async (vt0: number, segs: DubSegment[], opts = {}) => {
    sch = new DubScheduler(video as unknown as HTMLVideoElement, ctx as unknown as AudioContext, { lookaheadSec: 3, ...opts });
    sch.addSegments(segs);
    video.currentTime = vt0;
    sch.start();
    await vi.advanceTimersByTimeAsync(0);
  };

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

  it('never starts a source in the past or closer to now than START_AHEAD_SEC (slot already here)', async () => {
    await begin(5, [seg(5, 7)]); // the playhead sits exactly on the slot
    await run(0.2);
    const s = ctx.sources[0]!;
    expect(s.starts[0]!.when).toBeGreaterThanOrEqual(10 + START_AHEAD_SEC - 1e-9);
    expect(s.starts[0]!.offset).toBe(0);
  });

  it('a mid-buffer start (Yandex) keeps its position: the offset moves with the delayed start', async () => {
    await begin(6, [seg(5, 15, 'yandex')]);
    await run(0.1);
    const st = ctx.sources[0]!.starts[0]!;
    expect(st.when).toBeGreaterThanOrEqual(10 + START_AHEAD_SEC - 1e-9);
    expect(st.offset).toBeCloseTo(1 + (st.when - 10), 2); // buffer position follows the video clock
  });

  it('fade-in is 8 ms equal-power, starts at the source start and ends before the first voiced sample', async () => {
    await begin(5, [seg(5, 7)]);
    await run(0.2);
    const s = ctx.sources[0]!;
    const g = s.gain!.gain;
    expect(g.value).toBe(0);
    expect(g.curves).toHaveLength(1);
    const c = g.curves[0]!;
    expect(c.at).toBeCloseTo(s.starts[0]!.when, 6);
    expect(c.dur).toBeCloseTo(FADE_IN_SEC, 6);
    expect(c.dur).toBeLessThanOrEqual(0.01);
    expect(c.values[0]).toBe(0);
    expect(c.values[c.values.length - 1]).toBeCloseTo(1, 6);
    // equal power: sin curve above the linear one in the middle
    expect(c.values[7]!).toBeGreaterThan(7 / 15);
    // the fade ends before speech begins in the buffer
    expect(FADE_IN_SEC).toBeLessThan(SPEECH_AT);
    const ev = calls('seg-start')[0]!;
    expect(ev.fadeMs).toBe(FADE_IN_SEC * 1000);
    expect(ev.preRollMs).toBeGreaterThanOrEqual(40);
    expect(ev.preRollMs * 1e-3).toBeGreaterThan(FADE_IN_SEC);
    expect(ev.scheduledAhead).toBeGreaterThanOrEqual(START_AHEAD_SEC * 1000);
  });

  it('logs seg-start once per phrase', async () => {
    await begin(4, [seg(5, 7), seg(8, 10)]);
    await run(0.5);
    expect(calls('seg-start')).toHaveLength(1); // second phrase is not scheduled yet (lookahead)
    await run(4);
    expect(calls('seg-start')).toHaveLength(2);
    expect(Object.keys(calls('seg-start')[0]!).sort()).toEqual(['duckLeadMs', 'fadeMs', 'preRollMs', 'scheduledAhead', 'slot'].sort());
  });

  it('look-ahead ducking: the ramp starts 250 ms before the dub speech and is finished before it', async () => {
    // slot 5, speech at 5.1 in the buffer => audible from 5.1; ramp from 4.85, 150 ms long => done at 5.0
    await begin(3, [seg(5, 8)]);
    await run(1.7); // vt 4.7
    expect(video.volume).toBe(1);
    await run(0.1); // vt 4.8: still before the lead
    expect(video.volume).toBe(1);
    await run(0.15); // vt 4.95: ramp under way
    expect(video.volume).toBeLessThan(1);
    expect(video.volume).toBeGreaterThan(0.3);
    await run(0.1); // vt 5.05: complete, 50 ms before the speech
    expect(video.volume).toBeCloseTo(0.3, 2);
    const d = calls('duck').find((x: Record<string, any>) => x.on === true)!;
    expect(d.leadMs).toBeGreaterThanOrEqual(190); // the fake clock steps by 50 ms
    expect(d.leadMs).toBeLessThanOrEqual(260);
    const ev = calls('seg-start')[0]!;
    expect(ev.duckLeadMs).toBeGreaterThanOrEqual(190);
  });

  it('a late dub (slipped) waits a little so the duck ramp is under way; the anchor follows (no drift)', async () => {
    await begin(8, [seg(5, 7)]); // 3 s behind its slot: starts now from 0 (slip), original not ducked yet
    await run(0.05);
    const st = ctx.sources[0]!.starts[0]!;
    expect(st.when).toBeCloseTo(10 + 0.1, 2);
    await run(2.5);
    expect(calls('seg-drift')).toHaveLength(0);
  });
});
