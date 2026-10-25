/**
 * Download-only model fetch + robust session creation for the in-extension Whisper engine (offscreen document).
 *
 * Why: creating ONNX Runtime sessions as a side effect of a download (pipeline() with allowRemoteModels) made the 2nd..4th model
 * download fail with a bare number (a WASM pointer thrown by ORT) as soon as another pipeline had been built before. A download
 * now only moves bytes into the Cache API cache that transformers.js reads; sessions are created lazily at the first
 * transcription. Dependency-free (offscreen document, tests); fetch / Cache / session factory are injected.
 *
 * Cache layout (verified against transformers.js 3.7.6 utils/hub.js getModelFile): cache 'transformers-cache', key = the string
 * remoteHost + remotePathTemplate({model},{revision}) + filename = `https://huggingface.co/<model>/resolve/<rev>/<file>`.
 */
import type { WhisperDevice, WhisperDtype } from './whisperModels';

export const WHISPER_CACHE_NAME = 'transformers-cache';
export const HF_REMOTE_HOST = 'https://huggingface.co/';
const ERR_MAX = 240;

export interface WhisperFile {
  file: string;
  /** transformers.js treats a missing optional file as "{}" (generation_config.json) */
  optional?: boolean;
}

/**
 * ONNX file-name suffixes transformers.js appends for a dtype (DEFAULT_DTYPE_SUFFIX_MAPPING: fp32 '', fp16 '_fp16', q8 '_quantized',
 * q4 '_q4'); gpu-mixed uses a different dtype per graph (encoder fp32, merged decoder q4).
 */
export function dtypeSuffixes(dtype: WhisperDtype): { encoder: string; decoder: string } {
  if (dtype === 'gpu-mixed') return { encoder: '', decoder: '_q4' };
  const s = dtype === 'fp16' ? '_fp16' : '_quantized';
  return { encoder: s, decoder: s };
}

/** exact files pipeline('automatic-speech-recognition', model, {dtype}) reads: config, tokenizer, feature extractor, 2 ONNX graphs */
export function whisperFileList(dtype: WhisperDtype): WhisperFile[] {
  const s = dtypeSuffixes(dtype);
  return [
    { file: 'config.json' },
    { file: 'tokenizer.json' },
    { file: 'tokenizer_config.json' },
    { file: 'preprocessor_config.json' },
    { file: 'generation_config.json', optional: true },
    { file: `onnx/encoder_model${s.encoder}.onnx` },
    { file: `onnx/decoder_model_merged${s.decoder}.onnx` },
  ];
}

/** the Cache API key transformers.js looks a file up under */
export const whisperCacheKey = (model: string, revision: string, file: string): string => `${HF_REMOTE_HOST}${model}/resolve/${encodeURIComponent(revision)}/${file}`;

// ---------------------------------------------------------------- errors

export type WhisperStage = 'session-create' | 'download' | 'transcribe';
export interface ErrorContext {
  stage: WhisperStage;
  model?: string;
  device?: WhisperDevice;
  dtype?: WhisperDtype;
  deviceMemory?: number;
  gpu?: boolean;
  f16?: boolean;
}

/** the "(stage: …, model: …)" tail; also used for the diag line */
export function contextText(c: ErrorContext): string {
  const parts = [`stage: ${c.stage}`];
  if (c.model) parts.push(`model: ${c.model.replace(/^onnx-community\//, '')}`);
  if (c.device) parts.push(`device: ${c.device}`);
  if (c.dtype) parts.push(`dtype: ${c.dtype}`);
  if (c.deviceMemory !== undefined) parts.push(`deviceMemory: ${c.deviceMemory}GB`);
  if (c.gpu !== undefined) parts.push(`gpu: ${c.gpu ? 'yes' : 'no'}${c.gpu ? `, f16: ${c.f16 ? 'yes' : 'no'}` : ''}`);
  return `(${parts.join(', ')})`;
}

/** raw message of anything that can be thrown; '' when nothing readable */
function rawMessage(e: unknown): { text: string; code?: number } {
  if (typeof e === 'number') return { text: '', code: e };
  if (typeof e === 'string') return /^\s*\d+\s*$/.test(e) ? { text: '', code: Number(e) } : { text: e.trim() };
  if (e && typeof e === 'object') {
    const m = (e as { message?: unknown }).message;
    if (typeof m === 'string' && m.trim()) return /^\s*\d+\s*$/.test(m) ? { text: '', code: Number(m) } : { text: m.trim() };
    if (typeof m === 'number') return { text: '', code: m };
    const n = (e as { name?: unknown }).name;
    if (typeof n === 'string' && n && n !== 'Error') return { text: n };
    try {
      const j = JSON.stringify(e);
      if (j && j !== '{}') return { text: j };
    } catch {
      /* circular */
    }
  }
  return { text: '' };
}

