import type * as OrtNs from 'onnxruntime-web';
import { loadOrt } from '../ortModel';
// relative on purpose (as piper.ts): localtts/backend and localtts/silero are not re-exported from the @nvt/core index yet
import type { BackendJob, BackendOutput, LocalTtsBackend, ModelReader } from '../../../../../packages/core/src/localtts/backend';
import {
  SILERO_ACCENTOR,
  SILERO_ACOUSTIC,
  SILERO_BERT_VOCAB,
  SILERO_CHUNK_GAP_SEC,
  SILERO_DEFAULT_VOICE,
  SILERO_EXCEPTIONS,
  SILERO_HOMODICT,
  SILERO_HOMOSOLVER,
  SILERO_NGRAMS,
  SILERO_SAMPLE_RATE,
  SILERO_SPEAKER_INDEX,
  SILERO_VOCODER,
} from '../../../../../packages/core/src/localtts/silero/constants';
import {
  SileroBertTokenizer,
  SileroNgramIndex,
  chunkForSilero,
  parseSileroExceptions,
  sileroChunkInput,
  sileroPredsFromLogits,
  type SileroFrontendData,
  type SileroHomoCandidate,
  type SileroPredictors,
  type SileroWordPred,
} from '../../../../../packages/core/src/localtts/silero/text';
import { sileroIstft, sileroPqmf24k, sileroToInt16 } from '../../../../../packages/core/src/localtts/silero/dsp';
import { planSileroRates } from '../../../../../packages/core/src/localtts/silero/speed';

type Ort = typeof OrtNs;
type Session = OrtNs.InferenceSession;

const abortError = (): Error => Object.assign(new Error('aborted'), { name: 'AbortError' });

export interface SileroTimings {
  frontendMs: number;
  acousticMs: number;
  vocoderMs: number;
  dspMs: number;
}

/**
 * Silero TTS v5_ru (eugene / xenia) on onnxruntime-web WASM. Text front-end (accentor + homograph solver post-processing) is the pure
 * port in packages/core/src/localtts/silero; neural parts are 4 ONNX sessions; iSTFT + PQMF (24 kHz) run in TS.
 * Pipeline per chunk: text -> '+'/ё -> ids -> acoustic(durs_rate) -> mel -> vocoder -> complex spectrum -> iSTFT 48k -> PQMF 24k.
 */
export class SileroEngine {
  private acoustic?: Session;
  private vocoder?: Session;
  private accentor?: Session;
  private homosolver?: Session;
  private data?: SileroFrontendData;
  /** timings of the last synth (diagnostics) */
  lastTimings: SileroTimings = { frontendMs: 0, acousticMs: 0, vocoderMs: 0, dspMs: 0 };

  constructor(
    private readonly ort: Ort,
    private readonly opts: { graphOptimizationLevel?: 'disabled' | 'basic' | 'extended' | 'all' } = {},
  ) {}

  async load(files: ModelReader): Promise<void> {
    const ort = this.ort;
    const so: OrtNs.InferenceSession.SessionOptions = { executionProviders: ['wasm'], graphOptimizationLevel: this.opts.graphOptimizationLevel ?? 'all' };
    const bytes = async (p: string): Promise<Uint8Array> => {
      try {
        return new Uint8Array(await files.read(p));
      } catch (e) {
        throw new Error(`Silero: model file "${p}" is not downloaded (${e instanceof Error ? e.message : String(e)})`);
      }
    };
    const text = async (p: string): Promise<string> => new TextDecoder().decode(await bytes(p));
    const [ngrams, exceptions, vocab, homodict] = await Promise.all([text(SILERO_NGRAMS), text(SILERO_EXCEPTIONS), text(SILERO_BERT_VOCAB), text(SILERO_HOMODICT)]);
    // sequential: four parallel session inits would hold every model + its optimised copy in the WASM heap at once
    this.accentor = await ort.InferenceSession.create(await bytes(SILERO_ACCENTOR), so);
    this.homosolver = await ort.InferenceSession.create(await bytes(SILERO_HOMOSOLVER), so);
    this.acoustic = await ort.InferenceSession.create(await bytes(SILERO_ACOUSTIC), so);
    this.vocoder = await ort.InferenceSession.create(await bytes(SILERO_VOCODER), so);
    this.data = {
      ngrams: new SileroNgramIndex(ngrams),
      exceptions: parseSileroExceptions(exceptions),
      homo: { dict: JSON.parse(homodict) as Record<string, string[]>, tokenizer: new SileroBertTokenizer(vocab) },
    };
  }

  private i64(data: readonly number[], dims: number[]): OrtNs.Tensor {
    return new this.ort.Tensor('int64', BigInt64Array.from(data, (x) => BigInt(x)), dims);
  }

  private readonly predictors: SileroPredictors = {
    accent: async (b): Promise<SileroWordPred[]> => {
      const out = await this.accentor!.run({ ids: this.i64(b.ids, [b.n, b.k]), mask: new this.ort.Tensor('float32', Float32Array.from(b.mask), [b.n, b.k]) });
      const s = out.stress!;
      const y = out.yo!;
      return sileroPredsFromLogits(s.data as Float32Array, s.dims[1]!, y.data as Float32Array, y.dims[1]!, b.n);
    },
    homo: async (cands: readonly SileroHomoCandidate[]): Promise<number[]> => {
      const tok = this.data!.homo!.tokenizer;
      const L = Math.max(...cands.map((c) => c.ids.length));
      const ids = cands.flatMap((c) => [...c.ids, ...new Array<number>(L - c.ids.length).fill(tok.pad)]); // pad_sequence(pad id)
      const out = await this.homosolver!.run({
        input_ids: this.i64(ids, [cands.length, L]),
        start: this.i64(cands.map((c) => c.homoStart), [cands.length]),
        end: this.i64(cands.map((c) => c.homoEnd), [cands.length]),
      });
      return Array.from(out.logits!.data as Float32Array, (l) => (l > 0 ? 1 : 0)); // round(sigmoid(l))
    },
  };

