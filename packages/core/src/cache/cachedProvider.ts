/**
 * withCache(provider, cache, info): serves Gemini output from the local result cache.
 * Granularity = one grid cell (see capture/rechunk.ts). Never caches partial cells, errors, live streams;
 * a cache failure is logged and ignored (translation continues as if there were no cache).
 */
import type { AudioChunk, CacheSignature, ChunkResult, DubProvider, DubSegment, ProviderContext, TextSegment } from '../providers/types';
import type { Settings } from '../types';
import { sha256Hex } from './hash';
import { OPUS_MIME, webCodecsOpus, type AudioCodec } from './opus';
import type { CachedChunk, CachedSegment, ResultCache } from './types';

export const CACHE_KEY_VERSION = 'v1';

export interface CacheInfo {
  /** stable video identity (videoCacheKey); undefined = do not cache (live stream, unknown duration) */
  videoKey(): string | undefined;
  settings(): Settings;
  /** audio compression (default WebCodecs Opus) */
  codec?: AudioCodec;
  now?(): number;
  log?(msg: string, err?: unknown): void;
  /** a chunk was served from the cache (debug hook / tiny marker) */
  onHit?(h: { startSec: number; providerId: string; key: string }): void;
}

export interface CachedProvider extends DubProvider {
  /** resolves when every background cache write has finished (tests) */
  idle(): Promise<void>;
}

const EPS = 0.05;

export async function cacheKey(parts: {
  videoKey: string;
  gridStart: number;
  chunkSec: number;
  providerId: string;
  targetLang: string;
  sig: CacheSignature;
  wantSubtitles: boolean;
}): Promise<string> {
  const s = parts.sig;
  const raw = [
    CACHE_KEY_VERSION,
    parts.videoKey,
    parts.gridStart.toFixed(3),
    parts.chunkSec,
    parts.providerId,
    parts.targetLang,
    s.translateModel || 'auto',
    s.ttsModel || 'auto',
    s.voice || 'auto',
    parts.wantSubtitles ? 's1' : 's0',
  ].join('|');
  return sha256Hex(raw);
}

function onGrid(startSec: number, chunkSec: number): boolean {
  const r = startSec / chunkSec;
  return Math.abs(r - Math.round(r)) * chunkSec < EPS;
}

