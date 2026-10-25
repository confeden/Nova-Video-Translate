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

describe('DubScheduler dubLagSec (the dub trails the phrase)', () => {
  let ctx: FakeCtx;
  let video: FakeVideo;
  let sch: DubScheduler;
  const run = async (sec: number) => {
    for (let t = 0; t < sec - 1e-9; t += 0.1) {
      ctx.currentTime += 0.1;
      if (!video.paused) video.currentTime += 0.1 * video.playbackRate;
      await vi.advanceTimersByTimeAsync(100);
    }
  };
  const flush = () => vi.advanceTimersByTimeAsync(0);
  beforeEach(() => {
    vi.useFakeTimers();
    ctx = new FakeCtx();
    video = new FakeVideo();
  });
  afterEach(() => {
    sch?.dispose();
    vi.useRealTimers();
  });
  const make = (opts = {}) => (sch = new DubScheduler(video as unknown as HTMLVideoElement, ctx as unknown as AudioContext, opts));

  it('plays a segment at start + lag (whole timeline shifted)', async () => {
    make({ dubLagSec: 2, lookaheadSec: 10 }).addSegments([seg(1, 3), seg(5, 6)]);
    sch.start();
    await flush();
    expect(ctx.sources).toHaveLength(2);
    expect(ctx.sources[0]!.starts[0]!.when).toBeCloseTo(3, 1); // 1 + 2
    expect(ctx.sources[1]!.starts[0]!.when).toBeCloseTo(7, 1); // 5 + 2
    expect(sch.getBuffered()).toEqual([{ start: 3, end: 5 }, { start: 7, end: 8 }]);
  });

  it('ducks the original only while the shifted dub is audible', async () => {
    make({ dubLagSec: 2, lookaheadSec: 10, duckAttackMs: 0 }).addSegments([seg(0, 2)]);
    sch.start();
    await flush();
    await run(1.2); // vt 1.2: the unshifted slot (0..2) would be ducked now
    expect(video.volume).toBeCloseTo(1, 2);
    await run(1.5); // vt 2.7: inside the shifted slot 2..4
    expect(video.volume).toBeLessThan(1);
  });

  it('report numbers: dub ready 13 s after the cell start with live delay 11 s is on time only with the lag', async () => {
    const chunk = 8;
    const pipelineSec = 5; // ASR + translate + TTS
    const delay = 11;
    const readyAtLive = chunk + pipelineSec; // 13 s after the cell start
    const vtWhenReady = readyAtLive - delay; // playhead is `delay` behind the live edge
    expect(vtWhenReady).toBe(2);
    for (const [lag, expectOffset] of [[2, 0], [0, 2]] as const) {
      ctx = new FakeCtx();
      video = new FakeVideo();
      video.currentTime = vtWhenReady;
      make({ dubLagSec: lag, lookaheadSec: 10 }).addSegments([seg(0, 4)]);
      sch.start();
      await flush();
      expect(ctx.sources).toHaveLength(1);
      expect(ctx.sources[0]!.starts[0]!.offset).toBe(0); // never mid-buffer: with lag 0 the dub is late by 2 s and slips (starts now from 0)
      const w = ctx.sources[0]!.starts[0]!.when;
      expect(w).toBeGreaterThanOrEqual(ctx.currentTime + 0.03 - 1e-6);
      expect(w).toBeLessThanOrEqual(ctx.currentTime + 0.11);
      sch.dispose();
    }
  });

  it('setDubLagSec re-plans', async () => {
    make({ dubLagSec: 0, lookaheadSec: 10 }).addSegments([seg(4, 6)]);
    sch.start();
    await flush();
    expect(ctx.sources[0]!.starts[0]!.when).toBeCloseTo(4, 1);
    sch.setDubLagSec(2);
    await flush();
    expect(ctx.sources.at(-1)!.starts[0]!.when).toBeCloseTo(6, 1);
  });

  it("logs 'dub-lead' when the dub becomes audible before its slot start", async () => {
    const log = vi.spyOn(diag, 'log');
    make({ dubLagSec: 2, lookaheadSec: 10 }).addSegments([seg(3, 4)]); // slot 5
    sch.start();
    await flush();
    await run(4.8); // vt 4.8, the dub is due on the audio clock at 5
    // the playhead jumps back 1 s with no 'waiting' event while the audio clock runs on
    video.currentTime -= 1;
    ctx.currentTime += 0.4;
    await vi.advanceTimersByTimeAsync(250);
    const lead = log.mock.calls.filter((c) => c[0] === 'dub-lead');
    expect(lead).toHaveLength(1);
    expect(lead[0]![1]).toMatchObject({ segStart: 3, slot: 5 });
    expect((lead[0]![1] as { ahead: number }).ahead).toBeGreaterThan(1);
    log.mockRestore();
  });

  it("never logs 'dub-lead' on a normal run", async () => {
    const log = vi.spyOn(diag, 'log');
    make({ dubLagSec: 2, lookaheadSec: 10 }).addSegments([seg(3, 4), seg(8, 9)]);
    sch.start();
    await flush();
    await run(12);
    expect(ctx.sources.length).toBeGreaterThanOrEqual(2);
    expect(log.mock.calls.some((c) => c[0] === 'dub-lead')).toBe(false);
    log.mockRestore();
  });
});
