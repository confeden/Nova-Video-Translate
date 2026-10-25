import { afterEach, describe, expect, it } from 'vitest';
import { TranslationEngine } from '../src/pipeline';
import { diag } from '../src/diag';
import { localReasons, reasonText } from '../src/localasr';
import { AUTO_LIVE_DELAY_SEC, availableBackSec, isDefinitelyLive, resolveLiveDelaySec } from '../src/live/liveDelay';
import { liveVideoVoiceOverride, normalizeSettings, withSiteOverride } from '../src/settings';
import { readAudioTracks, type AudioTracksController, type AudioTracksState } from '../src/nativedub/audioTracks';
import { DEFAULT_SETTINGS } from '../src/types';
import type { AudioChunk } from '../src/providers/types';
import { FakeCapture, FakeProvider, FakeScheduler, flush, instantSleep, settings } from './helpers/pipelineFakes';

const ranges = (...r: Array<[number, number]>) => ({ length: r.length, start: (i: number) => r[i]![0], end: (i: number) => r[i]![1] });

/** a YouTube live player's <video>: DVR window [0, 3600] seekable, a few seconds buffered around the playhead */
class YtLiveVideo extends EventTarget {
  duration: number;
  paused = false;
  ended = false;
  volume = 1;
  seekable = ranges([0, 3600]);
  buffered = ranges([3590, 3605]);
  seeks: number[] = [];
  private _ct = 3600;
  constructor(duration = 3600) {
    super();
    this.duration = duration;
  }
  get currentTime(): number {
    return this._ct;
  }
  set currentTime(v: number) {
    this._ct = v;
    this.seeks.push(v);
  }
}

class OwnSeekCapture extends FakeCapture {
  ownSeeks = 0;
  noteOwnSeek(): void {
    this.ownSeeks++;
  }
}

class Tracks implements AudioTracksController {
  constructor(private readonly st: AudioTracksState | null) {}
  async list(): Promise<AudioTracksState | null> {
    return this.st && { ...this.st };
  }
  async select(): Promise<boolean> {
    return false;
  }
}

const evs = (name: string) => diag.entries().filter((e) => e.ev === name);

function setup(video: YtLiveVideo, tracks: Tracks | undefined, over: Partial<typeof DEFAULT_SETTINGS> = {}) {
  const providers = [new FakeProvider('yandex-live'), new FakeProvider('yandex'), new FakeProvider('gemini'), new FakeProvider('local')];
  const caps: OwnSeekCapture[] = [];
  const engine = new TranslationEngine({
    video: video as unknown as HTMLVideoElement,
    audioCtx: {} as AudioContext,
    providers,
    settings: settings({
      voiceOrder: ['yandex-live', 'yandex', 'gemini', 'local'],
      voiceEnabled: { ...DEFAULT_SETTINGS.voiceEnabled, 'yandex-live': true, yandex: true, gemini: true, local: true },
      liveDelaySec: -1,
      ...over,
    }),
    host: 'www.youtube.com',
    createCapture: (async () => {
      const c = new OwnSeekCapture();
      c.kind = 'mse';
      caps.push(c);
      return c;
    }) as never,
    createScheduler: ((_v: unknown, _c: unknown, o: any) => new FakeScheduler(o)) as never,
    now: () => 0,
    sleep: instantSleep(),
    hintSleep: () => new Promise(() => {}),
    retryDelayMs: 10,
    videoKey: () => 'yt:liveVideo1',
    audioTracks: tracks,
    detectLanguage: async () => ({ lang: 'en', confidence: 0.95, how: 'test', signals: [] }) as never,
  });
  return { engine, providers, caps };
}

afterEach(() => localReasons.clearAll());

describe('dub lag default', () => {
  it('is 1 s for new and unset settings; an explicit value is kept', () => {
    expect(DEFAULT_SETTINGS.dubLagSec).toBe(1);
    expect(normalizeSettings({}).dubLagSec).toBe(1);
    expect(normalizeSettings({ dubLagSec: 3 }).dubLagSec).toBe(3);
  });
});

