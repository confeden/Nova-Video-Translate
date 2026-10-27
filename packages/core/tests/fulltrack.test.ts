import { beforeEach, describe, expect, it } from 'vitest';
import { diag } from '../src/diag';
import { TranslationEngine } from '../src/pipeline';
import { LatencyModel, TIER_PRIOR_SEC } from '../src/pipeline/planner';
import type { Transport } from '../src/providers/types';
import {
  MP3_LEAD_FRAMES,
  POLL_FIRST_MS,
  POLL_MAX_MS,
  YandexClient,
  concat,
  createFullTrackProber,
  fStr,
  fVar,
  indexMp3,
  nextWatchDelayMs,
  serveFromTrack,
  sliceMp3,
  trackCovers,
  type FullTrack,
  type FullTrackClientApi,
  type FullTrackProber,
  type ProbeOptions,
  type ProbeReplyInfo,
  type TranslateReply,
} from '../src/providers/yandex';
import { FakeCapture, FakeProvider, FakeScheduler, FakeVideo, chunk, flush, instantSleep, settings } from './helpers/pipelineFakes';

// ---------- synthetic CBR mp3: MPEG1 Layer III, 128 kbps, 44.1 kHz, stereo, alternating padding ----------
const FRAME_SEC = 1152 / 44100;
function synthMp3(frames: number, opts: { id3?: boolean; info?: boolean } = {}): Uint8Array {
  const parts: number[][] = [];
  if (opts.id3) parts.push([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 20, ...new Array(20).fill(0)]);
  const total = frames + (opts.info ? 1 : 0);
  for (let i = 0; i < total; i++) {
    const len = Math.floor(((i + 1) * 144 * 128000) / 44100) - Math.floor((i * 144 * 128000) / 44100);
    const pad = len - 417;
    const f = new Array<number>(len).fill((i % 200) + 1);
    f[0] = 0xff;
    f[1] = 0xfb;
    f[2] = (9 << 4) | (0 << 2) | (pad << 1);
    f[3] = 0x00;
    if (opts.info && i === 0) {
      f.fill(0, 4);
      [0x49, 0x6e, 0x66, 0x6f].forEach((c, k) => (f[36 + k] = c)); // "Info"
    }
    parts.push(f);
  }
  return Uint8Array.from(parts.flat());
}
/** payload byte of audio frame `i` (the Info frame is not an audio frame) */
const frameMark = (i: number): number => (i % 200) + 1;

function track(tier: 'yandex' | 'yandex-live', sec: number, complete = true): FullTrack {
  const bytes = synthMp3(Math.ceil(sec / FRAME_SEC));
  const index = indexMp3(bytes)!;
  return { tier, bytes, index, durationSec: index.durationSec, bitrate: index.bitrateKbps, complete };
}

describe('mp3 frame index / slicing', () => {
  it('indexes CBR frames, skipping ID3v2 and the Info tag frame', () => {
    const bytes = synthMp3(400, { id3: true, info: true });
    const idx = indexMp3(bytes)!;
    expect(idx.frames).toBe(400);
    expect(idx.bitrateKbps).toBe(128);
    expect(idx.sampleRate).toBe(44100);
    expect(idx.durationSec).toBeCloseTo(400 * FRAME_SEC, 6);
    expect(indexMp3(new Uint8Array([1, 2, 3, 4, 5]))).toBeUndefined();
  });

  it('slices on frame boundaries with lead-in frames and reports the skip', () => {
    const bytes = synthMp3(1500);
    const idx = indexMp3(bytes)!;
    const s = sliceMp3(bytes, idx, 15, 30)!;
    const a = Math.floor(15 / FRAME_SEC);
    const b = Math.ceil(30 / FRAME_SEC);
    expect(s.skipSec).toBeCloseTo(MP3_LEAD_FRAMES * FRAME_SEC, 9);
    // starts at a frame header of frame a - 2, ends exactly at the end of frame b - 1
    expect(s.data[0]).toBe(0xff);
    expect(s.data[1]).toBe(0xfb);
    expect(s.data[8]).toBe(frameMark(a - MP3_LEAD_FRAMES));
    expect(s.data.length).toBe(idx.offsets[b]! - idx.offsets[a - MP3_LEAD_FRAMES]!);
    expect(s.data[s.data.length - 1]).toBe(frameMark(b - 1));
    // decodable length: lead-in + 15 s (within a frame)
    expect((s.data.length * 8) / 128000).toBeGreaterThan(15);
    expect((s.data.length * 8) / 128000).toBeLessThan(15 + (MP3_LEAD_FRAMES + 2) * FRAME_SEC);
  });

  it('first cell has no lead-in; the partial last cell is cut at the track end; beyond the end is nothing', () => {
    const bytes = synthMp3(1000); // ~26.1 s
    const idx = indexMp3(bytes)!;
    expect(sliceMp3(bytes, idx, 0, 15)!.skipSec).toBe(0);
    const last = sliceMp3(bytes, idx, 15, 30)!;
    expect(last.data.length).toBe(idx.offsets[idx.frames]! - idx.offsets[Math.floor(15 / FRAME_SEC) - MP3_LEAD_FRAMES]!);
    expect(sliceMp3(bytes, idx, 40, 55)).toBeUndefined();
  });

  it('serveFromTrack returns a one-segment result like the chunk-mode Yandex tier', () => {
    const t = track('yandex-live', 60);
    const r = serveFromTrack(t, { startSec: 15, durationSec: 15 }, 'en')!;
    expect(r.voice).toBe('lively');
    expect(r.sourceLang).toBe('en');
    expect(r.segments).toHaveLength(1);
    const seg = r.segments[0]!;
    expect([seg.start, seg.end]).toEqual([15, 30]);
    expect(seg.audio).toMatchObject({ kind: 'encoded', mime: 'audio/mpeg' });
    expect(serveFromTrack(track('yandex', 60), { startSec: 0, durationSec: 15 })!.voice).toBe('standard');
  });

  it('trackCovers: inside the track, tolerance for the partial last cell', () => {
    const t = track('yandex', 100);
    expect(trackCovers(t, 0, 15)).toBe(true);
    expect(trackCovers(t, 90, 11)).toBe(true);
    expect(trackCovers(t, 100, 15)).toBe(false);
    expect(trackCovers(t, 60, 60)).toBe(false);
  });
});

