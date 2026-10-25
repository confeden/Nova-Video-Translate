import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DubSegment } from '../src/providers/types';
import { DubScheduler } from '../src/playback/scheduler';
import { Ducker } from '../src/ducking';

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
  buffer: unknown = null;
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
/** payload: 10 bytes per second; the first byte of each second is 255 (speech) or 254 (silence); other values: no samples */
class FakeCtx {
  currentTime = 0;
  state = 'running';
  destination = {};
  sources: FakeSource[] = [];
  resumes = 0;
  createGain() {
    return new FakeGain();
  }
  createBufferSource() {
    const s = new FakeSource();
    this.sources.push(s);
    return s;
  }
  async resume() {
    this.resumes++;
  }
  async decodeAudioData(buf: ArrayBuffer) {
    const u8 = new Uint8Array(buf);
    if (u8.length === 3) throw new Error('EncodingError: Unable to decode audio data');
    const dur = buf.byteLength / 10;
    const sr = 100;
    const d = new Float32Array(Math.round(dur * sr));
    if (u8[0] === 255 || u8[0] === 254) {
      for (let sec = 0; sec < dur; sec++) if (u8[sec * 10] === 255) d.fill(0.2, sec * sr, (sec + 1) * sr);
    }
    const out: Record<string, unknown> = { duration: dur, sampleRate: sr };
    if (u8[0] === 255 || u8[0] === 254) out.getChannelData = () => d;
    return out;
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

/** speech seconds per `pattern` char: S = speech, _ = silence */
function seg(start: number, pattern: string, providerId?: DubSegment['providerId']): DubSegment {
  const data = new Uint8Array(pattern.length * 10);
  for (let i = 0; i < pattern.length; i++) data[i * 10] = pattern[i] === 'S' ? 255 : 254;
  return { start, end: start + pattern.length, audio: { kind: 'encoded', mime: 'audio/test', data }, providerId };
}

describe('adaptive ducking (D22)', () => {
  let ctx: FakeCtx;
  let video: FakeVideo;
  let sch: DubScheduler;
  const make = (opts = {}) => (sch = new DubScheduler(video as unknown as HTMLVideoElement, ctx as unknown as AudioContext, opts));
  const run = async (sec: number) => {
    for (let t = 0; t < sec - 1e-9; t += 0.1) {
      ctx.currentTime += 0.1;
      if (!video.paused) video.currentTime += 0.1 * video.playbackRate;
      await vi.advanceTimersByTimeAsync(100);
    }
  };
  beforeEach(() => {
    vi.useFakeTimers();
    ctx = new FakeCtx();
    video = new FakeVideo();
  });
  afterEach(() => {
    sch?.dispose();
    vi.useRealTimers();
  });

  it('does not duck at start; ducks when dub is within 0.3 s and restores the exact user volume after it', async () => {
    video.volume = 0.8;
    make().addSegments([seg(5, 'SSS')]);
    sch.start();
    await run(4);
    expect(video.volume).toBeCloseTo(0.8);
    await run(1.5); // vt 5.5
    expect(video.volume).toBeCloseTo(0.3);
    await run(4); // dub ended at 8 => released with a ramp
    expect(video.volume).toBe(0.8);
  });

  it('never raises the original above the user volume', async () => {
    video.volume = 0.2;
    make().addSegments([seg(1, 'SS')]);
    sch.start();
    await run(2);
    expect(video.volume).toBeCloseTo(0.2);
    await run(4);
    expect(video.volume).toBe(0.2);
  });

  it('stays ducked across a gap up to 2.5 s, releases in a longer gap and ducks again for the next dub', async () => {
    make().addSegments([seg(1, 'SS'), seg(5, 'SS'), seg(12, 'SS')]); // gaps: 2 s, 5 s
    sch.start();
    await run(2); // vt 2
    expect(video.volume).toBeCloseTo(0.3);
    await run(2.5); // vt 4.5: inside the 2 s gap
    expect(video.volume).toBeCloseTo(0.3);
    await run(3.3); // vt 7.5: 5 s gap after the second segment
    expect(video.volume).toBe(1);
    await run(4.2); // vt 12
    expect(video.volume).toBeCloseTo(0.3);
  });

  it('releases inside one long segment when its audio has a silent gap longer than 2.5 s', async () => {
    make().addSegments([seg(1, 'SS_____SS')]); // speech 0-2, silence 2-7, speech 7-9
    sch.start();
    await run(2); // vt 2: speech (buffer 1..2)
    expect(video.volume).toBeCloseTo(0.3);
    await run(3); // vt 5: deep in the silence
    expect(video.volume).toBe(1);
    await run(3.5); // vt 8.5
    expect(video.volume).toBeCloseTo(0.3);
  });

  it('a silent / no-speech buffer never ducks and is not played', async () => {
    make().addSegments([seg(1, '____')]);
    sch.start();
    await run(3);
    expect(video.volume).toBe(1);
    expect(ctx.sources).toHaveLength(0);
  });

  it('a user volume change while ducked is respected and not fought', async () => {
    make().addSegments([seg(1, 'SSSSSS')]);
    sch.start();
    await run(2);
    expect(video.volume).toBeCloseTo(0.3);
    video.volume = 0.6; // slider
    video.dispatchEvent(new Event('volumechange'));
    await run(3);
    expect(video.volume).toBe(0.6);
  });

  it('waits for a running AudioContext and resumes it instead of scheduling on a frozen clock', async () => {
    ctx.state = 'suspended';
    make().addSegments([seg(1, 'SSS')]);
    sch.start();
    await run(2);
    expect(ctx.sources).toHaveLength(0);
    expect(ctx.resumes).toBeGreaterThan(0);
    ctx.state = 'running';
    await run(0.4);
    expect(ctx.sources.length).toBeGreaterThan(0);
  });

  it('a decode failure is reported through onDecodeError and skipped without ducking', async () => {
    const errors: unknown[] = [];
    make({ onDecodeError: (i: unknown) => errors.push(i) }).addSegments([{ start: 1, end: 3, audio: { kind: 'encoded', mime: 'audio/mpeg', data: new Uint8Array(3) } }]);
    sch.start();
    await run(2);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ start: 1, mime: 'audio/mpeg', bytes: 3 });
    expect(video.volume).toBe(1);
  });

  it('removeSegmentsWhere drops matching segments, fades the playing one and releases the duck', async () => {
    make().addSegments([seg(1, 'SSSSSS', 'gemini'), seg(9, 'SSS', 'yandex')]);
    sch.start();
    await run(2);
    expect(video.volume).toBeCloseTo(0.3);
    const n = sch.removeSegmentsWhere((s) => s.providerId === 'gemini', { fadeSec: 0.3 });
    expect(n).toBe(1);
    expect(ctx.sources[0]!.stops).toHaveLength(1);
    expect(ctx.sources[0]!.stops[0]! - ctx.currentTime).toBeCloseTo(0.3);
    await run(1);
    expect(video.volume).toBe(1);
    expect(sch.getBuffered()).toEqual([{ start: 9, end: 12 }]);
  });

  it('stop restores the user volume at once', async () => {
    video.volume = 0.7;
    make().addSegments([seg(0.2, 'SSSS')]);
    sch.start();
    await run(1);
    expect(video.volume).toBeCloseTo(0.3);
    sch.stop();
    expect(video.volume).toBe(0.7);
  });
});

