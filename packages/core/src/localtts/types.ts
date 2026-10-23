/**
 * Local (free, offline-capable) Russian text-to-speech engines for the 'groq' and 'local' tiers (D30).
 * Implementations: in-browser Supertonic 3 on WebGPU (extension offscreen document), the localhost
 * 'helper' (OmniVoice + faster-whisper), and a CPU fallback (Silero v5 eugene/xenia). Keep dependency-free.
 */

export type LocalTtsEngineId = 'supertonic-webgpu' | 'supertonic-wasm' | 'silero-cpu' | 'piper-wasm' | 'helper-omnivoice';

/** a selectable voice of an engine (UI label is Russian) */
export interface LocalTtsVoiceInfo {
  id: string;
  label: string;
  gender?: 'm' | 'f';
}

export interface LocalTtsRequest {
  /** Russian text of ONE sentence/segment */
  text: string;
  /** engine-specific voice id; absent = the engine's default (male standard) */
  voice?: string;
  /** desired speaking duration (seconds): the engine adjusts speed to hit it when it can; the caller still measures */
  targetSec?: number;
  signal?: AbortSignal;
}

export interface LocalTtsResult {
  sampleRate: number;
  samples: Int16Array;
  durationSec: number;
}

export interface LocalTtsEngine {
  readonly id: LocalTtsEngineId;
  /** cheap readiness check (never downloads models; resolves false when unsupported or busy) */
  isAvailable(): Promise<boolean>;
  /** voice ids this engine offers (first = default) */
  voices(): Promise<string[]>;
  synth(req: LocalTtsRequest): Promise<LocalTtsResult>;
}
