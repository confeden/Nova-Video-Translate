/**
 * Cache over runtime messages (extension: content script <-> background service worker, so the cache is shared
 * across sites). Messages are JSON-serialised by the browser, so audio travels as base64.
 *
 *   nvt-cache-get   { key }                 -> { ok, value? }
 *   nvt-cache-put   { key, value, opts }    -> { ok }
 *   nvt-cache-purge {}                      -> { ok, removed }
 *   nvt-cache-clear {}                      -> { ok }
 *   nvt-cache-stats {}                      -> { ok, stats }
 */
import type { CachedChunk, CacheStats, PutOptions, ResultCache } from './types';

export interface WireSegment {
  start: number;
  end: number;
  src?: string;
  text?: string;
  rate?: number;
  opusB64?: string;
}
export interface WireChunk extends Omit<CachedChunk, 'segments'> {
  segments: WireSegment[];
}

export interface CacheReply {
  ok: boolean;
  error?: string;
  value?: WireChunk;
  stats?: CacheStats;
  removed?: number;
}

export type CacheMessage =
  | { type: 'nvt-cache-get'; key: string }
  | { type: 'nvt-cache-put'; key: string; value: WireChunk; opts?: PutOptions }
  | { type: 'nvt-cache-purge' }
  | { type: 'nvt-cache-clear' }
  | { type: 'nvt-cache-stats' };

export function toB64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}
export function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function toWire(c: CachedChunk): WireChunk {
  return {
    ...c,
    segments: c.segments.map(({ opus, ...s }) => (opus ? { ...s, opusB64: toB64(opus) } : s)),
  };
}
export function fromWire(w: WireChunk): CachedChunk {
  return {
    ...w,
    segments: w.segments.map(({ opusB64, ...s }) => (opusB64 !== undefined ? { ...s, opus: fromB64(opusB64) } : s)),
  };
}

export function isCacheMessage(m: unknown): m is CacheMessage {
  const t = (m as { type?: unknown } | null)?.type;
  return typeof t === 'string' && t.startsWith('nvt-cache-');
}

/** Service-worker side: runs one message against the real cache. */
export async function handleCacheMessage(cache: ResultCache, m: CacheMessage): Promise<CacheReply> {
  try {
    switch (m.type) {
      case 'nvt-cache-get': {
        const v = await cache.get(m.key);
        return { ok: true, value: v ? toWire(v) : undefined };
      }
      case 'nvt-cache-put':
        await cache.put(m.key, fromWire(m.value), m.opts);
        return { ok: true };
      case 'nvt-cache-purge':
        return { ok: true, removed: await cache.purgeExpired() };
      case 'nvt-cache-clear':
        await cache.clear();
        return { ok: true };
      case 'nvt-cache-stats':
        return { ok: true, stats: await cache.stats() };
      default:
        return { ok: false, error: 'unknown cache message' };
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Content-script side: a ResultCache that forwards to the background. Errors become misses / no-ops. */
export function createRemoteCache(send: (m: CacheMessage) => Promise<CacheReply | undefined>, log: (msg: string, err?: unknown) => void = () => {}): ResultCache {
  const call = async (m: CacheMessage): Promise<CacheReply | undefined> => {
    try {
      const r = await send(m);
      if (!r || !r.ok) {
        log(`${m.type} failed`, r?.error);
        return undefined;
      }
      return r;
    } catch (e) {
      log(`${m.type} failed`, e);
      return undefined;
    }
  };
  return {
    async get(key) {
      const r = await call({ type: 'nvt-cache-get', key });
      return r?.value ? fromWire(r.value) : undefined;
    },
    async put(key, value, opts) {
      await call({ type: 'nvt-cache-put', key, value: toWire(value), opts });
    },
    async purgeExpired() {
      return (await call({ type: 'nvt-cache-purge' }))?.removed ?? 0;
    },
    async clear() {
      await call({ type: 'nvt-cache-clear' });
    },
    async stats() {
      return (await call({ type: 'nvt-cache-stats' }))?.stats ?? { entries: 0, bytes: 0 };
    },
  };
}
