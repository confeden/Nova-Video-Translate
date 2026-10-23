import { describe, expect, it } from 'vitest';
import { installMseTap } from '../src/capture/mseTap';
import { TranslationEngine } from '../src/pipeline';
import { diag } from '../src/diag';
import type { AudioChunk, ChunkResult } from '../src/providers/types';
import type { CaptureOptions } from '../src/capture';
import { FakeCapture, FakeProvider, FakeScheduler, FakeVideo, chunk, flush, instantSleep, seg, settings } from './helpers/pipelineFakes';
import { mp4Fragment, mp4Init } from './helpers/media-fixtures';

// ---------- MSE tap: audio of the previous MediaSource must never be served for the next video ----------

function fakeMse() {
  class SourceBuffer {
    timestampOffset = 0;
    appendBuffer(_d: unknown): void {
      void _d;
    }
  }
  class MediaSource {
    readyState = 'open';
    addSourceBuffer(_m: string): SourceBuffer {
      void _m;
      return new SourceBuffer();
    }
  }
  return { MediaSource, SourceBuffer } as unknown as Record<string, any>;
}
const decoder = async (b: Uint8Array): Promise<Int16Array> => new Int16Array(Math.min(b.length, 160000)).fill(7);
const tick = () => new Promise((r) => setTimeout(r, 0));
const AUDIO = 'audio/mp4; codecs="mp4a.40.2"';
const frag = (t: number) => mp4Fragment({ trackId: 1, baseTime: 48000 * t, durations: Array(235).fill(1024) });
const init = () => mp4Init({ trackId: 1, timescale: 48000, handler: 'soun' });

describe('MSE tap across a video change (YouTube SPA navigation)', () => {
  const setup = () => {
    const target = fakeMse();
    const chunks: AudioChunk[] = [];
    const events: any[] = [];
    const tap = installMseTap((c) => chunks.push(c), { target, decoder, startActive: false, onEvent: (e) => events.push(e) });
    return { target, chunks, events, tap };
  };

  it('a new MediaSource drops the old one held audio; the new video own segments at the same times are not shadowed', async () => {
    const { target, chunks, tap, events } = setup();
    const ms1 = new target.MediaSource();
    const a1 = ms1.addSourceBuffer(AUDIO);
    a1.appendBuffer(init());
    for (const t of [0, 5, 10, 15]) a1.appendBuffer(frag(t));
    expect(tap.stats().segments).toBe(4);

    // video 2: same <video>, new MediaSource, segments start at 0 again
    const ms2 = new target.MediaSource();
    const a2 = ms2.addSourceBuffer(AUDIO);
    expect(tap.stats().segments).toBe(0);
    expect(events.some((e) => e.type === 'source' && e.dropped === 4)).toBe(true);
    a2.appendBuffer(init());
    a2.appendBuffer(frag(0));
    expect(tap.stats().segments).toBe(1);

    tap.activate(0);
    await tick();
    await tick();
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.startSec).toBeCloseTo(0, 1);
  });

  it('late appends into the replaced MediaSource SourceBuffer are ignored', async () => {
    const { target, chunks, tap, events } = setup();
    const ms1 = new target.MediaSource();
    const a1 = ms1.addSourceBuffer(AUDIO);
    a1.appendBuffer(init());
    a1.appendBuffer(frag(0));
    const ms2 = new target.MediaSource();
    ms2.addSourceBuffer(AUDIO);
    a1.appendBuffer(frag(5)); // old player pipeline still flushing
    a1.appendBuffer(frag(10));
    expect(tap.stats().segments).toBe(0);
    expect(events.filter((e) => e.type === 'stale-append').length).toBeGreaterThan(0);
    tap.activate(0);
    await tick();
    expect(chunks).toHaveLength(0);
  });

  it('a closed MediaSource is pruned even if no new one registered yet', async () => {
    const { target, chunks, tap } = setup();
    const ms1 = new target.MediaSource();
    const a1 = ms1.addSourceBuffer(AUDIO);
    a1.appendBuffer(init());
    a1.appendBuffer(frag(0));
    a1.appendBuffer(frag(5));
    expect(tap.stats().segments).toBe(2);
    ms1.readyState = 'closed';
    tap.activate(0);
    await tick();
    expect(chunks).toHaveLength(0);
    expect(tap.stats().segments).toBe(0);
  });

  it('an in-flight decode of the old video is discarded when the new source takes over', async () => {
    const target = fakeMse();
    const chunks: AudioChunk[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const tap = installMseTap((c) => chunks.push(c), {
      target,
      startActive: false,
      decoder: async (b) => {
        await gate;
        return new Int16Array(Math.min(b.length, 160000)).fill(7);
      },
    });
    const ms1 = new target.MediaSource();
    const a1 = ms1.addSourceBuffer(AUDIO);
    a1.appendBuffer(init());
    a1.appendBuffer(frag(0));
    tap.activate(0);
    await tick();
    new target.MediaSource().addSourceBuffer(AUDIO); // video 2 takes over while the decode is pending
    release();
    await tick();
    await tick();
    expect(chunks).toHaveLength(0);
  });

  it('reset() forgets everything held', () => {
    const { target, tap } = setup();
    const a = new target.MediaSource().addSourceBuffer(AUDIO);
    a.appendBuffer(init());
    a.appendBuffer(frag(0));
    expect(tap.stats().segments).toBe(1);
    tap.reset();
    expect(tap.stats().segments).toBe(0);
  });
});

