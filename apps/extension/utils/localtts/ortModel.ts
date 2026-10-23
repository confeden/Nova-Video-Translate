import { ttsAbortError, preprocessForModel, textToIds, type TtsModel } from '@nvt/core';
import { browser } from 'wxt/browser';
import type * as OrtNs from 'onnxruntime-web';
import type { ModelReader } from '@nvt/core';

type Ort = typeof OrtNs;

interface Cfg {
  ae: { sample_rate: number; base_chunk_size: number };
  ttl: { chunk_compress_factor: number; latent_dim: number };
}

interface Style {
  ttl: OrtNs.Tensor;
  dp: OrtNs.Tensor;
}

let ortPromise: Promise<Ort> | undefined;

/** onnxruntime-web 1.22 (webgpu bundle) from the extension's own files (copied to ort/ at build; no remote code) */
export function loadOrt(): Promise<Ort> {
  return (ortPromise ??= (async () => {
    const base = browser.runtime.getURL('/ort/' as never);
    const ort = (await import(/* @vite-ignore */ `${base}ort.webgpu.bundle.min.mjs`)) as Ort;
    ort.env.wasm.wasmPaths = base;
    ort.env.wasm.proxy = false;
    // never let Chrome pick a low-power adapter for the TTS (hybrid-GPU laptops); harmless on a single-GPU desktop
    (ort.env as unknown as { webgpu: { powerPreference?: string } }).webgpu.powerPreference = 'high-performance';
    // WASM engines (Silero / Piper / Supertonic CPU) scale with threads; the WebGPU EP only runs tiny CPU ops (measured: no change)
    ort.env.wasm.numThreads = Math.min(4, Math.max(1, Math.floor((navigator.hardwareConcurrency || 4) / 2)));
    return ort;
  })().catch((e) => {
    ortPromise = undefined;
    throw e;
  }));
}

/** true when a WebGPU adapter can be obtained in this context */
export async function hasWebGpu(): Promise<boolean> {
  try {
    const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    return !!gpu && !!(await gpu.requestAdapter());
  } catch {
    return false;
  }
}

/** Supertonic 3 pipeline (duration predictor -> text encoder -> N x vector estimator -> vocoder) on onnxruntime-web WebGPU. */
export class SupertonicOrtModel implements TtsModel {
  private readonly styles = new Map<string, Style>();

  private constructor(
    private readonly ort: Ort,
    private readonly store: ModelReader,
    private readonly ep: 'webgpu' | 'wasm',
    private readonly cfg: Cfg,
    private readonly indexer: number[],
    private readonly dp: OrtNs.InferenceSession,
    private readonly textEnc: OrtNs.InferenceSession,
    private readonly vecEst: OrtNs.InferenceSession,
    private readonly vocoder: OrtNs.InferenceSession,
    readonly sampleRate: number,
  ) {}

  /** per-stage compute time (ms) accumulated since the last takeStages() */
  private stages: Record<string, number> = {};

  private async timed<T>(stage: string, fn: () => Promise<T>): Promise<T> {
    const t0 = performance.now();
    try {
      return await fn();
    } finally {
      this.stages[stage] = (this.stages[stage] ?? 0) + (performance.now() - t0);
    }
  }

  takeStages(): Record<string, number> {
    const out = Object.fromEntries(Object.entries(this.stages).map(([k, v]) => [k, Math.round(v)]));
    this.stages = {};
    return out;
  }

  static async load(store: ModelReader, ep: 'webgpu' | 'wasm' = 'webgpu'): Promise<SupertonicOrtModel> {
    const ort = await loadOrt();
    const text = async (p: string): Promise<string> => new TextDecoder().decode(await store.read(p));
    const cfg = JSON.parse(await text('onnx/tts.json')) as Cfg;
    const indexer = JSON.parse(await text('onnx/unicode_indexer.json')) as number[];
    const opts: OrtNs.InferenceSession.SessionOptions = { executionProviders: [ep], graphOptimizationLevel: 'all' };
    const mk = async (p: string): Promise<OrtNs.InferenceSession> => ort.InferenceSession.create(new Uint8Array(await store.read(p)), opts);
    // sequential: peak memory = one model file + its session
    const dp = await mk('onnx/duration_predictor.onnx');
    const textEnc = await mk('onnx/text_encoder.onnx');
    const vecEst = await mk('onnx/vector_estimator.onnx');
    const vocoder = await mk('onnx/vocoder.onnx');
    return new SupertonicOrtModel(ort, store, ep, cfg, indexer, dp, textEnc, vecEst, vocoder, cfg.ae.sample_rate);
  }