/**
 * Turns anything thrown (ORT throws numbers = WASM pointers) into a readable line; never a bare number. Numbers become
 * `ORT error code <N> (stage: …)`, other errors keep their message and get the same context tail.
 */
export function describeError(e: unknown, ctx: ErrorContext): string {
  const { text, code } = rawMessage(e);
  const tail = contextText(ctx);
  const head = code !== undefined ? `ORT error code ${code}` : text || 'unknown error';
  const full = `${head} ${tail}`;
  return full.length > ERR_MAX ? `${head.slice(0, Math.max(20, ERR_MAX - tail.length - 2))}… ${tail}` : full;
}

/** the raw thrown value in a diag-friendly form (type + name + message + a stack head): `describeError` hides a bare ORT number behind a code, this keeps what exists */
export function rawDetail(e: unknown): string {
  if (typeof e === 'number') return `number ${e}`;
  if (typeof e === 'string') return `string ${e.slice(0, 200)}`;
  if (e && typeof e === 'object') {
    const o = e as { name?: unknown; message?: unknown; stack?: unknown };
    const stack = typeof o.stack === 'string' ? o.stack.split('\n').slice(0, 3).join(' | ') : '';
    const msg = typeof o.message === 'number' ? `number ${o.message}` : String(o.message ?? '');
    return `${String(o.name ?? 'object')}: ${msg}${stack ? ` @ ${stack}` : ''}`.slice(0, 400);
  }
  return String(e);
}

// ---------------------------------------------------------------- download

/** the subset of the Cache API used here */
export interface CacheLike {
  match(key: string): Promise<Response | undefined>;
  put(key: string, res: Response): Promise<void>;
}

export interface DownloadFileResult {
  file: string;
  bytes: number;
  /** true when the file was already in the cache and no network was used */
  cached: boolean;
  /** false for an optional file the server does not have */
  present: boolean;
}

export interface WhisperDownloadOptions {
  info: { id: string; revision: string };
  dtype: WhisperDtype;
  /** the mirror-first resilient fetch (createResilientFetch); called with the HF URL */
  fetch: typeof fetch;
  cache: CacheLike;
  /** cumulative bytes received so far and the sum of the known file sizes (grows as headers arrive) */
  onProgress?: (loaded: number, total: number) => void;
  isCancelled?: () => boolean;
  signal?: AbortSignal;
}

const abortError = (): Error => Object.assign(new Error('cancelled'), { name: 'AbortError' });

const sizeOf = async (r: Response): Promise<number> => {
  const len = Number(r.headers.get('content-length') ?? NaN);
  return Number.isFinite(len) && len > 0 ? len : (await r.blob()).size;
};

/**
 * Fetches every file of (model, dtype) into the cache under the key transformers.js reads, streaming with real byte progress.
 * Files that are already cached are skipped (resume at file granularity). No ONNX session is created. Throws AbortError on cancel.
 */
export async function downloadWhisperFiles(o: WhisperDownloadOptions): Promise<DownloadFileResult[]> {
  const out: DownloadFileResult[] = [];
  let loaded = 0;
  let total = 0;
  const cancelled = (): boolean => !!o.isCancelled?.() || !!o.signal?.aborted;
  for (const f of whisperFileList(o.dtype)) {
    if (cancelled()) throw abortError();
    const key = whisperCacheKey(o.info.id, o.info.revision, f.file);
    const have = await o.cache.match(key);
    if (have) {
      const n = await blobSize(have);
      loaded += n;
      total += n;
      out.push({ file: f.file, bytes: n, cached: true, present: true });
      o.onProgress?.(loaded, total);
      continue;
    }
    const res = await o.fetch(key, { signal: o.signal });
    if (res.status === 404 && f.optional) {
      out.push({ file: f.file, bytes: 0, cached: false, present: false });
      continue;
    }
    if (!res.ok || !res.body) throw new Error(`${f.file}: HTTP ${res.status}`);
    const declared = Number(res.headers.get('content-length') ?? 0) || 0;
    total += declared;
    let got = 0;
    const counter = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctl) {
        if (cancelled()) return ctl.error(abortError());
        got += chunk.byteLength;
        loaded += chunk.byteLength;
        if (!declared) total = Math.max(total, loaded);
        o.onProgress?.(loaded, Math.max(total, loaded));
        ctl.enqueue(chunk);
      },
    });
    const headers = new Headers();
    headers.set('content-type', res.headers.get('content-type') ?? 'application/octet-stream');
    if (declared) headers.set('content-length', String(declared));
    await o.cache.put(key, new Response(res.body.pipeThrough(counter), { status: 200, headers }));
    if (cancelled()) throw abortError();
    if (declared && got !== declared) throw new Error(`${f.file}: short body ${got}/${declared}`);
    out.push({ file: f.file, bytes: got, cached: false, present: true });
  }
  return out;
}