// ---------- probe ----------

const R = (status: number, extra: Partial<TranslateReply> = {}): TranslateReply => ({ status, ...extra });

function fakeClient(replies: Array<TranslateReply | Error>, mp3 = synthMp3(2000)) {
  const reqs: Array<{ url: string; firstRequest: boolean; lively: boolean; sourceLang: string; durationSec: number }> = [];
  const fetched: string[] = [];
  let i = 0;
  const client: FullTrackClientApi = {
    async requestTranslation(req) {
      reqs.push({ url: req.url, firstRequest: req.firstRequest, lively: req.lively, sourceLang: req.sourceLang, durationSec: req.durationSec });
      const r = replies[Math.min(i++, replies.length - 1)]!;
      if (r instanceof Error) throw r;
      return r;
    },
    async fetchAudio(url) {
      fetched.push(url);
      return mp3;
    },
  };
  return { client, reqs, fetched };
}

describe('full-track probe: status handling', () => {
  beforeEach(() => diag.clear());
  const opts = (tier: 'yandex' | 'yandex-live' = 'yandex', extra: Partial<ProbeOptions> = {}): ProbeOptions => ({ tier, url: 'https://youtu.be/dQw4w9WgXcQ', durationSec: 213, ...extra });
  const evs = (name: string) => diag.entries().filter((e) => e.ev === name);

  it('status 1 + url: downloads the full mp3 and builds the track', async () => {
    const f = fakeClient([R(1, { url: 'https://cdn/x.mp3' })]);
    const firsts: Array<number | undefined> = [];
    let downloads = 0;
    const t = await createFullTrackProber(f.client).probe(opts('yandex', { onFirst: (s) => firsts.push(s), onDownload: () => downloads++ }));
    expect(t?.tier).toBe('yandex');
    expect(t?.bitrate).toBe(128);
    expect(t?.durationSec).toBeCloseTo(2000 * FRAME_SEC, 3);
    expect(f.fetched).toEqual(['https://cdn/x.mp3']);
    expect(f.reqs[0]).toMatchObject({ url: 'https://youtu.be/dQw4w9WgXcQ', firstRequest: true, lively: false, sourceLang: 'auto', durationSec: 213 });
    // the release happens only after the mp3 is fetched and indexed: not by the prober, by the caller on resolution
    expect(downloads).toBe(1);
    expect(firsts).toEqual([]);
    expect(evs('fulltrack-probe')[0]!.data).toMatchObject({ tier: 'yandex', status: 1 });
    expect(evs('fulltrack-ok')[0]!.data).toMatchObject({ tier: 'yandex' });
  });

  it('status 5 (part content) with url is a track too; without url it is a miss', async () => {
    expect(await createFullTrackProber(fakeClient([R(5, { url: 'u' })]).client).probe(opts())).toBeDefined();
    expect(await createFullTrackProber(fakeClient([R(1)]).client).probe(opts())).toBeUndefined();
    expect(evs('fulltrack-miss').at(-1)!.data).toMatchObject({ reason: 'no-url' });
  });

  it('status 6 (audio requested): no track, a single request, no download, onFirst(6)', async () => {
    const f = fakeClient([R(6, { remainingTime: 80 })]);
    const firsts: Array<number | undefined> = [];
    expect(await createFullTrackProber(f.client).probe(opts('yandex', { onFirst: (s) => firsts.push(s) }))).toBeUndefined();
    expect(f.reqs).toHaveLength(1);
    expect(f.fetched).toHaveLength(0);
    expect(firsts).toEqual([6]);
    expect(evs('fulltrack-miss')[0]!.data).toMatchObject({ reason: 'audio-requested' });
  });

  it('failure statuses and errors are misses, never throws', async () => {
    expect(await createFullTrackProber(fakeClient([R(0)]).client).probe(opts())).toBeUndefined();
    expect(await createFullTrackProber(fakeClient([new Error('boom')]).client).probe(opts())).toBeUndefined();
    expect(evs('fulltrack-miss').map((e) => e.data?.reason)).toEqual(['status-0', 'error: boom']);
  });

  it('WAITING keeps polling the real url in the background and the track arrives later (waiting -> ready)', async () => {
    const f = fakeClient([R(2, { remainingTime: 30 }), R(3), R(2), R(1, { url: 'u' })]);
    const sleeps: number[] = [];
    const firsts: Array<number | undefined> = [];
    const prober = createFullTrackProber(f.client, { sleep: async (ms) => void sleeps.push(ms) });
    const t = await prober.probe(opts('yandex', { onFirst: (s) => firsts.push(s) }));
    expect(t).toBeDefined();
    expect(sleeps).toEqual([2500, 2500, 2500]);
    expect(f.reqs.map((r) => r.firstRequest)).toEqual([true, false, false, false]);
    expect(firsts).toEqual([2]); // the pipeline was released at the FIRST reply, not at the track
  });

  it('WAITING gives up after ~3 minutes, and stops at status 6 meanwhile', async () => {
    let now = 0;
    const waiting = fakeClient([R(2)]);
    const p1 = createFullTrackProber(waiting.client, { now: () => now, sleep: async (ms) => void (now += ms) });
    expect(await p1.probe(opts())).toBeUndefined();
    expect(evs('fulltrack-miss').at(-1)!.data).toMatchObject({ reason: 'wait-timeout' });
    expect(now).toBeGreaterThan(170_000);
    expect(now).toBeLessThan(190_000);
    const to6 = fakeClient([R(2), R(2), R(6)]);
    expect(await createFullTrackProber(to6.client, { sleep: async () => {} }).probe(opts())).toBeUndefined();
    expect(to6.reqs).toHaveLength(3);
  });

  it('lively probe: unknown language maps to en, a standard voice answer is not a lively track', async () => {
    const f = fakeClient([R(1, { url: 'u', isLivelyVoice: false })]);
    expect(await createFullTrackProber(f.client).probe(opts('yandex-live'))).toBeUndefined();
    expect(f.reqs[0]).toMatchObject({ lively: true, sourceLang: 'en' });
    expect(evs('fulltrack-miss').at(-1)!.data).toMatchObject({ reason: 'not-lively' });
    const ok = await createFullTrackProber(fakeClient([R(1, { url: 'u', isLivelyVoice: true })]).client).probe(opts('yandex-live'));
    expect(ok?.tier).toBe('yandex-live');
  });

  it('video duration falls back to 310 s', async () => {
    const f = fakeClient([R(6)]);
    await createFullTrackProber(f.client).probe(opts('yandex', { durationSec: NaN }));
    expect(f.reqs[0]!.durationSec).toBe(310);
  });
});

