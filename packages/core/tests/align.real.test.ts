/**
 * Regression on REAL Gemini TTS runs (gemini-3.1-flash-tts-preview, voice Orus, 2026-10-21), stored as 8 kHz mono
 * int16 PCM in tests/fixtures/. The expected cuts were verified by transcribing every aligned clip (each contained
 * exactly its own sentence; research verification, 14/14 clips correct).
 */
import { describe, expect, it } from 'vitest';
import { alignSentences } from '../src/audio/align';

async function node(spec: string): Promise<any> {
  return import(/* @vite-ignore */ spec);
}
async function load(name: string): Promise<Int16Array> {
  const fs = await node('node:fs');
  const path = await node('node:path');
  const url = await node('node:url');
  const buf: Uint8Array = fs.readFileSync(path.join(path.dirname(url.fileURLToPath(import.meta.url)), 'fixtures', name));
  return new Int16Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

const CASES = [
  // 5 sentences incl. a 10-char interjection ("Это важно.") and a 22-char question
  { file: 'align_orus_s1.pcm', chars: [68, 10, 84, 22, 70], cuts: [4.8, 6.0, 12.26, 13.96] },
  { file: 'align_orus_s2.pcm', chars: [61, 52, 49, 43], cuts: [4.23, 8.1, 11.71] },
];

describe('alignSentences on recorded Gemini TTS', () => {
  for (const c of CASES) {
    it(`${c.file}: cuts match the verified sentence boundaries`, async () => {
      const pcm = await load(c.file);
      const r = alignSentences(pcm, 8000, c.chars);
      expect(r.ok).toBe(true);
      expect(r.cuts).toHaveLength(c.cuts.length);
      r.cuts.forEach((cut, i) => expect(Math.abs(cut / 8000 - c.cuts[i]!)).toBeLessThan(0.08));
      // every cut sits in near-silence (never inside a word)
      let max = 0;
      for (const v of pcm) max = Math.max(max, Math.abs(v));
      for (const cut of r.cuts) {
        let m = 0;
        for (let i = cut - 160; i < cut + 160; i++) m = Math.max(m, Math.abs(pcm[i]!));
        expect(m).toBeLessThan(0.1 * max);
      }
    });
    it(`${c.file}: wrong sentence weights do not move cuts into words`, async () => {
      const pcm = await load(c.file);
      // +-25% char-count error (e.g. numbers / abbreviations spoken longer than written) must still pick real pauses
      const skew = c.chars.map((n, i) => Math.round(n * (i % 2 ? 1.25 : 0.8)));
      const r = alignSentences(pcm, 8000, skew);
      if (!r.ok) return; // refusing is acceptable (falls back to per-sentence calls)
      r.cuts.forEach((cut, i) => expect(Math.abs(cut / 8000 - c.cuts[i]!)).toBeLessThan(0.08));
    });
  }
});
