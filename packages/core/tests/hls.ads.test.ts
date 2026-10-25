import { afterEach, describe, expect, it, vi } from 'vitest';
import { HlsCapture, ADS_SETTLE_MS, ALIGN_GIVE_UP_FAILS, type PcmMonitor } from '../src/capture/hls/hlsCapture';
import type { AacDecoder } from '../src/capture/hls/aac';
import { Envelope, correlateEnvelopes } from '../src/capture/hls/align';
import { adSummary, parseMediaPlaylist } from '../src/capture/hls/playlist';
import { diag } from '../src/diag';
import { LiveDelayController } from '../src/live/liveDelay';
import { TranslationEngine, HLS_PROBE_EVERY_MS } from '../src/pipeline';
import { localReasons, reasonText } from '../src/localasr';
import type { AudioChunk } from '../src/providers/types';
import type { CaptureOptions, CaptureStatus } from '../src/capture';
import { audioSegment } from './hlsFixtures';
import { FakeCapture, FakeProvider, FakeScheduler, FakeVideo, flush, instantSleep, settings } from './helpers/pipelineFakes';

// ---- synthetic stream: a speech-like envelope as a function of absolute time ----
function amp(t: number): number {
  const k = Math.floor(t * 2.7);
  const x = Math.sin(k * 12.9898) * 43758.5453;
  const r = x - Math.floor(x);
  return r < 0.3 ? 0.01 : 0.05 + 0.5 * r;
}
function signal(t0: number, n: number): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = t0 + i / 16000;
    out[i] = Math.sin(2 * Math.PI * 220 * t) * amp(t);
  }
  return out;
}

const P0 = 970;
const OFFSET = 990.5;

/** playlist with per-sequence ad flags: ad segments carry the ad network title like Twitch's stitched ads */
function harness(opts: { monitorEvents?: boolean } = {}) {
  let first = 14;
  let last = 29;
  const ads = new Set<number>();
  let daterange = false;
  let dom = false;
  const playlist = (): string => {
    let s = `#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:${first}\n`;
    if (daterange) s += '#EXT-X-DATERANGE:ID="stitched-ad-1",CLASS="twitch-stitched-ad",START-DATE="2026-10-25T01:00:00.000Z",DURATION=30.0\n';
    for (let i = first; i <= last; i++) s += ads.has(i) ? `#EXTINF:2.000,Amazon|123\nad${i}.ts\n` : `#EXTINF:2.000,live\nseg${i}.ts\n`;
    return s;
  };
  const fetched: string[] = [];
  const fetchFn = vi.fn(async (url: string): Promise<Response> => {
    if (url.endsWith('index.m3u8')) return new Response(playlist());
    const m = /seg(\d+)\.ts$/.exec(url);
    if (m) {
      fetched.push(url);
      return new Response(audioSegment(P0 + Number(m[1]) * 2, 94, 2) as BlobPart);
    }
    return new Response('', { status: 404 });
  });
  const decoder: AacDecoder = {
    kind: 'decodeAudioData',
    decode: async (frames) => {
      const n = Math.round((frames.length * 1024 * 16000) / 48000);
      const f = signal(frames[0]!.pts, n);
      const out = new Int16Array(n);
      for (let i = 0; i < n; i++) out[i] = Math.round(f[i]! * 32767);
      return out;
    },
    close() {},
  };
  let onPcm: (s: Float32Array, vt: number) => void = () => {};
  let monCount = 0;
  let monCb: (s: { type: string }) => void = () => {};
  const monitor: PcmMonitor = { start: async () => {}, stop() {}, onStatus: (cb) => ((monCb = cb as never), () => {}) };
  void opts;
  let clock = 1_000_000;
  const statuses: Array<{ type: string; active?: boolean; reason?: string }> = [];
  const cap = new HlsCapture({
    video: { addEventListener() {}, removeEventListener() {} } as unknown as HTMLMediaElement,
    channel: 'chan',
    fetchFn,
    mediaUrl: 'https://v.example/audio_only/index.m3u8',
    monitorFactory: (cb) => {
      onPcm = cb;
      monCount++;
      return monitor;
    },
    decoderFactory: async () => decoder,
    onStatus: (s) => statuses.push(s as never),
    adProbe: () => dom,
    adPollMs: 3_600_000,
    now: () => clock,
    sleep: (_ms, signal) => new Promise<void>((r) => signal.addEventListener('abort', () => r(), { once: true })),
  });
  const chunks: AudioChunk[] = [];
  cap.onChunk((c) => chunks.push(c));
  const feedVideo = (fromVt: number, toVt: number, off = OFFSET): void => {
    const blk = 1600;
    for (let vt = fromVt; vt < toVt; vt += blk / 16000) onPcm(signal(vt + off, blk), vt + blk / 16000);
  };
  /** the live edge advances by one segment; `ad` marks it as a stitched-ad segment */
  const advance = async (ad: boolean): Promise<void> => {
    last++;
    first = Math.max(0, last - 15);
    if (ad) ads.add(last);
    clock += 1300;
    await cap.pollOnce();
  };
  return { cap, chunks, feedVideo, statuses, advance, tick: (ms: number) => (clock += ms), clock: () => clock, setDaterange: (v: boolean) => (daterange = v), fetched, ads, setDom: (v: boolean) => (dom = v), monitorStatus: (s: { type: string }) => monCb(s), monitors: () => monCount, tickAd: () => cap.tickAdProbe() };
}