// ---------- chunk-mode poll interval ----------

describe('chunk-mode polling interval', () => {
  it('first poll 2 s after the upload, then 1.5x steps capped at 4 s; the remainingTime hint is ignored', async () => {
    const replies = [
      concat(fVar(4, 6), fStr(7, 'tid'), fVar(5, 80)),
      concat(fVar(4, 2), fVar(5, 80)),
      concat(fVar(4, 2), fVar(5, 80)),
      concat(fVar(4, 3), fVar(5, 80)),
      concat(fVar(4, 2), fVar(5, 80)),
      concat(fVar(4, 1), fStr(1, 'https://cdn.example/a.mp3')),
    ];
    let i = 0;
    const transport: Transport = async (req) => {
      const u = new URL(req.url);
      const ok = (body: Uint8Array) => ({ status: 200, headers: {}, body });
      if (u.pathname === '/session/create') return ok(concat(fStr(1, 'SECRET'), fVar(2, 3600)));
      if (u.pathname === '/video-translation/translate') return ok(replies[Math.min(i++, replies.length - 1)]!);
      if (u.pathname === '/video-translation/audio') return ok(fVar(1, 2));
      return ok(new Uint8Array([1]));
    };
    const sleeps: number[] = [];
    const c = new YandexClient(transport, { random: () => 0.5, sleep: async (ms) => void sleeps.push(ms) });
    await c.translatePcm(new Int16Array(2400), 24000);
    expect(POLL_FIRST_MS).toBe(2000);
    expect(POLL_MAX_MS).toBe(4000);
    expect(sleeps).toEqual([2000, 3000, 4000, 4000, 4000]);
  });
});

// ---------- planner ----------

describe('latency model: pinned full-track tier', () => {
  it('a pinned tier is ~1 s regardless of priors / hints / samples, unpin restores them', () => {
    const m = new LatencyModel(() => 0);
    m.hint('yandex', 80);
    expect(m.expectedSec('yandex')).toBeGreaterThan(TIER_PRIOR_SEC.yandex * 0.9);
    m.pin('yandex', 1);
    m.observe('yandex', 60_000);
    expect(m.expectedSec('yandex')).toBe(1);
    m.unpin('yandex');
    expect(m.expectedSec('yandex')).toBeGreaterThan(10);
  });
});

// ---------- engine ----------

class FakeProber implements FullTrackProber {
  calls: ProbeOptions[] = [];
  private resolvers = new Map<string, (t: FullTrack | undefined) => void>();
  /** auto: answer at once with this */
  auto = new Map<string, FullTrack | undefined>();
  probe(o: ProbeOptions): Promise<FullTrack | undefined> {
    this.calls.push(o);
    if (this.auto.has(o.tier)) {
      o.onFirst?.(this.auto.get(o.tier) ? 1 : 6);
      return Promise.resolve(this.auto.get(o.tier));
    }
    return new Promise((res) => this.resolvers.set(o.tier, res));
  }
  first(tier: string, status: number): void {
    this.calls.findLast((c) => c.tier === tier)!.onFirst?.(status);
  }
  download(tier: string): void {
    this.calls.findLast((c) => c.tier === tier)!.onDownload?.();
  }
  finish(tier: string, t: FullTrack | undefined): void {
    this.resolvers.get(tier)!(t);
  }
  /** the latest probe of the tier ends without a track, reporting `info` (what the real prober's onReply carries) */
  miss(tier: string, info: ProbeReplyInfo): void {
    this.calls.findLast((c) => c.tier === tier)!.onReply?.(info);
    this.finish(tier, undefined);
  }
  /** probe calls made by the background watcher (once: true) */
  watched(tier: string): ProbeOptions[] {
    return this.calls.filter((c) => c.tier === tier && c.once);
  }
}

/** manual timers of the background watcher */
class WatchTimers {
  list: Array<{ ms: number; fire: () => void; signal: AbortSignal; done: boolean }> = [];
  sleep = (ms: number, signal: AbortSignal): Promise<void> =>
    new Promise((res, rej) => {
      const t = { ms, signal, done: false, fire: () => ((t.done = true), res()) };
      this.list.push(t);
      signal.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')), { once: true });
    });
  pending(): number[] {
    return this.list.filter((t) => !t.done && !t.signal.aborted).map((t) => t.ms);
  }
  /** fires the oldest pending timer and returns its delay */
  next(): number {
    const t = this.list.find((x) => !x.done && !x.signal.aborted)!;
    t.fire();
    return t.ms;
  }
}