describe('live helpers for finite live windows (YouTube DVR)', () => {
  it('isDefinitelyLive: Infinity or an absurd seekable end, never NaN', () => {
    expect(isDefinitelyLive({ duration: Infinity })).toBe(true);
    expect(isDefinitelyLive({ duration: 100, seekable: ranges([0, 1073741824]) })).toBe(true);
    expect(isDefinitelyLive({ duration: NaN })).toBe(false);
    expect(isDefinitelyLive({ duration: 3600, seekable: ranges([0, 3600]) })).toBe(false);
  });

  it('availableBackSec: the DVR window counts when it is larger than the buffer; Twitch absurd seekable is ignored', () => {
    expect(availableBackSec({ buffered: ranges([3590, 3605]), seekable: ranges([0, 3600]) }, 3600)).toEqual({ sec: 3600, via: 'dvr' });
    expect(availableBackSec({ buffered: ranges([70, 120]), seekable: ranges([0, 1073741824]) }, 100)).toEqual({ sec: 30, via: 'buffer' });
    expect(availableBackSec({ buffered: ranges([3500, 3605]), seekable: ranges([3590, 3600]) }, 3600)).toEqual({ sec: 100, via: 'buffer' });
    expect(availableBackSec({ buffered: undefined, seekable: undefined }, 5)).toEqual({ sec: 0, via: 'buffer' });
  });

  it('auto delay: mse captures count on a live video only; hls always; direct/realtime never', () => {
    expect(resolveLiveDelaySec(-1, 'mse', 8, 0, 1, true)).toBe(AUTO_LIVE_DELAY_SEC);
    expect(resolveLiveDelaySec(-1, 'mse', 8, 0, 1, false)).toBe(0);
    expect(resolveLiveDelaySec(-1, 'hls', 8, 0, 1, false)).toBe(AUTO_LIVE_DELAY_SEC);
    expect(resolveLiveDelaySec(-1, 'realtime', 8, 0, 1, true)).toBe(0);
    expect(resolveLiveDelaySec(7, 'mse', 8, 0, 1, false)).toBe(7);
    // the lag is a parameter of the measured formula: a bigger lag gives the pipeline more time => a smaller delay
    expect(resolveLiveDelaySec(-1, 'mse', 8, 12, 1, true)).toBeGreaterThan(resolveLiveDelaySec(-1, 'mse', 8, 12, 3, true));
  });

  it('live voice override: local tier only, applied for a live video on any host', () => {
    const s = withSiteOverride(DEFAULT_SETTINGS, 'www.youtube.com', true);
    expect(s.voiceEnabled).toMatchObject(liveVideoVoiceOverride());
    expect(s.voiceEnabled.yandex).toBe(false);
    expect(withSiteOverride(DEFAULT_SETTINGS, 'www.youtube.com', false)).toBe(DEFAULT_SETTINGS);
  });

  it('readAudioTracks reports isLive from the player response / video data, also without any audio tracks', () => {
    const player = { getPlayerResponse: () => ({ videoDetails: { videoId: 'a', isLive: true } }), getVideoData: () => ({ video_id: 'a' }) };
    const st = readAudioTracks({ getElementById: () => player }, undefined);
    expect(st?.live).toBe(true);
    expect(st?.tracks).toEqual([]);
    const vod = readAudioTracks({ getElementById: () => ({ getPlayerResponse: () => ({ videoDetails: { videoId: 'a', isLive: false } }), getVideoData: () => ({ video_id: 'a' }) }) }, undefined);
    expect(vod).toBeNull();
    const viaData = readAudioTracks({ getElementById: () => ({ getVideoData: () => ({ video_id: 'a', isLive: true }) }) }, undefined);
    expect(viaData?.live).toBe(true);
  });
});

