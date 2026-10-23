import { describe, expect, it } from 'vitest';
import { classifyMime, installMseTap } from '../src/capture/mseTap';
import { createMseBridgeClient, installMseTapMain } from '../src/capture/mseBridge';
import { RealtimeChunker, SilenceDetector } from '../src/capture/realtimeTap';
import { directChunks, probeDirect, sniffKind } from '../src/capture/directUrl';
import type { AudioChunk } from '../src/providers/types';
import { concat, mp4Fragment, mp4Init, webmCluster, webmInit } from './helpers/media-fixtures';

/** fake MSE classes: appendBuffer records calls, honours `throwNext` */
function fakeMse() {
  class SourceBuffer {
    timestampOffset = 0;
    appended: unknown[] = [];
    throwNext = false;
    appendBuffer(d: unknown): string {
      if (this.throwNext) throw new Error('QuotaExceededError');
      this.appended.push(d);
      return 'orig';
    }
  }
  class MediaSource {
    buffers: SourceBuffer[] = [];
    addSourceBuffer(mime: string): SourceBuffer {
      void mime;
      const sb = new SourceBuffer();
      this.buffers.push(sb);
      return sb;
    }
  }
  return { MediaSource, SourceBuffer } as unknown as Record<string, any>;
}

const fakeDecoder = async (b: Uint8Array): Promise<Int16Array> => new Int16Array(Math.min(b.length, 160000)).fill(7);
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('classifyMime', () => {
  it('detects audio / video / combined', () => {
    expect(classifyMime('audio/mp4; codecs="mp4a.40.2"')).toBe('yes');
    expect(classifyMime('audio/webm; codecs="opus"')).toBe('yes');
    expect(classifyMime('video/mp4; codecs="avc1.4d401f"')).toBe('no');
    expect(classifyMime('video/webm; codecs="vp9"')).toBe('no');
    expect(classifyMime('video/mp4; codecs="avc1.64001f, mp4a.40.2"')).toBe('maybe');
    expect(classifyMime('video/mp4')).toBe('maybe');
  });
});

