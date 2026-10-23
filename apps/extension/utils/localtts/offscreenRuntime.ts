/**
 * Offscreen-document side of the in-browser local TTS engines: model download (OPFS, per unit), ONE loaded model backend at a
 * time, a single FIFO synthesis queue shared by all engines, idle auto-close. Talks only chrome.runtime (the only API an
 * offscreen document has). Started from entrypoints/offscreen.
 */
import {
  LTTS_MSG,
  OFFSCREEN_IDLE_MS,
  SerialQueue,
  WARMUP_TEXT,
  downloadModel,
  engineInfo,
  int16ToB64,
  resolveVoice,
  unitFor,
  type BackendOutput,
  type LocalTtsBackend,
  type LocalTtsEngineId,
  type LocalTtsUnit,
  type LttsEvent,
  type LttsReply,
  type LttsRequest,
  type SelfTestReplyData,
  type SynthReplyData,
  type WarmReplyData,
} from '@nvt/core';
import { browser } from 'wxt/browser';
import { createPiperBackend } from './backends/piper';
import { createSileroBackend } from './backends/silero';
import { SupertonicBackend } from './backends/supertonic';
import { OpfsModelStore } from './opfsStore';
import { hasWebGpu } from './ortModel';

const queue = new SerialQueue();
const aborts = new Map<string, AbortController>();
const downloads = new Map<string, AbortController>();
const stores = new Map<string, OpfsModelStore>();

interface Loaded {
  engine: LocalTtsEngineId;
  backend: LocalTtsBackend;
  loadMs: number;
  bytes: number;
  /** voices already warmed (a warm-up synth compiles shaders / fills caches) */
  warmed: Map<string, number>;
}
/** the single loaded backend (a second engine replaces it: model memory is the scarce thing) */
let loaded: Loaded | undefined;

const DEFAULT_ENGINE: LocalTtsEngineId = 'supertonic-webgpu';

const SELFTEST_TEXTS = [
  'Сегодня мы поговорим о том, как устроены современные ракеты.',
  'Первая ступень отделяется на высоте около шестидесяти километров, и двигатели второй ступени начинают работу.',
  'Всё получилось.',
];

type EventBody = LttsEvent extends infer E ? (E extends LttsEvent ? Omit<E, 'type' | 'to' | 'op'> : never) : never;
const emit = (e: EventBody): void => {
  void browser.runtime.sendMessage({ type: LTTS_MSG, to: 'bg', op: 'event', ...e }).catch(() => {});
};

const storeFor = (u: LocalTtsUnit): OpfsModelStore => {
  const key = `${u.pack}:${u.rev}`;
  let s = stores.get(key);
  if (!s) stores.set(key, (s = new OpfsModelStore(u.pack, u.rev)));
  return s;
};

// ---- idle auto-close ----
let idleTimer: ReturnType<typeof setTimeout> | undefined;
function touch(): void {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (downloads.size > 0 || queue.size > 0) return touch();
    emit({ ev: 'idle-close' });
  }, OFFSCREEN_IDLE_MS);
}

async function unitFilesPresent(u: LocalTtsUnit): Promise<boolean> {
  const store = storeFor(u);
  for (const f of u.files) if (!(await store.isDone(f.path)) || (await store.size(f.path)) !== f.size) return false;
  return true;
}

function makeBackend(engine: LocalTtsEngineId): LocalTtsBackend {
  switch (engine) {
    case 'supertonic-webgpu':
      return new SupertonicBackend('webgpu');
    case 'supertonic-wasm':
      return new SupertonicBackend('wasm');
    case 'silero-cpu':
      return createSileroBackend();
    case 'piper-wasm':
      return createPiperBackend();
    default:
      throw new Error(`engine ${engine} is not hosted in the offscreen document`);
  }
}

async function disposeLoaded(): Promise<void> {
  const cur = loaded;
  loaded = undefined;
  await cur?.backend.dispose().catch(() => {});
}

