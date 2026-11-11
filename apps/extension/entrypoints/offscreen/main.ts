import { startLocalAsrRuntime } from '../../utils/localasr/offscreenRuntime';
import { startOffscreenRuntime } from '../../utils/localtts/offscreenRuntime';
import { startPageDevLog } from '../../utils/devlog';
import { browser } from 'wxt/browser';
import { configureLocalRuntimeHost, type LocalRuntimeHost } from '../../utils/localRuntimeHost';

configureLocalRuntimeHost({
  ...browser as unknown as LocalRuntimeHost,
  async loadOrt() {
    const base = browser.runtime.getURL('/ort/' as never);
    const ort = await import(/* @vite-ignore */ `${base}ort.webgpu.bundle.min.mjs`) as typeof import('onnxruntime-web');
    ort.env.wasm.wasmPaths = base;
    ort.env.wasm.numThreads = Math.min(2, Math.max(1, Math.floor((navigator.hardwareConcurrency || 4) / 4)));
    return ort;
  },
  async loadTransformers() {
    const tf = await import('@huggingface/transformers');
    const base = browser.runtime.getURL('/ort-hf/' as never);
    tf.env.backends.onnx.wasm!.wasmPaths = { mjs: `${base}ort-wasm-simd-threaded.jsep.mjs`, wasm: `${base}ort-wasm-simd-threaded.jsep.wasm` };
    return tf;
  },
});
startOffscreenRuntime();
startLocalAsrRuntime();
startPageDevLog('offscreen');
