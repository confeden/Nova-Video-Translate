import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LASR_ENV_KEY, LTTS_ENV_KEY, VOICE_CALIB_STORAGE_KEY, WHISPER_CACHE_NAME, WHISPER_MODELS, lasrStateKey, unitFor, unitStateKey } from '../src/index';
import { createLocalModelPanelHost } from '../../../apps/extension/utils/localModelPanelHost';
import { createGmFetch } from '../../../apps/userscript/src/gmFetch';
import type { GmXhrDetails, GmXhrResponse } from '../../../apps/userscript/src/gm';

vi.mock('@nvt/core', () => import('../src/index'));

beforeEach(() => vi.resetModules());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function gmStore(): Map<string, unknown> {
  const values = new Map<string, unknown>();
  vi.stubGlobal('GM_getValue', (key: string) => values.get(key));
  vi.stubGlobal('GM_setValue', (key: string, value: unknown) => { values.set(key, value); });
  vi.stubGlobal('GM_deleteValue', (key: string) => { values.delete(key); });
  return values;
}

function gmDownload() {
  let details!: GmXhrDetails;
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const abort = vi.fn();
  const stream = new ReadableStream<Uint8Array>({ start(controller) { source = controller; }, cancel });
  const fetchGm = createGmFetch((request) => { details = request; return { abort }; });
  return {
    fetchGm, source, cancel, abort,
    start(headers = 'Content-Type: application/octet-stream') {
      details.onloadstart!({ status: 200, responseHeaders: headers, response: stream });
    },
    details: () => details,
  };
}

describe('userscript streaming downloads', () => {
  it('resolves at stream headers and delivers chunks before the download completes', async () => {
    const download = gmDownload();
    const pending = download.fetchGm('https://example.test/model.onnx');
    expect(download.details()).toMatchObject({ fetch: true, responseType: 'stream', anonymous: true });
    download.start('Content-Type: application/octet-stream\r\nContent-Length: 3');
    const response = await pending;
    const reader = response.body!.getReader();
    download.source.enqueue(new Uint8Array([1, 2]));
    expect(await reader.read()).toEqual({ done: false, value: new Uint8Array([1, 2]) });
    download.source.enqueue(new Uint8Array([3]));
    expect(await reader.read()).toEqual({ done: false, value: new Uint8Array([3]) });
    download.source.close();
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    expect(download.abort).not.toHaveBeenCalled();
  });

  it('aborts the GM handle and rejects an outstanding read when cancelled after headers', async () => {
    const download = gmDownload();
    const abort = new AbortController();
    const pending = download.fetchGm('https://example.test/model.onnx', { signal: abort.signal });
    download.start();
    const reader = (await pending).body!.getReader();
    const read = reader.read();
    abort.abort();
    await expect(read).rejects.toMatchObject({ name: 'AbortError' });
    expect(download.abort).toHaveBeenCalledTimes(1);
    expect(download.cancel).toHaveBeenCalledTimes(1);
  });

  it('propagates native errors that occur after the response promise resolved', async () => {
    const download = gmDownload();
    const pending = download.fetchGm('https://example.test/model.onnx');
    download.start();
    const reader = (await pending).body!.getReader();
    const read = reader.read();
    download.details().onerror!({ error: 'connection reset' });
    await expect(read).rejects.toThrow('GM download failed: connection reset');
  });

  it('rejects a manager without streaming instead of buffering a complete model', async () => {
    const download = gmDownload();
    const pending = download.fetchGm('https://example.test/model.onnx');
    const buffered: GmXhrResponse = { status: 200, response: new ArrayBuffer(1024) };
    download.details().onloadstart!(buffered);
    download.details().onload!(buffered);
    await expect(pending).rejects.toThrow('GM streaming is unavailable');
  });

  it('drops compressed transport lengths because the manager streams decoded bytes', async () => {
    const download = gmDownload();
    const pending = download.fetchGm('https://example.test/config.json');
    download.start('Content-Encoding: gzip\r\nContent-Length: 30\r\nContent-Type: application/json');
    const response = await pending;
    expect(response.headers.has('content-encoding')).toBe(false);
    expect(response.headers.has('content-length')).toBe(false);
    download.source.close();
    await response.arrayBuffer();
  });
});

