/**
 * Message protocol for the in-browser Supertonic engine.
 *   page / content script / options page --(to:'bg')--> service worker --(to:'offscreen')--> offscreen document
 * The worker creates the offscreen document on demand and persists LttsState in chrome.storage.local (the offscreen
 * document has no storage API: it reports through 'event' messages). Audio travels as base64 Int16 PCM.
 */
import type { LocalTtsEngineId } from '../types';

export const LTTS_MSG = 'nvt-ltts';
/** chrome.storage.local key of LttsState */
export const LTTS_STATE_KEY = 'nvt.localtts.supertonic';
export const SUPERTONIC_ENGINE_ID = 'supertonic-webgpu' as const satisfies LocalTtsEngineId;
/** chrome.storage.local key of LttsEnv (capabilities of the browser, shared by all engines) */
export const LTTS_ENV_KEY = 'nvt.localtts.env';
/** chrome.storage.local key of the LttsState of a download unit ('supertonic' keeps the pre-multi-engine key) */
export const unitStateKey = (unitId: string): string => (unitId === 'supertonic' ? LTTS_STATE_KEY : `nvt.localtts.u.${unitId}`);

export interface LttsEnv {
  /** WebGPU adapter available in the extension context; undefined = not probed yet */
  gpu?: boolean;
  /** chrome.offscreen exists */
  offscreen?: boolean;
}

export type ModelPhase = 'none' | 'downloading' | 'ready' | 'error';

export interface LttsState {
  model: ModelPhase;
  /** download progress (bytes) while downloading; total bytes always */
  loaded: number;
  total: number;
  /** revision of the files on disk / being downloaded */
  rev: string;
  /** WebGPU adapter available in the extension context; undefined = not probed yet */
  gpu?: boolean;
  /** chrome.offscreen exists */
  offscreen?: boolean;
  error?: string;
  updatedAt: number;
}

export const initialState = (total: number, rev: string): LttsState => ({ model: 'none', loaded: 0, total, rev, updatedAt: 0 });

// ---- requests (content/options -> bg; bg forwards the same op to the offscreen document with to:'offscreen') ----
export type LttsOp =
  | { op: 'status'; probe?: boolean }
  /** engine absent = 'supertonic-webgpu'; baseUrl overrides the unit's base URL (tests / mirrors) */
  | { op: 'download'; engine?: LocalTtsEngineId; voice?: string; baseUrl?: string }
  | { op: 'download-cancel'; engine?: LocalTtsEngineId; voice?: string }
  | { op: 'delete'; engine?: LocalTtsEngineId; voice?: string }
  /** offscreen only: stop downloads, release the engine, wipe every nvt-* OPFS pack; replies { freedBytes } */
  | { op: 'clear-all' }
  | { op: 'warm'; engine?: LocalTtsEngineId; voice?: string }
  | { op: 'synth'; id: string; text: string; engine?: LocalTtsEngineId; voice?: string; targetSec?: number; steps?: number }
  | { op: 'abort'; id: string }
  | { op: 'selftest' };

export type LttsRequest = LttsOp & { type: typeof LTTS_MSG; to: 'bg' | 'offscreen' };

/** offscreen -> bg notifications (no reply expected) */
export type LttsEvent =
  | { type: typeof LTTS_MSG; to: 'bg'; op: 'event'; unit?: string; ev: 'progress'; loaded: number; total: number }
  | { type: typeof LTTS_MSG; to: 'bg'; op: 'event'; unit?: string; ev: 'downloaded'; bytes: number; fetchedBytes: number; ms: number }
  | { type: typeof LTTS_MSG; to: 'bg'; op: 'event'; unit?: string; ev: 'error'; message: string; missing?: boolean }
  | { type: typeof LTTS_MSG; to: 'bg'; op: 'event'; ev: 'gpu'; gpu: boolean }
  | { type: typeof LTTS_MSG; to: 'bg'; op: 'event'; unit?: string; ev: 'deleted' }
  | { type: typeof LTTS_MSG; to: 'bg'; op: 'event'; ev: 'idle-close' };

export type LttsReply<T = object> = ({ ok: true } & T) | { ok: false; error: string };

export interface SynthReplyData {
  sampleRate: number;
  pcmB64: string;
  durationSec: number;
  /** compute time inside the offscreen document (ms), model load excluded */
  ms: number;
  chars: number;
  speed: number;
  passes: number;
  /** present when this request had to load the model / run the warm-up first */
  loadMs?: number;
  loadBytes?: number;
  warmMs?: number;
  /** per-stage compute time (ms) summed over the request, when the backend measures it */
  stages?: Record<string, number>;
  /** time the request waited in the offscreen queue before its turn (ms): separates backlog from slow compute */
  queueMs?: number;
  engine?: LocalTtsEngineId;
}

export interface WarmReplyData {
  loadMs: number;
  loadBytes: number;
  warmMs: number;
  /** false when the session was already warm (no work done) */
  did: boolean;
}

export interface SelfTestReplyData {
  loadMs: number;
  warmMs: number;
  runs: Array<{ chars: number; sec: number; ms: number; rtf: number; speed: number }>;
}

export const isLttsMessage = (m: unknown): m is LttsRequest =>
  !!m && typeof m === 'object' && (m as { type?: unknown }).type === LTTS_MSG && typeof (m as { op?: unknown }).op === 'string';
