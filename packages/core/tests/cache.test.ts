import 'fake-indexeddb/auto';
// @ts-ignore -- no @types/node in the workspace
import { createHash } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import {
  IdbCache,
  MemoryCache,
  cacheKey,
  createRemoteCache,
  handleCacheMessage,
  muxOggOpus,
  parseOggOpus,
  sha256Hex,
  videoCacheKey,
  videoKey,
  withCache,
  type AudioCodec,
  type CachedChunk,
  type CacheInfo,
} from '../src/cache';
import type { AudioChunk, ChunkResult, DubProvider, DubSegment, ProviderContext, TextSegment } from '../src/providers/types';
import { DEFAULT_SETTINGS, type Settings } from '../src/types';
import { normalizeSettings } from '../src/settings';

const DAY = 86_400_000;

function entry(bytes = 100, tag = 'x'): CachedChunk {
  return { v: 1, audio: 'opus', createdAt: 0, sourceLang: 'en', segments: [{ start: 0, end: 1, text: tag, opus: new Uint8Array(bytes) }] };
}

describe('MemoryCache policy', () => {
  it('TTL expiry with a fake clock; purgeExpired removes expired rows', async () => {
    let t = 1000;
    const c = new MemoryCache(() => t);
    await c.put('a', entry(), { ttlMs: 7 * DAY });
    await c.put('b', entry(), { ttlMs: 1 * DAY });
    t += 2 * DAY;
    expect(await c.purgeExpired()).toBe(1);
    expect((await c.stats()).entries).toBe(1);
    expect(await c.get('a')).toBeDefined();
    t += 6 * DAY;
    expect(await c.get('a')).toBeUndefined();
    expect((await c.stats()).entries).toBe(0);
  });

  it('size cap evicts the least recently used entries first', async () => {
    let t = 0;
    const c = new MemoryCache(() => ++t);
    const cap = { maxBytes: 3 * 600 };
    for (const k of ['k1', 'k2', 'k3']) await c.put(k, entry(400), cap);
    await c.get('k1'); // k1 becomes the most recently used
    await c.put('k4', entry(400), cap);
    expect(await c.get('k2')).toBeUndefined(); // oldest unused went first
    expect(await c.get('k1')).toBeDefined();
    expect(await c.get('k3')).toBeDefined();
    expect(await c.get('k4')).toBeDefined();
    expect((await c.stats()).bytes).toBeLessThanOrEqual(cap.maxBytes);
  });
});

describe('IdbCache (fake-indexeddb)', () => {
  const mk = (now: () => number) => new IdbCache({ idb: new IDBFactory(), now, log: () => {} });

  it('round-trips binary data, applies TTL and the size cap', async () => {
    let t = 1;
    const c = mk(() => ++t);
    const v = entry(300, 'hello');
    v.segments[0]!.opus = new Uint8Array([1, 2, 3, 250]);
    await c.put('k', v, { ttlMs: DAY });
    const got = await c.get('k');
    expect(Array.from(got!.segments[0]!.opus!)).toEqual([1, 2, 3, 250]);
    t += 2 * DAY;
    expect(await c.get('k')).toBeUndefined();

    const cap = { maxBytes: 3 * 600, ttlMs: 7 * DAY };
    for (const k of ['a', 'b', 'c']) await c.put(k, entry(400), cap);
    await c.get('a');
    await c.put('d', entry(400), cap);
    expect(await c.get('b')).toBeUndefined();
    expect(await c.get('a')).toBeDefined();
    const st = await c.stats();
    expect(st.entries).toBe(3);
    expect(st.bytes).toBeLessThanOrEqual(cap.maxBytes);
    await c.clear();
    expect((await c.stats()).entries).toBe(0);
  });

  it('purgeExpired deletes by the expiresAt index', async () => {
    let t = 1;
    const c = mk(() => t);
    await c.put('old', entry(), { ttlMs: 10 });
    await c.put('new', entry(), { ttlMs: DAY });
    t += 100;
    expect(await c.purgeExpired()).toBe(1);
    expect((await c.stats()).entries).toBe(1);
  });

  it('a broken IndexedDB never throws', async () => {
    const bad = { open: () => { throw new Error('boom'); } } as unknown as IDBFactory;
    const c = new IdbCache({ idb: bad, log: () => {} });
    await expect(c.put('k', entry())).resolves.toBeUndefined();
    await expect(c.get('k')).resolves.toBeUndefined();
    await expect(c.stats()).resolves.toEqual({ entries: 0, bytes: 0 });
    await expect(c.clear()).resolves.toBeUndefined();
  });
});