function setup(over: { order?: Array<'yandex-live' | 'yandex' | 'gemini'>; key?: string; duration?: number; hint?: (ms: number, signal: AbortSignal) => Promise<void>; off?: Array<'yandex-live' | 'yandex' | 'gemini'> } = {}) {
  const video = new FakeVideo() as FakeVideo & { duration?: number };
  video.duration = over.duration ?? 600;
  const providers = [new FakeProvider('yandex-live'), new FakeProvider('yandex'), new FakeProvider('gemini')];
  const caps: FakeCapture[] = [];
  const scheds: FakeScheduler[] = [];
  const voices: Array<[string, string | undefined]> = [];
  const prober = new FakeProber();
  const watch = new WatchTimers();
  const base = settings({ voiceOrder: over.order ?? ['yandex-live', 'yandex', 'gemini'] });
  for (const id of over.off ?? []) base.voiceEnabled[id] = false;
  const engine = new TranslationEngine({
    video: video as unknown as HTMLVideoElement,
    audioCtx: {} as AudioContext,
    providers,
    settings: base,
    events: { onVoice: (v) => voices.push([v.providerId, v.voice]) },
    createCapture: (async () => {
      const c = new FakeCapture();
      caps.push(c);
      return c;
    }) as never,
    createScheduler: ((_v: unknown, _c: unknown, o: any) => {
      const s = new FakeScheduler(o);
      scheds.push(s);
      return s;
    }) as never,
    now: () => 0,
    sleep: instantSleep(),
    hintSleep: over.hint ?? (() => new Promise(() => {})),
    retryDelayMs: 10,
    fullTrack: prober,
    videoKey: () => over.key ?? 'yt:dQw4w9WgXcQ',
    probeRaceMs: 1500,
    probeWatchSleep: watch.sleep,
  });
  const by = (id: string) => providers.find((p) => p.id === id)!;
  return { video, engine, providers, by, caps, scheds, voices, prober, watch };
}

const providerIds = (s: FakeScheduler): string[] => s.added.map((x) => `${x.providerId}@${x.start}`);

