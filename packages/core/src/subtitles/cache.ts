import { sha256Hex } from '../cache/hash';
import type { ResultCache } from '../cache/types';
import type { SubtitleCue } from '../providers/types';
import type { Settings } from '../types';

const KEY_VERSION = 'sub1';

export interface SubtitleCacheOptions {
  cache: ResultCache;
  settings: () => Settings;
  /** identity of the video (cache/videoKey.ts videoCacheKey); undefined = live / unknown => never cached */
  videoKey: () => string | undefined;
}

/**
 * Subtitle results in the shared ResultCache (text entries: audio 'none', no segments). Key = video + source kind +
 * grid cell (S3) or `whole` (S2 translation). Only COMPLETE results are stored (never a partial cell / partial list).
 * A cache failure never breaks subtitles.
 */
export class SubtitleCache {
  constructor(private readonly o: SubtitleCacheOptions) {}

  private async key(kind: string, cell: number | 'whole'): Promise<string | undefined> {
    const vk = this.o.videoKey();
    if (!vk) return undefined;
    const s = this.o.settings();
    return sha256Hex([KEY_VERSION, vk, kind, cell === 'whole' ? 'whole' : cell.toFixed(3), s.chunkSec, s.targetLang].join('|'));
  }

  async get(kind: string, cell: number | 'whole'): Promise<SubtitleCue[] | undefined> {
    try {
      if (!this.o.settings().cacheEnabled) return undefined;
      const key = await this.key(kind, cell);
      if (!key) return undefined;
      const v = await this.o.cache.get(key);
      return v?.subtitles;
    } catch {
      return undefined;
    }
  }

  async put(kind: string, cell: number | 'whole', cues: SubtitleCue[]): Promise<void> {
    try {
      const s = this.o.settings();
      if (!s.cacheEnabled) return;
      const key = await this.key(kind, cell);
      if (!key) return;
      await this.o.cache.put(key, { v: 1, audio: 'none', segments: [], subtitles: cues, createdAt: Date.now() }, { ttlMs: s.cacheDays * 86_400_000, maxBytes: s.cacheMaxMB * 1024 * 1024 });
    } catch {
      /* a cache failure must never break subtitles */
    }
  }
}