// ---------------- wrapper ----------------

class FakeGemini implements DubProvider {
  readonly label = 'Gemini';
  calls = 0;
  synth = 0;
  sig = { translateModel: 'tm', ttsModel: 'tts', voice: 'Kore' };
  next: ChunkResult | Error = { segments: [seg(0)], sourceLang: 'en' };
  constructor(readonly id: 'gemini' | 'yandex' = 'gemini') {}
  isConfigured = () => true;
  cacheSignature = () => this.sig;
  async translateChunk(c: AudioChunk, _ctx: ProviderContext): Promise<ChunkResult> {
    this.calls++;
    if (this.next instanceof Error) throw this.next;
    return { ...this.next, segments: this.next.segments.map((s) => ({ ...s, start: c.startSec + 1, end: c.startSec + 2 })) };
  }
}
class FakeGeminiSynth extends FakeGemini {
  async synthesize(segments: TextSegment[]): Promise<DubSegment[]> {
    this.synth++;
    return segments.map((s) => ({ start: s.start, end: s.end, text: s.text, audio: { kind: 'pcm', sampleRate: 24000, samples: new Int16Array(10) } }));
  }
}

function seg(start: number): DubSegment {
  return { start, end: start + 1, src: 'hi', text: 'привет', rate: 1.1, audio: { kind: 'pcm', sampleRate: 24000, samples: new Int16Array(2400).fill(7) } };
}
const fakeCodec: AudioCodec = { encode: async (pcm) => new Uint8Array(pcm.length / 100) };
const noCodec: AudioCodec = { encode: async () => undefined };

const chunk = (startSec: number, durationSec = 15, partial = false): AudioChunk => ({ startSec, durationSec, sampleRate: 16000, pcm: new Int16Array(4), ...(partial ? { partial } : {}) });
const ctx = (over: Partial<ProviderContext> = {}): ProviderContext => ({ signal: new AbortController().signal, targetLang: 'ru', wantSubtitles: false, ...over });

function setup(over: Partial<Settings> = {}, infoOver: Partial<CacheInfo> = {}, provider: FakeGemini = new FakeGemini()) {
  const cache = new MemoryCache();
  const hits: number[] = [];
  const settings: Settings = { ...DEFAULT_SETTINGS, ...over };
  const w = withCache(provider, cache, {
    videoKey: () => 'yt:abc|d300',
    settings: () => settings,
    codec: fakeCodec,
    log: () => {},
    onHit: (h) => hits.push(h.startSec),
    ...infoOver,
  });
  return { cache, provider, w, hits, settings };
}