describe('ad break detection (hls)', () => {
  it('the player shows an ad (DOM): no alignment attempts, no failures, no chunks, status ads; cleared 1 s after the DOM evidence is gone', async () => {
    const h = harness();
    await h.cap.start(0);
    await vi.waitFor(() => expect(h.cap.state().historySec).toBeGreaterThan(30));
    // playlist ad segments ALONE are not a break
    await h.advance(true);
    await h.advance(true);
    await h.advance(true);
    expect(h.cap.state().inAds).toBe(false);
    expect(h.statuses.some((s) => s.type === 'ads')).toBe(false);
    h.setDom(true);
    h.tickAd();
    expect(h.cap.state().inAds).toBe(true);
    expect(h.statuses).toContainEqual({ type: 'ads', active: true });
    for (let vt = 0; vt < 100; vt += 10) {
      h.feedVideo(vt, vt + 10, 9000);
      await h.advance(true);
      h.tick(3000);
      h.tickAd();
    }
    expect(h.statuses.some((s) => s.type === 'unsupported')).toBe(false); // 100 s of failing audio would have given up before
    expect(h.cap.state().aligned).toBe(false);
    expect(h.chunks).toHaveLength(0);
    expect(h.fetched.every((u) => !u.includes('/ad'))).toBe(true);
    // evidence gone: still an ad for < 1 s, cleared after it
    h.setDom(false);
    h.tickAd();
    expect(h.cap.state().inAds).toBe(true);
    h.tick(500);
    h.setDom(true); // flicker: the 1 s hold restarts
    h.tickAd();
    h.setDom(false);
    h.tick(300);
    h.tickAd();
    expect(h.cap.state().inAds).toBe(true);
    h.tick(1100);
    h.tickAd();
    expect(h.cap.state().inAds).toBe(false);
    expect(h.statuses).toContainEqual({ type: 'ads', active: false });
    h.cap.stop();
  });

  it('playlist ads while the player shows NO ad are only a gap: no ad status, offset and chunks unchanged, diag hls-gap', async () => {
    diag.clear();
    const h = harness();
    h.setDaterange(true);
    await h.cap.start(0);
    await vi.waitFor(() => expect(h.cap.state().historySec).toBeGreaterThan(30));
    h.feedVideo(8, 30);
    await h.cap.pollOnce();
    expect(h.cap.state().aligned).toBe(true);
    const off = h.cap.state().offsetSec;
    const before = h.chunks.length;
    for (let i = 0; i < 6; i++) await h.advance(true);
    h.tickAd();
    expect(h.cap.state().inAds).toBe(false);
    expect(h.statuses.some((s) => s.type === 'ads')).toBe(false);
    expect(h.cap.state().aligned).toBe(true);
    expect(h.cap.state().offsetSec).toBe(off);
    await h.advance(false);
    await h.advance(false);
    expect(h.cap.state().offsetSec).toBe(off); // no re-measuring after the gap
    expect(h.chunks.length).toBeGreaterThan(before);
    const gaps = diag.entries().filter((e) => e.ev === 'hls-gap');
    expect(gaps.length).toBeGreaterThan(0);
    expect(gaps.reduce((n, e) => n + (e.data as { segments: number }).segments, 0)).toBe(6);
    expect((gaps[0]!.data as { sec: number }).sec).toBeGreaterThan(0);
    expect(h.fetched.every((u) => !u.includes('/ad'))).toBe(true);
    h.cap.stop();
  });

  it('while aligned, an ad break stops chunk delivery and re-verification; after it the mapping is recalibrated from scratch', async () => {
    const h = harness();
    await h.cap.start(0);
    await vi.waitFor(() => expect(h.cap.state().historySec).toBeGreaterThan(30));
    h.feedVideo(8, 30);
    await h.cap.pollOnce();
    expect(h.cap.state().aligned).toBe(true);
    const before = h.chunks.length;
    // break: the player shows the ad (6 ad segments = 12 s), then live again with a different mapping (the ad shifted the video clock by 2 s)
    h.setDom(true);
    h.tickAd();
    for (let i = 0; i < 6; i++) await h.advance(true);
    expect(h.cap.state().inAds).toBe(true);
    expect(h.chunks.length).toBe(before);
    // first clean poll: the DOM still shows the ad, nothing emitted
    await h.advance(false);
    expect(h.cap.state().inAds).toBe(true);
    expect(h.chunks.length).toBe(before);
    h.setDom(false); // the ad UI is gone; 1 s later the break is over
    h.tickAd();
    h.tick(1100);
    h.tickAd();
    expect(h.cap.state().inAds).toBe(false);
    expect(h.statuses).toContainEqual({ type: 'ads', active: false });
    expect(h.cap.state().aligned).toBe(false); // from scratch
    expect(h.cap.state().offsetSec).toBeUndefined();
    // the player now plays the stream again with the new mapping; it needs fresh video audio before the next try
    const NEW = OFFSET + 2;
    h.tick(4000);
    h.feedVideo(10, 30, NEW);
    await h.advance(false);
    h.tick(4000);
    await h.cap.pollOnce();
    expect(h.cap.state().aligned).toBe(true);
    expect(h.cap.state().offsetSec).toBeCloseTo(NEW, 1);
    // chunks emitted after recalibration start no earlier than the first post-break segment
    const firstPostPts = P0 + 36 * 2; // segments 30..35 are ads (6), 36 is the first clean one
    const post = h.chunks.slice(before);
    expect(post.length).toBeGreaterThan(0);
    for (const c of post) expect(c.startSec + NEW).toBeGreaterThanOrEqual(firstPostPts - 0.01);
    h.cap.stop();
  });

  it('failures during the settling time after a break are not counted; later failures still give up', async () => {
    const h = harness();
    await h.cap.start(0);
    await vi.waitFor(() => expect(h.cap.state().historySec).toBeGreaterThan(30));
    h.setDom(true);
    h.tickAd();
    await h.advance(true);
    await h.advance(false);
    h.setDom(false);
    h.tickAd();
    h.tick(1100);
    h.tickAd(); // break over, settle window opens
    expect(h.cap.state().inAds).toBe(false);
    // unrelated audio for > 60 s of video, but all inside the settle window
    let vt = 0;
    for (let i = 0; i < 14; i++) {
      h.feedVideo(vt, vt + 5, 9000);
      vt += 5;
      h.tick(2900);
      await h.cap.pollOnce();
    }
    expect(h.statuses.some((s) => s.type === 'unsupported')).toBe(false);
    // beyond the settle window the failures count
    h.tick(ADS_SETTLE_MS);
    for (let i = 0; i < ALIGN_GIVE_UP_FAILS + 3; i++) {
      h.feedVideo(vt, vt + 5, 9000);
      vt += 5;
      h.tick(3100);
      await h.cap.pollOnce();
    }
    expect(h.statuses.some((s) => s.type === 'unsupported' && s.reason === 'align-failed')).toBe(true);
    h.cap.stop();
  });
});

