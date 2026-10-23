/** Remembers "this video is Russian" verdicts per videoKey in the shared result cache (tiny text-only entries). */
import type { ResultCache } from '../cache/types';
import { diag } from '../diag';

export interface LangVerdictStore {
  /** true when this video was recorded as Russian earlier */
  isRussian(): Promise<boolean>;
  markRussian(): Promise<void>;
}

const TTL_MS = 30 * 24 * 3600_000;

export function createLangStore(cache: ResultCache, videoKey: () => string | undefined): LangVerdictStore {
  const key = (): string | undefined => {
    const k = videoKey();
    return k ? `lang|${k}` : undefined;
  };
  return {
    async isRussian() {
      const k = key();
      if (!k) return false;
      try {
        return (await cache.get(k))?.sourceLang === 'ru';
      } catch {
        return false;
      }
    },
    async markRussian() {
      const k = key();
      if (!k) return;
      try {
        await cache.put(k, { v: 1, sourceLang: 'ru', audio: 'none', segments: [], createdAt: Date.now() }, { ttlMs: TTL_MS });
      } catch (e) {
        diag.log('lang-store-fail', { msg: e instanceof Error ? e.message.slice(0, 60) : 'err' });
      }
    },
  };
}
