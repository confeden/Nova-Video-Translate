/**
 * Whisper checkpoints for the in-extension ASR engine (transformers.js, ONNX; onnx-community conversions of OpenAI Whisper,
 * MIT). Revisions are pinned to the HF commit seen on 2026-10-24; sizes are the measured sum of the files transformers.js
 * fetches for the dtype (tokenizer/config + encoder + merged decoder). Keep dependency-free (content script, worker, offscreen).
 */

export type WhisperModelId =
  | 'onnx-community/whisper-tiny.en'
  | 'onnx-community/whisper-base.en'
  | 'onnx-community/whisper-small.en'
  | 'onnx-community/whisper-base'
  | 'onnx-community/whisper-small';

/** the user's choice: 'auto' = best downloaded model for the stream language */
export type LocalAsrModelChoice = 'auto' | WhisperModelId;

/**
 * 'gpu-mixed' = encoder fp32 + merged decoder q4 (transformers.js dtype object, see transformersDtype): the combination that
 * creates a WebGPU session on every tested adapter. Pure 'fp16' fails at session creation on NVIDIA Blackwell (owner 0.2.35 and
 * lab 2026-10-25, ORT error 26624112) and stays only as a later attempt when its files are already cached.
 */
export type WhisperDtype = 'gpu-mixed' | 'fp16' | 'q8';
export type WhisperDevice = 'webgpu' | 'wasm';

export interface WhisperModelInfo {
  id: WhisperModelId;
  label: string;
  /** pinned HF commit */
  revision: string;
  multilingual: boolean;
  /** download size (bytes) per dtype (HF-measured sum of the files transformers.js fetches) */
  bytes: Record<WhisperDtype, number>;
  /** one-line speed/quality note (Russian, shown in the settings panel) */
  note: string;
}

export const WHISPER_MODELS: readonly WhisperModelInfo[] = [
  { id: 'onnx-community/whisper-base.en', label: 'Whisper base (английский)', revision: '51eefc0af78b103839eda9e7e4f4186acc6517fe', multilingual: false, bytes: { 'gpu-mixed': 208_760_882, fp16: 150_291_322, q8: 81_131_503 }, note: 'быстрый, хороший баланс' },
  { id: 'onnx-community/whisper-tiny.en', label: 'Whisper tiny (английский)', revision: '2575352d61be1bf7225cf8f8b268a4678025fc58', multilingual: false, bytes: { 'gpu-mixed': 122_309_681, fp16: 80_345_902, q8: 45_081_321 }, note: 'самый быстрый, больше ошибок' },
  { id: 'onnx-community/whisper-small.en', label: 'Whisper small (английский)', revision: '482fb8ba081b6e906f92efe103622316b2a0cc69', multilingual: false, bytes: { 'gpu-mixed': 588_664_964, fp16: 489_416_794, q8: 253_314_032 }, note: 'точнее, нужна быстрая видеокарта' },
  { id: 'onnx-community/whisper-base', label: 'Whisper base (многоязычный)', revision: '1846881b6b3a3024392c1eea3ad983695bc23925', multilingual: true, bytes: { 'gpu-mixed': 208_840_059, fp16: 150_449_909, q8: 81_284_108 }, note: 'для видео не на английском' },
  { id: 'onnx-community/whisper-small', label: 'Whisper small (многоязычный) — лучше для датского/редких языков', revision: '36050c46d777d46dc4b5f43f6d90574fc38f8732', multilingual: true, bytes: { 'gpu-mixed': 588_744_805, fp16: 487_960_440, q8: 251_846_613 }, note: 'точнее base на не-английской речи, нужна быстрая видеокарта' },
];

export const DEFAULT_WHISPER_MODEL: WhisperModelId = 'onnx-community/whisper-base.en';
/** auto-mode preference among downloaded models for English / unknown-English use: English-only first (faster), then multilingual */
const AUTO_ORDER: readonly WhisperModelId[] = ['onnx-community/whisper-base.en', 'onnx-community/whisper-tiny.en', 'onnx-community/whisper-small.en', 'onnx-community/whisper-base', 'onnx-community/whisper-small'];
const SMALL_EN: WhisperModelId = 'onnx-community/whisper-small.en';
/** auto-mode preference for any non-English or unknown language: multilingual only, the more accurate one first */
const MULTI_ORDER: readonly WhisperModelId[] = ['onnx-community/whisper-small', 'onnx-community/whisper-base'];