  private async style(voice: string): Promise<Style> {
    let s = this.styles.get(voice);
    if (!s) {
      const j = JSON.parse(new TextDecoder().decode(await this.store.read(`voice_styles/${voice}.json`))) as {
        style_ttl: { dims: number[]; data: unknown[] };
        style_dp: { dims: number[]; data: unknown[] };
      };
      const t = (x: { dims: number[]; data: unknown[] }): OrtNs.Tensor =>
        new this.ort.Tensor('float32', Float32Array.from((x.data as number[]).flat(Infinity) as number[]), x.dims);
      s = { ttl: t(j.style_ttl), dp: t(j.style_dp) };
      this.styles.set(voice, s);
    }
    return s;
  }

  private inputs(text: string): { ids: OrtNs.Tensor; mask: OrtNs.Tensor } {
    const ids = textToIds(preprocessForModel(text, 'ru'), this.indexer);
    return {
      ids: new this.ort.Tensor('int64', ids, [1, ids.length]),
      mask: new this.ort.Tensor('float32', new Float32Array(ids.length).fill(1), [1, 1, ids.length]),
    };
  }

  async predictDuration(text: string, voice: string): Promise<number> {
    const { ids, mask } = this.inputs(text);
    const st = await this.style(voice);
    const out = await this.timed('dur', () => this.dp.run({ text_ids: ids, style_dp: st.dp, text_mask: mask }));
    return (out.duration!.data as Float32Array)[0]!;
  }

  async infer(text: string, voice: string, speed: number, steps: number, signal?: AbortSignal): Promise<Float32Array> {
    const { Tensor } = this.ort;
    const { ids, mask } = this.inputs(text);
    const st = await this.style(voice);
    const dpOut = await this.timed('dur', () => this.dp.run({ text_ids: ids, style_dp: st.dp, text_mask: mask }));
    const durationSec = (dpOut.duration!.data as Float32Array)[0]! / speed;
    const enc = await this.timed('enc', () => this.textEnc.run({ text_ids: ids, style_ttl: st.ttl, text_mask: mask }));
    const textEmb = enc.text_emb!;

    const sr = this.sampleRate;
    const wavLen = Math.floor(durationSec * sr);
    const chunk = this.cfg.ae.base_chunk_size * this.cfg.ttl.chunk_compress_factor;
    const latentLen = Math.max(1, Math.floor((wavLen + chunk - 1) / chunk));
    const latentDim = this.cfg.ttl.latent_dim * this.cfg.ttl.chunk_compress_factor;
    let xt: Float32Array<ArrayBuffer> = new Float32Array(latentDim * latentLen);
    for (let i = 0; i < xt.length; i++) {
      const u1 = Math.max(0.0001, Math.random());
      xt[i] = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * Math.random()); // Box-Muller; single item => mask is all ones
    }
    const latentMask = new Tensor('float32', new Float32Array(latentLen).fill(1), [1, 1, latentLen]);
    const totalStep = new Tensor('float32', Float32Array.of(steps), [1]);
    for (let step = 0; step < steps; step++) {
      if (signal?.aborted) throw ttsAbortError();
      const out = await this.timed('vec', () => this.vecEst.run({
        noisy_latent: new Tensor('float32', xt, [1, latentDim, latentLen]),
        text_emb: textEmb,
        style_ttl: st.ttl,
        latent_mask: latentMask,
        text_mask: mask,
        current_step: new Tensor('float32', Float32Array.of(step), [1]),
        total_step: totalStep,
      }));
      xt = out.denoised_latent!.data as Float32Array<ArrayBuffer>;
    }
    const voc = await this.timed('voc', () => this.vocoder.run({ latent: new Tensor('float32', xt, [1, latentDim, latentLen]) }));
    const wav = voc.wav_tts!.data as Float32Array;
    // the whole vocoder output is kept: no trimming to the predicted duration (owner: tails were cut); edges are cleaned in runner.trimEdges
    return Float32Array.from(wav);
  }

  async dispose(): Promise<void> {
    await Promise.allSettled([this.dp.release(), this.textEnc.release(), this.vecEst.release(), this.vocoder.release()]);
  }
}