describe('userscript local-model parity', () => {
  it('serializes competing file mutations across runtimes and lets a queued download cancel', async () => {
    const waiting = new Map<string, Promise<unknown>>();
    vi.stubGlobal('navigator', { locks: {
      request<T>(name: string, options: { signal?: AbortSignal }, run: () => Promise<T>): Promise<T> {
        const predecessor = waiting.get(name) ?? Promise.resolve();
        let abort: (() => void) | undefined;
        const cancelled = new Promise<never>((_resolve, reject) => {
          abort = () => reject(new DOMException('Aborted', 'AbortError'));
          options.signal?.addEventListener('abort', abort, { once: true });
        });
        const next = Promise.race([predecessor, cancelled]).then(() => {
          if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
          return run();
        }).finally(() => options.signal?.removeEventListener('abort', abort!));
        // A cancelled waiter must not release the predecessor's lock.
        waiting.set(name, Promise.allSettled([predecessor, next]));
        return next;
      },
    } });
    const { withLocalModelFiles } = await import('../../../apps/extension/utils/localRuntimeHost');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const events: string[] = [];
    const downloading = withLocalModelFiles(async () => { events.push('download'); await gate; events.push('downloaded'); });
    const abort = new AbortController();
    const cancelledWrite = vi.fn(async () => { events.push('cancelled'); });
    const cancelled = withLocalModelFiles(cancelledWrite, abort.signal);
    const deleting = withLocalModelFiles(async () => { events.push('delete'); });
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(['download']);
    abort.abort();
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancelledWrite).not.toHaveBeenCalled();
    expect(events).toEqual(['download']);
    release();
    await Promise.all([downloading, deleting]);
    expect(events).toEqual(['download', 'downloaded', 'delete']);
  });

  it('keeps per-site file readiness separate while preserving global settings on removal', async () => {
    const values = gmStore();
    values.set('nvt.settings', { autoTranslate: 'off' });
    const { createOriginModelStorage } = await import('../../../apps/userscript/src/localModels');
    const youtube = createOriginModelStorage('https://www.youtube.com');
    const twitch = createOriginModelStorage('https://www.twitch.tv');
    const key = unitStateKey('supertonic');
    const ready = { model: 'ready', rev: unitFor('supertonic-webgpu')!.rev };
    await youtube.set({ [key]: ready, [LTTS_ENV_KEY]: { gpu: true } });
    expect((await twitch.get(key))[key]).toBeUndefined();
    await twitch.set({ [key]: { model: 'none' } });
    await youtube.remove([key, LTTS_ENV_KEY]);
    expect((await youtube.get(key))[key]).toBeUndefined();
    expect((await twitch.get(key))[key]).toEqual({ model: 'none' });
    expect(values.get('nvt.settings')).toEqual({ autoTranslate: 'off' });
  });

  it('surfaces backend cancellation and deletion failures for both ASR and TTS', async () => {
    const send = vi.fn().mockResolvedValue({ ok: false, error: 'storage permission denied' });
    const host = createLocalModelPanelHost({ storage: { get: async () => ({}) }, send, clearModels: async () => ({ freedBytes: 0 }) });
    const actions = [
      () => host.localAsrCancel!(WHISPER_MODELS[0]!.id),
      () => host.localAsrDelete!(WHISPER_MODELS[0]!.id),
      () => host.localTtsCancel!('silero-cpu', 'eugene'),
      () => host.localTtsDelete!('silero-cpu', 'eugene'),
    ];
    for (const action of actions) await expect(action()).rejects.toThrow('storage permission denied');
    send.mockResolvedValue(undefined);
    await expect(host.localAsrCancel!(WHISPER_MODELS[0]!.id)).rejects.toThrow('локальный движок не ответил');
  });

  it('refreshes stalled download state without downloading and retains voice calibration', async () => {
    const key = unitStateKey('supertonic');
    const data: Record<string, unknown> = {
      [LTTS_ENV_KEY]: { gpu: true },
      [VOICE_CALIB_STORAGE_KEY]: { test: { f0: { M1: 115 } } },
      [key]: { model: 'ready', updatedAt: Date.now() },
    };
    const send = vi.fn(async (_type: string, op: string) => {
      if (op === 'status') data[key] = { model: 'ready', updatedAt: Date.now() };
      return { ok: true };
    });
    const host = createLocalModelPanelHost({
      storage: { get: async (keys) => Object.fromEntries((typeof keys === 'string' ? [keys] : keys).map((k) => [k, data[k]])) },
      send,
      clearModels: async () => ({ freedBytes: 0 }),
    });
    await host.getLocalTtsInfo!();
    data[key] = { model: 'downloading', updatedAt: Date.now() - 11_000 };
    const info = await host.getLocalTtsInfo!();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.every(([, op]) => op === 'status')).toBe(true);
    expect(info?.units.supertonic?.model).toBe('ready');
    expect(info?.calib).toEqual({ test: { f0: { M1: 115 } } });
  });

  it('dispatches userscript model controls through shared reducers without an extension runtime', async () => {
    vi.useFakeTimers();
    gmStore();
    vi.stubGlobal('location', { origin: 'https://example.test', href: 'https://example.test/video' });
    vi.stubGlobal('navigator', { hardwareConcurrency: 4, storage: { getDirectory: vi.fn() } });
    vi.stubGlobal('caches', {});
    const transport = vi.fn();
    vi.stubGlobal('GM_xmlhttpRequest', transport);
    const { createUserscriptLocalModels } = await import('../../../apps/userscript/src/localModels');
    const models = createUserscriptLocalModels();
    await expect(models.panelHost.localAsrDownload!('unknown-model')).rejects.toThrow('неизвестная модель');
    const info = await models.panelHost.getLocalAsrInfo!();
    expect(info?.env).toMatchObject({ offscreen: true, gpu: false });
    expect(await models.asrTransport.readEnv!()).toMatchObject({ offscreen: true, gpu: false });
    expect(transport).not.toHaveBeenCalled();
  });

  it('clears NVT model files through userscript controls while retaining unrelated site data', async () => {
    vi.useFakeTimers();
    const values = gmStore();
    values.set('nvt.settings', { sourceLang: 'en' });
    vi.stubGlobal('location', { origin: 'https://example.test', href: 'https://example.test/video' });
    const unit = unitFor('silero-cpu')!;
    const modelDir = `nvt-${unit.pack}-${unit.rev.slice(0, 12)}`;
    const removedDirs: string[] = [];
    const root = {
      async *keys() { yield modelDir; yield 'nvt-site-settings'; yield 'website-files'; },
      async getDirectoryHandle() {
        return { async *entries() { yield ['model.onnx', { kind: 'file', getFile: async () => ({ size: 13 }) }]; } };
      },
      async removeEntry(name: string) { removedDirs.push(name); },
    };
    vi.stubGlobal('navigator', { storage: { getDirectory: async () => root } });
    const whisper = WHISPER_MODELS[0]!;
    const nvtUrl = `https://huggingface.co/${whisper.id}/resolve/${whisper.revision}/config.json`;
    const unrelatedUrl = 'https://example.test/site-model.bin';
    const entries = new Map([
      [nvtUrl, new Response('model bytes', { headers: { 'content-length': '11' } })],
      [unrelatedUrl, new Response('site data')],
    ]);
    const deleteCache = vi.fn();
    const openedCaches: string[] = [];
    vi.stubGlobal('caches', {
      async open(name: string) {
        openedCaches.push(name);
        return {
          keys: async () => [...entries.keys()].map((url) => new Request(url)),
          match: async (request: Request) => entries.get(request.url),
          delete: async (request: Request) => entries.delete(request.url),
        };
      },
      keys: async () => [WHISPER_CACHE_NAME, 'website-offline'],
      delete: deleteCache,
    });
    const { createOriginModelStorage, createUserscriptLocalModels } = await import('../../../apps/userscript/src/localModels');
    const storage = createOriginModelStorage('https://example.test');
    await storage.set({ [unitStateKey('silero')]: { model: 'ready' }, [lasrStateKey(whisper.id)]: { model: 'ready' }, [LASR_ENV_KEY]: { gpu: false } });
    const transport = vi.fn();
    vi.stubGlobal('GM_xmlhttpRequest', transport);
    const models = createUserscriptLocalModels();
    const cleared = models.panelHost.clearLocalModels!();
    await vi.advanceTimersByTimeAsync(300);
    await expect(cleared).resolves.toEqual({ freedBytes: 24 });
    expect(removedDirs).toEqual([modelDir]);
    expect(entries.has(nvtUrl)).toBe(false);
    expect(entries.has(unrelatedUrl)).toBe(true);
    expect(openedCaches).toEqual([WHISPER_CACHE_NAME]);
    expect(deleteCache).not.toHaveBeenCalled();
    expect((await storage.get(unitStateKey('silero')))[unitStateKey('silero')]).toBeUndefined();
    expect(values.get('nvt.settings')).toEqual({ sourceLang: 'en' });
    expect(transport).not.toHaveBeenCalled();
  });
});