describe('playlist ad flag', () => {
  it('adBreak is set by a stitched-ad DATERANGE and not by a plain live playlist', () => {
    const ad = parseMediaPlaylist('#EXTM3U\n#EXT-X-DATERANGE:ID="stitched-ad-1",CLASS="twitch-stitched-ad",START-DATE="2026-10-25T01:00:00.000Z",DURATION=30.0\n#EXTINF:2.0,live\na.ts\n');
    expect(ad.adBreak).toBe(true);
    expect(parseMediaPlaylist('#EXTM3U\n#EXTINF:2.0,live\na.ts\n').adBreak).toBe(false);
  });
});

describe('robust alignment (music-heavy streams)', () => {
  // two competing candidates: peak 0.45-ish with a high second is rejected strictly, a lower peak with a clear ratio is accepted
  const build = (noise: number) => {
    const rate = 20;
    const video = new Envelope(rate * 200);
    const hls = new Envelope(rate * 200);
    const shift = 12; // hls bin = video bin + 12 s
    for (let b = 0; b < rate * 60; b++) {
      const sig = amp(b / rate) ** 2;
      const nz = noise * amp(b / rate + 77.7);
      const v = new Float32Array(160).fill(Math.sqrt(sig));
      const h = new Float32Array(160).fill(Math.sqrt(sig * (1 - noise) + nz * noise));
      video.add(v, 16000, b / rate);
      hls.add(h, 16000, b / rate + shift);
    }
    return { video, hls };
  };

  it('reports the ratio and accepts a modest peak that stands out of the runner-up by 1.4x', () => {
    const { video, hls } = build(0.6);
    const strict = correlateEnvelopes(video, hls, { fromSec: 10, toSec: 40, centerSec: 12, rangeSec: 30, minPeak: 0.99 });
    expect(strict.ok).toBe(false);
    expect(strict.ratio).toBeGreaterThan(1.4);
    const relaxed = correlateEnvelopes(video, hls, { fromSec: 10, toSec: 40, centerSec: 12, rangeSec: 30, minPeak: 0.99, relaxedPeak: 0.4, minRatio: 1.4 });
    expect(relaxed.ok).toBe(true);
    expect(relaxed.offsetSec).toBeCloseTo(12, 1);
  });

  it('does not accept a flat ratio even above the relaxed peak', () => {
    const { video, hls } = build(0.6);
    const r = correlateEnvelopes(video, hls, { fromSec: 10, toSec: 40, centerSec: 12, rangeSec: 30, minPeak: 0.99, relaxedPeak: 0.4, minRatio: 50 });
    expect(r.ok).toBe(false);
  });
});