describe('withCache', () => {
  it('forwards the async probe() of the inner provider (groq/local readiness would stay false otherwise)', async () => {
    let probed = 0;
    const inner = Object.assign(new FakeGemini(), { probe: async () => void probed++ });
    const { w } = setup({}, {}, inner);
    await w.probe?.();
    expect(probed).toBe(1);
  });

  it('miss then hit: second call does not reach the provider; audio comes back as ogg-opus', async () => {
    const { w, provider, hits } = setup();
    const a = await w.translateChunk(chunk(15), ctx());
    await w.idle();
    const b = await w.translateChunk(chunk(15), ctx());
    expect(provider.calls).toBe(1);
    expect(hits).toEqual([15]);
    expect(b.sourceLang).toBe('en');
    expect(b.segments).toHaveLength(1);
    expect(b.segments[0]).toMatchObject({ start: a.segments[0]!.start, end: a.segments[0]!.end, text: 'привет', src: 'hi', rate: 1.1 });
    expect(b.segments[0]!.audio).toMatchObject({ kind: 'encoded', mime: 'audio/ogg; codecs=opus' });
  });

  it('never caches partial chunks, off-grid or wrong-length chunks', async () => {
    const { w, provider, cache } = setup();
    await w.translateChunk(chunk(15, 15, true), ctx());
    await w.translateChunk(chunk(15, 8), ctx());
    await w.translateChunk(chunk(17, 15), ctx());
    await w.idle();
    expect((await cache.stats()).entries).toBe(0);
    expect(provider.calls).toBe(3);
  });

  it('yandex (not in cacheProviders) is passed through untouched', async () => {
    const { w, provider, cache } = setup({}, {}, new FakeGemini('yandex'));
    await w.translateChunk(chunk(0), ctx());
    await w.translateChunk(chunk(0), ctx());
    await w.idle();
    expect(provider.calls).toBe(2);
    expect((await cache.stats()).entries).toBe(0);
  });

  it('cacheEnabled=false disables lookups and writes', async () => {
    const { w, provider, cache } = setup({ cacheEnabled: false });
    await w.translateChunk(chunk(0), ctx());
    await w.translateChunk(chunk(0), ctx());
    await w.idle();
    expect(provider.calls).toBe(2);
    expect((await cache.stats()).entries).toBe(0);
  });

  it('live / unknown video identity: no caching', async () => {
    const { w, provider, cache } = setup({}, { videoKey: () => undefined });
    await w.translateChunk(chunk(0), ctx());
    await w.idle();
    expect((await cache.stats()).entries).toBe(0);
    expect(provider.calls).toBe(1);
  });

  it("caches 'ru' detections as tiny entries; Russian video costs no quota twice", async () => {
    const p = new FakeGemini();
    p.next = { segments: [], sourceLang: 'ru' };
    const { w, cache } = setup({}, {}, p);
    await w.translateChunk(chunk(0), ctx());
    await w.idle();
    const st = await cache.stats();
    expect(st.entries).toBe(1);
    expect(st.bytes).toBeLessThan(300);
    const r = await w.translateChunk(chunk(0), ctx());
    expect(r.sourceLang).toBe('ru');
    expect(p.calls).toBe(1);
  });

  it('does not cache zero-segment results without a language, nor errors', async () => {
    const p = new FakeGemini();
    p.next = { segments: [] };
    const { w, cache } = setup({}, {}, p);
    await w.translateChunk(chunk(0), ctx());
    p.next = new Error('429');
    await expect(w.translateChunk(chunk(15), ctx())).rejects.toThrow('429');
    await w.idle();
    expect((await cache.stats()).entries).toBe(0);
  });

  it('cache errors are swallowed: translation still works (get and put failing)', async () => {
    const { w, cache, provider } = setup();
    cache.failWith = new Error('disk gone');
    const a = await w.translateChunk(chunk(0), ctx());
    await w.idle();
    expect(a.segments).toHaveLength(1);
    expect(provider.calls).toBe(1);
    // a throwing key source too
    const b = setup({}, { videoKey: () => { throw new Error('no url'); } });
    expect((await b.w.translateChunk(chunk(0), ctx())).segments).toHaveLength(1);
  });

  it('no WebCodecs and no synthesize(): nothing is cached (full audio would be needed)', async () => {
    const { w, cache } = setup({}, { codec: noCodec });
    await w.translateChunk(chunk(0), ctx());
    await w.idle();
    expect((await cache.stats()).entries).toBe(0);
  });

  it("no WebCodecs but synthesize(): text-only entry (audio:'none'); a hit re-runs only the TTS step", async () => {
    const p = new FakeGeminiSynth();
    const { w, cache } = setup({}, { codec: noCodec }, p);
    await w.translateChunk(chunk(0), ctx());
    await w.idle();
    const keys = (cache as unknown as { map: Map<string, { value: CachedChunk }> }).map;
    const stored = [...keys.values()][0]!.value;
    expect(stored.audio).toBe('none');
    expect(stored.segments[0]!.opus).toBeUndefined();
    expect(stored.segments[0]!.text).toBe('привет');
    const r = await w.translateChunk(chunk(0), ctx());
    expect(p.calls).toBe(1);
    expect(p.synth).toBe(1);
    expect(r.segments[0]!.audio.kind).toBe('pcm');
  });

  it('a text-only entry on a provider without synthesize() is treated as a miss', async () => {
    const { w, cache, provider } = setup();
    // plant a text-only entry under the real key
    const key = await cacheKey({ videoKey: 'yt:abc|d300', gridStart: 0, chunkSec: 15, providerId: 'gemini', targetLang: 'ru', sig: provider.sig, wantSubtitles: false });
    await cache.put(key, { v: 1, audio: 'none', createdAt: 0, sourceLang: 'en', segments: [{ start: 1, end: 2, text: 'x' }] });
    await w.translateChunk(chunk(0), ctx());
    expect(provider.calls).toBe(1);
  });

  it('model / voice / subtitles / chunk size / grid cell change the key (different cache rows)', async () => {
    const { w, provider, cache } = setup();
    await w.translateChunk(chunk(0), ctx());
    provider.sig = { ...provider.sig, voice: 'Puck' };
    await w.translateChunk(chunk(0), ctx());
    provider.sig = { ...provider.sig, ttsModel: 'tts2' };
    await w.translateChunk(chunk(0), ctx());
    await w.translateChunk(chunk(0), ctx({ wantSubtitles: true }));
    await w.translateChunk(chunk(15), ctx());
    await w.idle();
    expect(provider.calls).toBe(5);
    expect((await cache.stats()).entries).toBe(5);
  });

  it('cache TTL / cap come from settings', async () => {
    const { w, cache } = setup({ cacheDays: 2, cacheMaxMB: 1 });
    const seen: unknown[] = [];
    const orig = cache.put.bind(cache);
    cache.put = (k, v, o) => (seen.push(o), orig(k, v, o));
    await w.translateChunk(chunk(0), ctx());
    await w.idle();
    expect(seen).toEqual([{ ttlMs: 2 * DAY, maxBytes: 1048576 }]);
  });
});

