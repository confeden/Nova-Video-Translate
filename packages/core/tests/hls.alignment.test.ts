import { describe, expect, it, vi } from 'vitest';
import { HlsCapture, type PcmMonitor } from '../src/capture/hls/hlsCapture';
import type { AacDecoder } from '../src/capture/hls/aac';
import { ALIGN_MIN_CLEAN_SEC, Envelope, alignAcceptance, correlateEnvelopes } from '../src/capture/hls/align';
import { diag } from '../src/diag';
import { AD_FLOOR_MARGIN_SEC, LiveDelayController, availableBackSec, backBufferSec } from '../src/live/liveDelay';
import type { AudioChunk } from '../src/providers/types';
import { audioSegment } from './hlsFixtures';
import { TranslationEngine } from '../src/pipeline';
import type { CaptureOptions } from '../src/capture';
import type { DubSegment } from '../src/providers/types';
import { FakeCapture, FakeProvider, FakeScheduler, flush, instantSleep, seg, settings } from './helpers/pipelineFakes';

// ---- synthetic stream: a speech-like envelope as a function of absolute time ----
function amp(t: number): number {
  const k = Math.floor(t * 9);
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
function harness() {
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
  const monitor: PcmMonitor = { start: async () => {}, stop() {}, onStatus: () => () => {} };
  let clock = 1_000_000;
  const statuses: Array<{ type: string; active?: boolean; reason?: string }> = [];
  const cap = new HlsCapture({
    video: { addEventListener() {}, removeEventListener() {} } as unknown as HTMLMediaElement,
    channel: 'chan',
    fetchFn,
    mediaUrl: 'https://v.example/audio_only/index.m3u8',
    monitorFactory: (cb) => {
      onPcm = cb;
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
  return { cap, chunks, feedVideo, statuses, advance, tick: (ms: number) => (clock += ms), clock: () => clock, setDaterange: (v: boolean) => (daterange = v), fetched, ads, setDom: (v: boolean) => (dom = v), tickAd: () => cap.tickAdProbe() };
}


// ---- pure envelopes ----
const R = 20;
function fillEnv(env: Envelope, from: number, to: number, shift: number): void {
  for (let t = from; t < to; t += 1 / R) env.add(new Float32Array(800).fill(amp(t + shift)), 16000, t);
}

describe('alignment acceptance by window length', () => {
  it('5-12 s need peak >= 0.6 and ratio >= 2; longer windows keep the 0.4 / 1.4 rules', () => {
    const short = alignAcceptance(8);
    expect(short.relaxedPeak).toBe(0.6);
    expect(short.minRatio).toBe(2);
    expect(short.minPeak).toBeGreaterThan(1); // the absolute path is off
    const long = alignAcceptance(12);
    expect(long.relaxedPeak).toBe(0.4);
    expect(long.minRatio).toBe(1.4);
  });

  const hls = new Envelope(R * 240);
  fillEnv(hls, 1000, 1090, 0);
  it('a clean 5.5 s window from t0 aligns', () => {
    const video = new Envelope();
    fillEnv(video, 0, 5.5, 1012.5);
    const r = correlateEnvelopes(video, hls, { fromSec: 0, toSec: 6, centerSec: 1010, rangeSec: 40, minOverlapSec: ALIGN_MIN_CLEAN_SEC * 0.9, ...alignAcceptance(5.5) });
    expect(r.ok).toBe(true);
    expect(r.offsetSec).toBeCloseTo(1012.5, 1);
  });

  it('a polluted prefix (foreign audio) breaks the window; the clean tail alone aligns', () => {
    const video = new Envelope();
    fillEnv(video, 0, 20, 7000); // ad / pre-seek audio that is not in the stream
    fillEnv(video, 20, 27, 1012.5); // 7 s clean
    const opts = { centerSec: 1010, rangeSec: 40, minOverlapSec: 4.5 };
    const polluted = correlateEnvelopes(video, hls, { fromSec: 0, toSec: 27, ...opts, ...alignAcceptance(27) });
    expect(polluted.ok).toBe(false);
    const clean = correlateEnvelopes(video, hls, { fromSec: 20, toSec: 27, ...opts, ...alignAcceptance(7) });
    expect(clean.ok).toBe(true);
    expect(clean.offsetSec).toBeCloseTo(1012.5, 1);
  });

  it('after an own seek the replayed range is dropped and re-recorded, the earlier clean part stays', () => {
    const video = new Envelope();
    fillEnv(video, 0, 30, 1012.5);
    video.clearFrom(19);
    expect(video.span()![1] / R).toBeLessThan(19.01);
    fillEnv(video, 19, 30, 1012.5);
    expect(video.count(0, 30)).toBeGreaterThan(R * 29);
  });
});

// ---- capture ----
describe('HlsCapture: clean-window alignment, ad regions, provisional offset', () => {
  it('ad audio is never recorded; after the break 6 s of clean audio are enough (no 30 s wait)', async () => {
    const h = harness();
    await h.cap.start(0);
    await vi.waitFor(() => expect(h.cap.state().historySec).toBeGreaterThan(30));
    h.feedVideo(8, 30);
    await h.cap.pollOnce();
    expect(h.cap.state().aligned).toBe(true);
    expect(h.cap.adEndSec()).toBeUndefined();
    h.setDom(true); // the player's ad UI appears: the ad starts at video time 30
    h.tickAd();
    h.feedVideo(30, 40, 9000); // the player plays the ad (foreign audio)
    for (let i = 0; i < 6; i++) await h.advance(true);
    expect(h.cap.state().inAds).toBe(true);
    expect(h.cap.adEndSec()).toBe(Infinity);
    await h.advance(false);
    h.setDom(false);
    h.tickAd();
    h.tick(1100);
    h.tickAd();
    expect(h.cap.state().inAds).toBe(false);
    const end = h.cap.adEndSec()!;
    expect(end).toBeGreaterThan(39.9);
    expect(end).toBeLessThan(41);
    // 6.5 s of clean post-break audio: pts 1010.. of the stream played at video time 41..
    const NEW = 969;
    h.tick(2000);
    h.feedVideo(41, 47.5, NEW);
    h.tick(2000);
    await h.cap.pollOnce();
    expect(h.cap.state().aligned).toBe(true);
    expect(h.cap.state().offsetSec).toBeCloseTo(NEW, 1);
    const al = diag.entries().filter((e) => e.ev === 'hls-align').pop()!;
    expect((al.data as { cleanSec: number }).cleanSec).toBeLessThan(8);
    h.cap.stop();
  });

  it('own seek while unaligned: the pre-seek (foreign) audio of the replayed range is dropped, the clean replay aligns', async () => {
    const h = harness();
    await h.cap.start(0);
    await vi.waitFor(() => expect(h.cap.state().historySec).toBeGreaterThan(30));
    h.feedVideo(12, 18, 9000); // 6 s of audio that is not in the stream (no alignment possible)
    await h.cap.pollOnce();
    expect(h.cap.state().aligned).toBe(false);
    h.cap.noteOwnSeek();
    h.feedVideo(12, 19.6, OFFSET); // the playhead went back to 12 s: the replay is clean
    h.tick(2000);
    await h.cap.pollOnce();
    expect(h.cap.state().aligned).toBe(true);
    expect(h.cap.state().offsetSec).toBeCloseTo(OFFSET, 1);
    h.cap.stop();
  });

  it('provisional offset after 8 s of clean audio without a match: chunks flow flagged; the real alignment reports the shift', async () => {
    const h = harness();
    await h.cap.start(0);
    await vi.waitFor(() => expect(h.cap.state().historySec).toBeGreaterThan(30));
    h.feedVideo(8, 17.5, 9000); // 9.5 s the correlation cannot place
    h.tick(2000);
    await h.cap.pollOnce();
    const st = h.cap.state();
    expect(st.aligned).toBe(false);
    expect(st.provisional).toBe(true);
    expect(h.statuses.some((s) => s.type === 'provisional')).toBe(true);
    expect(h.chunks.length).toBeGreaterThan(5);
    expect(h.chunks.every((c: AudioChunk) => c.provisional === true)).toBe(true);
    // provisional = newest pts end - video max - one segment
    expect(st.offsetSec).toBeCloseTo(st.newestPtsEnd - 17.5 - 2, 0);
    const n = h.chunks.length;
    // the right audio plays on; once the window is dominated by it, the real offset arrives
    h.tick(2000);
    h.feedVideo(17.5, 42, OFFSET);
    h.tick(2000);
    await h.cap.pollOnce();
    expect(h.cap.state().aligned).toBe(true);
    expect(h.cap.state().provisional).toBe(false);
    const rt = h.statuses.find((s) => s.type === 'retime') as unknown as { shiftSec: number };
    expect(rt).toBeTruthy();
    expect(rt.shiftSec).toBeCloseTo(st.offsetSec! - h.cap.state().offsetSec!, 1);
    expect(h.chunks.length).toBe(n); // no replay of what already went out
    expect(diag.entries().some((e) => e.ev === 'hls-align-provisional')).toBe(true);
    h.cap.stop();
  });
});

// ---- ad-aware back-buffer and rewind-when-ready ----
const ranges = (...r: Array<[number, number]>) => ({ length: r.length, start: (i: number) => r[i]![0], end: (i: number) => r[i]![1] });

describe('ad-aware back-buffer', () => {
  it('report numbers: ad region 0-31 s, now 37 s => 5 s available (not 37 / 18)', () => {
    const buffered = ranges([0, 41]);
    expect(backBufferSec(buffered, 37)).toBe(37);
    expect(availableBackSec({ buffered, seekable: ranges([0, 1073741824]) }, 37, 31).sec).toBe(37 - (31 + AD_FLOOR_MARGIN_SEC));
    expect(availableBackSec({ buffered }, 37, 31).sec).toBe(5);
    expect(availableBackSec({ buffered }, 37, undefined).sec).toBe(37);
    expect(availableBackSec({ buffered }, 37, Infinity).sec).toBe(0);
    // an ad that ended before the buffer start does not matter
    expect(availableBackSec({ buffered: ranges([20, 41]) }, 37, 5).sec).toBe(17);
  });

  class V extends EventTarget {
    duration = NaN;
    paused = false;
    ended = false;
    seekable = ranges([0, 1073741824]);
    buffered = ranges([0, 41]);
    seeks: number[] = [];
    private _ct = 37;
    get currentTime() {
      return this._ct;
    }
    set currentTime(x: number) {
      this._ct = x;
      this.seeks.push(x);
    }
  }

  it('rewind-when-ready: nothing moves before a dub asks; then at most available - 1 = 4 s (never into the ad)', () => {
    vi.useFakeTimers();
    const v = new V();
    let slot: number | undefined;
    const c = new LiveDelayController({
      video: v as unknown as HTMLVideoElement,
      getDelaySec: () => (slot === undefined ? 0 : v.currentTime - slot + 1),
      adEnd: () => 31,
      gate: () => slot !== undefined,
      immediate: () => true,
    });
    c.start();
    vi.advanceTimersByTime(20_000);
    expect(v.seeks).toEqual([]); // no dub yet: no rewind, no waiting for a back-buffer either
    slot = 19; // the first dub's slot was 18 s ago
    c.requestRewind();
    expect(v.seeks).toEqual([33]); // 37 - 4, not 37 - 19
    expect(c.appliedSec()).toBe(4);
    c.stop();
    vi.useRealTimers();
  });

  it('the rewind is never below 3 s: 3 s of back-buffer after the ad => nothing happens', () => {
    vi.useFakeTimers();
    const v = new V();
    const c = new LiveDelayController({ video: v as unknown as HTMLVideoElement, getDelaySec: () => 15, adEnd: () => 33, immediate: () => true });
    c.start();
    vi.advanceTimersByTime(10_000);
    expect(v.seeks).toEqual([]);
    c.stop();
    vi.useRealTimers();
  });
});

// ---- engine: rewind-when-ready, retime, ttfd ----
describe('engine: rewind-when-ready on the hls capture', () => {
  class LiveVideo extends EventTarget {
    volume = 1;
    paused = false;
    ended = false;
    duration = Infinity;
    seekable = ranges([0, 1073741824]);
    buffered = ranges([0, 41]);
    seeks: number[] = [];
    private _ct = 37;
    get currentTime(): number {
      return this._ct;
    }
    set currentTime(x: number) {
      this._ct = x;
      this.seeks.push(x);
    }
  }

  async function setup(over: Partial<ReturnType<typeof settings>> = {}) {
    const video = new LiveVideo();
    const provider = new FakeProvider('local');
    provider.fallback = { segments: [seg(24.14, 29.6)], sourceLang: 'en' };
    const sched: FakeScheduler[] = [];
    const caps: Array<FakeCapture & { adEnd?: number; opts: CaptureOptions }> = [];
    const engine = new TranslationEngine({
      video: video as unknown as HTMLVideoElement,
      audioCtx: {} as AudioContext,
      providers: [provider],
      settings: settings({ voiceOrder: ['local'], voiceEnabled: { local: true }, liveDelaySec: -1, dubLagSec: 1, ...over }),
      host: 'www.twitch.tv',
      createCapture: (async (_v: unknown, o: CaptureOptions = {}) => {
        const c = Object.assign(new FakeCapture(), { opts: o, adEnd: 28 as number | undefined });
        c.kind = 'hls';
        (c as unknown as { adEndSec: () => number | undefined }).adEndSec = () => c.adEnd;
        caps.push(c);
        return c;
      }) as never,
      createScheduler: ((_v: unknown, _c: unknown, o: any) => {
        const s = new FakeScheduler(o);
        sched.push(s);
        return s;
      }) as never,
      now: () => Date.now(),
      sleep: instantSleep(),
      retryDelayMs: 10,
    });
    await engine.start();
    return { engine, video, caps, provider, sched };
  }

  it('does not rewind before a dub exists; the first late dub rewinds by min(needed, available - 1) = 7 s (ad until 28 s, now 37 s)', async () => {
    const { engine, video, caps } = await setup();
    await flush();
    expect(video.seeks).toEqual([]); // translating starts at once, nothing waits for a back-buffer
    caps[0]!.emit({ startSec: 24, durationSec: 8, sampleRate: 16000, pcm: new Int16Array(8) });
    await flush(30);
    expect(video.seeks).toEqual([30]);
    expect(diag.entries().some((e) => e.ev === 'rewind-ready')).toBe(true);
    engine.stop();
  });

  it('a dub whose slot is still ahead causes no rewind', async () => {
    const { engine, video, caps, provider } = await setup();
    provider.fallback = { segments: [seg(40, 44)], sourceLang: 'en' };
    caps[0]!.emit({ startSec: 40, durationSec: 8, sampleRate: 16000, pcm: new Int16Array(8) });
    await flush(30);
    expect(video.seeks).toEqual([]);
    engine.stop();
  });

  it('never rewinds into the ad: with the break ending at 35.5 s nothing usable is left => no seek', async () => {
    const { engine, video, caps } = await setup();
    caps[0]!.adEnd = 35.5;
    caps[0]!.emit({ startSec: 24, durationSec: 8, sampleRate: 16000, pcm: new Int16Array(8) });
    await flush(30);
    expect(video.seeks).toEqual([]);
    engine.stop();
  });

  for (const [shift, expected] of [[-3, [-3]], [0.8, []]] as Array<[number, number[]]>) {
    it(`a retime status of ${shift} s ${expected.length ? 're-times the provisional dubs in the scheduler' : 'leaves scheduled dubs alone (<= 1.5 s)'}`, async () => {
      const { engine, caps, sched, provider } = await setup();
      provider.fallback = { segments: [seg(30, 34)], sourceLang: 'en' };
      const s = sched[0]!;
      const shifted: number[] = [];
      (s as unknown as { shiftSegmentsWhere: (p: (x: DubSegment) => boolean, d: number) => number }).shiftSegmentsWhere = (p, d) => {
        shifted.push(d);
        return s.added.filter(p).length;
      };
      caps[0]!.emit({ startSec: 24, durationSec: 8, sampleRate: 16000, pcm: new Int16Array(8), provisional: true });
      await flush(30);
      expect(s.added.length).toBe(1);
      caps[0]!.opts.onStatus!({ type: 'retime', shiftSec: shift });
      expect(shifted).toEqual(expected);
      engine.stop();
    });
  }

  it('diag ttfd once, at the first audible dub, with ad / align / asr parts', async () => {
    const { engine, caps, sched } = await setup({ liveDelaySec: 0 });
    caps[0]!.opts.onStatus!({ type: 'ads', active: true });
    caps[0]!.opts.onStatus!({ type: 'ads', active: false });
    caps[0]!.opts.onStatus!({ type: 'aligned' });
    caps[0]!.emit({ startSec: 24, durationSec: 8, sampleRate: 16000, pcm: new Int16Array(8) });
    await flush(30);
    const first = (sched[0] as unknown as { opts: { onFirstPlay?: () => void } }).opts.onFirstPlay;
    expect(first).toBeTypeOf('function');
    first!();
    first!();
    const t = diag.entries().filter((e) => e.ev === 'ttfd');
    expect(t.length).toBe(1);
    expect(Object.keys(t[0]!.data as object).sort()).toEqual(expect.arrayContaining(['sinceStartSec', 'adSec', 'alignSec', 'asrSec']));
    engine.stop();
  });
});