describe('engine: Yandex full track', () => {
  it('probes the real youtu.be url for every usable Yandex tier, YouTube only', async () => {
    const e = setup();
    await e.engine.start();
    expect(e.prober.calls.map((c) => [c.tier, c.url, c.durationSec])).toEqual([
      ['yandex-live', 'https://youtu.be/dQw4w9WgXcQ', 600],
      ['yandex', 'https://youtu.be/dQw4w9WgXcQ', 600],
    ]);
    e.engine.stop();
    const other = setup({ key: 'u:https://vimeo.com/1' });
    await other.engine.start();
    expect(other.prober.calls).toHaveLength(0);
    other.engine.stop();
  });

  it('a found track voices cells instantly, Gemini is never started, when the track tier is first in voiceOrder', async () => {
    const e = setup({ order: ['yandex', 'yandex-live', 'gemini'] });
    e.prober.auto.set('yandex', track('yandex', 120));
    e.prober.auto.set('yandex-live', undefined);
    await e.engine.start();
    await flush();
    e.caps[0]!.emit(chunk(0));
    e.caps[0]!.emit(chunk(15));
    await flush();
    expect(e.by('gemini').calls).toHaveLength(0);
    expect(e.by('yandex').calls).toHaveLength(0);
    expect(providerIds(e.scheds[0]!)).toEqual(expect.arrayContaining(['yandex@0', 'yandex@15']));
    const seg = e.scheds[0]!.added.find((x) => x.start === 15)!;
    expect(seg.audio).toMatchObject({ kind: 'encoded', mime: 'audio/mpeg' });
    expect(e.voices.at(-1)).toEqual(['yandex', 'standard']);
    // seek / rewind: any cell is served by time
    e.video.currentTime = 100;
    e.caps[0]!.emit(chunk(105));
    await flush();
    expect(providerIds(e.scheds[0]!).at(-1)).toBe('yandex@105');
    e.engine.stop();
  });

  it('prefers the higher-priority track when both exist', async () => {
    const e = setup();
    e.prober.auto.set('yandex', track('yandex', 120));
    e.prober.auto.set('yandex-live', track('yandex-live', 120));
    await e.engine.start();
    await flush();
    e.caps[0]!.emit(chunk(15));
    await flush();
    expect(providerIds(e.scheds[0]!)).toContain('yandex-live@15');
    expect(providerIds(e.scheds[0]!).every((x) => x.startsWith('yandex-live@'))).toBe(true);
    expect(e.voices.at(-1)).toEqual(['yandex-live', 'lively']);
    e.engine.stop();
  });

  it('holds the first cells for the first probe reply only, then starts Gemini at once when Yandex is not ready (status 2/3/6)', async () => {
    const e = setup();
    await e.engine.start();
    e.caps[0]!.emit(chunk(0));
    await flush();
    expect(e.by('gemini').calls).toHaveLength(0); // race window: waiting for the first reply
    e.prober.first('yandex', 2);
    await flush();
    expect(e.by('gemini').calls).toHaveLength(0); // the live probe has not answered yet
    e.prober.first('yandex-live', 6);
    await flush();
    expect(e.by('gemini').calls).toHaveLength(1); // both answered: Gemini bridges
    e.engine.stop();
  });

  it('a probe that never answers delays the first cells by the race window only', async () => {
    const e = setup();
    const timers: Array<() => void> = [];
    (e.engine as unknown as { deps: { hintSleep: unknown } }).deps.hintSleep = (_ms: number) => new Promise<void>((r) => timers.push(r));
    await e.engine.start();
    e.caps[0]!.emit(chunk(0));
    await flush();
    expect(e.by('gemini').calls).toHaveLength(0);
    timers.forEach((t) => t()); // the race timer (registered first) fires, and the slow-start one
    await flush();
    expect(e.by('gemini').calls).toHaveLength(1);
    e.engine.stop();
  });

  it('waiting -> ready mid-playback: Gemini bridges, then the track serves new cells and upgrades upcoming Gemini dubs', async () => {
    const e = setup();
    await e.engine.start();
    e.prober.first('yandex-live', 2);
    e.prober.first('yandex', 2);
    await flush();
    e.video.currentTime = 5;
    e.caps[0]!.emit(chunk(0));
    e.caps[0]!.emit(chunk(15));
    await flush();
    expect(e.by('gemini').calls.map((c) => c.chunk.startSec).sort((a, b) => a - b)).toEqual([0, 15]);
    expect(providerIds(e.scheds[0]!).sort()).toEqual(['gemini@0', 'gemini@15']);
    // the standard full track becomes ready while the video plays
    e.prober.finish('yandex', track('yandex', 200));
    await flush();
    // D29: everything is replaced NOW, the playing cell 0 included (no lead >= 3 s rule for full-track upgrades)
    expect(providerIds(e.scheds[0]!)).toContain('yandex@15');
    expect(providerIds(e.scheds[0]!)).not.toContain('gemini@15');
    expect(providerIds(e.scheds[0]!)).not.toContain('gemini@0');
    expect(e.scheds[0]!.added.some((x) => x.providerId === 'yandex' && x.start > 4.9 && x.start <= 5 && x.end === 15)).toBe(true); // from the playhead
    expect(e.scheds[0]!.removed.some((r) => r.opts?.reason === 'tier-upgrade' && r.n === 1)).toBe(true);
    // later cells never reach Gemini
    e.caps[0]!.emit(chunk(30));
    await flush();
    expect(e.by('gemini').calls).toHaveLength(2);
    expect(providerIds(e.scheds[0]!)).toContain('yandex@30');
    e.engine.stop();
  });

  it('live over standard: a lively track arriving after the standard one takes over', async () => {
    const e = setup();
    e.prober.auto.set('yandex', track('yandex', 200));
    await e.engine.start();
    e.prober.first('yandex-live', 2); // the live probe is WAITING: the gate opens
    await flush();
    e.caps[0]!.emit(chunk(0));
    e.caps[0]!.emit(chunk(15));
    await flush();
    expect(providerIds(e.scheds[0]!)).toEqual(expect.arrayContaining(['yandex@0', 'yandex@15']));
    e.prober.finish('yandex-live', track('yandex-live', 200));
    await flush();
    const ids = providerIds(e.scheds[0]!);
    expect(ids).toContain('yandex-live@15');
    expect(ids).not.toContain('yandex@15');
    expect(ids).not.toContain('yandex@0'); // the playing cell is switched now too
    expect(e.scheds[0]!.added.some((x) => x.providerId === 'yandex-live' && x.end === 15)).toBe(true);
    e.caps[0]!.emit(chunk(30));
    await flush();
    expect(providerIds(e.scheds[0]!)).toContain('yandex-live@30');
    expect(e.voices.at(-1)).toEqual(['yandex-live', 'lively']);
    e.engine.stop();
  });

  it('the track is dropped with the session: a restart has none until the probe finds it again', async () => {
    const e = setup();
    e.prober.auto.set('yandex', track('yandex', 120));
    await e.engine.start();
    await flush();
    e.engine.stop();
    e.prober.auto.clear();
    await e.engine.start();
    e.prober.first('yandex', 6);
    e.prober.first('yandex-live', 6);
    e.caps[1]!.emit(chunk(0));
    await flush();
    expect(e.by('gemini').calls.length + e.by('yandex').calls.length + e.by('yandex-live').calls.length).toBeGreaterThan(0);
    e.engine.stop();
  });
});


