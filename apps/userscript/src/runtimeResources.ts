/** Pinned executable dependencies, cached by Tampermonkey at installation. Model weights remain opt-in downloads. */
export const RUNTIME_RESOURCES = {
  ortBundle: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort.webgpu.bundle.min.mjs',
  transformersBundle: 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.6/dist/transformers.min.js',
  ortGlue: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort-wasm-simd-threaded.jsep.mjs',
  hfGlue: 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.6/dist/ort-wasm-simd-threaded.jsep.mjs',
  piperJs: 'https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize.js',
};