describe('installMseTap', () => {
  const setup = (opts: Parameters<typeof installMseTap>[1] = {}) => {
    const target = fakeMse();
    const chunks: AudioChunk[] = [];
    const tap = installMseTap((c) => chunks.push(c), { target, decoder: fakeDecoder, ...opts });
    const ms = new target.MediaSource();
    return { target, chunks, tap, ms };
  };

  it('is a pure pass-through: same this/args/return value, exceptions propagate, video buffers are not copied', () => {
    const { ms, chunks, tap } = setup();
    const a = ms.addSourceBuffer('audio/mp4; codecs="mp4a.40.2"');
    const v = ms.addSourceBuffer('video/mp4; codecs="avc1.4d401f"');
    const buf = new Uint8Array([1, 2, 3]);
    expect(a.appendBuffer(buf)).toBe('orig');
    expect(a.appended[0]).toBe(buf); // original receives the very same object
    v.appendBuffer(buf);
    expect(v.appended[0]).toBe(buf);
    a.throwNext = true;
    expect(() => a.appendBuffer(buf)).toThrow('QuotaExceededError');
    expect(chunks).toHaveLength(0);
    expect(tap.stats().audioBuffers).toBe(1);
    expect(tap.stats().segments).toBe(0); // garbage / unparsable appends never break the page
  });

  it('harvests fMP4 audio: init then segments positioned by tfdt + timestampOffset, deduped, video-only init dropped', async () => {
    const { ms, chunks, tap } = setup();
    const a = ms.addSourceBuffer('audio/mp4; codecs="mp4a.40.2"');
    const combined = ms.addSourceBuffer('video/mp4; codecs="avc1.4d401f, mp4a.40.2"');
    a.appendBuffer(mp4Init({ trackId: 1, timescale: 48000, handler: 'soun' }));
    const seg = (t: number) => mp4Fragment({ trackId: 1, baseTime: 48000 * t, durations: Array(235).fill(1024) });
    a.appendBuffer(seg(0));
    a.appendBuffer(seg(5));
    a.appendBuffer(seg(5)); // quality-switch re-append
    a.timestampOffset = 100;
    a.appendBuffer(seg(0));
    combined.appendBuffer(mp4Init({ trackId: 1, timescale: 90000, handler: 'vide' })); // video only => dropped
    combined.appendBuffer(seg(0));
    await tick();
    await tick();
    expect(chunks.map((c) => Math.round(c.startSec * 100) / 100)).toEqual([0, 5, 100]);
    expect(chunks[0]!.sampleRate).toBe(16000);
    const s = tap.stats();
    expect(s.segments).toBe(3);
    expect(s.audioBuffers).toBe(1);
    expect(s.maxEndSec).toBeCloseTo(105.017, 2);
  });

  it('harvests WebM/Opus: init+cluster in one append and separate clusters', async () => {
    const { ms, chunks } = setup();
    const a = ms.addSourceBuffer('audio/webm; codecs="opus"');
    const blocks = (n: number) => Array.from({ length: n }, (_, i) => ({ track: 1, rel: i * 20 }));
    a.appendBuffer(concat(webmInit({ audioTrack: 1 }), webmCluster({ timecode: 20_000, blocks: blocks(250) })));
    a.appendBuffer(webmCluster({ timecode: 25_000, blocks: blocks(250) }));
    await tick();
    await tick();
    expect(chunks.map((c) => c.startSec)).toEqual([20, 25]);
  });

  it('reassembles a cluster / fragment appended in several slices (YouTube appends 16 KB pieces)', async () => {
    const { ms, chunks, tap } = setup();
    const a = ms.addSourceBuffer('audio/webm; codecs="opus"');
    const blocks = Array.from({ length: 500 }, (_, i) => ({ track: 1, rel: i * 20 }));
    const init = webmInit({ audioTrack: 1 });
    a.appendBuffer(init);
    const cl = webmCluster({ timecode: 10_000, blocks });
    const cl2 = webmCluster({ timecode: 20_000, blocks });
    for (const c of [cl, cl2]) for (let o = 0; o < c.length; o += 1500) a.appendBuffer(c.slice(o, o + 1500));
    await tick();
    await tick();
    expect(chunks.map((c) => c.startSec)).toEqual([10, 20]);
    expect(tap.stats().segments).toBe(2);
    expect(tap.stats().maxEndSec).toBeCloseTo(30, 2);

    const m = ms.addSourceBuffer('audio/mp4; codecs="mp4a.40.2"');
    m.appendBuffer(mp4Init({ trackId: 1, timescale: 1000, handler: 'soun' }));
    const frag = mp4Fragment({ trackId: 1, baseTime: 40_000, durations: Array(50).fill(100) });
    m.appendBuffer(frag.slice(0, 70)); // inside the moof
    m.appendBuffer(frag.slice(70, frag.length - 5)); // mdat cut
    expect(tap.stats().segments).toBe(2); // not yet complete
    m.appendBuffer(frag.slice(frag.length - 5));
    await tick();
    await tick();
    expect(chunks.at(-1)!.startSec).toBe(40);
    expect(tap.stats().segments).toBe(3);
  });

  it('inactive tap holds raw audio; activate(fromSec) decodes only what ends after fromSec', async () => {
    const { ms, chunks, tap } = setup({ startActive: false });
    const a = ms.addSourceBuffer('audio/mp4; codecs="mp4a.40.2"');
    a.appendBuffer(mp4Init({ trackId: 1, timescale: 1000, handler: 'soun' }));
    for (let t = 0; t < 30; t += 5) a.appendBuffer(mp4Fragment({ trackId: 1, baseTime: t * 1000, durations: [5000] }));
    await tick();
    expect(chunks).toHaveLength(0);
    expect(tap.stats().segments).toBe(6);
    tap.activate(12);
    await tick();
    await tick();
    expect(chunks.map((c) => c.startSec)).toEqual([10, 15, 20, 25]);
    a.appendBuffer(mp4Fragment({ trackId: 1, baseTime: 30_000, durations: [5000] }));
    await tick();
    await tick();
    expect(chunks.at(-1)!.startSec).toBe(30);
  });

  it('caps memory to maxBufferedSec', () => {
    const { ms, tap } = setup({ startActive: false, maxBufferedSec: 20 });
    const a = ms.addSourceBuffer('audio/mp4; codecs="mp4a.40.2"');
    a.appendBuffer(mp4Init({ trackId: 1, timescale: 1000, handler: 'soun' }));
    for (let t = 0; t < 100; t += 5) a.appendBuffer(mp4Fragment({ trackId: 1, baseTime: t * 1000, durations: [5000] }));
    expect(tap.stats().bufferedSec).toBeLessThanOrEqual(20);
  });

  it('uninstall restores the originals when outermost; stays an inert pass-through when wrapped by someone else', () => {
    const t1 = fakeMse();
    const orig = t1.SourceBuffer.prototype.appendBuffer;
    const tap1 = installMseTap(() => undefined, { target: t1 });
    expect(t1.SourceBuffer.prototype.appendBuffer).not.toBe(orig);
    tap1.uninstall();
    expect(t1.SourceBuffer.prototype.appendBuffer).toBe(orig);

    const t2 = fakeMse();
    const tap2 = installMseTap(() => undefined, { target: t2 });
    const ours = t2.SourceBuffer.prototype.appendBuffer;
    let others = 0;
    t2.SourceBuffer.prototype.appendBuffer = function (this: unknown, ...a: unknown[]) {
      others++;
      return ours.apply(this, a);
    };
    const wrapped = t2.SourceBuffer.prototype.appendBuffer;
    tap2.uninstall();
    expect(t2.SourceBuffer.prototype.appendBuffer).toBe(wrapped); // not clobbered
    const sb = new t2.MediaSource().addSourceBuffer('audio/mp4; codecs="mp4a.40.2"');
    expect(sb.appendBuffer(new Uint8Array(4))).toBe('orig');
    expect(others).toBe(1);
  });

  it('a second install replaces the first instead of stacking', () => {
    const t = fakeMse();
    const orig = t.SourceBuffer.prototype.appendBuffer;
    installMseTap(() => undefined, { target: t });
    const second = installMseTap(() => undefined, { target: t });
    second.uninstall();
    expect(t.SourceBuffer.prototype.appendBuffer).toBe(orig);
  });
});

