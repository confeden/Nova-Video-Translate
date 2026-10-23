import { browser } from 'wxt/browser';
import type * as OrtNs from 'onnxruntime-web';
import { loadOrt } from '../ortModel';
// relative on purpose: neither localtts/backend nor localtts/piper is re-exported from the @nvt/core index yet (owner wires it)
import type { BackendJob, BackendOutput, LocalTtsBackend, ModelReader } from '../../../../../packages/core/src/localtts/backend';
import {
  PIPER_CHUNK_GAP_SEC,
  PIPER_NOISE_SCALE,
  PIPER_NOISE_W,
  PIPER_PHONEMIZE_DATA,
  PIPER_SAMPLE_RATE,
  PIPER_VOICES,
  piperConfigPath,
  piperModelPath,
} from '../../../../../packages/core/src/localtts/piper/constants';
import {
  assemblePiperPcm,
  chunkForPiper,
  parsePiperPhonemes,
  piperFirstPassSpeed,
  piperNeedsCorrection,
  piperPhonemesToIds,
  refinePiperSpeed,
  type PiperPhonemeIdMap,
} from '../../../../../packages/core/src/localtts/piper/text';

type Ort = typeof OrtNs;

/** Emscripten module of piper-phonemize (public/piper/piper_phonemize.js, a classic script defining a global factory) */
interface PhonemizeModule {
  callMain(args: string[]): number;
}
type PhonemizeFactory = (opts: {
  locateFile: (file: string) => string;
  print: (line: string) => void;
  printErr: (line: string) => void;
}) => Promise<PhonemizeModule>;

interface VoiceConfig {
  audio: { sample_rate: number };
  espeak: { voice: string };
  inference: { noise_scale: number; length_scale: number; noise_w: number };
  num_speakers: number;
  phoneme_id_map: PiperPhonemeIdMap;
}

interface LoadedVoice {
  id: string;
  session: OrtNs.InferenceSession;
  cfg: VoiceConfig;
  sampleRate: number;
}

/** fresh phonemizer instance after this many callMain calls (OOM seen at ~50) */
const PHONEMIZER_MAX_CALLS = 8;
const abortError = (): Error => Object.assign(new Error('aborted'), { name: 'AbortError' });
const base = (): string => browser.runtime.getURL('/piper/' as never);

let factoryPromise: Promise<PhonemizeFactory> | undefined;
/** injects the vendored glue script (extension origin, allowed by script-src 'self') and returns its global factory */
function loadPhonemizeFactory(): Promise<PhonemizeFactory> {
  return (factoryPromise ??= new Promise<PhonemizeFactory>((resolve, reject) => {
    const g = globalThis as unknown as { createPiperPhonemize?: PhonemizeFactory };
    if (g.createPiperPhonemize) return resolve(g.createPiperPhonemize);
    const s = document.createElement('script');
    s.src = `${base()}piper_phonemize.js`;
    s.onload = () => (g.createPiperPhonemize ? resolve(g.createPiperPhonemize) : reject(new Error('Piper: phonemizer script loaded but createPiperPhonemize is missing')));
    s.onerror = () => reject(new Error('Piper: cannot load piper/piper_phonemize.js (not packaged in the extension?)'));
    document.head.appendChild(s);
  }).catch((e) => {
    factoryPromise = undefined;
    throw e;
  }));
}

/** Piper (VITS) on onnxruntime-web WASM; espeak-ng phonemes from the vendored piper-phonemize WASM. One voice session at a time. */
export class PiperBackend implements LocalTtsBackend {
  readonly engine = 'piper-wasm' as const;

  private reader?: ModelReader;
  private ort?: Ort;
  private factory?: PhonemizeFactory;
  private dataUrl?: string;
  private phonemizer?: PhonemizeModule;
  private phonemizerCalls = 0;
  private stdout: string[] = [];
  private voice?: LoadedVoice;
  private voiceLoading?: { id: string; p: Promise<LoadedVoice> };

  async load(files: ModelReader): Promise<void> {
    this.reader = files;
    this.ort = await loadOrt();
    this.factory = await loadPhonemizeFactory();
    // the espeak-ng data pack is a runtime download; Emscripten fetches it by XHR from this blob URL (no remote code, data only)
    const data = await files.read(PIPER_PHONEMIZE_DATA);
    this.dataUrl = URL.createObjectURL(new Blob([data], { type: 'application/octet-stream' }));
    await this.createPhonemizer(); // fail early (data pack / wasm unusable) instead of at the first synth
  }

  private async createPhonemizer(): Promise<PhonemizeModule> {
    if (!this.factory || !this.dataUrl) throw new Error('Piper: backend not loaded');
    const dataUrl = this.dataUrl;
    this.phonemizer = await this.factory({
      locateFile: (f) => (f.endsWith('.data') ? dataUrl : `${base()}${f}`),
      print: (l) => this.stdout.push(l),
      printErr: () => undefined,
    });
    return this.phonemizer;
  }