describe('cacheKey', () => {
  const base = { videoKey: 'yt:abc', gridStart: 30, chunkSec: 15, providerId: 'gemini', targetLang: 'ru', sig: { translateModel: 'm', ttsModel: 't', voice: 'v' }, wantSubtitles: false };
  it('is a stable sha-256 hex; auto fills missing signature parts', async () => {
    const k1 = await cacheKey(base);
    expect(k1).toMatch(/^[0-9a-f]{64}$/);
    expect(await cacheKey({ ...base })).toBe(k1);
    expect(await cacheKey({ ...base, sig: {} })).toBe(await cacheKey({ ...base, sig: { voice: '' } }));
    expect(await cacheKey({ ...base, sig: { translateModel: 'other', ttsModel: 't', voice: 'v' } })).not.toBe(k1);
    expect(await cacheKey({ ...base, chunkSec: 10 })).not.toBe(k1);
    expect(await cacheKey({ ...base, targetLang: 'en' })).not.toBe(k1);
  });
  it('sha256Hex matches node crypto (subtle and the pure fallback)', async () => {
    const txt = 'v1|yt:abc|30.000|15|gemini|ru|a|b|c|s0 — юникод';
    const want = createHash('sha256').update(txt).digest('hex');
    expect(await sha256Hex(txt)).toBe(want);
    const g = globalThis as { crypto?: unknown };
    const saved = g.crypto;
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
    try {
      expect(await sha256Hex(txt)).toBe(want);
      expect(await sha256Hex('')).toBe(createHash('sha256').update('').digest('hex'));
      expect(await sha256Hex('a'.repeat(1000))).toBe(createHash('sha256').update('a'.repeat(1000)).digest('hex'));
    } finally {
      Object.defineProperty(globalThis, 'crypto', { value: saved, configurable: true });
    }
  });
});

