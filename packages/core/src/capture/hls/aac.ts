/**
 * ADTS/AAC -> mono Int16 @16 kHz for the HLS capture. Primary path: WebCodecs AudioDecoder (one persistent decoder, so
 * the AAC overlap state survives segment borders); fallback: decodeAudioData over the concatenated ADTS frames of one
 * segment (Chromium decodes raw ADTS). Browser-only; the pure parts are unit-tested through the injected `AacDecoder`.
 */
import { downmixToMono, floatToInt16, resampleMono, TARGET_RATE } from '../audio';
import { decodeToPcm16k } from '../decode';
import type { AdtsFrame } from './tsDemux';

export interface AacDecoder {
  /** decodes the frames of one segment (in order) to mono 16 kHz PCM */
  decode(frames: AdtsFrame[]): Promise<Int16Array>;
  readonly kind: 'webcodecs' | 'decodeAudioData';
  close(): void;
}

interface AudioDataLike {
  numberOfChannels: number;
  numberOfFrames: number;
  sampleRate: number;
  copyTo(dest: Float32Array, opts: { planeIndex: number; format: 'f32-planar' }): void;
  close(): void;
}

interface WcDecoder {
  configure(c: { codec: string; sampleRate: number; numberOfChannels: number }): void;
  decode(chunk: unknown): void;
  flush(): Promise<void>;
  close(): void;
  state: string;
}

interface WcGlobals {
  AudioDecoder?: {
    new (init: { output: (d: AudioDataLike) => void; error: (e: Error) => void }): WcDecoder;
    isConfigSupported(c: { codec: string; sampleRate: number; numberOfChannels: number }): Promise<{ supported?: boolean }>;
  };
  EncodedAudioChunk?: new (init: { type: 'key' | 'delta'; timestamp: number; data: Uint8Array }) => unknown;
}

export function concatFrames(frames: AdtsFrame[]): Uint8Array {
  let n = 0;
  for (const f of frames) n += f.data.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const f of frames) {
    out.set(f.data, o);
    o += f.data.length;
  }
  return out;
}

export async function createAacDecoder(first: AdtsFrame): Promise<AacDecoder> {
  const g = globalThis as unknown as WcGlobals;
  const cfg = { codec: 'mp4a.40.2', sampleRate: first.sampleRate, numberOfChannels: first.channels };
  if (g.AudioDecoder && g.EncodedAudioChunk) {
    try {
      const sup = await g.AudioDecoder.isConfigSupported(cfg);
      if (sup.supported) return webCodecsDecoder(g, cfg);
    } catch {
      /* fall through to decodeAudioData */
    }
  }
  return {
    kind: 'decodeAudioData',
    decode: async (frames) => (frames.length === 0 ? new Int16Array(0) : decodeToPcm16k(concatFrames(frames))),
    close() {},
  };
}

function webCodecsDecoder(g: WcGlobals, cfg: { codec: string; sampleRate: number; numberOfChannels: number }): AacDecoder {
  let outs: Float32Array[] = [];
  let rate = cfg.sampleRate;
  let err: Error | undefined;
  const dec = new g.AudioDecoder!({
    output: (d) => {
      const planes: Float32Array[] = [];
      for (let c = 0; c < d.numberOfChannels; c++) {
        const p = new Float32Array(d.numberOfFrames);
        d.copyTo(p, { planeIndex: c, format: 'f32-planar' });
        planes.push(p);
      }
      rate = d.sampleRate;
      outs.push(downmixToMono(planes));
      d.close();
    },
    error: (e) => {
      err = e;
    },
  });
  dec.configure(cfg);
  return {
    kind: 'webcodecs',
    async decode(frames) {
      if (err) throw err;
      outs = [];
      for (const f of frames) dec.decode(new g.EncodedAudioChunk!({ type: 'key', timestamp: Math.round(f.pts * 1e6), data: f.data }));
      await dec.flush();
      if (err) throw err;
      let n = 0;
      for (const o of outs) n += o.length;
      const mono = new Float32Array(n);
      let p = 0;
      for (const o of outs) {
        mono.set(o, p);
        p += o.length;
      }
      return floatToInt16(resampleMono(mono, rate, TARGET_RATE));
    },
    close() {
      try {
        dec.close();
      } catch {
        /* already closed */
      }
    },
  };
}
