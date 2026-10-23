/**
 * Offscreen-document side contract of an in-browser TTS model (one per engine id). Pure types: the ONNX sessions live in
 * apps/extension/utils/localtts/backends/*. The generic runtime (download, OPFS, queue, idle close) drives any backend.
 */
import type { LocalTtsEngineId } from './types';

/** read access to the downloaded model files (paths as in the pack manifest, e.g. 'onnx/tts.json') */
export interface ModelReader {
  read(path: string): Promise<ArrayBuffer>;
}

export interface BackendJob {
  text: string;
  /** a voice id of this engine (already validated by the runtime) */
  voice: string;
  /** desired duration in seconds; backends honour it by speed control when the model supports it */
  targetSec?: number;
  signal?: AbortSignal;
}

export interface BackendOutput {
  samples: Int16Array;
  sampleRate: number;
  /** exact length of `samples` in seconds */
  durationSec: number;
  /** speed factor actually used (1 = natural) */
  speed: number;
  /** model passes (>1 when a corrective pass was needed) */
  passes: number;
  chunks: number;
}

export interface LocalTtsBackend {
  readonly engine: LocalTtsEngineId;
  /** creates the sessions (and anything else needed) from the downloaded files; may be slow */
  load(files: ModelReader): Promise<void>;
  /** one request (arbitrary text length: the backend chunks it); the runtime serialises calls */
  synth(job: BackendJob): Promise<BackendOutput>;
  dispose(): Promise<void>;
}