  private async runAcoustic(ids: number[], speaker: number, rates?: Float32Array): Promise<{ mel: OrtNs.Tensor; durs: number[] }> {
    const out = await this.acoustic!.run({
      sequence: this.i64(ids, [1, ids.length]),
      speaker: this.i64([speaker], [1]),
      durs_rate: new this.ort.Tensor('float32', rates ?? new Float32Array(ids.length).fill(1), [1, ids.length]),
    });
    return { mel: out.mel!, durs: Array.from(out.durs!.data as Float32Array) };
  }

  async synth(job: BackendJob): Promise<BackendOutput & { accented: string[] }> {
    const { signal } = job;
    if (!this.data || !this.acoustic || !this.vocoder) throw new Error('Silero: backend not loaded');
    if (signal?.aborted) throw abortError();
    const voice = job.voice || SILERO_DEFAULT_VOICE;
    const speaker = SILERO_SPEAKER_INDEX[voice];
    if (speaker === undefined) throw new Error(`Silero: unknown voice "${voice}"`);
    const empty = { samples: new Int16Array(0), sampleRate: SILERO_SAMPLE_RATE, durationSec: 0, speed: 1, passes: 0, chunks: 0, accented: [] };
    const t: SileroTimings = { frontendMs: 0, acousticMs: 0, vocoderMs: 0, dspMs: 0 };
    let t0 = performance.now();

    const inputs: { accented: string; ids: number[] }[] = [];
    for (const c of chunkForSilero(job.text)) {
      if (signal?.aborted) throw abortError();
      const inp = await sileroChunkInput(c, this.data, this.predictors);
      if (inp) inputs.push(inp);
    }
    t.frontendMs = performance.now() - t0;
    if (!inputs.length) return empty;

    t0 = performance.now();
    let ac: { mel: OrtNs.Tensor; durs: number[] }[] = [];
    for (const inp of inputs) {
      if (signal?.aborted) throw abortError();
      ac.push(await this.runAcoustic(inp.ids, speaker));
    }
    let passes = 1;
    // exact plan from the natural durations (per-symbol rates; within one 12.5 ms frame of the target, speed clamped 0.8-1.5)
    const plan = planSileroRates(
      ac.map((a) => a.durs),
      job.targetSec,
      SILERO_CHUNK_GAP_SEC,
    );
    const speed = plan.speed;
    if (plan.rates) {
      for (const a of ac) a.mel.dispose();
      const second: typeof ac = [];
      for (const [i, inp] of inputs.entries()) {
        if (signal?.aborted) throw abortError();
        second.push(await this.runAcoustic(inp.ids, speaker, plan.rates[i]));
      }
      ac = second;
      passes = 2;
    }
    t.acousticMs = performance.now() - t0;

    const pcm: Float64Array[] = [];
    for (const a of ac) {
      if (signal?.aborted) throw abortError();
      t0 = performance.now();
      const out = await this.vocoder.run({ mel: a.mel });
      const re = out.re!;
      t.vocoderMs += performance.now() - t0;
      t0 = performance.now();
      const frames = re.dims[2]!;
      pcm.push(sileroPqmf24k(sileroIstft(re.data as Float32Array, out.im!.data as Float32Array, frames)));
      re.dispose();
      out.im!.dispose();
      a.mel.dispose();
      t.dspMs += performance.now() - t0;
    }
    const gap = Math.round(SILERO_CHUNK_GAP_SEC * SILERO_SAMPLE_RATE);
    const total = pcm.reduce((n, p) => n + p.length, 0) + gap * (pcm.length - 1);
    const all = new Float64Array(total);
    let pos = 0;
    pcm.forEach((p, i) => {
      if (i > 0) pos += gap;
      all.set(p, pos);
      pos += p.length;
    });
    const samples = sileroToInt16(all);
    this.lastTimings = t;
    return {
      samples,
      sampleRate: SILERO_SAMPLE_RATE,
      durationSec: samples.length / SILERO_SAMPLE_RATE,
      speed,
      passes,
      chunks: pcm.length,
      accented: inputs.map((i) => i.accented),
    };
  }

  async dispose(): Promise<void> {
    const ss = [this.acoustic, this.vocoder, this.accentor, this.homosolver];
    this.acoustic = this.vocoder = this.accentor = this.homosolver = undefined;
    this.data = undefined;
    await Promise.all(ss.map((s) => s?.release().catch(() => undefined)));
  }
}

/** LocalTtsBackend 'silero-cpu' for the offscreen runtime */
export class SileroBackend implements LocalTtsBackend {
  readonly engine = 'silero-cpu' as const;
  private engineImpl?: SileroEngine;

  async load(files: ModelReader): Promise<void> {
    const e = new SileroEngine(await loadOrt());
    await e.load(files);
    this.engineImpl = e;
  }

  async synth(job: BackendJob): Promise<BackendOutput> {
    if (!this.engineImpl) throw new Error('Silero: backend not loaded');
    const { samples, sampleRate, durationSec, speed, passes, chunks } = await this.engineImpl.synth(job);
    return { samples, sampleRate, durationSec, speed, passes, chunks };
  }

  async dispose(): Promise<void> {
    const e = this.engineImpl;
    this.engineImpl = undefined;
    await e?.dispose();
  }
}

export function createSileroBackend(): SileroBackend {
  return new SileroBackend();
}
