/**
 * Piper (rhasspy/piper, VITS) Russian voices ru_RU medium, run in the offscreen document with onnxruntime-web (WASM) and the
 * piper-phonemize WASM build (espeak-ng) for phonemes. Voices pinned to one rhasspy/piper-voices commit; sizes / sha256 (HF LFS oid
 * or measured for the small json) taken 2026-10-22. Keep dependency-free.
 */
import type { LocalTtsVoiceInfo } from '../types';
import type { ModelFile } from '../supertonic/constants';

export const PIPER_REVISION = '5041a7a49ae5b3a0f30e6837769eb03fdbb231bd';
export const PIPER_VOICES_BASE_URL = `https://huggingface.co/rhasspy/piper-voices/resolve/${PIPER_REVISION}/`;

/** a manifest file that is fetched from an absolute URL (ModelFile.url, when the shared type has it) */
type UrlFile = ModelFile & { url?: string };

export const PIPER_VOICES: LocalTtsVoiceInfo[] = [
  { id: 'dmitri', label: 'Дмитрий (муж.)', gender: 'm' },
  { id: 'denis', label: 'Денис (муж.)', gender: 'm' },
  { id: 'ruslan', label: 'Руслан (муж.)', gender: 'm' },
  { id: 'irina', label: 'Ирина (жен.)', gender: 'f' },
];
export const PIPER_DEFAULT_VOICE = 'dmitri';

/** vendored in the extension (public/piper/): the phonemizer glue + wasm; the data pack below is the only runtime download of it */
export const PIPER_PHONEMIZE_JS = 'piper/piper_phonemize.js';
export const PIPER_PHONEMIZE_WASM = 'piper/piper_phonemize.wasm';
/** manifest path of the espeak-ng data pack (Emscripten .data, all languages) */
export const PIPER_PHONEMIZE_DATA = 'piper/piper_phonemize.data';

/** shared by every voice: espeak-ng-data (npm @diffusionstudio/piper-wasm@1.0.0, served by jsDelivr at that exact version) */
const COMMON: UrlFile[] = [
  {
    path: PIPER_PHONEMIZE_DATA,
    size: 18077249,
    sha256: '29f1025eb23a5b5c192cd14a6efbce4509402ff265405072ee6f7d1a09b78f8c',
    url: 'https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize.data',
  },
];
export const PIPER_COMMON_FILES: readonly ModelFile[] = COMMON;

interface VoiceSpec {
  onnxSize: number;
  onnxSha: string;
  jsonSize: number;
  jsonSha: string;
}

const SPECS: Record<string, VoiceSpec> = {
  denis: {
    onnxSize: 63201294,
    onnxSha: '15fab56e11a097858ee115545d0f697fc2a316c41a291a5362349fb870411b0a',
    jsonSize: 4823,
    jsonSha: '831c860dac0b5073eaa81610a0a638ec23d90a6cf8e5f871b4485c2cec3767c8',
  },
  dmitri: {
    onnxSize: 63201294,
    onnxSha: 'f073356ebc4bd0f80c5af58df2953a5988bd5bdab1eb38635ce960b071fbefcb',
    jsonSize: 4824,
    jsonSha: '667ef3117bc642c2892dff7690d8bdc8ca4228aeaa783b2dc1416df632855e0d',
  },
  irina: {
    onnxSize: 63201294,
    onnxSha: '8ff38212d23da300bbe3705c645e6e5b9475f0bfde01558eb17813e22acaaaaa',
    jsonSize: 4765,
    jsonSha: 'c2ec28bb38e2b59e93b959b3e40348c1afebbd272f30fed5d41205d08e98a9d7',
  },
  ruslan: {
    onnxSize: 63201294,
    onnxSha: '72a5f88e0b20928064eb45d88e1daa21f8af62d18613580d32cbb4aed48dcf7f',
    jsonSize: 4882,
    jsonSha: '706a4fb17bc304abd07809b552deae615e64dcbffbfbd09854ba37ca59e88117',
  },
};

/** manifest path of a voice's model / config (repo path, so one OPFS name each) */
export function piperModelPath(voice: string): string {
  return `ru/ru_RU/${voice}/medium/ru_RU-${voice}-medium.onnx`;
}
export function piperConfigPath(voice: string): string {
  return `${piperModelPath(voice)}.json`;
}

/** the downloadable unit of one voice: onnx + config json (throws on an unknown voice) */
export function piperVoiceFiles(voice: string): readonly ModelFile[] {
  const s = SPECS[voice];
  if (!s) throw new Error(`Unknown Piper voice: ${voice}`);
  const model = piperModelPath(voice);
  const config = piperConfigPath(voice);
  const files: UrlFile[] = [
    { path: model, size: s.onnxSize, sha256: s.onnxSha, url: `${PIPER_VOICES_BASE_URL}${model}` },
    { path: config, size: s.jsonSize, sha256: s.jsonSha, url: `${PIPER_VOICES_BASE_URL}${config}` },
  ];
  return files;
}

/** model native rate of every ru_RU medium voice */
export const PIPER_SAMPLE_RATE = 22050;

/** sentence/comma chunk limit (chars) fed to the phonemizer + model */
export const PIPER_MAX_CHUNK_CHARS = 200;
/** silence between chunks of one request (seconds) */
export const PIPER_CHUNK_GAP_SEC = 0.2;
/** speed = 1 / length_scale; clamp for duration fitting */
export const PIPER_SPEED_MIN = 0.8;
export const PIPER_SPEED_MAX = 1.6;
/** a result missing targetSec by more than this fraction triggers the (single) corrective pass */
export const PIPER_FIT_TOLERANCE = 0.08;
/** Russian speech rate at length_scale 1 for the first-pass estimate (chars of text per second; measured on the 4 voices) */
export const PIPER_CHARS_PER_SEC = 19;
/** default VITS scales from the voice json: noise_scale / noise_w (length_scale is set per pass) */
export const PIPER_NOISE_SCALE = 0.667;
export const PIPER_NOISE_W = 0.8;
