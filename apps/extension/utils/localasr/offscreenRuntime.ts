/**
 * Offscreen-document side of the local Whisper ASR (transformers.js 3.7.6: WebGPU, WASM fallback). One loaded pipeline at a
 * time, a single FIFO queue (downloads and transcriptions share it: one model instance, one GPU), auto-unload after idle.
 * Models come from a pinned HF revision. A download is DOWNLOAD-ONLY: it streams the exact files into the Cache API
 * ('transformers-cache', key = HF resolve URL, what transformers.js reads) through the mirror-first fetch and verifies them; no ONNX
 * session is created. Sessions are created lazily at the first transcription (ensurePipe) with a WebGPU -> WASM/q8 retry.
 * Transcription never uses the network (allowRemoteModels = false), except the one-off fetch of the q8 files before a CPU retry.
 * The library is imported lazily so the local-TTS path never pays for it.
 */
import {
  LASR_MSG,
  SerialQueue,
  b64ToInt16,
  rmsInt16,
  pcmStats,
  isEmptyWhisperOutput,
  SILENCE_RMS,
  createResilientFetch,
  createSessionWithFallback,
  deviceForDtype,
  describeError,
  detectWhisperLanguage,
  downloadWhisperFiles,
  verifyWhisperFiles,
  WHISPER_CACHE_NAME,
  whisperModelInfo,
  whisperToSegments,
  planDtype,
  GPU_DTYPE_ORDER,
  transformersDtype,
  rawDetail,
  type DetectPipe,
  type ErrorContext,
  type LasrEvent,
  type LasrReply,
  type LasrRequest,
  type TranscribeReplyData,
  type WhisperDevice,
  type WhisperDtype,
  type WhisperStage,
} from '@nvt/core';
import { browser } from 'wxt/browser';
import { hasWebGpu } from '../localtts/ortModel';
import { touch } from '../localtts/offscreenRuntime';

type Pipe = ((audio: Float32Array, o: Record<string, unknown>) => Promise<{ text?: string; chunks?: Array<{ text?: string; timestamp?: [number | null, number | null] | null }> }>) & { dispose?: () => Promise<void>; processor?: DetectPipe['processor']; model?: DetectPipe['model'] };
type Transformers = typeof import('@huggingface/transformers');

/** the loaded model is released after this much idle time (the files stay cached; reloading takes seconds) */
const MODEL_IDLE_MS = 3 * 60_000;
const CACHE_NAME = WHISPER_CACHE_NAME;
/** the page's own fetch, captured before anything can patch it; downloads wrap it mirror-first (S3) with huggingface.co as fallback */
const rawFetch: typeof fetch = globalThis.fetch.bind(globalThis);
const downloadFetch = (): typeof fetch => createResilientFetch(rawFetch, { onRetry: (i) => console.warn(`[nvt-asr] ${i.file} ${i.source} try ${i.attempt}: ${i.error}`) });
/** models whose WebGPU session failed once: they run on WASM/q8 until the offscreen document is recreated (the worker persists it too) */
const cpuModels = new Set<string>();
/** models whose WebGPU was re-tested in this offscreen document (once per document life) */
const gpuProbed = new Set<string>();

const queue = new SerialQueue();
const aborts = new Map<string, AbortController>();
const downloads = new Map<string, { cancelled: boolean }>();

interface Loaded {
  model: string;
  device: WhisperDevice;
  dtype: WhisperDtype;
  pipe: Pipe;
}
let loaded: Loaded | undefined;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let tfPromise: Promise<Transformers> | undefined;

type EventBody = LasrEvent extends infer E ? (E extends LasrEvent ? Omit<E, 'type' | 'to' | 'op'> : never) : never;
const emit = (e: EventBody): void => {
  void browser.runtime.sendMessage({ type: LASR_MSG, to: 'bg', op: 'event', ...e }).catch(() => {});
};

interface GpuAdapterLike {
  features: { has(f: string): boolean };
  info?: { vendor?: string; architecture?: string; device?: string };
  requestAdapterInfo?: () => Promise<{ vendor?: string; architecture?: string; device?: string }>;
  requestDevice(d?: Record<string, unknown>): Promise<{ destroy?: () => void }>;
}
interface GpuCaps {
  gpu: boolean;
  f16: boolean;
  /** 'vendor/architecture' of the adapter when the browser exposes it */
  adapter?: string;
}

