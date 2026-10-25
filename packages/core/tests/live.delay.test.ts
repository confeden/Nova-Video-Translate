import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTO_LIVE_DELAY_SEC, LiveDelayController, backBufferSec, isLiveVideo, resolveLiveDelaySec, safeDelaySec } from '../src/live/liveDelay';
import { normalizeSettings, siteVoiceOverride, withSiteOverride } from '../src/settings';
import { DEFAULT_SETTINGS } from '../src/types';

const ranges = (...r: Array<[number, number]>) => ({ length: r.length, start: (i: number) => r[i]![0], end: (i: number) => r[i]![1] });

class FakeVideo extends EventTarget {
  duration = Infinity;
  paused = false;
  ended = false;
  seekable = ranges([0, 1073741824]);
  buffered = ranges([70, 120]);
  seeks: number[] = [];
  private _ct = 100;
  get currentTime() {
    return this._ct;
  }
  set currentTime(v: number) {
    this._ct = v;
    this.seeks.push(v);
  }
  setCt(v: number) {
    this._ct = v;
  }
}

describe('live helpers', () => {
  it('detects live', () => {
    expect(isLiveVideo({ duration: NaN })).toBe(true);
    expect(isLiveVideo({ duration: Infinity })).toBe(true);
    expect(isLiveVideo({ duration: 100, seekable: ranges([0, 1073741824]) })).toBe(true);
    expect(isLiveVideo({ duration: 100, seekable: ranges([0, 100]) })).toBe(false);
  });
  it('back buffer and safe delay', () => {
    expect(backBufferSec(ranges([70, 120]), 100)).toBe(30);
    expect(backBufferSec(ranges([0, 10]), 100)).toBe(0);
    expect(safeDelaySec(15, 30)).toBe(15);
    expect(safeDelaySec(15, 10)).toBe(9);
    expect(safeDelaySec(15, 3)).toBe(0);
  });
});

describe('LiveDelayController', () => {
  let v: FakeVideo;
  let c: LiveDelayController;
  const mk = (delay = 15) => {
    c = new LiveDelayController({ video: v as unknown as HTMLVideoElement, getDelaySec: () => delay });
    return c;
  };
  beforeEach(() => {
    vi.useFakeTimers();
    v = new FakeVideo();
  });
  afterEach(() => {
    c?.stop();
    vi.useRealTimers();
  });

  it('seeks back once by the asked delay', () => {
    mk().start();
    expect(v.seeks).toEqual([85]);
    expect(c.takeOwnSeek()).toBe(true);
    expect(c.takeOwnSeek()).toBe(false);
    vi.advanceTimersByTime(30_000);
    expect(v.seeks).toHaveLength(1);
  });

  it('waits for the back buffer to grow, then applies the asked delay', () => {
    v.buffered = ranges([98, 100]);
    mk().start();
    expect(v.seeks).toHaveLength(0);
    v.buffered = ranges([60, 100]);
    vi.advanceTimersByTime(2000);
    expect(v.seeks).toEqual([85]);
  });

  it('after 60 s applies the largest safe delay', () => {
    v.buffered = ranges([92, 100]); // available 8 -> 7 s
    mk().start();
    vi.advanceTimersByTime(58_000);
    expect(v.seeks).toHaveLength(0);
    vi.advanceTimersByTime(4000);
    expect(v.seeks).toEqual([93]);
  });

  it('does nothing while paused and after a user seek', () => {
    v.paused = true;
    mk().start();
    vi.advanceTimersByTime(10_000);
    expect(v.seeks).toHaveLength(0);
    v.paused = false;
    v.dispatchEvent(new Event('seeking')); // user seek
    vi.advanceTimersByTime(20_000);
    expect(v.seeks).toHaveLength(0);
  });

  it('re-arms after a player reset (currentTime 0) and applies again', () => {
    mk().start();
    expect(v.seeks).toHaveLength(1);
    vi.advanceTimersByTime(4000); // past the own-seek window
    v.setCt(0);
    v.buffered = ranges();
    v.dispatchEvent(new Event('seeking'));
    vi.advanceTimersByTime(2000);
    expect(v.seeks).toHaveLength(1); // nothing buffered
    v.setCt(60);
    v.buffered = ranges([20, 60]);
    vi.advanceTimersByTime(2000);
    expect(v.seeks).toEqual([85, 45]);
  });

  it('is off when delay is 0', () => {
    mk(0).start();
    vi.advanceTimersByTime(10_000);
    expect(v.seeks).toHaveLength(0);
  });
});

describe('site override and setting', () => {
  it('twitch hosts use the local tier only', () => {
    for (const h of ['twitch.tv', 'www.twitch.tv', 'm.twitch.tv', 'TWITCH.TV']) {
      expect(siteVoiceOverride(h)).toMatchObject({ local: true, yandex: false, 'yandex-live': false, groq: false, gemini: false });
    }
    expect(siteVoiceOverride('nottwitch.tv')).toBeUndefined();
    expect(siteVoiceOverride('youtube.com')).toBeUndefined();
    expect(siteVoiceOverride('')).toBeUndefined();
    const s = withSiteOverride(DEFAULT_SETTINGS, 'www.twitch.tv');
    expect(s.voiceEnabled.groq).toBe(false);
    expect(DEFAULT_SETTINGS.voiceEnabled.groq).toBe(true);
    expect(withSiteOverride(DEFAULT_SETTINGS, 'youtube.com')).toBe(DEFAULT_SETTINGS);
  });
  it('liveDelaySec is normalized', () => {
    expect(normalizeSettings({}).liveDelaySec).toBe(-1);
    expect(normalizeSettings({ liveDelaySec: 0 }).liveDelaySec).toBe(0);
    expect(normalizeSettings({ liveDelaySec: 99 }).liveDelaySec).toBe(60);
    expect(normalizeSettings({ liveDelaySec: -4 }).liveDelaySec).toBe(-1);
    expect(normalizeSettings({ liveDelaySec: 'x' }).liveDelaySec).toBe(-1);
  });
});

describe('auto live delay (-1)', () => {
  it('is 15 s only while the hls capture runs; explicit values win', () => {
    expect(AUTO_LIVE_DELAY_SEC).toBe(15);
    expect(resolveLiveDelaySec(-1, 'hls')).toBe(15);
    for (const k of ['mse', 'direct', 'realtime', undefined]) expect(resolveLiveDelaySec(-1, k)).toBe(0);
    expect(resolveLiveDelaySec(0, 'hls')).toBe(0);
    expect(resolveLiveDelaySec(8, 'realtime')).toBe(8);
    expect(resolveLiveDelaySec(8, 'hls')).toBe(8);
  });
});

describe('auto live delay with the dub lag', () => {
  it('delay = clamp(ceil(chunk + latency + 1 - lag), 6, 20)', async () => {
    const { autoDelayFromLatency } = await import('../src/live/liveDelay');
    expect(autoDelayFromLatency(8, 5, 0)).toBe(14);
    expect(autoDelayFromLatency(8, 5, 2)).toBe(12);
    // a fast GPU pipeline (~1 s end to end) needs ~10 s, not 18
    expect(autoDelayFromLatency(8, 1, 0)).toBe(10);
    expect(autoDelayFromLatency(8, 0.5, 2)).toBe(8);
    expect(autoDelayFromLatency(4, 0.5, 3)).toBe(6);
    expect(autoDelayFromLatency(8, 60, 2)).toBe(20);
    expect(resolveLiveDelaySec(-1, 'hls', 8, 5, 2)).toBe(12);
    expect(resolveLiveDelaySec(-1, 'mse', 8, 5, 2)).toBe(0);
  });
});