describe('engine: full track hold while the mp3 downloads, and track-fed cells', () => {
  /** manual hint timers: resolve by their delay */
  function timers() {
    const list: Array<{ ms: number; fire: () => void }> = [];
    const hint = (ms: number): Promise<void> => new Promise((res) => list.push({ ms, fire: () => res() }));
    return { hint, fire: (ms: number) => list.filter((t) => t.ms === ms).forEach((t) => t.fire()), list };
  }

  it('a FINISHED url keeps the hold open past the race window: the first audible cell comes from the track, not Gemini', async () => {
    const t = timers();
    const e = setup({ order: ['yandex-live', 'yandex', 'gemini'], hint: t.hint });
    await e.engine.start();
    e.prober.first('yandex-live', 6);
    e.prober.download('yandex'); // status FINISHED + url: the mp3 download starts, no onFirst yet
    t.fire(1500); // race window over
    await flush();
    e.caps[0]!.emit(chunk(0));
    e.caps[0]!.emit(chunk(15));
    await flush();
    expect(e.by('gemini').calls).toHaveLength(0); // still held
    expect(e.scheds[0]!.added).toHaveLength(0);
    e.prober.finish('yandex', track('yandex', 200)); // the download took "2 s"
    await flush();
    expect(e.by('gemini').calls).toHaveLength(0);
    expect(providerIds(e.scheds[0]!)).toEqual(expect.arrayContaining(['yandex@0', 'yandex@15']));
    expect(providerIds(e.scheds[0]!).some((x) => x.startsWith('gemini'))).toBe(false);
    e.engine.stop();
  });

  it('the download hold is bounded: after 6 s without a track the cells go to the normal tiers', async () => {
    const t = timers();
    const e = setup({ order: ['gemini', 'yandex', 'yandex-live'], hint: t.hint });
    await e.engine.start();
    e.prober.first('yandex-live', 6);
    e.prober.download('yandex');
    t.fire(1500);
    await flush();
    e.caps[0]!.emit(chunk(0));
    await flush();
    expect(e.by('gemini').calls).toHaveLength(0);
    t.fire(6000);
    await flush();
    expect(e.by('gemini').calls.length).toBeGreaterThan(0);
    e.engine.stop();
  });

  it('a download failure (prober resolves undefined) releases the hold', async () => {
    const t = timers();
    const e = setup({ order: ['gemini', 'yandex', 'yandex-live'], hint: t.hint });
    await e.engine.start();
    e.prober.first('yandex-live', 6);
    e.prober.download('yandex');
    t.fire(1500);
    e.caps[0]!.emit(chunk(0));
    await flush();
    expect(e.by('gemini').calls).toHaveLength(0);
    e.prober.finish('yandex', undefined);
    await flush();
    expect(e.by('gemini').calls.length).toBeGreaterThan(0);
    e.engine.stop();
  });

  it('status 2/3/6 keeps the immediate release (no hold)', async () => {
    const t = timers();
    const e = setup({ order: ['gemini', 'yandex', 'yandex-live'], hint: t.hint });
    await e.engine.start();
    e.prober.first('yandex-live', 2);
    e.prober.first('yandex', 6);
    e.caps[0]!.emit(chunk(0));
    await flush();
    expect(e.by('gemini').calls.length).toBeGreaterThan(0);
    e.engine.stop();
  });

  it('cells ahead of the playhead are created from the track with no captured audio, and roll forward / follow seeks', async () => {
    const e = setup();
    e.prober.auto.set('yandex', track('yandex', 400));
    e.prober.auto.set('yandex-live', undefined);
    await e.engine.start();
    await flush();
    // the capture never emitted anything
    const ids = providerIds(e.scheds[0]!);
    expect(ids).toEqual(expect.arrayContaining(['yandex@0', 'yandex@15', 'yandex@30', 'yandex@45', 'yandex@60', 'yandex@75']));
    expect(ids).not.toContain('yandex@90');
    expect(e.by('gemini').calls).toHaveLength(0);
    e.video.currentTime = 40;
    e.video.dispatchEvent(new Event('timeupdate'));
    await flush();
    expect(providerIds(e.scheds[0]!)).toContain('yandex@120');
    // seek far away
    e.video.currentTime = 300;
    e.video.dispatchEvent(new Event('seeked'));
    await flush();
    expect(providerIds(e.scheds[0]!)).toContain('yandex@300');
    expect(providerIds(e.scheds[0]!)).toContain('yandex@375');
    expect(e.by('gemini').calls).toHaveLength(0);
    e.engine.stop();
  });

  it('cells beyond a partial track are not fed (they stay with the capture / normal tiers)', async () => {
    const e = setup();
    e.prober.auto.set('yandex', track('yandex', 40, false));
    e.prober.auto.set('yandex-live', undefined);
    await e.engine.start();
    await flush();
    const ids = providerIds(e.scheds[0]!);
    expect(ids).toEqual(expect.arrayContaining(['yandex@0', 'yandex@15']));
    expect(ids).not.toContain('yandex@45');
    e.engine.stop();
  });
});

// ---------- D29: background re-probe + immediate switch ----------

describe('engine: Yandex tiers enabled MID-SESSION (D29 switch)', () => {
  it('a tier that was off at start is probed on the real url when enabled; the track replaces the lower dub at once; no chunk-mode Yandex job', async () => {
    const e = setup({ off: ['yandex-live', 'yandex'] });
    await e.engine.start();
    await flush();
    expect(e.prober.calls).toHaveLength(0);
    e.video.currentTime = 5;
    e.caps[0]!.emit(chunk(0));
    e.caps[0]!.emit(chunk(15));
    await flush();
    expect(providerIds(e.scheds[0]!).sort()).toEqual(['gemini@0', 'gemini@15']);
    // the owner switches the Yandex tiers on; the standard one has a cached full track
    diag.clear();
    const s = settings({ voiceOrder: ['yandex-live', 'yandex', 'gemini'] });
    e.engine.updateSettings({ ...s, voiceEnabled: { ...s.voiceEnabled, 'yandex-live': true, yandex: true } });
    await flush();
    expect(e.prober.calls.map((c) => [c.tier, c.url])).toEqual(expect.arrayContaining([['yandex', 'https://youtu.be/dQw4w9WgXcQ']]));
    // while the probes are unanswered no chunk-mode Yandex job may start (hold), then the track arrives
    expect(e.by('yandex').calls).toHaveLength(0);
    e.prober.miss('yandex-live', { status: 6 });
    e.prober.finish('yandex', track('yandex', 200));
    await flush();
    expect(providerIds(e.scheds[0]!)).toContain('yandex@15');
    expect(providerIds(e.scheds[0]!)).not.toContain('gemini@15');
    expect(diag.entries().some((x) => x.ev === 'tier-switch-now')).toBe(true);
    expect(diag.entries().some((x) => x.ev === 'settings-switch')).toBe(true);
    // new cells come from the track; nothing is started in Yandex chunk mode
    e.caps[0]!.emit(chunk(30));
    await flush();
    expect(providerIds(e.scheds[0]!)).toContain('yandex@30');
    expect(e.by('yandex').calls).toHaveLength(0);
    expect(e.by('yandex-live').calls).toHaveLength(0);
    e.engine.stop();
  });
});