async function webGpuCaps(): Promise<GpuCaps> {
  if (!(await hasWebGpu())) return { gpu: false, f16: false };
  try {
    const gpu = (navigator as unknown as { gpu: { requestAdapter(): Promise<GpuAdapterLike | null> } }).gpu;
    const a = await gpu.requestAdapter();
    let info = a?.info;
    if (!info && a?.requestAdapterInfo) info = await a.requestAdapterInfo().catch(() => undefined);
    const adapter = info ? [info.vendor, info.architecture || info.device].filter(Boolean).join('/') || undefined : undefined;
    return { gpu: true, f16: !!a?.features.has('shader-f16'), adapter };
  } catch {
    return { gpu: true, f16: false };
  }
}

/** direct GPUAdapter.requestDevice() with the features ORT asks for: a failure here has a readable message (ORT itself throws a bare number). Once per document. */
let deviceProbe: Promise<string | undefined> | undefined;
function probeGpuDevice(f16: boolean): Promise<string | undefined> {
  deviceProbe ??= (async () => {
    try {
      const gpu = (navigator as unknown as { gpu: { requestAdapter(): Promise<GpuAdapterLike | null> } }).gpu;
      const a = await gpu.requestAdapter();
      if (!a) return 'requestAdapter returned null';
      const d = await a.requestDevice(f16 ? { requiredFeatures: ['shader-f16'] } : {});
      d.destroy?.();
      return undefined;
    } catch (e) {
      return rawDetail(e);
    }
  })();
  return deviceProbe;
}

/** context for error text: stage, model, device/dtype, navigator.deviceMemory and the GPU caps */
async function errCtx(stage: WhisperStage, model?: string, device?: WhisperDevice, dtype?: WhisperDtype): Promise<ErrorContext> {
  const caps = await webGpuCaps().catch(() => ({ gpu: false, f16: false }));
  const deviceMemory = (navigator as unknown as { deviceMemory?: number }).deviceMemory;
  return { stage, model, device, dtype, gpu: caps.gpu, f16: caps.f16, ...(deviceMemory !== undefined ? { deviceMemory } : {}) };
}

/** a message for the panel / reply: never a bare number; session errors are already normalised */
const readable = (e: unknown, ctx: ErrorContext): string => {
  const m = e instanceof Error ? e.message : '';
  return m === 'model files missing' || m.includes('(stage: ') ? m : describeError(e, ctx);
};

function transformers(): Promise<Transformers> {
  tfPromise ??= import('@huggingface/transformers').then((tf) => {
    // transcription reads ONLY the Cache API: remote is off. allowLocalModels must stay true, otherwise getModelFile throws
    // "both local and remote models are disabled" before it even looks into the cache (transformers.js 3.7.6 utils/hub.js).
    tf.env.allowLocalModels = true;
    tf.env.allowRemoteModels = false;
    tf.env.localModelPath = browser.runtime.getURL('/nvt-no-local-models/' as never);
    tf.env.useBrowserCache = true;
    // the ONNX runtime glue + wasm shipped with the library are copied into the extension (wxt.config.ts): no CDN code
    const base = browser.runtime.getURL('/ort-hf/' as never);
    (tf.env.backends.onnx as unknown as { wasm: { wasmPaths: unknown } }).wasm.wasmPaths = { mjs: `${base}ort-wasm-simd-threaded.jsep.mjs`, wasm: `${base}ort-wasm-simd-threaded.jsep.wasm` };
    return tf;
  });
  tfPromise.catch(() => (tfPromise = undefined));
  return tfPromise;
}

function armIdle(): void {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (queue.size > 0 || downloads.size > 0) return armIdle();
    void queue.run(() => disposeLoaded());
  }, MODEL_IDLE_MS);
}

/** fully releases the loaded pipeline (ORT sessions + their GPU/WASM buffers) */
async function disposeLoaded(): Promise<void> {
  const cur = loaded;
  loaded = undefined;
  await cur?.pipe.dispose?.().catch(() => {});
}