describe('live delay is suspended during ads', () => {
  afterEach(() => vi.useRealTimers());
  it('no seek while suspended, seeks once the break is over', () => {
    vi.useFakeTimers();
    const ranges = (...r: Array<[number, number]>) => ({ length: r.length, start: (i: number) => r[i]![0], end: (i: number) => r[i]![1] });
    const seeks: number[] = [];
    let ct = 100;
    class V extends EventTarget {
      duration = Infinity;
      paused = false;
      ended = false;
      buffered = ranges([70, 120]);
      get currentTime(): number {
        return ct;
      }
      set currentTime(x: number) {
        ct = x;
        seeks.push(x);
      }
    }
    const v = new V();
    let ads = true;
    const c = new LiveDelayController({ video: v as unknown as HTMLVideoElement, getDelaySec: () => 15, suspended: () => ads });
    c.start();
    vi.advanceTimersByTime(10_000);
    expect(seeks).toHaveLength(0);
    ads = false;
    vi.advanceTimersByTime(2500);
    expect(seeks).toEqual([85]);
    c.stop();
  });
});

describe('engine: ads reason and background hls probe', () => {
  function engineSetup() {
    const video = new FakeVideo();
    const caps: Array<FakeCapture & { opts: CaptureOptions }> = [];
    const engine = new TranslationEngine({
      video: video as unknown as HTMLVideoElement,
      audioCtx: {} as AudioContext,
      providers: [new FakeProvider('gemini')],
      settings: settings({ voiceOrder: ['gemini'] }),
      host: 'example.com',
      createCapture: (async (_v: unknown, o: CaptureOptions = {}) => {
        const c = Object.assign(new FakeCapture(), { opts: o });
        c.kind = o.strategies?.length === 1 && o.strategies[0] === 'hls' ? 'hls' : caps.length === 0 ? 'hls' : 'realtime';
        caps.push(c);
        return c;
      }) as never,
      createScheduler: ((_v: unknown, _c: unknown, o: any) => {
        const s = new FakeScheduler(o);
        s.onStarve = o.onStarve;
        return s;
      }) as never,
      now: () => 0,
      sleep: instantSleep(),
      retryDelayMs: 10,
      hlsProbeEveryMs: 20,
      hlsProbeRunMs: 60_000,
    });
    return { engine, caps, video };
  }
  const status = (c: { opts: CaptureOptions }, s: CaptureStatus): void => c.opts.onStatus!(s);

  afterEach(() => localReasons.clearAll());

  it('an ads status shows the local reason (no banner) and clears when the break ends', async () => {
    const { engine, caps } = engineSetup();
    await engine.start();
    status(caps[0]!, { type: 'ads', active: true });
    expect(localReasons.first()).toEqual({ key: 'ads', text: reasonText.ads() });
    expect(reasonText.ads()).toBe('Идёт реклама: перевод начнётся после неё');
    status(caps[0]!, { type: 'ads', active: false });
    expect(localReasons.first()).toBeUndefined();
    engine.stop();
  });

  it('align-failed falls back to realtime, keeps probing hls and switches back when the probe aligns', async () => {
    const { engine, caps } = engineSetup();
    await engine.start();
    expect(caps[0]!.kind).toBe('hls');
    status(caps[0]!, { type: 'unsupported', reason: 'align-failed' });
    await flush();
    await vi.waitFor(() => expect(caps.length).toBeGreaterThanOrEqual(2)); // realtime opened
    expect(caps[1]!.kind).toBe('realtime');
    // first probe fails (its own alignment is unsupported) -> re-armed
    await vi.waitFor(() => expect(caps.length).toBeGreaterThanOrEqual(3));
    expect(caps[2]!.kind).toBe('hls');
    expect(caps[2]!.opts.strategies).toEqual(['hls']);
    status(caps[2]!, { type: 'unsupported', reason: 'align-failed' });
    await vi.waitFor(() => expect(caps.length).toBeGreaterThanOrEqual(4));
    expect(caps[2]!.stopped).toBe(true);
    // second probe succeeds -> the engine switches back to hls (the realtime capture is stopped)
    status(caps[3]!, { type: 'ads', active: true });
    expect(localReasons.first()?.key).toBe('ads');
    status(caps[3]!, { type: 'aligned' });
    await vi.waitFor(() => expect(caps.length).toBeGreaterThanOrEqual(5));
    expect(caps[1]!.stopped).toBe(true);
    expect(localReasons.first()).toBeUndefined();
    engine.stop();
    expect(HLS_PROBE_EVERY_MS).toBe(30_000);
  });
});