/** loads (once) the backend of an engine; must run inside the queue. A different engine replaces the loaded one. */
async function ensureBackend(engine: LocalTtsEngineId, voice?: string): Promise<{ l: Loaded; newlyLoaded: boolean; unit: LocalTtsUnit }> {
  const info = engineInfo(engine);
  const unit = unitFor(engine, voice);
  if (!info || !unit) throw new Error(`unknown engine ${engine}`);
  if (loaded && loaded.engine === engine) return { l: loaded, newlyLoaded: false, unit };
  await disposeLoaded();
  if (info.needsGpu) {
    const gpu = await hasWebGpu();
    emit({ ev: 'gpu', gpu });
    if (!gpu) throw new Error('WebGPU недоступен');
  }
  if (!(await unitFilesPresent(unit))) {
    emit({ ev: 'error', unit: unit.id, message: 'файлы модели не найдены (кэш браузера очищен?)', missing: true });
    throw new Error('model files missing');
  }
  const backend = makeBackend(engine);
  const t0 = performance.now();
  await backend.load(storeFor(unit));
  loaded = { engine, backend, loadMs: Math.round(performance.now() - t0), bytes: unit.total, warmed: new Map() };
  return { l: loaded, newlyLoaded: true, unit };
}

interface NewWork {
  loadMs?: number;
  loadBytes?: number;
  warmMs?: number;
}

/** loads (once) and runs the warm-up synth (once per voice); returns what was newly done by this call */
async function ensureWarm(engine: LocalTtsEngineId, voice?: string): Promise<NewWork & { l: Loaded }> {
  const { l, newlyLoaded } = await ensureBackend(engine, voice);
  const out: NewWork = newlyLoaded ? { loadMs: l.loadMs, loadBytes: l.bytes } : {};
  const v = resolveVoice(engine, voice);
  if (!l.warmed.has(v)) {
    const t0 = performance.now();
    await l.backend.synth({ text: WARMUP_TEXT, voice: v });
    const ms = Math.round(performance.now() - t0);
    l.warmed.set(v, ms);
    out.warmMs = ms;
  }
  return { ...out, l };
}

async function startDownload(engine: LocalTtsEngineId, voice: string | undefined, baseUrlOverride?: string): Promise<void> {
  const unit = unitFor(engine, voice);
  if (!unit) return emit({ ev: 'error', message: 'неизвестная модель' });
  if (downloads.has(unit.id)) return;
  const ac = new AbortController();
  downloads.set(unit.id, ac);
  const t0 = Date.now();
  try {
    const baseUrl = baseUrlOverride || unit.baseUrl;
    if (!baseUrl && !unit.files.every((f) => f.url)) throw new Error('модель ещё не опубликована (нет адреса загрузки)');
    const store = storeFor(unit);
    await navigator.storage.persist?.().catch(() => false);
    await store.pruneOld().catch(() => {});
    const r = await downloadModel({
      files: unit.files,
      baseUrl,
      store,
      signal: ac.signal,
      onProgress: (p) => emit({ ev: 'progress', unit: unit.id, loaded: p.loaded, total: p.total }),
    });
    emit({ ev: 'downloaded', unit: unit.id, bytes: r.bytes, fetchedBytes: r.fetchedBytes, ms: Date.now() - t0 });
  } catch (e) {
    if ((e as Error).name === 'AbortError') emit({ ev: 'error', unit: unit.id, message: 'скачивание отменено' });
    else emit({ ev: 'error', unit: unit.id, message: String((e as Error).message ?? e).slice(0, 200) });
  } finally {
    downloads.delete(unit.id);
    touch();
  }
}

function stagesOf(b: LocalTtsBackend): Record<string, number> | undefined {
  const t = (b as unknown as { takeStages?: () => Record<string, number> }).takeStages;
  const s = t?.call(b);
  return s && Object.keys(s).length ? s : undefined;
}

async function synth(req: Extract<LttsRequest, { op: 'synth' }>): Promise<LttsReply<SynthReplyData>> {
  const ac = new AbortController();
  aborts.set(req.id, ac);
  const engine = req.engine ?? DEFAULT_ENGINE;
  const tRecv = performance.now();
  try {
    return await queue.run(async (signal) => {
      const queueMs = Math.round(performance.now() - tRecv);
      const warm = await ensureWarm(engine, req.voice);
      const { l } = warm;
      stagesOf(l.backend); // reset: the warm-up must not leak into this request's stages
      const t0 = performance.now();
      const r: BackendOutput = await l.backend.synth({ text: req.text, voice: resolveVoice(engine, req.voice), targetSec: req.targetSec, signal });
      return {
        ok: true as const,
        engine,
        sampleRate: r.sampleRate,
        pcmB64: int16ToB64(r.samples),
        durationSec: r.durationSec,
        ms: Math.round(performance.now() - t0),
        chars: req.text.length,
        speed: r.speed,
        passes: r.passes,
        stages: stagesOf(l.backend),
        queueMs,
        loadMs: warm.loadMs,
        loadBytes: warm.loadBytes,
        warmMs: warm.warmMs,
      };
    }, ac.signal);
  } catch (e) {
    return { ok: false, error: (e as Error).name === 'AbortError' ? 'aborted' : String((e as Error).message ?? e) };
  } finally {
    aborts.delete(req.id);
  }
}