/** builds a pipeline from the cached files (no network) */
async function buildPipe(model: string, device: WhisperDevice, dtype: WhisperDtype): Promise<Pipe> {
  const info = whisperModelInfo(model);
  if (!info) throw new Error(`unknown model ${model}`);
  const tf = await transformers();
  const pipe = await tf.pipeline('automatic-speech-recognition', model, { device, dtype: transformersDtype(dtype), revision: info.revision } as never);
  return pipe as unknown as Pipe;
}

const cacheOf = (): Promise<Cache> => caches.open(CACHE_NAME);

/** WebGPU dtypes (GPU_DTYPE_ORDER) whose files are complete in the cache */
async function cachedGpuDtypes(info: { id: string; revision: string }, cache: Cache): Promise<WhisperDtype[]> {
  const out: WhisperDtype[] = [];
  for (const d of GPU_DTYPE_ORDER) if ((await verifyWhisperFiles(cache, info, d).catch(() => ({ ok: false }))).ok) out.push(d);
  return out;
}

/**
 * Lazily creates (once) the pipeline for a model; a different model / device / dtype replaces it (the old one is fully
 * disposed first). A WebGPU failure retries on WASM/q8 and is remembered. Must run inside the queue.
 */
async function ensurePipe(model: string, device: WhisperDevice, dtype: WhisperDtype): Promise<{ l: Loaded; loadMs?: number }> {
  const info = whisperModelInfo(model)!;
  // q8 files only run on WASM: asking webgpu for them is a planning slip, not a GPU failure (no fallback, nothing logged)
  const plan = cpuModels.has(model) || dtype === 'q8' ? { device: 'wasm' as const, dtype: 'q8' as const } : { device: deviceForDtype(dtype), dtype };
  if (loaded && loaded.model === model && loaded.device === plan.device && loaded.dtype === plan.dtype) return { l: loaded };
  await disposeLoaded();
  const t0 = performance.now();
  const cache = await cacheOf();
  // the files are gone from the cache (browser cleared site data): tell the worker so the panel offers a new download
  if (!(await verifyWhisperFiles(cache, info, plan.dtype)).ok) {
    emit({ model, ev: 'error', message: 'файлы модели не найдены (кэш браузера очищен?)', missing: true });
    throw new Error('model files missing');
  }
  const ctx = await errCtx('session-create', model, plan.device, plan.dtype);
  const r = await createSessionWithFallback<Pipe>({
    model,
    plan,
    caps: { deviceMemory: ctx.deviceMemory, gpu: ctx.gpu, f16: ctx.f16 },
    factory: (d, t) => buildPipe(model, d, t),
    // pure fp16 is attempted only when its files are already cached (no download without a click)
    gpuAlternatives: plan.device === 'webgpu' ? await cachedGpuDtypes(info, cache) : [],
    ensureFiles: async (t) => {
      await downloadWhisperFiles({ info, dtype: t, fetch: downloadFetch(), cache });
      const v = await verifyWhisperFiles(cache, info, t);
      if (!v.ok) throw new Error(`files incomplete: ${[...v.missing, ...v.bad].join(', ')}`);
    },
    reset: async () => {
      await disposeLoaded();
      await new Promise((res) => setTimeout(res, 100)); // let ORT release the failed session's buffers
    },
  });
  if (r.fellBack) {
    cpuModels.add(model);
    console.warn(`[nvt-asr] ${model}: WebGPU session failed, running on WASM/q8: ${r.firstError}`);
    const deviceError = await probeGpuDevice(!!ctx.f16).catch(() => undefined);
    emit({ model, ev: 'fallback', device: r.device, dtype: r.dtype, reason: r.firstError ?? '', raw: r.firstRaw, deviceError, diag: `deviceMemory=${ctx.deviceMemory ?? '?'} gpu=${ctx.gpu ? 1 : 0} f16=${ctx.f16 ? 1 : 0}` });
  }
  loaded = { model, device: r.device, dtype: r.dtype, pipe: r.value };
  return { l: loaded, loadMs: Math.round(performance.now() - t0) };
}

