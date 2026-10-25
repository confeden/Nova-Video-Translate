/**
 * Message protocol of the in-extension Whisper engine (same relay as local TTS):
 *   content script / options page --(to:'bg')--> service worker --(to:'offscreen')--> offscreen document
 * The worker persists LasrState per model in chrome.storage.local (the offscreen document has no storage API and reports
 * through 'event' messages). Audio travels as base64 Int16 PCM (16 kHz mono).
 */
import type { LttsState } from '../localtts/supertonic/protocol';
import type { LocalAsrSegment } from './types';
import type { WhisperDevice, WhisperDtype } from './whisperModels';

export const LASR_MSG = 'nvt-lasr';
/** chrome.storage.local key of LasrEnv */
export const LASR_ENV_KEY = 'nvt.localasr.env';
export const lasrStateKey = (modelId: string): string => `nvt.localasr.m.${modelId.replace(/[^\w.-]/g, '_')}`;

export interface LasrEnv {
  /** WebGPU adapter available in the extension context; undefined = not probed yet */
  gpu?: boolean;
  /** the adapter has shader-f16 (fp16 weights) */
  f16?: boolean;
  /** chrome.offscreen exists */
  offscreen?: boolean;
}

/** download state of one model + the device/dtype its files were fetched for (the cache holds only those files) */
export interface LasrState extends LttsState {
  device?: WhisperDevice;
  dtype?: WhisperDtype;
  /** WebGPU session creation failed once: this model runs on the CPU (WASM, q8) from now on */
  cpu?: boolean;
  /** when `cpu` was set (ms): the WebGPU session is re-tried after GPU_RETRY_MS, a stale flag must not pin the model to WASM forever */
  cpuAt?: number;
  /** extension version that wrote the `cpu` mark: a mark of another version is stale (the WebGPU stack may have changed) and is cleared */
  cpuVer?: string;
  /** dtypes whose files are complete in the cache (q8 and a GPU dtype can both be there); absent in states written before 0.2.35: then `dtype` */
  files?: Partial<Record<WhisperDtype, boolean>>;
  /** user-clicked GPU upgrade (gpu-mixed files) in progress */
  upgrade?: { loaded: number; total: number };
  /** why the last GPU upgrade failed (download or the WebGPU session): the real message, shown in the panel */
  upgradeError?: string;
}

/** dtypes whose files are cached for a ready model */
export function cachedDtypes(s: LasrState | undefined): WhisperDtype[] {
  if (!s || s.model !== 'ready') return [];
  const out = (['gpu-mixed', 'fp16', 'q8'] as const).filter((d) => s.files?.[d]);
  if (s.dtype && !out.includes(s.dtype)) out.push(s.dtype);
  return out;
}

/** re-test WebGPU for a model remembered as CPU-only after this long */
export const GPU_RETRY_MS = 6 * 3600_000;

export type LasrOp =
  | { op: 'status'; probe?: boolean }
  /** dtype: explicit GPU upgrade (gpu-mixed) of an already downloaded model (omitted = the plan for the current caps) */
  | { op: 'download'; model: string; dtype?: WhisperDtype }
  | { op: 'download-cancel'; model: string }
  | { op: 'delete'; model: string }
  /** offscreen only: stop downloads, release the model, wipe the Cache API; replies { freedBytes } */
  | { op: 'clear-all' }
  /** device/dtype are filled in by the worker from the persisted state */
  | { op: 'transcribe'; id: string; model: string; pcmB64: string; lang?: string; device?: WhisperDevice; dtype?: WhisperDtype; retryGpu?: boolean; cpuAt?: number; cpuVer?: string; extVer?: string }
  | { op: 'abort'; id: string };

export type LasrRequest = LasrOp & { type: typeof LASR_MSG; to: 'bg' | 'offscreen' };

/** offscreen -> bg notifications (no reply expected) */
export type LasrEvent =
  | { type: typeof LASR_MSG; to: 'bg'; op: 'event'; model: string; ev: 'progress'; loaded: number; total: number; upgrade?: boolean }
  | { type: typeof LASR_MSG; to: 'bg'; op: 'event'; model: string; ev: 'downloaded'; device: WhisperDevice; dtype: WhisperDtype; ms: number }
  | { type: typeof LASR_MSG; to: 'bg'; op: 'event'; model: string; ev: 'error'; message: string; missing?: boolean; upgrade?: boolean }
  | { type: typeof LASR_MSG; to: 'bg'; op: 'event'; model: string; ev: 'deleted' }
  | { type: typeof LASR_MSG; to: 'bg'; op: 'event'; model: string; ev: 'fallback'; device: WhisperDevice; dtype: WhisperDtype; reason: string; diag: string; raw?: string; deviceError?: string }
  /** the GPU upgrade downloaded fine but the WebGPU session failed: stay on q8/WASM, show the reason */
  | { type: typeof LASR_MSG; to: 'bg'; op: 'event'; model: string; ev: 'gpu-fail'; message: string; raw?: string; deviceError?: string; diag: string }
  | { type: typeof LASR_MSG; to: 'bg'; op: 'event'; model: string; ev: 'device'; device: WhisperDevice; dtype: WhisperDtype }
  | { type: typeof LASR_MSG; to: 'bg'; op: 'event'; ev: 'gpu'; gpu: boolean; f16: boolean };

export type LasrReply<T = object> = ({ ok: true } & T) | { ok: false; error: string };

export interface TranscribeReplyData {
  segments: LocalAsrSegment[];
  lang?: string;
  /** compute time inside the offscreen document (ms), model load excluded */
  ms: number;
  /** present when this request had to load the model */
  loadMs?: number;
  device: WhisperDevice;
  dtype: WhisperDtype;
  /** time the request waited behind other work in the offscreen queue (ms) */
  queueMs?: number;
  /** diagnostics of the request: PCM level (0..1), raw pipeline text length and head, whether the timestamp-less retry ran */
  pcmRms?: number;
  pcmPeak?: number;
  rawLen?: number;
  rawHead?: string;
  tsRetry?: boolean;
  /** why this device/dtype: requested + GPU caps + whether a WebGPU re-probe ran (for the `local-asr-device` diag line) */
  why?: string;
}

export const isLasrMessage = (m: unknown): m is LasrRequest =>
  !!m && typeof m === 'object' && (m as { type?: unknown }).type === LASR_MSG && typeof (m as { op?: unknown }).op === 'string';
