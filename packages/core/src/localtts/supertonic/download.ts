/**
 * Resumable model download. IO is injected (ModelStore = OPFS in the extension, a fake in tests; fetch = global fetch).
 * A file counts as complete only after it is size-checked, sha256-verified (when known) and markDone()'d; anything
 * else on disk is a partial file and is continued with an HTTP Range request.
 */
import { abortError } from './queue';
import type { ModelFile } from './constants';

export interface PartWriter {
  write(chunk: Uint8Array): Promise<void>;
  /** make everything written so far durable (OPFS writables only commit on close) */
  checkpoint(): Promise<void>;
  close(): Promise<void>;
}

export interface ModelStore {
  /** bytes on disk for this file (complete or partial); 0 when absent */
  size(path: string): Promise<number>;
  isDone(path: string): Promise<boolean>;
  markDone(path: string): Promise<void>;
  /** open for writing at `offset` (offset 0 truncates) */
  open(path: string, offset: number): Promise<PartWriter>;
  remove(path: string): Promise<void>;
  /** hex sha256 of the stored file */
  sha256(path: string): Promise<string>;
}

export interface DownloadProgress {
  loaded: number;
  total: number;
  file: string;
}

export interface DownloadOptions {
  files: readonly ModelFile[];
  baseUrl: string;
  store: ModelStore;
  fetch?: typeof fetch;
  onProgress?: (p: DownloadProgress) => void;
  signal?: AbortSignal;
  /** network-error retries per file (each resumes from the partial file) */
  retries?: number;
  /** ms between retries (multiplied by the attempt number) */
  backoffMs?: number;
  /** bytes between durable checkpoints */
  checkpointBytes?: number;
  progressEveryMs?: number;
}

export class DownloadError extends Error {
  constructor(
    message: string,
    readonly kind: 'http' | 'size' | 'checksum' | 'network',
  ) {
    super(message);
    this.name = 'DownloadError';
  }
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((res, rej) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      rej(abortError());
    }, { once: true });
  });

/** Downloads every file that is not complete yet. Resolves when all files are verified and marked done. */
export async function downloadModel(o: DownloadOptions): Promise<{ bytes: number; fetchedBytes: number }> {
  const fetchFn = o.fetch ?? fetch;
  const total = o.files.reduce((a, f) => a + f.size, 0);
  const retries = o.retries ?? 3;
  const ckEvery = o.checkpointBytes ?? 8 * 1048576;
  const every = o.progressEveryMs ?? 250;
  let base = 0; // bytes of fully finished files
  let fetched = 0;
  let lastEmit = 0;
  const emit = (loaded: number, file: string, force = false): void => {
    const now = Date.now();
    if (!force && now - lastEmit < every) return;
    lastEmit = now;
    o.onProgress?.({ loaded: Math.min(total, loaded), total, file });
  };

  for (const f of o.files) {
    if (o.signal?.aborted) throw abortError();
    if (await o.store.isDone(f.path) && (await o.store.size(f.path)) === f.size) {
      base += f.size;
      emit(base, f.path, true);
      continue;
    }
    for (let attempt = 0; ; attempt++) {
      try {
        fetched += await fetchOne(f, base);
        break;
      } catch (e) {
        if ((e as Error).name === 'AbortError' || o.signal?.aborted) throw abortError();
        const retriable = !(e instanceof DownloadError) || e.kind === 'network' || e.kind === 'size';
        if (!retriable || attempt >= retries) throw e;
        await sleep((o.backoffMs ?? 1500) * (attempt + 1), o.signal);
      }
    }
    base += f.size;
    emit(base, f.path, true);
  }
  return { bytes: total, fetchedBytes: fetched };

  async function fetchOne(f: ModelFile, doneBefore: number): Promise<number> {
    let have = await o.store.size(f.path);
    if (have > f.size) {
      await o.store.remove(f.path);
      have = 0;
    }
    let got = 0;
    if (have < f.size) {
      const headers: Record<string, string> = {};
      if (have > 0) headers.Range = `bytes=${have}-`;
      let res: Response;
      try {
        res = await fetchFn(f.url ?? o.baseUrl + f.path, { headers, signal: o.signal, redirect: 'follow' });
      } catch (e) {
        if ((e as Error).name === 'AbortError') throw e;
        throw new DownloadError(`network: ${(e as Error).message}`, 'network');
      }
      if (have > 0 && res.status === 200) have = 0; // server ignored Range: restart this file
      else if (res.status !== (have > 0 ? 206 : 200)) throw new DownloadError(`HTTP ${res.status} for ${f.path}`, res.status >= 500 ? 'network' : 'http');
      if (!res.body) throw new DownloadError('empty body', 'network');
      const w = await o.store.open(f.path, have);
      let sinceCk = 0;
      try {
        const reader = res.body.getReader();
        for (;;) {
          if (o.signal?.aborted) {
            await reader.cancel().catch(() => {});
            throw abortError();
          }
          let r: ReadableStreamReadResult<Uint8Array>;
          try {
            r = await reader.read();
          } catch (e) {
            if ((e as Error).name === 'AbortError') throw e;
            throw new DownloadError(`network: ${(e as Error).message}`, 'network');
          }
          if (r.done) break;
          await w.write(r.value);
          have += r.value.length;
          got += r.value.length;
          sinceCk += r.value.length;
          if (sinceCk >= ckEvery) {
            await w.checkpoint();
            sinceCk = 0;
          }
          emit(doneBefore + have, f.path);
        }
      } finally {
        await w.close().catch(() => {});
      }
    }
    const size = await o.store.size(f.path);
    if (size !== f.size) {
      await o.store.remove(f.path);
      throw new DownloadError(`size ${size} != ${f.size} for ${f.path}`, 'size');
    }
    if (f.sha256) {
      const h = await o.store.sha256(f.path);
      if (h !== f.sha256) {
        await o.store.remove(f.path);
        throw new DownloadError(`sha256 mismatch for ${f.path}`, 'checksum');
      }
    }
    await o.store.markDone(f.path);
    return got;
  }
}