/** download-only: streams the files into the cache transformers.js reads, verifies them, creates NO session */
async function startDownload(model: string, want?: WhisperDtype): Promise<void> {
  const info = whisperModelInfo(model);
  if (!info) return emit({ model, ev: 'error', message: 'неизвестная модель' });
  if (downloads.has(model)) return;
  const job = { cancelled: false };
  downloads.set(model, job);
  const t0 = Date.now();
  let plan: { device: WhisperDevice; dtype: WhisperDtype } | undefined;
  try {
    await navigator.storage.persist?.().catch(() => false);
    await queue.run(async () => {
      if (job.cancelled) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
      const caps = await webGpuCaps();
      emit({ ev: 'gpu', gpu: caps.gpu, f16: caps.f16 });
      const upgrade = want === 'gpu-mixed';
      if (upgrade && !(caps.gpu && caps.f16)) throw new Error(`видеокарта сейчас недоступна (WebGPU ${caps.gpu ? 'есть, но без shader-f16' : 'нет'})`);
      const p = (plan = upgrade ? { device: 'webgpu' as const, dtype: 'gpu-mixed' as const } : planDtype(caps));
      const est = info.bytes[p.dtype];
      emit({ model, ev: 'progress', loaded: 0, total: est, ...(upgrade ? { upgrade } : {}) });
      const cache = await cacheOf();
      let lastEmit = 0;
      const results = await downloadWhisperFiles({
        info,
        dtype: p.dtype,
        fetch: downloadFetch(),
        cache,
        isCancelled: () => job.cancelled,
        onProgress: (l, total) => {
          touch();
          const now = Date.now();
          if (now - lastEmit < 250) return;
          lastEmit = now;
          const t = Math.max(total, est);
          emit({ model, ev: 'progress', loaded: Math.min(l, t), total: t, ...(upgrade ? { upgrade } : {}) });
        },
      });
      if (job.cancelled) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
      const expected = Object.fromEntries(results.filter((r) => r.present).map((r) => [r.file, r.bytes]));
      const v = await verifyWhisperFiles(cache, info, p.dtype, expected);
      if (!v.ok) throw new Error(`files incomplete: ${[...v.missing, ...v.bad].join(', ')}`);
      if (upgrade) {
        // verify the GPU session now (the user waits for the answer): success -> gpu-mixed/WebGPU becomes the active plan, failure ->
        // the files stay cached, q8/WASM keeps serving and the real WebGPU error is shown in the panel
        await disposeLoaded();
        try {
          const pipe = await buildPipe(model, 'webgpu', 'gpu-mixed');
          loaded = { model, device: 'webgpu', dtype: 'gpu-mixed', pipe };
          cpuModels.delete(model);
        } catch (e) {
          await disposeLoaded();
          await new Promise((res) => setTimeout(res, 100));
          const ctx = await errCtx('session-create', model, 'webgpu', 'gpu-mixed');
          const message = describeError(e, ctx);
          const deviceError = await probeGpuDevice(!!ctx.f16).catch(() => undefined);
          console.warn(`[nvt-asr] ${model}: gpu-mixed WebGPU session failed after upgrade: ${message}`);
          emit({ model, ev: 'gpu-fail', message, raw: rawDetail(e), deviceError, diag: `gpu=${ctx.gpu ? 1 : 0} f16=${ctx.f16 ? 1 : 0} deviceMemory=${ctx.deviceMemory ?? '?'}` });
          return;
        }
      }
      cpuModels.delete(model);
      emit({ model, ev: 'downloaded', device: p.device, dtype: p.dtype, ms: Date.now() - t0 });
    });
  } catch (e) {
    const up = want === 'gpu-mixed' ? { upgrade: true } : {};
    if ((e as Error)?.name === 'AbortError' || job.cancelled) emit({ model, ev: 'error', message: 'скачивание отменено', ...up });
    else emit({ model, ev: 'error', message: readable(e, await errCtx('download', model, plan?.device, plan?.dtype)), ...up });
  } finally {
    downloads.delete(model);
    touch();
    armIdle();
  }
}

async function deleteModel(model: string): Promise<LasrReply<object>> {
  if (!whisperModelInfo(model)) return { ok: false, error: 'unknown model' };
  const job = downloads.get(model);
  if (job) job.cancelled = true;
  await queue.run(async () => {
    if (loaded?.model === model) await disposeLoaded();
    cpuModels.delete(model);
    try {
      const cache = await caches.open(CACHE_NAME);
      for (const r of await cache.keys()) if (r.url.includes(`/${model}/resolve/`)) await cache.delete(r);
    } catch {
      /* nothing cached */
    }
  });
  emit({ model, ev: 'deleted' });
  return { ok: true };
}