export function withCache(inner: DubProvider, cache: ResultCache, info: CacheInfo): CachedProvider {
  const pending = new Set<Promise<void>>();
  const log = info.log ?? ((m, e) => console.debug(`NVT cache: ${m}`, e instanceof Error ? e.message : (e ?? '')));
  const codec = info.codec ?? webCodecsOpus;
  const now = info.now ?? Date.now;

  const eligible = (chunk: AudioChunk): { chunkSec: number; s: Settings } | undefined => {
    const s = info.settings();
    if (!s.cacheEnabled || !s.cacheProviders.includes(inner.id)) return undefined;
    if (chunk.partial) return undefined;
    if (Math.abs(chunk.durationSec - s.chunkSec) > EPS || !onGrid(chunk.startSec, s.chunkSec)) return undefined;
    return { chunkSec: s.chunkSec, s };
  };

  const toDub = async (c: CachedChunk, ctx: ProviderContext): Promise<ChunkResult | undefined> => {
    const result: ChunkResult = { segments: [], sourceLang: c.sourceLang };
    if (c.subtitles) result.subtitles = c.subtitles;
    if (c.segments.length === 0) return result;
    if (c.audio === 'opus') {
      result.segments = c.segments.map(
        (s): DubSegment => ({
          start: s.start,
          end: s.end,
          audio: { kind: 'encoded', mime: OPUS_MIME, data: s.opus! },
          src: s.src,
          text: s.text,
          rate: s.rate,
        }),
      );
      return result;
    }
    // text-only entry: only the TTS step runs again
    if (!inner.synthesize) return undefined;
    const text: TextSegment[] = c.segments.map((s) => ({ start: s.start, end: s.end, src: s.src, text: s.text ?? '', rate: s.rate }));
    result.segments = await inner.synthesize(text, ctx);
    return result;
  };

  const toCached = async (res: ChunkResult): Promise<CachedChunk | undefined> => {
    const base = { v: 1 as const, sourceLang: res.sourceLang, createdAt: now() };
    if (res.segments.length === 0) {
      // 'ru' detections and "no speech" verdicts are real answers; a zero-segment result with no language is not
      if (!res.sourceLang) return undefined;
      return { ...base, audio: 'opus', segments: [] };
    }
    const segs: CachedSegment[] = [];
    let allAudio = true;
    for (const s of res.segments) {
      const meta = { start: s.start, end: s.end, src: s.src, text: s.text, rate: s.rate };
      let opus: Uint8Array | undefined;
      try {
        if (s.audio.kind === 'pcm') opus = await codec.encode(s.audio.samples, s.audio.sampleRate);
        else if (/opus/i.test(s.audio.mime)) opus = s.audio.data;
      } catch (e) {
        log('encode failed', e);
      }
      if (!opus) allAudio = false;
      segs.push({ ...meta, opus });
    }
    const out: CachedChunk = { ...base, audio: allAudio ? 'opus' : 'none', segments: segs };
    if (res.subtitles) out.subtitles = res.subtitles;
    if (!allAudio) {
      // text-only entry is only useful when the provider can re-synthesize, and needs the text to do it
      if (!inner.synthesize || segs.some((s) => !s.text)) return undefined;
      out.segments = segs.map(({ opus: _o, ...rest }) => (void _o, rest));
    }
    return out;
  };

  const store = (key: string, res: ChunkResult, s: Settings): void => {
    // a partly voiced cell (some segments failed TTS) must not live 7 days with holes in it
    if (res.failedSegments?.length) return;
    const p = (async () => {
      const v = await toCached(res);
      if (!v) return;
      await cache.put(key, v, { ttlMs: s.cacheDays * 86_400_000, maxBytes: s.cacheMaxMB * 1024 * 1024 });
    })()
      .catch((e) => log('put failed', e))
      .finally(() => pending.delete(p));
    pending.add(p);
  };

  const wrapped: CachedProvider = {
    id: inner.id,
    label: inner.label,
    isConfigured: () => inner.isConfigured(),
    // the async readiness probe of the groq/local tiers must survive the wrapper, else isConfigured() stays false forever
    probe: inner.probe?.bind(inner),
    cacheSignature: inner.cacheSignature?.bind(inner),
    synthesize: inner.synthesize?.bind(inner),
    idle: async () => {
      while (pending.size > 0) await Promise.all([...pending]);
    },
    async translateChunk(chunk, ctx) {
      let key: string | undefined;
      let el: ReturnType<typeof eligible>;
      try {
        el = eligible(chunk);
        const vk = el ? info.videoKey() : undefined;
        if (el && vk) {
          let sig: CacheSignature = {};
          try {
            sig = (await inner.cacheSignature?.()) ?? {};
          } catch (e) {
            log('cacheSignature failed', e);
          }
          key = await cacheKey({
            videoKey: vk,
            gridStart: chunk.startSec,
            chunkSec: el.chunkSec,
            providerId: inner.id,
            targetLang: ctx.targetLang,
            sig,
            wantSubtitles: ctx.wantSubtitles,
          });
          const hit = await cache.get(key);
          if (hit) {
            const res = await toDub(hit, ctx);
            if (res) {
              info.onHit?.({ startSec: chunk.startSec, providerId: inner.id, key });
              return res;
            }
          }
        }
      } catch (e) {
        log('lookup failed', e);
        key = undefined;
      }
      const res = await inner.translateChunk(chunk, ctx);
      if (key && el) store(key, res, el.s);
      return res;
    },
  };
  return wrapped;
}