describe('watch backoff (nextWatchDelayMs)', () => {
  it('WAITING: remainingTime when <= 180 s else 120 s, then every 30 s; status 6 slow; auth stops', () => {
    expect(nextWatchDelayMs({ status: 2, remainingSec: 100 }, 0)).toBe(100_000);
    expect(nextWatchDelayMs({ status: 3, remainingSec: 650 }, 0)).toBe(120_000);
    expect(nextWatchDelayMs({ status: 2 }, 0)).toBe(120_000);
    expect(nextWatchDelayMs({ status: 2, remainingSec: 100 }, 1)).toBe(30_000);
    expect(nextWatchDelayMs({ status: 2, reason: 'wait-timeout', remainingSec: 650 }, 0)).toBe(30_000);
    expect(nextWatchDelayMs({ status: 6 }, 0)).toBe(90_000);
    expect(nextWatchDelayMs({ errorKind: 'network' }, 0)).toBe(60_000);
    expect(nextWatchDelayMs({ errorKind: 'auth' }, 0)).toBeUndefined();
  });
});

describe('full-track probe: once (background re-probe)', () => {
  beforeEach(() => diag.clear());
  it('one request, no WAITING polling, firstRequest false, reports the reply', async () => {
    const f = fakeClient([R(2, { remainingTime: 650 })]);
    const infos: ProbeReplyInfo[] = [];
    const t = await createFullTrackProber(f.client, {
      sleep: async () => {
        throw new Error('must not poll');
      },
    }).probe({
      tier: 'yandex-live',
      url: 'https://youtu.be/x',
      durationSec: 100,
      sourceLang: 'en',
      once: true,
      firstRequest: false,
      onReply: (i) => infos.push(i),
    });
    expect(t).toBeUndefined();
    expect(f.reqs).toHaveLength(1);
    expect(f.reqs[0]!.firstRequest).toBe(false);
    expect(infos).toEqual([expect.objectContaining({ status: 2, remainingSec: 650, reason: 'waiting' })]);
  });

  it('an auth error is reported as errorKind', async () => {
    const err = Object.assign(new Error('401'), { kind: 'auth' });
    const infos: ProbeReplyInfo[] = [];
    await createFullTrackProber(fakeClient([err]).client).probe({ tier: 'yandex', url: 'u', durationSec: 10, once: true, onReply: (i) => infos.push(i) });
    expect(infos[0]).toMatchObject({ errorKind: 'auth' });
  });
});