describe('engine: YouTube live stream', () => {
  it('isLive from the bridge on a finite DVR duration: local tier only, delay by seeking inside the DVR window, own seek announced, window restarted', async () => {
    diag.clear();
    const video = new YtLiveVideo(3600);
    const { engine, providers, caps } = setup(video, new Tracks({ tracks: [], canSelect: false, live: true }));
    await engine.start();
    await flush();
    expect(evs('live-video')[0]?.data).toMatchObject({ via: 'yt-isLive' });
    // never a yandex / gemini request: only the local tier is usable
    expect(evs('engine-start')[0]?.data).toMatchObject({ usable: ['local'] });
    caps[0]!.emit({ startSec: 3590, durationSec: 8, sampleRate: 16000, pcm: new Int16Array(8) } as AudioChunk);
    await flush();
    for (const p of providers.filter((x) => x.id !== 'local')) expect(p.calls).toHaveLength(0);
    // the live delay seeks back inside the DVR window although the player buffer is only a few seconds
    expect(video.seeks).toEqual([3600 - engine.effectiveLiveDelaySec()]);
    expect(caps[0]!.ownSeeks).toBe(1);
    // the engine consumes the seeked event of the own seek and restarts the capture window there
    video.dispatchEvent(new Event('seeked'));
    await flush();
    expect(caps[0]!.starts.at(-1)).toBe(3600 - engine.effectiveLiveDelaySec());
    // the status text is informative: the user had cloud voices
    expect(localReasons.first()).toEqual({ key: 'live', text: reasonText.live() });
    expect(reasonText.live()).toBe('Прямой эфир: перевод локальными моделями');
    engine.stop();
  });

  it('Infinity duration, no bridge: same treatment (duration signal)', async () => {
    diag.clear();
    const video = new YtLiveVideo(Infinity);
    const { engine, caps } = setup(video, undefined);
    await engine.start();
    await flush();
    expect(evs('live-video')[0]?.data).toMatchObject({ via: 'duration' });
    expect(evs('engine-start')[0]?.data).toMatchObject({ usable: ['local'] });
    expect(video.seeks).toEqual([3600 - engine.effectiveLiveDelaySec()]);
    expect(caps).toHaveLength(1);
    engine.stop();
  });

  it('an explicit delay larger than the DVR window is cut to window - 1 and the reasons are logged', async () => {
    diag.clear();
    const video = new YtLiveVideo(3600);
    video.seekable = ranges([3590, 3600]); // only 10 s of DVR
    video.buffered = ranges([3595, 3605]);
    const { engine } = setup(video, new Tracks({ tracks: [], canSelect: false, live: true }), { liveDelaySec: 30 });
    await engine.start();
    await flush();
    expect(video.seeks.length).toBeLessThanOrEqual(1);
    if (video.seeks.length === 1) expect(video.seeks[0]).toBeGreaterThanOrEqual(3590);
    // no DVR at all: nothing to seek into, the reason is logged
    diag.clear();
    const v2 = new YtLiveVideo(3600);
    v2.seekable = ranges([3599, 3600]);
    v2.buffered = ranges([3599, 3602]);
    const s2 = setup(v2, new Tracks({ tracks: [], canSelect: false, live: true }), { liveDelaySec: 20 });
    await s2.engine.start();
    await flush();
    expect(v2.seeks).toEqual([]);
    expect(evs('live-delay-skip').some((e) => (e.data as { reason?: string }).reason === 'no-backbuffer')).toBe(true);
    engine.stop();
    s2.engine.stop();
  });

  it('a VOD (isLive false, finite seekable) is untouched: cloud tiers stay, no live delay, no live reason', async () => {
    diag.clear();
    const video = new YtLiveVideo(600);
    video.seekable = ranges([0, 600]);
    video.buffered = ranges([0, 60]);
    video.currentTime = 10;
    video.seeks.length = 0;
    const { engine } = setup(video, new Tracks({ tracks: [{ id: 'en.4', original: true, ru: false }], currentId: 'en.4', canSelect: true }));
    await engine.start();
    await flush();
    expect(evs('live-video')).toHaveLength(0);
    expect((evs('engine-start')[0]?.data as { usable: string[] }).usable).toContain('yandex');
    expect(video.seeks).toEqual([]);
    expect(localReasons.first()).toBeUndefined();
    engine.stop();
  });
});
