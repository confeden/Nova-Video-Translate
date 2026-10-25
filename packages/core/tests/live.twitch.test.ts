import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { diag } from '../src/diag';
import { LIVE_CHUNK_SEC, LiveDelayController, autoDelayFromLatency, isLiveVideo, resolveLiveDelaySec } from '../src/live/liveDelay';

const ranges = (...r: Array<[number, number]>) => ({ length: r.length, start: (i: number) => r[i]![0], end: (i: number) => r[i]![1] });

/** Twitch <video> as measured: duration NaN, seekable ends at 2^30, ~30 s back-buffer, 3-4 s ahead, rate 1 */
class TwitchVideo extends EventTarget {
  duration = NaN;
  paused = false;
  ended = false;
  seekable = ranges([0, 1073741824]);
  seeks: number[] = [];
  private _ct = 0;
  bufStart = 0;
  get currentTime() {
    return this._ct;
  }
  set currentTime(x: number) {
    this._ct = x;
    this.seeks.push(x);
  }
  get buffered() {
    return this._empty ? ranges() : ranges([this.bufStart, this._ct + 4]);
  }
  private _empty = false;
  /** playback for `s` seconds; the buffer keeps at most 30 s behind */
  play(s: number) {
    this._ct += s;
    this.bufStart = Math.max(this.bufStart, this._ct - 30);
  }
  reset() {
    this._ct = 0;
    this._empty = true;
    this.bufStart = 0;
    this.dispatchEvent(new Event('seeking'));
  }
  rebuild() {
    this._empty = false;
  }
}

describe('LiveDelayController on a Twitch-like video', () => {
  let v: TwitchVideo;
  let c: LiveDelayController;
  const skips = () => diag.entries().filter((e) => e.ev === 'live-delay-skip');
  beforeEach(() => {
    vi.useFakeTimers();
    v = new TwitchVideo();
  });
  afterEach(() => {
    c?.stop();
    vi.useRealTimers();
  });

  it('detects the Twitch video as live', () => {
    expect(isLiveVideo(v)).toBe(true);
  });

  it('waits for the back-buffer, then seeks back ~15 s; logs why it waited (throttled)', () => {
    c = new LiveDelayController({ video: v as unknown as HTMLVideoElement, getDelaySec: () => 15 });
    v.play(2);
    c.start();
    for (let i = 0; i < 6; i++) {
      v.play(2);
      vi.advanceTimersByTime(2000);
    }
    expect(v.seeks).toHaveLength(0); // 14 s played: 13 s available < 15 + 1... still waiting
    const waits = skips().filter((e) => e.data?.reason === 'no-backbuffer');
    expect(waits.length).toBeGreaterThan(0);
    expect(waits.length).toBeLessThanOrEqual(2); // one per 10 s
    expect(waits[0]!.data!).toMatchObject({ need: 15 });
    for (let i = 0; i < 3; i++) {
      v.play(2);
      vi.advanceTimersByTime(2000);
    }
    expect(v.seeks).toHaveLength(1);
    expect(v.seeks[0]).toBeCloseTo(1, 0); // ct 20 -> 5
  });

  it('after a Twitch reset (ct 0, empty buffer) it re-arms and delays again', () => {
    c = new LiveDelayController({ video: v as unknown as HTMLVideoElement, getDelaySec: () => 15 });
    v.play(40);
    c.start();
    expect(v.seeks).toHaveLength(1);
    expect(c.appliedSec()).toBeCloseTo(15, 5);
    vi.advanceTimersByTime(4000); // out of the own-seek window
    v.reset();
    vi.advanceTimersByTime(2000);
    expect(c.appliedSec()).toBe(0);
    v.rebuild();
    for (let i = 0; i < 12; i++) {
      v.play(2);
      vi.advanceTimersByTime(2000);
    }
    expect(v.seeks).toHaveLength(2);
    expect(diag.entries().some((e) => e.ev === 'live-delay-rearm')).toBe(true);
  });

  it('raises the delay later (only upward) when the wanted delay grows', () => {
    let want = 12;
    c = new LiveDelayController({ video: v as unknown as HTMLVideoElement, getDelaySec: () => want });
    v.play(40);
    c.start();
    expect(c.appliedSec()).toBeCloseTo(12, 5);
    vi.advanceTimersByTime(4000);
    want = 11; // lower: ignored
    c.reapply();
    vi.advanceTimersByTime(4000);
    expect(v.seeks).toHaveLength(1);
    want = 20;
    v.play(10); // back-buffer grows again
    c.reapply();
    vi.advanceTimersByTime(2000);
    expect(v.seeks).toHaveLength(2);
    expect(c.appliedSec()).toBeCloseTo(20, 5);
  });

  it('logs setting<3 and paused skips', () => {
    c = new LiveDelayController({ video: v as unknown as HTMLVideoElement, getDelaySec: () => 0 });
    c.start();
    expect(skips().some((e) => e.data?.reason === 'setting<3')).toBe(true);
    c.stop();
    v.paused = true;
    c = new LiveDelayController({ video: v as unknown as HTMLVideoElement, getDelaySec: () => 15 });
    c.start();
    expect(skips().some((e) => e.data?.reason === 'paused')).toBe(true);
  });
});

describe('auto delay from the measured latency', () => {
  it('clamps chunk + latency + 1 to 6..20', () => {
    expect(autoDelayFromLatency(8, 5.1)).toBe(15);
    expect(autoDelayFromLatency(8, 0.5)).toBe(10);
    expect(autoDelayFromLatency(8, 60)).toBe(20);
    expect(autoDelayFromLatency(8, 0)).toBe(15); // nothing measured yet
    expect(resolveLiveDelaySec(-1, 'hls', 8, 5)).toBe(14);
    expect(resolveLiveDelaySec(-1, 'mse', 8, 5)).toBe(0);
    expect(resolveLiveDelaySec(25, 'hls', 8, 5)).toBe(25);
  });

  it('the dub of a cell is ready while its slot is still in the future (numbers of the 2026-10-24 report)', () => {
    const asr = 4.4, translate = 0.1, tts = 0.6, chunk = LIVE_CHUNK_SEC;
    const latency = asr + translate + tts;
    for (const delay of [20, autoDelayFromLatency(chunk, latency)]) {
      for (let cellStart = 0; cellStart < 80; cellStart += chunk) {
        // live time: the cell's last audio exists at cellStart + chunk; the dub is ready `latency` later
        const readyLive = cellStart + chunk + latency;
        const playheadThen = readyLive - delay; // the player runs `delay` behind the live edge
        expect(cellStart - playheadThen).toBeGreaterThan(0.5); // slot start still ahead
      }
    }
    expect(8 + latency).toBeCloseTo(13.1, 1);
    expect(0 - (8 + latency - 20)).toBeCloseTo(6.9, 1); // ~7 s in the future with delay 20
  });
});
