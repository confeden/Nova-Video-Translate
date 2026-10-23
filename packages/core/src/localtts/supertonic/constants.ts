/**
 * Supertonic 3 (supertone-inc/supertonic, HF Supertone/supertonic-3; code MIT, weights OpenRAIL-M).
 * Files are pinned to one HF commit so sizes / sha256 stay valid. Sizes + sha256 measured 2026-10-22 from the HF tree API.
 * Keep dependency-free (shared by the content script, the service worker and the offscreen document).
 */

export const SUPERTONIC_REVISION = '3cadd1ee6394adea1bd021217a0e650ede09a323';
export const SUPERTONIC_BASE_URL = `https://huggingface.co/Supertone/supertonic-3/resolve/${SUPERTONIC_REVISION}/`;

export interface ModelFile {
  /** path inside the repo (also the OPFS file name, '/' -> '__') */
  path: string;
  size: number;
  /** hex sha256 (LFS oid); absent for the small non-LFS files (size check only) */
  sha256?: string;
  /** absolute download URL; absent = pack baseUrl + path */
  url?: string;
}

export const SUPERTONIC_VOICE_IDS = ['M1', 'F1', 'M2', 'M3', 'M4', 'M5', 'F2', 'F3', 'F4', 'F5'] as const;
export const SUPERTONIC_DEFAULT_VOICE = 'M1';

const VOICE_SIZES: Record<string, number> = {
  F1: 292046, F2: 292423, F3: 290794, F4: 291808, F5: 291479,
  M1: 291748, M2: 292055, M3: 290198, M4: 291522, M5: 291469,
};

export const MODEL_FILES: readonly ModelFile[] = [
  { path: 'onnx/tts.json', size: 8253 },
  { path: 'onnx/unicode_indexer.json', size: 277676 },
  { path: 'onnx/duration_predictor.onnx', size: 3700147, sha256: 'c3eb91414d5ff8a7a239b7fe9e34e7e2bf8a8140d8375ffb14718b1c639325db' },
  { path: 'onnx/text_encoder.onnx', size: 36416150, sha256: 'c7befd5ea8c3119769e8a6c1486c4edc6a3bc8365c67621c881bbb774b9902ff' },
  { path: 'onnx/vector_estimator.onnx', size: 256534781, sha256: '883ac868ea0275ef0e991524dc64f16b3c0376efd7c320af6b53f5b780d7c61c' },
  { path: 'onnx/vocoder.onnx', size: 101424195, sha256: '085de76dd8e8d5836d6ca66826601f615939218f90e519f70ee8a36ed2a4c4ba' },
  ...SUPERTONIC_VOICE_IDS.map((v) => ({ path: `voice_styles/${v}.json`, size: VOICE_SIZES[v]! })),
];

export const MODEL_TOTAL_BYTES: number = MODEL_FILES.reduce((a, f) => a + f.size, 0);

/** denoising steps: 8 = reference quality, 5 = faster variant (quality NOT judged yet) */
export const STEPS_DEFAULT = 8;
export const STEPS_FAST = 5;
export const SYNTH_STEPS: number = STEPS_DEFAULT;

/** sentence chunk limit (chars) fed to the model */
export const MAX_CHUNK_CHARS = 220;
/** speed used when the caller gave no targetSec (Supertonic reference default) */
export const DEFAULT_SPEED = 1.0;
/**
 * speed clamp for duration fitting (owner: voices were squeezed too hard at 1.4-1.6): natural 1.0 whenever the text fits,
 * first pass never above 1.2, the corrective pass never above the hard cap 1.3. Overflow is handled by shifting in the layout.
 */
export const SPEED_MIN = 1.0;
export const SPEED_FIRST_MAX = 1.2;
export const SPEED_MAX = 1.3;
/** a result missing targetSec by more than this fraction triggers one more pass */
export const FIT_TOLERANCE = 0.08;
/** silence between chunks of one request (seconds) */
export const CHUNK_GAP_SEC = 0.25;
/** PCM sent to the caller is downsampled to this rate (model native: 44100) */
export const OUTPUT_SAMPLE_RATE = 24000;

/** offscreen document closes itself after this much idle time (ms) */
export const OFFSCREEN_IDLE_MS = 10 * 60_000;

export const WARMUP_TEXT = 'Проверка связи, один два три.';
