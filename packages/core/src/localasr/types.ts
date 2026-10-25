/**
 * Local (on-device or localhost-helper) speech recognition for the 'local' tier (D30) and for any other tier that wants
 * free text from audio. Keep dependency-free; implementations are registered by the apps through `LocalAsrRegistry`.
 */

export type LocalAsrEngineId = 'whisper-webgpu' | 'chrome-prompt-audio' | 'whisper-wasm' | 'helper-faster-whisper';

export interface LocalAsrOptions {
  /** ISO language hint (the engine may ignore it; the Prompt API is English only) */
  lang?: string;
  signal?: AbortSignal;
}

/** One recognised phrase; times in seconds RELATIVE to the start of the audio handed to transcribe() */
export interface LocalAsrSegment {
  start: number;
  end: number;
  text: string;
}

export interface LocalAsrResult {
  segments: LocalAsrSegment[];
  /** ISO code when the engine knows it */
  lang?: string;
  /** `lang` came from the engine's own language detection (no language was passed in) */
  detected?: boolean;
  /** which model / device ran it (diagnostics only) */
  model?: string;
  device?: string;
}

export interface LocalAsr {
  readonly id: LocalAsrEngineId;
  /** cheap readiness check (never downloads models; resolves false when unsupported) */
  isAvailable(): Promise<boolean>;
  /** languages the engine can recognise ('*' = any) */
  languages(): readonly string[];
  /** 16 kHz mono PCM -> timed phrases; [] = no speech */
  transcribe(pcm16k: Int16Array, opts?: LocalAsrOptions): Promise<LocalAsrResult>;
}