async function selftest(): Promise<LttsReply<SelfTestReplyData>> {
  try {
    return await queue.run(async () => {
      const w = await ensureWarm(DEFAULT_ENGINE);
      const runs: SelfTestReplyData['runs'] = [];
      for (const text of SELFTEST_TEXTS) {
        const t0 = performance.now();
        const r = await w.l.backend.synth({ text, voice: 'M1' });
        const ms = Math.round(performance.now() - t0);
        runs.push({ chars: text.length, sec: r.durationSec, ms, rtf: r.durationSec ? ms / 1000 / r.durationSec : 0, speed: r.speed });
      }
      return { ok: true as const, loadMs: w.loadMs ?? 0, warmMs: w.warmMs ?? w.l.warmed.get('M1') ?? 0, runs };
    });
  } catch (e) {
    return { ok: false, error: String((e as Error).message ?? e) };
  }
}

async function deleteUnit(engine: LocalTtsEngineId, voice: string | undefined): Promise<LttsReply<object>> {
  const unit = unitFor(engine, voice);
  if (!unit) return { ok: false, error: 'unknown engine' };
  downloads.get(unit.id)?.abort();
  // drop the loaded model if it belongs to this pack (its files are about to disappear)
  if (loaded && unitFor(loaded.engine)?.pack === unit.pack) await queue.run(() => disposeLoaded());
  const store = storeFor(unit);
  if (unit.pack === 'piper') {
    // only this voice's files; the shared phonemizer data stays
    for (const f of unit.files) if (!f.path.startsWith('piper/')) await store.remove(f.path).catch(() => {});
  } else await store.clear();
  emit({ ev: 'deleted', unit: unit.id });
  return { ok: true };
}

export function startOffscreenRuntime(): void {
  browser.runtime.onMessage.addListener((raw: unknown, _sender: unknown, sendResponse: (r: unknown) => void) => {
    const msg = raw as LttsRequest | undefined;
    if (!msg || msg.type !== LTTS_MSG || msg.to !== 'offscreen') return false;
    touch();
    const reply = (p: Promise<unknown>): true => {
      void p.then(sendResponse, (e) => sendResponse({ ok: false, error: String((e as Error)?.message ?? e) }));
      return true;
    };
    switch (msg.op) {
      case 'status':
        return reply(hasWebGpu().then((gpu) => {
          emit({ ev: 'gpu', gpu });
          return { ok: true, gpu };
        }));
      case 'download':
        void startDownload(msg.engine ?? DEFAULT_ENGINE, msg.voice, msg.baseUrl);
        sendResponse({ ok: true });
        return false;
      case 'download-cancel': {
        const u = unitFor(msg.engine ?? DEFAULT_ENGINE, msg.voice);
        if (u) downloads.get(u.id)?.abort();
        sendResponse({ ok: true });
        return false;
      }
      case 'delete':
        return reply(deleteUnit(msg.engine ?? DEFAULT_ENGINE, msg.voice));
      case 'warm': {
        const engine = msg.engine ?? DEFAULT_ENGINE;
        return reply(queue.run(async () => {
          const w = await ensureWarm(engine, msg.voice);
          return { ok: true, did: w.loadMs !== undefined || w.warmMs !== undefined, loadMs: w.loadMs ?? 0, loadBytes: w.loadBytes ?? 0, warmMs: w.warmMs ?? 0 } satisfies LttsReply<WarmReplyData>;
        }));
      }
      case 'synth':
        return reply(synth(msg));
      case 'abort':
        aborts.get(msg.id)?.abort();
        sendResponse({ ok: true });
        return false;
      case 'selftest':
        return reply(selftest());
      default:
        return false;
    }
  });
  touch();
}