// ---- strict ad detection: only segments that are really ads, and only the NEWEST ones start a break ----
const pdt = (ms: number): string => new Date(ms).toISOString();

describe('strict ad detection (playlist)', () => {
  const T0 = Date.parse('2026-10-25T01:00:00.000Z');
  const seg = (i: number, title = 'live'): string => `#EXT-X-PROGRAM-DATE-TIME:${pdt(T0 + i * 2000)}\n#EXTINF:2.000,${title}\ns${i}.ts\n`;

  it('a stale stitched-ad DATERANGE flags only the segments inside [START, START+DURATION); the newest clean ones are not ads', () => {
    // the ad ran 01:00:00 .. 01:00:10 (segments 0..4); the window now ends at segment 15
    let t = `#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-DATERANGE:ID="stitched-ad-1",CLASS="twitch-stitched-ad",START-DATE="${pdt(T0)}",DURATION=10.0,X-TV-TWITCH-AD-ROLL-TYPE="MIDROLL"\n`;
    for (let i = 0; i < 16; i++) t += seg(i);
    const pl = parseMediaPlaylist(t);
    expect(pl.adBreak).toBe(true); // the tag is there ...
    expect(pl.segments.filter((s) => s.ad).map((s) => s.seq)).toEqual([0, 1, 2, 3, 4]); // ... but only 5 segments lie inside it
    const a = adSummary(pl);
    expect(a.adSegs).toBe(5);
    expect(a.newestIsAd).toBe(false);
    expect(a.lastAdSeq).toBe(4);
  });

  it('a DATERANGE without any duration is capped (a stale open-ended one must not flag the live stream for ever)', () => {
    let t = `#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-DATERANGE:ID="stitched-ad-9",CLASS="twitch-stitched-ad",START-DATE="${pdt(T0)}"\n`;
    for (let i = 0; i < 30; i++) t += seg(i);
    const pl = parseMediaPlaylist(t);
    expect(pl.segments[29]!.ad).toBe(false);
    expect(adSummary(pl).newestIsAd).toBe(false);
  });

  it('trigger / metadata DATERANGEs and unusual segment titles are not ads; the ad network title is', () => {
    const t =
      `#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-DATERANGE:ID="trigger-1",CLASS="twitch-trigger",START-DATE="${pdt(T0)}",DURATION=300\n` +
      `#EXT-X-DATERANGE:ID="source-1",CLASS="twitch-stream-source",START-DATE="${pdt(T0)}",X-TV-TWITCH-STREAM-SOURCE="live"\n` +
      seg(0, 'live') + seg(1, 'channel-points|x') + seg(2, '') + seg(3, 'Amazon|1234') + seg(4, 'twitch-stitched-ad');
    const pl = parseMediaPlaylist(t);
    expect(pl.adBreak).toBe(false);
    expect(pl.segments.map((s) => s.ad)).toEqual([false, false, false, true, true]);
  });

  it('SCTE35 / CUE markers flag the segments between OUT and IN only', () => {
    const t = `#EXTM3U\n${seg(0)}#EXT-X-CUE-OUT:30\n${seg(1)}${seg(2)}#EXT-X-CUE-IN\n${seg(3)}`;
    expect(parseMediaPlaylist(t).segments.map((s) => s.ad)).toEqual([false, true, true, false]);
  });
});

