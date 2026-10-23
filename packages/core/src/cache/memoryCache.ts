import { DEFAULT_MAX_BYTES, DEFAULT_TTL_MS, estimateBytes, type CachedChunk, type CacheStats, type PutOptions, type ResultCache } from './types';

interface Rec {
  value: CachedChunk;
  bytes: number;
  expiresAt: number;
  lastUsed: number;
  seq: number;
}

/** In-memory ResultCache with the same TTL / size-cap policy as the IndexedDB one (tests, fallback). */
export class MemoryCache implements ResultCache {
  private readonly map = new Map<string, Rec>();
  private seq = 0;
  /** make operations fail (tests of the error-swallowing paths) */
  failWith?: Error;
  constructor(private readonly now: () => number = Date.now) {}

  async get(key: string): Promise<CachedChunk | undefined> {
    if (this.failWith) throw this.failWith;
    const r = this.map.get(key);
    if (!r) return undefined;
    if (r.expiresAt <= this.now()) {
      this.map.delete(key);
      return undefined;
    }
    r.lastUsed = this.now();
    r.seq = ++this.seq;
    return r.value;
  }

  async put(key: string, value: CachedChunk, opts: PutOptions = {}): Promise<void> {
    if (this.failWith) throw this.failWith;
    const t = this.now();
    this.map.set(key, { value, bytes: estimateBytes(value), expiresAt: t + (opts.ttlMs ?? DEFAULT_TTL_MS), lastUsed: t, seq: ++this.seq });
    this.evict(opts.maxBytes ?? DEFAULT_MAX_BYTES);
  }

  private evict(maxBytes: number): void {
    let total = 0;
    for (const r of this.map.values()) total += r.bytes;
    if (total <= maxBytes) return;
    const order = [...this.map.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed || a[1].seq - b[1].seq);
    for (const [k, r] of order) {
      if (total <= maxBytes) break;
      this.map.delete(k);
      total -= r.bytes;
    }
  }

  async purgeExpired(): Promise<number> {
    if (this.failWith) throw this.failWith;
    const t = this.now();
    let n = 0;
    for (const [k, r] of [...this.map]) {
      if (r.expiresAt <= t) {
        this.map.delete(k);
        n++;
      }
    }
    return n;
  }

  async clear(): Promise<void> {
    if (this.failWith) throw this.failWith;
    this.map.clear();
  }

  async stats(): Promise<CacheStats> {
    if (this.failWith) throw this.failWith;
    let bytes = 0;
    for (const r of this.map.values()) bytes += r.bytes;
    return { entries: this.map.size, bytes };
  }
}