/** "Delete all models": stops downloads, releases the model, deletes every cache of this origin (only Whisper files live there) */
async function clearAll(): Promise<LasrReply<{ freedBytes: number }>> {
  for (const j of downloads.values()) j.cancelled = true;
  await queue.run(async () => {
    await disposeLoaded();
    cpuModels.clear();
  });
  let freed = 0;
  for (const name of await caches.keys()) {
    const cache = await caches.open(name);
    for (const r of await cache.keys()) {
      const res = await cache.match(r);
      const len = Number(res?.headers.get('content-length'));
      freed += Number.isFinite(len) && len > 0 ? len : res ? (await res.blob()).size : 0;
    }
    await caches.delete(name);
  }
  return { ok: true, freedBytes: freed };
}

const toFloat32 = (pcm: Int16Array): Float32Array => {
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i]! / 32768;
  return out;
};

async function transcribe(req: Extract<LasrRequest, { op: 'transcribe' }>): Promise<LasrReply<TranscribeReplyData>> {
  const info = whisperModelInfo(req.model);
  if (!info) return { ok: false, error: 'unknown model' };
  if (!req.device || !req.dtype) return { ok: false, error: 'model not downloaded' };
  const { dtype } = req;
  const device = deviceForDtype(dtype); // q8 -> wasm whatever the stored device says
  const ac = new AbortController();
  aborts.set(req.id, ac);
  const tRecv = performance.now();
  try {
    return await queue.run(async (signal) => {
      const queueMs = Math.round(performance.now() - tRecv);
      // a model remembered as WASM/q8 re-tests WebGPU once per offscreen-document life (= once per extension version and per
      // document start); every decision is explained in `why` (diag local-asr-device): caps, adapter, stored mark age/version.
      let useDevice = device;
      let useDtype = dtype;
      let why = `requested=${device}/${dtype} ext=${req.extVer ?? '?'}`;
      if (device === 'wasm') {
        const caps = await webGpuCaps().catch((): GpuCaps => ({ gpu: false, f16: false }));
        why += ` gpu=${caps.gpu ? 1 : 0} f16=${caps.f16 ? 1 : 0} adapter=${caps.adapter ?? '?'}`;
        why += req.cpuAt ? ` cpuMark=${Math.round((Date.now() - req.cpuAt) / 60000)}min/${req.cpuVer ?? '?'}` : req.cpuVer ? ` cpuMark=stale(${req.cpuVer})` : ' cpuMark=none';
        if (req.retryGpu && !gpuProbed.has(req.model)) {
          gpuProbed.add(req.model);
          const p = planDtype(caps);
          if (p.device === 'webgpu') {
            try {
              // D31: never download without a user click. No GPU dtype in the cache -> stay on the cached WASM/q8 files.
              const cache = await cacheOf();
              const have = await cachedGpuDtypes(info, cache);
              if (have.length > 0) {
                cpuModels.delete(req.model);
                useDevice = p.device;
                useDtype = have[0]!;
                why += ` reprobe=${p.device}/${useDtype}`;
              } else why += ` reprobe=${p.dtype}-not-cached(kept ${device}/${dtype}, no download without a click)`;
            } catch (e) {
              why += ` reprobe=verify-failed:${String((e as Error)?.message ?? e).slice(0, 60)}`;
            }
          } else why += ' reprobe=no-webgpu';
        } else why += gpuProbed.has(req.model) ? ' reprobe=done' : ' reprobe=off';
        if (cpuModels.has(req.model)) why += ' cpuModels';
      }
      const { l, loadMs } = await ensurePipe(req.model, useDevice, useDtype);
      if (l.device !== device || l.dtype !== dtype) {
        if (l.device === 'webgpu') emit({ model: req.model, ev: 'device', device: l.device, dtype: l.dtype });
        if (l.device !== useDevice) why += ' webgpu-failed->wasm';
      }
      armIdle();
      const pcm = b64ToInt16(req.pcmB64);
      if (pcm.length === 0) return { ok: true as const, segments: [], ms: 0, loadMs, device: l.device, dtype: l.dtype, queueMs, why }; // warm-up request
      const st = pcmStats(pcm);
      if (st.rms < SILENCE_RMS) return { ok: true as const, segments: [], ms: 0, loadMs, device: l.device, dtype: l.dtype, queueMs, why, lang: info.multilingual ? undefined : 'en', pcmRms: st.rms, pcmPeak: st.peak };
      if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      const t0 = performance.now();
      // no timestamps by default: with them the .en decoder returns '' for ~85 % of chunks (see below) and a retry costs a second pass
      const opts: Record<string, unknown> = { return_timestamps: false };
      // chunk_length_s:0 would not help: Whisper always encodes a padded 30 s window, so short chunks cost the same as long ones
      let lang: string | undefined = info.multilingual ? req.lang : 'en';
      const audio = toFloat32(pcm);
      if (info.multilingual) {
        opts.task = 'transcribe';
        // transformers.js does not detect the language (it silently assumes English): ask the decoder for the language token
        if (!lang && l.pipe.processor && l.pipe.model) {
          try {
            lang = await detectWhisperLanguage({ processor: l.pipe.processor, model: l.pipe.model }, audio);
          } catch (e) {
            console.warn('[nvt-asr] language detection failed:', e);
          }
        }
        if (lang) opts.language = lang;
      }
      let out = await l.pipe(audio, opts);
      // transformers.js 3.7.6 + whisper-base/small.en: with return_timestamps the decoder very often ends right after the
      // first token and the pipeline returns '' for clearly spoken audio (measured 2026-10-25: ~85 % of 15 s Twitch chunks,
      // WASM q8 / fp32 and WebGPU alike). The same audio decoded without timestamps is transcribed fine, so an empty
      // answer is retried once that way (the text is then spread over the clip by whisperToSegments).
      let tsRetry = false;
      if (opts.return_timestamps !== false && isEmptyWhisperOutput(out)) {
        tsRetry = true;
        out = await l.pipe(audio, { ...opts, return_timestamps: false });
      }
      const segments = whisperToSegments(out, pcm.length / 16000, pcm);
      const rawText = (out?.text ?? '').trim();
      return {
        ok: true as const,
        segments,
        lang,
        ms: Math.round(performance.now() - t0),
        loadMs,
        device: l.device,
        dtype: l.dtype,
        queueMs,
        why,
        pcmRms: st.rms,
        pcmPeak: st.peak,
        rawLen: rawText.length,
        rawHead: rawText.slice(0, 60),
        tsRetry,
      };
    }, ac.signal);
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') return { ok: false, error: 'aborted' };
    return { ok: false, error: readable(e, await errCtx('transcribe', req.model, device, dtype)) };
  } finally {
    aborts.delete(req.id);
  }
}