export const whisperModelInfo = (id: string | undefined): WhisperModelInfo | undefined => WHISPER_MODELS.find((m) => m.id === id);
export const isWhisperModelId = (v: unknown): v is WhisperModelId => typeof v === 'string' && WHISPER_MODELS.some((m) => m.id === v);

/**
 * the device + dtype a download uses: gpu-mixed on WebGPU when the adapter has shader-f16, else q8 on WASM. q8 (MatMulInteger /
 * DynamicQuantizeLinear) does not run on the WebGPU EP, so q8 is never planned for webgpu. Pass FRESH caps (probe at click time).
 */
export function planDtype(env: { gpu?: boolean; f16?: boolean } | undefined): { device: WhisperDevice; dtype: WhisperDtype } {
  return env?.gpu && env.f16 ? { device: 'webgpu', dtype: 'gpu-mixed' } : { device: 'wasm', dtype: 'q8' };
}

/** WebGPU dtypes in the order a session is attempted; a later one is tried only when its files are already cached (no download without a click) */
export const GPU_DTYPE_ORDER: readonly WhisperDtype[] = ['gpu-mixed', 'fp16'];
export const isGpuDtype = (d: WhisperDtype | undefined): boolean => d === 'gpu-mixed' || d === 'fp16';

/** the `dtype` option of transformers.js pipeline(): gpu-mixed is a per-graph object (fp32 => '' suffix, q4 => '_q4'), the others a plain string */
export function transformersDtype(dtype: WhisperDtype): string | Record<string, string> {
  return dtype === 'gpu-mixed' ? { encoder_model: 'fp32', decoder_model_merged: 'q4' } : dtype;
}

/** q8 files only run on WASM, the GPU dtypes only on WebGPU: a stored/requested pair is normalised so q8 never "fails" on webgpu */
export const deviceForDtype = (dtype: WhisperDtype): WhisperDevice => (dtype === 'q8' ? 'wasm' : 'webgpu');

/** estimated download bytes of a model for the capabilities of this browser */
export const whisperBytes = (m: WhisperModelInfo, env: { gpu?: boolean; f16?: boolean } | undefined): number => m.bytes[planDtype(env).dtype];

/** 'da-DK' -> 'da'; '' / 'auto' / undefined -> undefined */
export function baseLang(lang: string | undefined): string | undefined {
  const l = (lang ?? '').toLowerCase().split(/[-_]/)[0];
  return l && l !== 'auto' ? l : undefined;
}

/**
 * Which downloaded model serves a request. English-only checkpoints transcribe any other language as garbage, so they serve
 * ONLY an English source: for an unknown or foreign language only a multilingual model is used (undefined when none is ready).
 * Explicit choice: only that model, and an English-only choice is refused for a known non-English language.
 */
export function pickWhisperModel(choice: LocalAsrModelChoice, lang: string | undefined, ready: ReadonlySet<string>, gpu?: ReadonlySet<string>): WhisperModelId | undefined {
  const l = baseLang(lang);
  if (choice !== 'auto') {
    if (!ready.has(choice)) return undefined;
    if (l && l !== 'en' && !whisperModelInfo(choice)?.multilingual) return undefined;
    return choice;
  }
  if (l === 'en') {
    // measured 2026-10-25 (Twitch audio): on the GPU small.en costs ~1 s per chunk, on the CPU it is far too slow for live ->
    // small.en leads only when it actually runs on WebGPU (`gpu`); otherwise base.en (q8/WASM) as before
    if (gpu?.has(SMALL_EN) && ready.has(SMALL_EN)) return SMALL_EN;
    return AUTO_ORDER.find((id) => ready.has(id));
  }
  return MULTI_ORDER.find((id) => ready.has(id));
}