const blobSize = async (r: Response): Promise<number> => (await r.clone().blob()).size;

export interface VerifyResult {
  ok: boolean;
  missing: string[];
  /** present but the wrong size / empty */
  bad: string[];
}

/** every required file is in the cache, non-empty and (when `expected` has it) of exactly the expected size */
export async function verifyWhisperFiles(cache: CacheLike, info: { id: string; revision: string }, dtype: WhisperDtype, expected?: Record<string, number>): Promise<VerifyResult> {
  const missing: string[] = [];
  const bad: string[] = [];
  for (const f of whisperFileList(dtype)) {
    const r = await cache.match(whisperCacheKey(info.id, info.revision, f.file)).catch(() => undefined);
    if (!r) {
      if (!f.optional) missing.push(f.file);
      continue;
    }
    const n = await blobSize(r);
    const want = expected?.[f.file];
    if (n <= 0 || (want !== undefined && n !== want)) bad.push(f.file);
  }
  return { ok: missing.length === 0 && bad.length === 0, missing, bad };
}

// ---------------------------------------------------------------- session creation

export interface SessionPlan {
  device: WhisperDevice;
  dtype: WhisperDtype;
}

export interface CreateSessionOptions<T> {
  model: string;
  plan: SessionPlan;
  /** builds the pipeline for a device/dtype; may throw anything (ORT throws numbers) */
  factory: (device: WhisperDevice, dtype: WhisperDtype) => Promise<T>;
  /** makes sure the files of a dtype are cached (used before the q8 WASM retry when the plan was fp16) */
  ensureFiles?: (dtype: WhisperDtype) => Promise<void>;
  /** drops state left by the failed attempt (dispose a half-built pipeline, yield to the event loop) */
  reset?: () => Promise<void>;
  /** further WebGPU dtypes (files already cached) tried in order when the planned one throws, before the WASM/q8 retry */
  gpuAlternatives?: readonly WhisperDtype[];
  /** diagnostics fields for error text */
  caps?: Pick<ErrorContext, 'deviceMemory' | 'gpu' | 'f16'>;
}

export interface CreatedSession<T> extends SessionPlan {
  value: T;
  /** true when WebGPU failed and the WASM/q8 retry was used (false when another WebGPU dtype succeeded: see dtype) */
  fellBack: boolean;
  /** the normalised WebGPU error when fellBack */
  firstError?: string;
  /** the raw thrown value of the WebGPU failure (type / name / message / stack head), see rawDetail */
  firstRaw?: string;
}

/**
 * Creates a session on the planned device; when WebGPU throws (number or Error) it retries once on WASM with q8. When that also
 * fails (or the plan was WASM already) a readable Error is thrown that carries both causes.
 */
export async function createSessionWithFallback<T>(o: CreateSessionOptions<T>): Promise<CreatedSession<T>> {
  const ctx = (device: WhisperDevice, dtype: WhisperDtype): ErrorContext => ({ stage: 'session-create', model: o.model, device, dtype, ...o.caps });
  const { device, dtype } = o.plan;
  try {
    return { value: await o.factory(device, dtype), device, dtype, fellBack: false };
  } catch (e1) {
    const first = describeError(e1, ctx(device, dtype));
    if (device !== 'webgpu') throw new Error(first);
    const tried: string[] = [first];
    for (const alt of o.gpuAlternatives ?? []) {
      if (alt === dtype) continue;
      try {
        await o.reset?.();
        return { value: await o.factory('webgpu', alt), device: 'webgpu', dtype: alt, fellBack: false, firstError: first, firstRaw: rawDetail(e1) };
      } catch (eAlt) {
        tried.push(describeError(eAlt, ctx('webgpu', alt)));
      }
    }
    try {
      await o.reset?.();
      await o.ensureFiles?.('q8');
      return { value: await o.factory('wasm', 'q8'), device: 'wasm', dtype: 'q8', fellBack: true, firstError: first, firstRaw: rawDetail(e1) };
    } catch (e2) {
      await o.reset?.().catch(() => {});
      throw new Error(`${describeError(e2, ctx('wasm', 'q8'))}; ${tried.join('; ')}`.slice(0, ERR_MAX * 2));
    }
  }
}