  /**
   * espeak-ng phonemes of one chunk. The Emscripten heap of piper-phonemize leaks per callMain and aborts with OOM after ~50 calls
   * (measured), so a fresh module instance is made per request (`fresh`), after PHONEMIZER_MAX_CALLS calls, and after any failure.
   */
  private async phonemize(text: string, espeakVoice: string, fresh: boolean): Promise<string[]> {
    for (let attempt = 0; attempt < 2; attempt++) {
      let m = this.phonemizer;
      if (!m || fresh || attempt > 0 || this.phonemizerCalls >= PHONEMIZER_MAX_CALLS) {
        m = await this.createPhonemizer();
        this.phonemizerCalls = 0;
      }
      this.stdout = [];
      this.phonemizerCalls++;
      try {
        m.callMain(['-l', espeakVoice, '--input', JSON.stringify([{ text }]), '--espeak_data', '/espeak-ng-data']);
        const ph = parsePiperPhonemes(this.stdout);
        if (ph.length) return ph;
      } catch (e) {
        if (attempt === 1) throw new Error(`Piper: phonemizer failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      fresh = true;
    }
    throw new Error('Piper: phonemizer returned no phonemes');
  }

  private loadVoice(id: string): Promise<LoadedVoice> {
    if (this.voice?.id === id) return Promise.resolve(this.voice);
    if (this.voiceLoading?.id === id) return this.voiceLoading.p;
    const p = (async () => {
      const { reader, ort } = this;
      if (!reader || !ort) throw new Error('Piper: backend not loaded');
      if (!PIPER_VOICES.some((v) => v.id === id)) throw new Error(`Piper: unknown voice "${id}"`);
      let model: ArrayBuffer;
      let cfgBuf: ArrayBuffer;
      try {
        [model, cfgBuf] = await Promise.all([reader.read(piperModelPath(id)), reader.read(piperConfigPath(id))]);
      } catch (e) {
        throw new Error(`Piper: voice "${id}" is not downloaded (${e instanceof Error ? e.message : String(e)})`);
      }
      const cfg = JSON.parse(new TextDecoder().decode(cfgBuf)) as VoiceConfig;
      // 'basic': session creation ~2 s; 'all' took ~9 s for the same RTF (measured)
      const session = await ort.InferenceSession.create(new Uint8Array(model), { executionProviders: ['wasm'], graphOptimizationLevel: 'basic' });
      const prev = this.voice;
      this.voice = { id, session, cfg, sampleRate: cfg.audio?.sample_rate ?? PIPER_SAMPLE_RATE };
      if (prev) void prev.session.release().catch(() => undefined); // keep ONE voice resident (63 MB model + arena each)
      return this.voice;
    })();
    this.voiceLoading = { id, p };
    const clear = (): void => {
      if (this.voiceLoading?.p === p) this.voiceLoading = undefined;
    };
    p.then(clear, clear);
    return p;
  }

  private async infer(v: LoadedVoice, ids: number[], speed: number): Promise<Float32Array> {
    const { Tensor } = this.ort!;
    const n = ids.length;
    const inf = v.cfg.inference;
    const out = await v.session.run({
      input: new Tensor('int64', BigInt64Array.from(ids, (x) => BigInt(x)), [1, n]),
      input_lengths: new Tensor('int64', BigInt64Array.of(BigInt(n)), [1]),
      scales: new Tensor('float32', Float32Array.of(inf?.noise_scale ?? PIPER_NOISE_SCALE, 1 / speed, inf?.noise_w ?? PIPER_NOISE_W), [3]),
    });
    const o = out.output ?? Object.values(out)[0];
    if (!o) throw new Error('Piper: model returned no output');
    return Float32Array.from(o.data as Float32Array);
  }

  async synth(job: BackendJob): Promise<BackendOutput> {
    const { signal } = job;
    if (signal?.aborted) throw abortError();
    const voiceId = job.voice || 'dmitri';
    const v = await this.loadVoice(voiceId);
    const chunks = chunkForPiper(job.text);
    if (!chunks.length) return { samples: new Int16Array(0), sampleRate: v.sampleRate, durationSec: 0, speed: 1, passes: 0, chunks: 0 };

    const idLists: number[][] = [];
    for (const [i, c] of chunks.entries()) {
      if (signal?.aborted) throw abortError();
      const ids = piperPhonemesToIds(await this.phonemize(c, v.cfg.espeak?.voice || 'ru', i === 0), v.cfg.phoneme_id_map);
      if (ids.length <= 3) continue; // BOS PAD EOS only: nothing speakable in the chunk
      idLists.push(ids);
    }
    if (!idLists.length) return { samples: new Int16Array(0), sampleRate: v.sampleRate, durationSec: 0, speed: 1, passes: 0, chunks: 0 };

    const run = async (speed: number): Promise<{ pcm: Float32Array[]; speechSec: number }> => {
      const pcm: Float32Array[] = [];
      let n = 0;
      for (const ids of idLists) {
        if (signal?.aborted) throw abortError();
        const a = await this.infer(v, ids, speed);
        pcm.push(a);
        n += a.length;
      }
      return { pcm, speechSec: n / v.sampleRate };
    };

    const totalChars = chunks.reduce((a, c) => a + c.length, 0);
    const gaps = Math.max(0, idLists.length - 1) * PIPER_CHUNK_GAP_SEC;
    let speed = piperFirstPassSpeed(totalChars, idLists.length, job.targetSec);
    let r = await run(speed);
    let passes = 1;
    if (piperNeedsCorrection(r.speechSec + gaps, job.targetSec, speed)) {
      const s2 = refinePiperSpeed(speed, r.speechSec, idLists.length, job.targetSec!);
      if (Math.abs(s2 - speed) > 0.01) {
        r = await run(s2);
        speed = s2;
        passes = 2;
      }
    }
    const samples = assemblePiperPcm(r.pcm, v.sampleRate, PIPER_CHUNK_GAP_SEC);
    return { samples, sampleRate: v.sampleRate, durationSec: samples.length / v.sampleRate, speed, passes, chunks: idLists.length };
  }

  async dispose(): Promise<void> {
    const v = this.voice;
    this.voice = undefined;
    this.voiceLoading = undefined;
    this.phonemizer = undefined;
    this.reader = undefined;
    if (this.dataUrl) URL.revokeObjectURL(this.dataUrl);
    this.dataUrl = undefined;
    await v?.session.release().catch(() => undefined);
  }
}

export function createPiperBackend(): PiperBackend {
  return new PiperBackend();
}