describe('engine: background watcher and immediate full-track switch (D29)', () => {
  async function startWaiting(e: ReturnType<typeof setup>, live: ProbeReplyInfo, std: ProbeReplyInfo) {
    await e.engine.start();
    e.prober.first('yandex-live', 2);
    e.prober.first('yandex', 6);
    e.prober.miss('yandex-live', live);
    e.prober.miss('yandex', std);
    await flush();
  }

  it('late live track after the 3-minute WAITING window is noticed by the watcher and takes over at once, mid-cell', async () => {
    const e = setup();
    e.prober.auto.set('yandex', track('yandex', 200));
    await e.engine.start();
    e.prober.first('yandex-live', 2);
    await flush();
    e.video.currentTime = 7;
    e.caps[0]!.emit(chunk(0));
    e.caps[0]!.emit(chunk(15));
    await flush();
    expect(providerIds(e.scheds[0]!)).toEqual(expect.arrayContaining(['yandex@0', 'yandex@15']));
    // the initial probe polled 3 minutes and gave up
    e.prober.miss('yandex-live', { status: 2, remainingSec: 640, reason: 'wait-timeout' });
    await flush();
    expect(e.watch.pending()).toEqual([30_000]); // standard has its track: only live is watched
    expect(e.prober.watched('yandex-live')).toHaveLength(0);
    e.watch.next();
    await flush();
    expect(e.prober.watched('yandex-live')).toHaveLength(1);
    expect(e.prober.watched('yandex-live')[0]).toMatchObject({ once: true, firstRequest: false, url: 'https://youtu.be/dQw4w9WgXcQ' });
    const before = e.scheds[0]!.removed.length;
    e.prober.finish('yandex-live', track('yandex-live', 200));
    await flush();
    const added = e.scheds[0]!.added;
    // no standard dub is left anywhere
    expect(added.some((x) => x.providerId === 'yandex')).toBe(false);
    // the playing cell: the lively slice starts at the playhead (mp3 frame holding 7 s), ends with the cell: no overlap, no gap
    const mid = added.find((x) => x.providerId === 'yandex-live' && x.end === 15 && x.start > 1)!;
    expect(mid.start).toBeGreaterThan(7 - 0.03);
    expect(mid.start).toBeLessThanOrEqual(7);
    expect(added.some((x) => x.providerId === 'yandex-live' && x.start === 15)).toBe(true);
    // the old voice of the playing cell fades out over <= 0.3 s in the same tick the new one is added
    const rem = e.scheds[0]!.removed.slice(before);
    expect(rem.some((r) => r.n >= 1 && (r.opts?.fadeSec ?? 1) <= 0.3 && (r.opts?.fadeSec ?? 1) >= 0.1)).toBe(true);
    const sw = diag.entries().filter((x) => x.ev === 'tier-switch-now').at(-1)!;
    expect(sw.data).toMatchObject({ from: 'yandex', to: 'yandex-live', vt: 7 });
    expect(e.voices.at(-1)).toEqual(['yandex-live', 'lively']);
    // the watcher is done: no more timers
    expect(e.watch.pending()).toEqual([]);
    e.engine.stop();
  });

  it('re-probe backoff follows the replies: status 6 -> 90 s, WAITING 650 s -> 120 s, then 30 s; never two requests in flight', async () => {
    const e = setup();
    await startWaiting(e, { status: 6, reason: 'audio-requested' }, { status: 6, reason: 'audio-requested' });
    expect(e.watch.pending()).toEqual([90_000, 90_000]);
    e.watch.next(); // live
    await flush();
    expect(e.prober.watched('yandex-live')).toHaveLength(1);
    expect(e.prober.watched('yandex')).toHaveLength(0);
    // live probe still in flight: its next timer does not exist yet
    expect(e.watch.pending()).toEqual([90_000]);
    e.prober.miss('yandex-live', { status: 2, remainingSec: 650, reason: 'waiting' });
    await flush();
    expect(e.watch.pending().sort((a, b) => a - b)).toEqual([90_000, 120_000]);
    e.watch.list.find((t) => !t.done && t.ms === 120_000)!.fire();
    await flush();
    expect(e.prober.watched('yandex-live')).toHaveLength(2);
    e.prober.miss('yandex-live', { status: 2, remainingSec: 600, reason: 'waiting' });
    await flush();
    expect(e.watch.pending()).toContain(30_000);
    e.engine.stop();
    expect(e.watch.pending()).toEqual([]); // the session ended: nothing keeps asking
  });

  it('an auth error stops the tier watcher; the other tier keeps going', async () => {
    const e = setup();
    await startWaiting(e, { errorKind: 'auth', reason: 'error: 401' }, { status: 6, reason: 'audio-requested' });
    expect(e.watch.pending()).toEqual([90_000]); // only the standard tier
    e.engine.stop();
  });

  it('chunk-mode cooldown does not block the probe; an auth-skip verdict stops the watcher', async () => {
    const e = setup();
    await startWaiting(e, { status: 6 }, { status: 6 });
    const chain = (e.engine as unknown as { chain: { cooldownUntil: Map<string, number>; authSkip: Set<string> } }).chain;
    chain.cooldownUntil.set('yandex-live', Number.MAX_SAFE_INTEGER);
    e.watch.next();
    await flush();
    expect(e.prober.watched('yandex-live')).toHaveLength(1); // cooldown ignored
    e.prober.miss('yandex-live', { status: 6 });
    await flush();
    chain.authSkip.add('yandex-live');
    e.watch.list.filter((t) => !t.done && t.ms === 90_000).at(-1)!.fire();
    await flush();
    expect(e.prober.watched('yandex-live')).toHaveLength(1); // auth verdict: stopped
    e.engine.stop();
  });

  it('standard first, live later wins (live ranked first); a late standard never downgrades live', async () => {
    const e = setup({ order: ['yandex-live', 'yandex', 'gemini'] });
    e.prober.auto.set('yandex', track('yandex', 200));
    await e.engine.start();
    e.prober.first('yandex-live', 2);
    await flush();
    e.caps[0]!.emit(chunk(0));
    e.caps[0]!.emit(chunk(15));
    await flush();
    expect(providerIds(e.scheds[0]!)).toContain('yandex@15');
    e.prober.finish('yandex-live', track('yandex-live', 200));
    await flush();
    expect(providerIds(e.scheds[0]!)).toContain('yandex-live@15');
    expect(providerIds(e.scheds[0]!)).not.toContain('yandex@15');
    // the other way round: live first, a standard track later does nothing
    const f = setup({ order: ['yandex-live', 'yandex', 'gemini'] });
    f.prober.auto.set('yandex-live', track('yandex-live', 200));
    await f.engine.start();
    f.prober.first('yandex', 2);
    await flush();
    f.caps[0]!.emit(chunk(0));
    await flush();
    f.prober.finish('yandex', track('yandex', 200));
    await flush();
    expect(providerIds(f.scheds[0]!).every((x) => x.startsWith('yandex-live@'))).toBe(true);
    e.engine.stop();
    f.engine.stop();
  });

  it('a Gemini bridge is replaced by a late Yandex track, the playing cell included', async () => {
    const e = setup();
    await startWaiting(e, { status: 6 }, { status: 6 });
    e.video.currentTime = 4;
    e.caps[0]!.emit(chunk(0));
    await flush();
    expect(providerIds(e.scheds[0]!)).toContain('gemini@0');
    e.watch.next();
    await flush();
    e.prober.finish('yandex-live', track('yandex-live', 200));
    await flush();
    expect(providerIds(e.scheds[0]!)).not.toContain('gemini@0');
    expect(e.scheds[0]!.added.some((x) => x.providerId === 'yandex-live' && x.start > 3.9 && x.start <= 4)).toBe(true);
    e.engine.stop();
  });

  it('live disabled in settings: never probed after start, never used; enabling it later probes at once', async () => {
    const e = setup({ off: ['yandex-live'] });
    await e.engine.start();
    expect(e.prober.calls.map((c) => c.tier)).toEqual(['yandex']);
    e.prober.first('yandex', 2);
    e.prober.miss('yandex', { status: 6 });
    await flush();
    e.watch.next();
    await flush();
    expect(e.prober.calls.filter((c) => c.tier === 'yandex-live')).toHaveLength(0);
    e.prober.finish('yandex', undefined);
    await flush();
    const eng = e.engine as unknown as { applyTierChange(prev: unknown, s: unknown): void; settings: { voiceEnabled: Record<string, boolean> } };
    const prev = { ...eng.settings, voiceEnabled: { ...eng.settings.voiceEnabled } };
    eng.settings.voiceEnabled['yandex-live'] = true;
    eng.applyTierChange(prev, eng.settings);
    await flush();
    e.watch.list.filter((t) => !t.done && t.ms === 0).forEach((t) => t.fire());
    await flush();
    expect(e.prober.watched('yandex-live')).toHaveLength(1);
    e.engine.stop();
  });
});