describe('videoKey', () => {
  const v = (currentSrc = '') => ({ currentSrc });
  it('YouTube family -> yt:<id>, noise ignored', () => {
    expect(videoKey(v(), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('yt:dQw4w9WgXcQ');
    expect(videoKey(v(), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s&list=PL1&index=3&si=zz&utm_source=a#c')).toBe('yt:dQw4w9WgXcQ');
    expect(videoKey(v(), 'https://m.youtube.com/watch?feature=share&v=dQw4w9WgXcQ')).toBe('yt:dQw4w9WgXcQ');
    expect(videoKey(v(), 'https://www.youtube.com/shorts/abcDEF12345?feature=share')).toBe('yt:abcDEF12345');
    expect(videoKey(v(), 'https://www.youtube.com/embed/abcDEF12345?start=30&autoplay=1')).toBe('yt:abcDEF12345');
    expect(videoKey(v(), 'https://www.youtube-nocookie.com/embed/abcDEF12345')).toBe('yt:abcDEF12345');
    expect(videoKey(v(), 'https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=RDAMVM')).toBe('yt:dQw4w9WgXcQ');
    expect(videoKey(v(), 'https://youtu.be/dQw4w9WgXcQ?t=5')).toBe('yt:dQw4w9WgXcQ');
  });
  it('generic site: origin + path + meaningful ids, no hash / tracking', () => {
    const a = videoKey(v(), 'https://vimeo.example.com/watch/123?utm_source=x&fbclid=y&t=30#frag');
    const b = videoKey(v(), 'https://vimeo.example.com/watch/123?t=99&utm_campaign=z');
    expect(a).toBe('u:https://vimeo.example.com/watch/123');
    expect(b).toBe(a);
    expect(videoKey(v(), 'https://site.tv/player?id=7&utm_x=1&vid=3&t=4')).toBe('u:https://site.tv/player?id=7&vid=3');
    expect(videoKey(v(), 'https://site.tv/player?vid=3&id=7')).toBe('u:https://site.tv/player?id=7&vid=3');
    expect(videoKey(v(), 'https://site.tv/watch?v=1')).not.toBe(videoKey(v(), 'https://site.tv/watch?v=2'));
  });
  it('root-like page falls back to the media src without query', () => {
    expect(videoKey(v('https://cdn.x.com/a/b.mp4?token=1&exp=2'), 'https://x.com/?utm_source=a')).toBe('src:https://cdn.x.com/a/b.mp4');
    expect(videoKey(v('blob:https://x.com/uuid'), 'https://x.com/')).toBe('u:https://x.com/');
  });
  it('videoCacheKey adds the duration and refuses live / unknown duration', () => {
    expect(videoCacheKey({ currentSrc: '', duration: 212.4 }, 'https://youtu.be/dQw4w9WgXcQ')).toBe('yt:dQw4w9WgXcQ|d212');
    expect(videoCacheKey({ currentSrc: '', duration: Infinity }, 'https://youtu.be/dQw4w9WgXcQ')).toBeUndefined();
    expect(videoCacheKey({ currentSrc: '', duration: NaN }, 'https://youtu.be/dQw4w9WgXcQ')).toBeUndefined();
  });
});

describe('remote cache over JSON messages', () => {
  it('round-trips binary through base64 and survives backend errors', async () => {
    const backend = new MemoryCache();
    const send = async (m: unknown) => handleCacheMessage(backend, JSON.parse(JSON.stringify(m)));
    const remote = createRemoteCache(send);
    const v = entry(0, 'q');
    v.segments[0]!.opus = new Uint8Array([0, 1, 254, 255]);
    await remote.put('k', v, { ttlMs: 5 });
    const got = await remote.get('k');
    expect(Array.from(got!.segments[0]!.opus!)).toEqual([0, 1, 254, 255]);
    expect((await remote.stats()).entries).toBe(1);
    await remote.clear();
    expect(await remote.get('k')).toBeUndefined();
    const broken = createRemoteCache(async () => { throw new Error('no receiver'); });
    expect(await broken.get('k')).toBeUndefined();
    await expect(broken.put('k', v)).resolves.toBeUndefined();
  });
});

describe('Ogg-Opus muxer', () => {
  it('writes valid pages (CRC), keeps packets and the exact trimmed length', () => {
    const packets = Array.from({ length: 120 }, (_, i) => new Uint8Array(40 + (i % 7) * 50).fill(i));
    const ogg = muxOggOpus({ channels: 1, inputRate: 24000, preSkip: 312, packets, packetSamples: packets.map(() => 960), totalSamples48: 120 * 960 - 500 });
    expect(Array.from(ogg.subarray(0, 4))).toEqual([0x4f, 0x67, 0x67, 0x53]);
    const p = parseOggOpus(ogg);
    expect(p.crcOk).toBe(true);
    expect(p.channels).toBe(1);
    expect(p.preSkip).toBe(312);
    expect(p.packets).toHaveLength(120);
    expect(Array.from(p.packets[7]!)).toEqual(Array.from(packets[7]!));
    expect(p.lastGranule).toBe(312 + 120 * 960 - 500);
  });
  it('handles packets of 255+ bytes (multi-segment lacing)', () => {
    const packets = [new Uint8Array(255).fill(1), new Uint8Array(600).fill(2), new Uint8Array(10).fill(3)];
    const p = parseOggOpus(muxOggOpus({ channels: 1, inputRate: 24000, preSkip: 0, packets, packetSamples: [960, 960, 960] }));
    expect(p.packets.map((x) => x.length)).toEqual([255, 600, 10]);
    expect(p.crcOk).toBe(true);
  });
});

describe('settings normalisation of cache fields', () => {
  it('defaults and clamping', () => {
    const d = normalizeSettings({});
    expect(d).toMatchObject({ cacheEnabled: true, cacheDays: 7, cacheMaxMB: 300, cacheProviders: ['gemini', 'groq', 'local'] });
    const s = normalizeSettings({ cacheDays: 99, cacheMaxMB: 1, cacheEnabled: false, cacheProviders: ['yandex', 'bogus'] });
    expect(s).toMatchObject({ cacheDays: 30, cacheMaxMB: 10, cacheEnabled: false, cacheProviders: ['yandex'] });
    expect(normalizeSettings({ cacheDays: 0 }).cacheDays).toBe(1);
  });
});
