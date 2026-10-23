/**
 * Model-independent synthesis driver: chunking, speed fitting to targetSec (with one corrective pass), gaps,
 * resampling and Int16 conversion. The ONNX model hides behind `TtsModel` (offscreen document); tests use a fake.
 */
import { CHUNK_GAP_SEC, DEFAULT_SPEED, OUTPUT_SAMPLE_RATE, SYNTH_STEPS } from './constants';
import { concatWithGaps, floatToInt16, resample, trimEdges } from './pcm';
import { abortError } from './queue';
import { missesTarget, refineSpeed, speedForTarget } from './speed';
import { splitForTts } from './text';

export interface TtsModel {
  /** native sample rate of infer() output */
  readonly sampleRate: number;
  /** predicted duration (s) of the chunk at speed 1 (duration predictor only: cheap) */
  predictDuration(text: string, voice: string): Promise<number>;
  /** full synthesis of one chunk (<= MAX_CHUNK_CHARS) */
  infer(text: string, voice: string, speed: number, steps: number, signal?: AbortSignal): Promise<Float32Array>;
}

export interface SynthJob {
  text: string;
  voice: string;
  targetSec?: number;
  steps?: number;
  signal?: AbortSignal;
}

export interface SynthOutput {
  samples: Int16Array;
  sampleRate: number;
  durationSec: number;
  /** speed of the returned pass */
  speed: number;
  /** model passes over the whole text (1 or 2) */
  passes: number;
  chunks: number;
}

export async function synthesizeText(model: TtsModel, job: SynthJob): Promise<SynthOutput> {
  const outSr = Math.min(OUTPUT_SAMPLE_RATE, model.sampleRate);
  const chunks = splitForTts(job.text);
  if (chunks.length === 0) return { samples: new Int16Array(0), sampleRate: outSr, durationSec: 0, speed: 1, passes: 0, chunks: 0 };
  const steps = job.steps ?? SYNTH_STEPS;
  const gapSec = CHUNK_GAP_SEC * Math.max(0, chunks.length - 1);
  const gapSamples = Math.round(CHUNK_GAP_SEC * model.sampleRate);
  const target = job.targetSec && job.targetSec > 0 ? job.targetSec : undefined;

  let speed = DEFAULT_SPEED;
  if (target) {
    let natural = 0;
    for (const c of chunks) {
      if (job.signal?.aborted) throw abortError();
      natural += await model.predictDuration(c, job.voice);
    }
    speed = speedForTarget(natural, gapSec, target);
  }

  const pass = async (sp: number): Promise<{ wav: Float32Array; sec: number }> => {
    const parts: Float32Array[] = [];
    for (const c of chunks) {
      if (job.signal?.aborted) throw abortError();
      parts.push(trimEdges(await model.infer(c, job.voice, sp, steps, job.signal), model.sampleRate, { fadeSec: 0.02 }));
    }
    const wav = concatWithGaps(parts, gapSamples);
    return { wav, sec: wav.length / model.sampleRate };
  };

  let best = await pass(speed);
  let passes = 1;
  if (target && missesTarget(best.sec, target)) {
    const next = refineSpeed(speed, best.sec, gapSec, target);
    if (next !== null) {
      const second = await pass(next);
      passes = 2;
      if (Math.abs(second.sec - target) < Math.abs(best.sec - target)) {
        best = second;
        speed = next;
      }
    }
  }
  // final edge cleanup: lead <= 60 ms, trailing digital silence > 150 ms removed, 60 ms fade-out; the tail is never cut
  const wav = resample(trimEdges(best.wav, model.sampleRate), model.sampleRate, outSr);
  const samples = floatToInt16(wav);
  return { samples, sampleRate: outSr, durationSec: samples.length / outSr, speed, passes, chunks: chunks.length };
}
