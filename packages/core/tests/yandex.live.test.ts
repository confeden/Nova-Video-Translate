// @ts-nocheck -- Node-only opt-in integration test (no @types/node in the workspace)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { YandexProvider } from '../src/providers/yandex';
import { nodeTransport } from './helpers/nodeTransport';

const live = process.env.NVT_LIVE === '1';

/** Reads a 16-bit PCM WAV (mono assumed; stereo is downmixed by taking the left channel). */
function readWav(path: string): { pcm: Int16Array; sampleRate: number } {
  const b = readFileSync(path);
  const sampleRate = b.readUInt32LE(24);
  const channels = b.readUInt16LE(22);
  const i = b.indexOf('data');
  const len = b.readUInt32LE(i + 4);
  const raw = new Int16Array(b.buffer.slice(b.byteOffset + i + 8, b.byteOffset + i + 8 + len - (len % 2)));
  if (channels === 1) return { pcm: raw, sampleRate };
  const pcm = new Int16Array(Math.floor(raw.length / channels));
  for (let k = 0; k < pcm.length; k++) pcm[k] = raw[k * channels];
  return { pcm, sampleRate };
}

describe.skipIf(!live)('Yandex live (NVT_LIVE=1)', () => {
  it('translates a real wav end to end', async () => {
    const wav = fileURLToPath(new URL('../../../research/en_gemini-3.1-flash-tts-preview.wav', import.meta.url));
    const { pcm, sampleRate } = readWav(wav);
    const provider = new YandexProvider(nodeTransport());
    const res = await provider.translateChunk(
      { startSec: 0, durationSec: pcm.length / sampleRate, sampleRate, pcm },
      { signal: new AbortController().signal, targetLang: 'ru', wantSubtitles: false },
    );
    const seg = res.segments[0];
    expect(seg.audio.kind).toBe('encoded');
    const data = seg.audio.data as Uint8Array;
    console.log(`NVT_LIVE result: mp3 bytes=${data.length} samplerate=${sampleRate} dur=${(pcm.length / sampleRate).toFixed(1)}s`);
    expect(data.length).toBeGreaterThan(10_000);
  }, 240_000);
});