describe('MAIN <-> isolated bridge', () => {
  /** one shared fake window: postMessage dispatches to all listeners with source = window */
  function fakeWindow() {
    const ls = new Set<(e: MessageEvent) => void>();
    const win: any = {
      location: { origin: 'https://x.test' },
      postMessage(data: unknown, _origin: string, transfer?: Transferable[]) {
        const copy = data as { [k: string]: any };
        // emulate structured clone + transfer detach
        const msg = JSON.parse(JSON.stringify(copy, (_k, v) => (v instanceof ArrayBuffer ? { __ab: Array.from(new Uint8Array(v)) } : v)), (_k, v) => (v && v.__ab ? new Uint8Array(v.__ab).buffer : v));
        void transfer;
        queueMicrotask(() => ls.forEach((f) => f({ source: win, data: msg } as MessageEvent)));
      },
      addEventListener: (_t: string, f: (e: MessageEvent) => void) => ls.add(f),
      removeEventListener: (_t: string, f: (e: MessageEvent) => void) => ls.delete(f),
    };
    return win;
  }

  it('ping -> start -> chunks arrive in the isolated world; silent without a MAIN tap', async () => {
    const lonely = fakeWindow();
    const c0 = createMseBridgeClient(lonely);
    expect(await c0.ping(30)).toBeNull();
    c0.dispose();

    const win = fakeWindow();
    const target = fakeMse();
    const main = installMseTapMain({ win, target, decoder: fakeDecoder });
    const client = createMseBridgeClient(win);
    const got: AudioChunk[] = [];
    client.onChunk((c) => got.push(c));
    const sb = new target.MediaSource().addSourceBuffer('audio/mp4; codecs="mp4a.40.2"');
    sb.appendBuffer(mp4Init({ trackId: 1, timescale: 1000, handler: 'soun' }));
    sb.appendBuffer(mp4Fragment({ trackId: 1, baseTime: 0, durations: [5000] }));
    sb.appendBuffer(mp4Fragment({ trackId: 1, baseTime: 5000, durations: [5000] }));
    await tick();
    const stats = await client.ping(200);
    expect(stats?.audioBuffers).toBe(1);
    expect(stats?.segments).toBe(2);
    expect(got).toHaveLength(0); // idle until start()
    client.start(4);
    for (let i = 0; i < 6; i++) await tick();
    expect(got.map((c) => c.startSec)).toEqual([0, 5]);
    expect(got[0]!.pcm).toBeInstanceOf(Int16Array);
    client.dispose();
    main.dispose();
  });
});

