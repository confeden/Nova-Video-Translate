import { DEFAULT_MAX_BYTES, DEFAULT_TTL_MS, PURGE_INTERVAL_MS, estimateBytes, type CachedChunk, type CacheStats, type PutOptions, type ResultCache } from './types';

const STORE = 'chunks';

interface Row {
  key: string;
  value: CachedChunk;
  bytes: number;
  expiresAt: number;
  lastUsed: number;
}

export interface IdbCacheOptions {
  dbName?: string;
  now?: () => number;
  /** injectable factory (tests with fake-indexeddb) */
  idb?: IDBFactory;
  log?: (msg: string, err?: unknown) => void;
}

const req = <T>(r: IDBRequest<T>): Promise<T> =>
  new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
const done = (tx: IDBTransaction): Promise<void> =>
  new Promise((res, rej) => {
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error ?? new Error('tx aborted'));
  });

/**
 * IndexedDB ResultCache ('nvt-cache'): TTL via the `expiresAt` index, oldest-first (least recently used) eviction
 * via the `lastUsed` index, expired rows purged on first use and then at most once an hour. Every public method
 * swallows its own errors (a broken cache must never break translation).
 */
export class IdbCache implements ResultCache {
  private dbp?: Promise<IDBDatabase>;
  private total?: number;
  private lastPurge = 0;
  private readonly now: () => number;
  private readonly name: string;
  private readonly log: (msg: string, err?: unknown) => void;

  constructor(private readonly o: IdbCacheOptions = {}) {
    this.now = o.now ?? Date.now;
    this.name = o.dbName ?? 'nvt-cache';
    this.log = o.log ?? ((m, e) => console.debug(`NVT cache: ${m}`, e instanceof Error ? e.message : (e ?? '')));
  }

  private db(): Promise<IDBDatabase> {
    if (this.dbp) return this.dbp;
    const p = new Promise<IDBDatabase>((resolve, reject) => {
      const f = this.o.idb ?? globalThis.indexedDB;
      if (!f) return reject(new Error('indexedDB unavailable'));
      const r = f.open(this.name, 1);
      r.onupgradeneeded = () => {
        const s = r.result.createObjectStore(STORE, { keyPath: 'key' });
        s.createIndex('expiresAt', 'expiresAt');
        s.createIndex('lastUsed', 'lastUsed');
      };
      r.onsuccess = () => {
        r.result.onversionchange = () => {
          r.result.close();
          this.dbp = undefined;
        };
        resolve(r.result);
      };
      r.onerror = () => reject(r.error);
      r.onblocked = () => reject(new Error('indexedDB blocked'));
    });
    this.dbp = p;
    p.catch(() => {
      if (this.dbp === p) this.dbp = undefined;
    });
    return p;
  }

  private async guard<T>(what: string, fallback: T, fn: (db: IDBDatabase) => Promise<T>): Promise<T> {
    try {
      const db = await this.db();
      return await fn(db);
    } catch (e) {
      this.log(`${what} failed`, e);
      return fallback;
    }
  }

  /** hourly lazy purge (a service worker cannot rely on timers) */
  private maybePurge(): void {
    if (this.now() - this.lastPurge < PURGE_INTERVAL_MS) return;
    this.lastPurge = this.now();
    void this.purgeExpired();
  }

  async get(key: string): Promise<CachedChunk | undefined> {
    this.maybePurge();
    return this.guard('get', undefined, async (db) => {
      const tx = db.transaction(STORE, 'readwrite');
      const st = tx.objectStore(STORE);
      const row = (await req(st.get(key))) as Row | undefined;
      if (!row) return undefined;
      if (row.expiresAt <= this.now()) {
        st.delete(key);
        await done(tx);
        if (this.total !== undefined) this.total -= row.bytes;
        return undefined;
      }
      st.put({ ...row, lastUsed: this.now() });
      await done(tx);
      return row.value;
    });
  }

  async put(key: string, value: CachedChunk, opts: PutOptions = {}): Promise<void> {
    this.maybePurge();
    await this.guard('put', undefined, async (db) => {
      const t = this.now();
      const bytes = estimateBytes(value);
      const tx = db.transaction(STORE, 'readwrite');
      const st = tx.objectStore(STORE);
      const old = (await req(st.get(key))) as Row | undefined;
      st.put({ key, value, bytes, expiresAt: t + (opts.ttlMs ?? DEFAULT_TTL_MS), lastUsed: t } satisfies Row);
      await done(tx);
      if (this.total === undefined) this.total = (await this.scanStats(db)).bytes;
      else this.total += bytes - (old?.bytes ?? 0);
      await this.evict(db, opts.maxBytes ?? DEFAULT_MAX_BYTES);
    });
  }

  private async scanStats(db: IDBDatabase): Promise<CacheStats> {
    const tx = db.transaction(STORE, 'readonly');
    let entries = 0;
    let bytes = 0;
    await new Promise<void>((res, rej) => {
      const c = tx.objectStore(STORE).openCursor();
      c.onsuccess = () => {
        const cur = c.result;
        if (!cur) return res();
        entries++;
        bytes += (cur.value as Row).bytes;
        cur.continue();
      };
      c.onerror = () => rej(c.error);
    });
    return { entries, bytes };
  }

  /** delete least-recently-used rows until the total is within the cap */
  private async evict(db: IDBDatabase, maxBytes: number): Promise<void> {
    if ((this.total ?? 0) <= maxBytes) return;
    const tx = db.transaction(STORE, 'readwrite');
    let total = this.total ?? 0;
    await new Promise<void>((res, rej) => {
      const c = tx.objectStore(STORE).index('lastUsed').openCursor();
      c.onsuccess = () => {
        const cur = c.result;
        if (!cur || total <= maxBytes) return res();
        total -= (cur.value as Row).bytes;
        cur.delete();
        cur.continue();
      };
      c.onerror = () => rej(c.error);
    });
    await done(tx);
    this.total = total;
  }

  async purgeExpired(): Promise<number> {
    this.lastPurge = this.now();
    return this.guard('purge', 0, async (db) => {
      const tx = db.transaction(STORE, 'readwrite');
      let n = 0;
      let freed = 0;
      await new Promise<void>((res, rej) => {
        const c = tx.objectStore(STORE).index('expiresAt').openCursor(IDBKeyRange.upperBound(this.now()));
        c.onsuccess = () => {
          const cur = c.result;
          if (!cur) return res();
          n++;
          freed += (cur.value as Row).bytes;
          cur.delete();
          cur.continue();
        };
        c.onerror = () => rej(c.error);
      });
      await done(tx);
      if (this.total !== undefined) this.total -= freed;
      return n;
    });
  }

  async clear(): Promise<void> {
    await this.guard('clear', undefined, async (db) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      await done(tx);
      this.total = 0;
    });
  }

  async stats(): Promise<CacheStats> {
    return this.guard('stats', { entries: 0, bytes: 0 }, async (db) => {
      const s = await this.scanStats(db);
      this.total = s.bytes;
      return s;
    });
  }

  close(): void {
    void this.dbp?.then((d) => d.close()).catch(() => {});
    this.dbp = undefined;
  }
}

/** Purge now and then every hour (persistent contexts; the IdbCache also purges lazily on use). */
export function startCacheMaintenance(cache: ResultCache, intervalMs = PURGE_INTERVAL_MS): () => void {
  void cache.purgeExpired().catch(() => {});
  const t = setInterval(() => void cache.purgeExpired().catch(() => {}), intervalMs);
  return () => clearInterval(t);
}