// ---------- engine: nothing of session A may reach session B ----------

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function mkEngine(video: FakeVideo, provider: FakeProvider, vk: { v: string }) {
  const caps: FakeCapture[] = [];
  const scheds: FakeScheduler[] = [];
  const engine = new TranslationEngine({
    video: video as unknown as HTMLVideoElement,
    audioCtx: {} as AudioContext,
    providers: [provider],
    settings: settings({ voiceOrder: ['gemini'] }),
    videoKey: () => vk.v,
    createCapture: (async (_v: unknown, _o: CaptureOptions = {}) => {
      const c = new FakeCapture();
      caps.push(c);
      return c;
    }) as never,
    createScheduler: ((_v: unknown, _c: unknown, o: any) => {
      const s = new FakeScheduler(o);
      s.onStarve = o.onStarve;
      scheds.push(s);
      return s;
    }) as never,
    now: () => 0,
    sleep: instantSleep(),
    retryDelayMs: 10,
  });
  return { engine, caps, scheds };
}

const staleDrops = () => diag.entries().filter((e) => e.ev === 'stale-drop');

describe('TranslationEngine: stale results from a previous video session', () => {
  it('engine A stopped, engine B started on the same element: a late provider result of A never reaches B or A', async () => {
    diag.clear();
    const video = new FakeVideo();
    const vk = { v: 'yt:AAAAAAAAAAA' };
    const provider = new FakeProvider('gemini');
    const late = deferred<ChunkResult>();
    provider.script = [() => late.promise];
    const A = mkEngine(video, provider, vk);
    await A.engine.start();
    A.caps[0]!.emit(chunk(0));
    await flush();
    expect(provider.calls).toHaveLength(1);
    A.engine.stop(); // navigation: emptied -> controller stops the engine

    vk.v = 'yt:BBBBBBBBBBB';
    video.currentTime = 0;
    const B = mkEngine(video, provider, vk);
    await B.engine.start();
    B.caps[0]!.emit(chunk(15));
    await flush();

    late.resolve({ segments: [seg(0), seg(5)], sourceLang: 'en' }); // video 1's dub arrives now
    await flush();
    expect(A.scheds[0]?.added ?? []).toHaveLength(0);
    expect(B.scheds[0]!.added.every((s) => s.start >= 15)).toBe(true);
    expect(provider.calls.map((c) => c.chunk.startSec)).toEqual([0, 15]);
  });

  it('the page navigated without the controller restarting the engine: chunks and results for the old videoKey are dropped (stale-drop)', async () => {
    diag.clear();
    const video = new FakeVideo();
    const vk = { v: 'yt:AAAAAAAAAAA' };
    const provider = new FakeProvider('gemini');
    const late = deferred<ChunkResult>();
    provider.script = [() => late.promise];
    const A = mkEngine(video, provider, vk);
    await A.engine.start();
    A.caps[0]!.emit(chunk(0));
    await flush();
    vk.v = 'yt:BBBBBBBBBBB'; // SPA navigation
    A.caps[0]!.emit(chunk(15)); // stale MSE audio of video 1
    late.resolve({ segments: [seg(0)], sourceLang: 'en' });
    await flush();
    expect(provider.calls).toHaveLength(1); // chunk 15 never became a request
    expect(A.scheds[0]!.added).toHaveLength(0);
    expect(staleDrops().map((e) => e.data?.where)).toEqual(expect.arrayContaining(['chunk', 'result']));
  });

  it('a cell beyond the duration of the current video is dropped', async () => {
    diag.clear();
    const video = new FakeVideo() as FakeVideo & { duration: number };
    video.duration = 100;
    const provider = new FakeProvider('gemini');
    const A = mkEngine(video, provider, { v: 'yt:AAAAAAAAAAA' });
    await A.engine.start();
    A.caps[0]!.emit(chunk(150));
    A.caps[0]!.emit(chunk(30));
    await flush();
    expect(provider.calls.map((c) => c.chunk.startSec)).toEqual([30]);
    expect(staleDrops().some((e) => e.data?.why === 'beyond-duration' && e.data?.cell === 150)).toBe(true);
  });

  it('a full-track probe of the previous session resolving late is dropped', async () => {
    diag.clear();
    const video = new FakeVideo();
    const provider = new FakeProvider('yandex');
    const probes: Array<(t: any) => void> = [];
    const fullTrack = {
      probe: (o: any) => {
        o.onFirst?.(undefined);
        return new Promise((r) => probes.push(r));
      },
    };
    const eng = new TranslationEngine({
      video: video as unknown as HTMLVideoElement,
      audioCtx: {} as AudioContext,
      providers: [provider],
      settings: settings({ voiceOrder: ['yandex'] }),
      videoKey: () => 'yt:AAAAAAAAAAA',
      fullTrack: fullTrack as never,
      createCapture: (async () => new FakeCapture()) as never,
      createScheduler: (() => new FakeScheduler()) as never,
      sleep: instantSleep(),
    });
    await eng.start();
    expect(probes.length).toBeGreaterThan(0);
    eng.stop();
    const before = staleDrops().length;
    probes[0]!({ tier: 'yandex', bytes: new Uint8Array(4), index: { durationSec: 100, frames: [] }, durationSec: 100, bitrate: 128, complete: true });
    await flush();
    expect(staleDrops().length).toBe(before + 1);
  });
});
