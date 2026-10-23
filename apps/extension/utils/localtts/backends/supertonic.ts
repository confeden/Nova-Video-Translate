import { SUPERTONIC_DEFAULT_VOICE, synthesizeText, type BackendJob, type BackendOutput, type LocalTtsBackend, type LocalTtsEngineId, type ModelReader } from '@nvt/core';
import { SupertonicOrtModel } from '../ortModel';

/** Supertonic 3 on onnxruntime-web: 'webgpu' (supertonic-webgpu) or 'wasm' (supertonic-wasm, same files, same model) */
export class SupertonicBackend implements LocalTtsBackend {
  readonly engine: LocalTtsEngineId;
  private model: SupertonicOrtModel | undefined;

  constructor(private readonly ep: 'webgpu' | 'wasm') {
    this.engine = ep === 'webgpu' ? 'supertonic-webgpu' : 'supertonic-wasm';
  }

  async load(files: ModelReader): Promise<void> {
    this.model = await SupertonicOrtModel.load(files, this.ep);
  }

  /** per-stage compute time (ms) since the last call (dur / enc / vec / voc) */
  takeStages(): Record<string, number> {
    return this.model?.takeStages() ?? {};
  }

  async synth(job: BackendJob): Promise<BackendOutput> {
    if (!this.model) throw new Error('supertonic: model not loaded');
    const r = await synthesizeText(this.model, { text: job.text, voice: job.voice || SUPERTONIC_DEFAULT_VOICE, targetSec: job.targetSec, signal: job.signal });
    return { samples: r.samples, sampleRate: r.sampleRate, durationSec: r.durationSec, speed: r.speed, passes: r.passes, chunks: r.chunks };
  }

  async dispose(): Promise<void> {
    const m = this.model;
    this.model = undefined;
    await m?.dispose();
  }
}
