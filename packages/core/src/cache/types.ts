import type { SubtitleCue } from '../providers/types';

/** One cached translated segment. `opus` is a complete Ogg-Opus file (absent in text-only entries). */
export interface CachedSegment {
  start: number;
  end: number;
  src?: string;
  text?: string;
  rate?: number;
  opus?: Uint8Array;
}

/** What is stored per grid cell. */
export interface CachedChunk {
  v: 1;
  sourceLang?: string;
  /** 'opus': every segment carries compressed audio; 'none': text only, the TTS step must re-run on a hit */
  audio: 'opus' | 'none';
  segments: CachedSegment[];
  subtitles?: SubtitleCue[];
  createdAt: number;
}

export interface PutOptions {
  /** time to live, ms (default 7 days) */
  ttlMs?: number;
  /** size cap of the whole cache in bytes (default 300 MB); oldest entries are evicted first */
  maxBytes?: number;
}

export interface CacheStats {
  entries: number;
  bytes: number;
}

export const DEFAULT_TTL_MS = 7 * 24 * 3600_000;
export const DEFAULT_MAX_BYTES = 300 * 1024 * 1024;
export const PURGE_INTERVAL_MS = 3600_000;

/** A cache failure must never break translation: implementations swallow their own errors (log + continue). */
export interface ResultCache {
  get(key: string): Promise<CachedChunk | undefined>;
  put(key: string, value: CachedChunk, opts?: PutOptions): Promise<void>;
  /** @returns number of removed entries */
  purgeExpired(): Promise<number>;
  clear(): Promise<void>;
  stats(): Promise<CacheStats>;
}

export function estimateBytes(v: CachedChunk): number {
  let n = 128;
  for (const s of v.segments) {
    n += 64 + (s.opus?.byteLength ?? 0) + ((s.src?.length ?? 0) + (s.text?.length ?? 0)) * 2;
  }
  if (v.subtitles) for (const c of v.subtitles) n += 48 + ((c.src?.length ?? 0) + c.text.length) * 2;
  return n;
}
