/** PCM -> Ogg-Opus using WebCodecs AudioEncoder (secure contexts, Chromium). */
import { floatToInt16, int16ToFloat, resampleMono } from '../capture/audio';
import { muxOggOpus } from './ogg';

export const OPUS_MIME = 'audio/ogg; codecs=opus';
export const OPUS_BITRATE = 24_000;
const OPUS_RATES = [8000, 12000, 16000, 24000, 48000];
/** libopus look-ahead at 48 kHz (6.5 ms); the muxed length is exact regardless, this only trims leading padding */
const PRE_SKIP = 312;

/** Compresses mono PCM; undefined when this environment cannot (no WebCodecs). */
export interface AudioCodec {
  encode(pcm: Int16Array, sampleRate: number): Promise<Uint8Array | undefined>;
}

interface WcAudioEncoder {
  configure(c: unknown): void;
  encode(d: unknown): void;
  flush(): Promise<void>;
  close(): void;
}

const G = globalThis as unknown as {
  AudioEncoder?: {
    new (init: { output: (chunk: { byteLength: number; duration: number | null; copyTo(d: Uint8Array): void }) => void; error: (e: unknown) => void }): WcAudioEncoder;
    isConfigSupported(c: unknown): Promise<{ supported?: boolean }>;
  };
  AudioData?: new (init: unknown) => { close(): void };
};

export function webCodecsAvailable(): boolean {
  return typeof G.AudioEncoder === 'function' && typeof G.AudioData === 'function';
}

export async function opusEncodingSupported(): Promise<boolean> {
  if (!webCodecsAvailable()) return false;
  try {
    const r = await G.AudioEncoder!.isConfigSupported({ codec: 'opus', sampleRate: 24000, numberOfChannels: 1, bitrate: OPUS_BITRATE });
    return !!r.supported;
  } catch {
    return false;
  }
}

export const webCodecsOpus: AudioCodec = {
  async encode(pcm, sampleRate) {
    if (!webCodecsAvailable() || pcm.length === 0) return undefined;
    let rate = sampleRate;
    let samples = pcm;
    if (!OPUS_RATES.includes(rate)) {
      samples = floatToInt16(resampleMono(int16ToFloat(pcm), rate, 48000));
      rate = 48000;
    }
    const cfg = { codec: 'opus', sampleRate: rate, numberOfChannels: 1, bitrate: OPUS_BITRATE };
    if (!(await opusEncodingSupported())) return undefined;
    const packets: Uint8Array[] = [];
    const packetSamples: number[] = [];
    let err: unknown;
    const enc = new G.AudioEncoder!({
      output: (c) => {
        const b = new Uint8Array(c.byteLength);
        c.copyTo(b);
        packets.push(b);
        packetSamples.push(Math.round(((c.duration ?? 20_000) * 48000) / 1_000_000));
      },
      error: (e) => (err = e),
    });
    try {
      enc.configure(cfg);
      // feed in 1 s slices: bounded encoder queue, same output
      const slice = rate;
      for (let off = 0; off < samples.length; off += slice) {
        const part = samples.subarray(off, Math.min(samples.length, off + slice));
        const data = new G.AudioData!({
          format: 's16',
          sampleRate: rate,
          numberOfFrames: part.length,
          numberOfChannels: 1,
          timestamp: Math.round((off / rate) * 1_000_000),
          data: part,
        });
        enc.encode(data);
        data.close();
      }
      await enc.flush();
    } finally {
      try {
        enc.close();
      } catch {
        /* already closed after an error */
      }
    }
    if (err || packets.length === 0) return undefined;
    return muxOggOpus({
      channels: 1,
      inputRate: rate,
      preSkip: PRE_SKIP,
      packets,
      packetSamples,
      totalSamples48: Math.round((samples.length * 48000) / rate),
    });
  },
};