describe('realtime pure parts', () => {
  it('RealtimeChunker cuts N-second chunks stamped from begin(), discards partials, resumes after seek', () => {
    const out: AudioChunk[] = [];
    const rc = new RealtimeChunker(1, (c) => out.push(c), 8000);
    rc.push(new Float32Array(100)); // not begun: ignored
    rc.begin(42);
    rc.push(new Float32Array(5000).fill(0.5));
    rc.push(new Float32Array(5000).fill(0.5));
    expect(out).toHaveLength(1);
    expect(out[0]!.startSec).toBe(42);
    expect(out[0]!.pcm).toHaveLength(8000);
    expect(rc.bufferedSec).toBeCloseTo(0.25, 5);
    expect(rc.discard()).toBeCloseTo(0.25, 5);
    rc.push(new Float32Array(8000));
    expect(out).toHaveLength(1);
    rc.begin(100);
    rc.push(new Float32Array(16000).fill(0.1));
    expect(out.map((c) => c.startSec)).toEqual([42, 100, 101]);
  });

  it('SilenceDetector fires once after > limit of digital silence and re-arms on signal', () => {
    const d = new SilenceDetector(3, 16000);
    const z = new Float32Array(16000);
    expect([d.feed(z), d.feed(z), d.feed(z)]).toEqual([false, false, false]);
    expect(d.feed(z)).toBe(true);
    expect(d.feed(z)).toBe(false);
    d.feed(Float32Array.of(0.1));
    expect([d.feed(z), d.feed(z), d.feed(z), d.feed(z)]).toEqual([false, false, false, true]);
  });
});

describe('directUrl', () => {
  const mp4Bytes = concat(mp4Init({ trackId: 1, timescale: 1000, handler: 'soun' }), new Uint8Array(1000));
  const fakeFetch = (bytes: Uint8Array, range = true): typeof fetch =>
    (async (_u: any, init?: RequestInit) => {
      const h = (init?.headers ?? {}) as Record<string, string>;
      const m = /bytes=(\d+)-(\d+)/.exec(h['Range'] ?? '');
      if (m && range) {
        const a = Number(m[1]);
        const b = Math.min(bytes.length - 1, Number(m[2]));
        return new Response(bytes.slice(a, b + 1), { status: 206, headers: { 'content-range': `bytes ${a}-${b}/${bytes.length}` } });
      }
      return new Response(bytes.slice(), { status: 200, headers: { 'content-length': String(bytes.length) } });
    }) as typeof fetch;

  it('sniffs containers', () => {
    expect(sniffKind(mp4Bytes)).toBe('mp4');
    expect(sniffKind(webmInit({ audioTrack: 1 }))).toBe('webm');
    expect(sniffKind(new Uint8Array([0x49, 0x44, 0x33, 4]))).toBe('mp3');
    expect(sniffKind(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toBeNull();
  });

  it('probes, rejects oversize mp4, and streams chunks from fromSec', async () => {
    const f = fakeFetch(mp4Bytes);
    expect(await probeDirect('https://a.test/v.mp4', { fetchFn: f })).toMatchObject({ supported: true, kind: 'mp4', size: mp4Bytes.length, rangeOk: true });
    expect(await probeDirect('https://a.test/v.mp4', { fetchFn: f, maxBytes: 100 })).toMatchObject({ supported: false });
    expect(await probeDirect('blob:abc')).toMatchObject({ supported: false });
    const decoder = async () => new Int16Array(16000 * 40);
    const got: AudioChunk[] = [];
    for await (const c of directChunks('https://a.test/v.mp4', 20, { fetchFn: f, decoder, chunkSec: 15 })) got.push(c);
    expect(got.map((c) => [c.startSec, c.durationSec])).toEqual([[20, 15], [35, 5]]);
  });

  it('cross-origin: Content-Range hidden => mp4 still supported (size-checked while streaming), mp3 is not', async () => {
    const hidden: typeof fetch = (async () => new Response(mp4Bytes.slice(0, 4096), { status: 206 })) as typeof fetch;
    expect(await probeDirect('https://a.test/v.mp4', { fetchFn: hidden })).toMatchObject({ supported: true, kind: 'mp4' });
    const mp3: typeof fetch = (async () => new Response(new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0]), { status: 206 })) as typeof fetch;
    expect(await probeDirect('https://a.test/a.mp3', { fetchFn: mp3 })).toMatchObject({ supported: false, kind: 'mp3' });
    const big = new Uint8Array(5000).fill(0);
    big.set(mp4Bytes.subarray(0, 64));
    const f: typeof fetch = (async () => new Response(big, { status: 206 })) as typeof fetch;
    await expect((async () => { for await (const _ of directChunks('https://a.test/v.mp4', 0, { fetchFn: f, maxBytes: 4000, decoder: async () => new Int16Array(0) })) void _; })()).rejects.toThrow(/too large/);
  });

  it('works when the server ignores Range (200)', async () => {
    const f = fakeFetch(mp4Bytes, false);
    const p = await probeDirect('https://a.test/v.mp4', { fetchFn: f });
    expect(p).toMatchObject({ supported: true, kind: 'mp4', rangeOk: false });
  });
});