describe('Ducker ramps', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('ramps the release and writes the exact saved volume at the end', async () => {
    const v = Object.assign(new EventTarget(), { volume: 0.55 }) as unknown as HTMLMediaElement;
    const d = new Ducker(v);
    d.duck(0.3);
    expect(v.volume).toBeCloseTo(0.3);
    d.restore(250);
    await vi.advanceTimersByTimeAsync(100);
    expect(v.volume).toBeGreaterThan(0.3);
    expect(v.volume).toBeLessThan(0.55);
    await vi.advanceTimersByTimeAsync(200);
    expect(v.volume).toBe(0.55);
    expect(d.active).toBe(false);
  });

  it('ignores volumechange events that report values from its own ramp', async () => {
    const v = Object.assign(new EventTarget(), { volume: 1 }) as unknown as HTMLMediaElement;
    const d = new Ducker(v);
    d.duck(0.2, 100);
    await vi.advanceTimersByTimeAsync(50);
    v.dispatchEvent(new Event('volumechange'));
    await vi.advanceTimersByTimeAsync(100);
    expect(v.volume).toBeCloseTo(0.2);
    expect(d.active).toBe(true);
    d.restore(0);
    expect(v.volume).toBe(1);
  });
});

describe('no ducking before a dub is actually audible (planner / late arrivals)', () => {
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
  beforeEach(() => {
    vi.useFakeTimers();
    ctx = new FakeCtx();
    video = new FakeVideo();
  });
  afterEach(() => {
    sch?.dispose();
    vi.useRealTimers();
  });

  it('a suspended audio context never ducks (nothing can be heard); ducking starts once it runs', async () => {
    ctx.state = 'suspended';
    sch = new DubScheduler(video as unknown as HTMLVideoElement, ctx as unknown as AudioContext, {});
    sch.addSegments([seg(1, 'SSSSSSSS')]);
    sch.start();
    await run(3);
    expect(video.volume).toBe(1);
    ctx.state = 'running';
    await run(1);
    expect(video.volume).toBeCloseTo(0.3);
    await run(8);
    expect(video.volume).toBe(1);
  });

  it('a dub that arrives more than 4 s behind its slot (skipped whole) never lowers the original', async () => {
    sch = new DubScheduler(video as unknown as HTMLVideoElement, ctx as unknown as AudioContext, {});
    sch.start();
    await run(9.6);
    sch.addSegments([seg(5, 'SSSS')]); // slot 5..9, now 9.6: 4.6 s late > 4 s slip cap
    await run(1.5);
    expect(video.volume).toBe(1);
  });

  it('removing the playing segment (tier upgrade) restores the original volume', async () => {
    sch = new DubScheduler(video as unknown as HTMLVideoElement, ctx as unknown as AudioContext, {});
    sch.addSegments([seg(1, 'SSSSSS', 'yandex')]);
    sch.start();
    await run(2.5);
    expect(video.volume).toBeCloseTo(0.3);
    sch.removeSegmentsWhere((s) => s.providerId === 'yandex', { reason: 'tier-upgrade' });
    await run(3.5);
    expect(video.volume).toBe(1);
  });
});