describe('strict ad detection (capture state machine)', () => {
  it('a finished break still in the window (old ad segments, clean newest) never produces an ad state', async () => {
    const h = harness();
    for (const i of [14, 15, 16, 17, 18, 19]) h.ads.add(i); // history of the window
    h.setDaterange(true); // stale DATERANGE on top
    await h.cap.start(0);
    await vi.waitFor(() => expect(h.cap.state().historySec).toBeGreaterThan(20));
    for (let i = 0; i < 6; i++) await h.advance(false);
    expect(h.cap.state().inAds).toBe(false);
    expect(h.statuses.some((s) => s.type === 'ads')).toBe(false);
    expect(h.fetched.every((u) => !u.includes('/ad'))).toBe(true);
    h.cap.stop();
  });

  it('a real break: the DOM drives the state; hls-ad-state carries BOTH evidences', async () => {
    diag.clear();
    const h = harness();
    h.setDaterange(true);
    await h.cap.start(0);
    await vi.waitFor(() => expect(h.cap.state().historySec).toBeGreaterThan(20));
    await h.advance(true);
    await h.advance(true);
    await h.advance(true);
    expect(h.cap.state().inAds).toBe(false);
    h.setDom(true);
    h.tickAd();
    expect(h.cap.state().inAds).toBe(true);
    await h.advance(false);
    await h.advance(false);
    expect(h.cap.state().inAds).toBe(true); // clean playlist alone does not end it
    h.setDom(false);
    h.tickAd();
    h.tick(1100);
    h.tickAd();
    expect(h.cap.state().inAds).toBe(false);
    const ev = diag.entries().filter((e) => e.ev === 'hls-ad-state').map((e) => e.data as { domAd: boolean; playlistAd: boolean; why: string });
    expect(ev.find((e) => e.why === 'playlist-changed' && e.playlistAd)).toMatchObject({ domAd: false, playlistAd: true });
    expect(ev.find((e) => e.why === 'player-shows-ad')).toMatchObject({ domAd: true, playlistAd: true });
    expect(ev.find((e) => e.why === 'player-ad-over')).toMatchObject({ domAd: false });
    h.cap.stop();
  });

  it('a one- or two-poll blip of ad segments never reaches the status', async () => {
    diag.clear();
    const h = harness();
    await h.cap.start(0);
    await vi.waitFor(() => expect(h.cap.state().historySec).toBeGreaterThan(20));
    await h.advance(true);
    await h.advance(true);
    await h.advance(false);
    await h.advance(false);
    await h.advance(false);
    expect(h.cap.state().inAds).toBe(false);
    expect(h.statuses.some((s) => s.type === 'ads')).toBe(false);
    expect(diag.entries().some((e) => e.ev === 'hls-gap')).toBe(true);
    h.cap.stop();
  });

  it('the monitor tap reporting tainted does not abandon hls: the offset is kept, the tap is retried after 10 s', async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ monitorEvents: true });
      await h.cap.start(0);
      await vi.waitFor(() => expect(h.cap.state().historySec).toBeGreaterThan(30));
      h.feedVideo(8, 30);
      await h.cap.pollOnce();
      expect(h.cap.state().aligned).toBe(true);
      const off = h.cap.state().offsetSec;
      h.monitorStatus({ type: 'tainted' });
      await h.advance(false);
      await h.advance(false);
      expect(h.statuses.some((s) => s.type === 'unsupported')).toBe(false);
      expect(h.cap.state().offsetSec).toBe(off);
      const n = h.chunks.length;
      await h.advance(false);
      expect(h.chunks.length).toBeGreaterThan(n); // chunks keep flowing under the constant offset
      expect(h.monitors()).toBe(1);
      vi.advanceTimersByTime(10_500);
      expect(h.monitors()).toBe(2); // a fresh tap
      h.feedVideo(30, 31);
      expect(diag.entries().some((e) => e.ev === 'hls-monitor-up')).toBe(true);
      h.cap.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('own live-delay seek keeps the mapping (no re-measuring)', () => {
  it('aligned: after a seek back by 15 s the offset is unchanged and the first chunks come out with the restart, at once', async () => {
    const h = harness();
    await h.cap.start(0);
    await vi.waitFor(() => expect(h.cap.state().historySec).toBeGreaterThan(30));
    h.feedVideo(8, 30);
    await h.cap.pollOnce();
    expect(h.cap.state().aligned).toBe(true);
    const off = h.cap.state().offsetSec;
    // the controller announces its seek, the element jumps back by 15 s and plays on
    h.cap.noteOwnSeek();
    h.feedVideo(15, 22);
    expect(h.cap.state().aligned).toBe(true);
    expect(h.cap.state().offsetSec).toBe(off);
    // the engine restarts the capture window at the new position: already captured audio is re-delivered synchronously
    const before = h.chunks.length;
    const clock0 = h.clock();
    await h.cap.start(15);
    expect(h.chunks.length).toBeGreaterThan(before);
    expect(h.clock() - clock0).toBeLessThanOrEqual(8_000); // <= one 8 s chunk (it is 0: no waiting)
    for (const c of h.chunks.slice(before)) expect(c.startSec + c.durationSec).toBeGreaterThan(15);
    h.cap.stop();
  });

  it('not yet aligned: the seek does not throw the collected video envelope away, alignment completes on the next poll', async () => {
    const h = harness();
    await h.cap.start(0);
    await vi.waitFor(() => expect(h.cap.state().historySec).toBeGreaterThan(30));
    h.feedVideo(8, 24); // 16 s of the element's audio, no poll yet
    h.cap.noteOwnSeek();
    h.feedVideo(14, 20); // jumped back by 10 s
    h.tick(4000);
    await h.cap.pollOnce();
    expect(h.cap.state().aligned).toBe(true); // without the keep, only 6 s would be left (< 12 s) and this would wait ~6 s more
    expect(h.cap.state().offsetSec).toBeCloseTo(OFFSET, 1);
    h.cap.stop();
  });

  it('a user seek (not announced) is not taken for our own', async () => {
    const h = harness();
    await h.cap.start(0);
    await vi.waitFor(() => expect(h.cap.state().historySec).toBeGreaterThan(30));
    h.feedVideo(8, 30);
    await h.cap.pollOnce();
    expect(h.cap.state().aligned).toBe(true);
    diag.clear();
    h.feedVideo(15, 22);
    expect(diag.entries().some((e) => e.ev === 'hls-own-seek')).toBe(false);
    h.cap.stop();
  });
});