export function startLocalAsrRuntime(): void {
  browser.runtime.onMessage.addListener((raw: unknown, _sender: unknown, sendResponse: (r: unknown) => void) => {
    const msg = raw as LasrRequest | undefined;
    if (!msg || msg.type !== LASR_MSG || msg.to !== 'offscreen') return false;
    touch();
    const reply = (p: Promise<unknown>): true => {
      void p.then(sendResponse, (e) => sendResponse({ ok: false, error: describeError(e, { stage: 'transcribe' }) }));
      return true;
    };
    switch (msg.op) {
      case 'status':
        return reply(webGpuCaps().then((c) => {
          emit({ ev: 'gpu', gpu: c.gpu, f16: c.f16 });
          return { ok: true, ...c };
        }));
      case 'download':
        void startDownload(msg.model, msg.dtype);
        sendResponse({ ok: true });
        return false;
      case 'download-cancel': {
        const j = downloads.get(msg.model);
        if (j) j.cancelled = true;
        sendResponse({ ok: true });
        return false;
      }
      case 'delete':
        return reply(deleteModel(msg.model));
      case 'clear-all':
        return reply(clearAll());
      case 'transcribe':
        return reply(transcribe(msg));
      case 'abort':
        aborts.get(msg.id)?.abort();
        sendResponse({ ok: true });
        return false;
      default:
        return false;
    }
  });
}
