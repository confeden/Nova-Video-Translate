import { describe, expect, it } from 'vitest';
import { findTailBurst, trimAndFade } from '../src/audio/tailTrim';
import { estimateF0 } from '../src/audio/pitch';
import { alignSentences } from '../src/audio/align';
import { concat, noiseBurst, readResearchWav, silence, voiced } from './helpers/wavFile';

const SR = 24000;
const peakDb = (p: Int16Array) => {
  let m = 0;
  for (const v of p) m = Math.max(m, Math.abs(v));
  return 20 * Math.log10(Math.max(1, m) / 32768);
};
const tailPeakDb = (p: Int16Array, sr: number, sec = 0.3) => peakDb(p.subarray(Math.max(0, p.length - Math.round(sec * sr))));

describe('tail noise burst (Gemini 3.8 TTS artifact)', () => {
  const speech = concat(voiced(SR, 1.5, 140), silence(SR, 0.3), voiced(SR, 1.2, 150));
  const clip = concat(speech, silence(SR, 0.15), noiseBurst(SR, 0.12));

  it('is detected and cut at the burst start', () => {
    const at = findTailBurst(clip, SR);
    expect(at).toBeGreaterThanOrEqual(speech.length);
    expect(at).toBeLessThanOrEqual(speech.length + Math.round(0.15 * SR));
  });

  it('trimAndFade removes it: tail peak drops by >30 dB', () => {
    expect(tailPeakDb(clip, SR, 0.1)).toBeGreaterThan(-3);
    const out = trimAndFade(clip, SR);
    expect(peakDb(out)).toBeLessThan(-8); // only the speech (peak 8000) is left, no clipped burst
    expect(tailPeakDb(out, SR, 0.005)).toBeLessThan(-25); // faded
    expect(out.length).toBeLessThan(speech.length + Math.round(0.1 * SR));
  });

  it('leaves speech that merely ends loudly alone', () => {
    const plain = concat(speech, silence(SR, 0.2));
    expect(findTailBurst(plain, SR)).toBe(-1);
    const shortWordAfterPause = concat(voiced(SR, 1.5, 140), silence(SR, 0.2), voiced(SR, 0.3, 150));
    expect(findTailBurst(shortWordAfterPause, SR)).toBe(-1);
  });

  it('works on a view with a non-zero byteOffset (no garbage beyond the view)', () => {
    const big = new Int16Array(clip.length + 5000).fill(32767);
    big.set(clip, 2000);
    const view = big.subarray(2000, 2000 + clip.length);
    const out = trimAndFade(view, SR);
    expect(out.buffer.byteLength).toBe(out.length * 2);
    expect(peakDb(out)).toBeLessThan(-8);
  });

  it('real research clips: 3.8 models end with a burst, 3.1 does not; trim removes it', async () => {
    for (const name of ['ru_gemini-3.8-flash-lite-tts_0.wav', 'ru_gemini-3.8-flash-lite-tts_3.wav', 'en_gemini-3.8-flash-tts.wav']) {
      const w = await readResearchWav(name);
      if (!w) continue;
      expect(tailPeakDb(w.pcm, w.sampleRate)).toBeGreaterThan(-3);
      const out = trimAndFade(w.pcm, w.sampleRate);
      expect(tailPeakDb(out, w.sampleRate, 0.005)).toBeLessThan(-25);
      expect(out.length).toBeLessThan(w.pcm.length - Math.round(0.08 * w.sampleRate));
    }
    const ok = await readResearchWav('ru_gemini-3.1-flash-tts-preview_1.wav');
    if (ok) expect(findTailBurst(ok.pcm, ok.sampleRate)).toBe(-1);
  });
});

describe('estimateF0', () => {
  for (const f0 of [90, 120, 180, 250, 330]) {
    it(`finds ${f0} Hz on a harmonic tone (24 kHz)`, () => {
      const r = estimateF0(voiced(24000, 1.5, f0), 24000);
      expect(Math.abs(r.f0 - f0) / f0).toBeLessThan(0.03);
    });
  }
  it('works at 48 kHz and on a plain sine', () => {
    const sine = new Int16Array(48000).map((_, i) => Math.round(8000 * Math.sin((2 * Math.PI * 200 * i) / 48000)));
    expect(Math.abs(estimateF0(sine, 48000).f0 - 200)).toBeLessThan(4);
  });
  it('returns 0 for noise and silence', () => {
    expect(estimateF0(noiseBurst(SR, 1), SR).f0).toBe(0);
    expect(estimateF0(silence(SR, 1), SR).f0).toBe(0);
  });
  it('honours ranges', () => {
    const pcm = concat(voiced(SR, 1, 100), voiced(SR, 1, 220));
    expect(Math.abs(estimateF0(pcm, SR, { ranges: [[0, 1]] }).f0 - 100)).toBeLessThan(4);
    expect(Math.abs(estimateF0(pcm, SR, { ranges: [[1.05, 2]] }).f0 - 220)).toBeLessThan(6);
  });
});

describe('alignSentences', () => {
  const sent = (sec: number, f = 140) => voiced(SR, sec, f);
  const chars = (sec: number) => Math.round(sec * 14); // 14 chars per second

  it('cuts three sentences at the pauses', () => {
    const pcm = concat(sent(2), silence(SR, 0.35), sent(3), silence(SR, 0.35), sent(1.5));
    const r = alignSentences(pcm, SR, [chars(2), chars(3), chars(1.5)]);
    expect(r.ok).toBe(true);
    expect(r.cuts).toHaveLength(2);
    expect(Math.abs(r.cuts[0]! / SR - 2.175)).toBeLessThan(0.1);
    expect(Math.abs(r.cuts[1]! / SR - 5.525)).toBeLessThan(0.1);
    expect(r.ranges[0]![0]).toBe(0);
    expect(r.ranges[2]![1]).toBe(pcm.length);
  });

  it('ignores extra pauses the model added inside a sentence', () => {
    const pcm = concat(sent(1.2), silence(SR, 0.15), sent(1.3), silence(SR, 0.5), sent(2.5), silence(SR, 0.2), sent(1));
    const r = alignSentences(pcm, SR, [chars(2.65), chars(3.7)]);
    expect(r.ok).toBe(true);
    expect(Math.abs(r.cuts[0]! / SR - (1.2 + 0.15 + 1.3 + 0.25))).toBeLessThan(0.1);
  });

  it('single sentence: trivially ok', () => {
    const r = alignSentences(sent(2), SR, [20]);
    expect(r.ok).toBe(true);
    expect(r.ranges).toEqual([[0, 2 * SR]]);
  });

  it('no usable pauses (continuous speech) -> not ok', () => {
    const r = alignSentences(sent(5), SR, [30, 40]);
    expect(r.ok).toBe(false);
    expect(r.reason).toBeTruthy();
  });

  it('only a tiny pause between sentences -> not ok (caller falls back to per-segment calls)', () => {
    const pcm = concat(sent(2), silence(SR, 0.07), sent(3));
    expect(alignSentences(pcm, SR, [chars(2), chars(3)]).ok).toBe(false);
  });

  it('a lost sentence (audio much shorter than the text) -> not ok', () => {
    const pcm = concat(sent(2), silence(SR, 0.4), sent(0.5));
    expect(alignSentences(pcm, SR, [chars(2), chars(4)]).ok).toBe(false);
  });

  it('ambiguous pauses: either rejected or still cut at the right one', () => {
    const pcm = concat(sent(2), silence(SR, 0.2), sent(1), silence(SR, 0.9), sent(2));
    const r = alignSentences(pcm, SR, [chars(3.2), chars(2)]);
    if (r.ok) expect(Math.abs(r.cuts[0]! / SR - (3.2 + 0.45))).toBeLessThan(0.1);
  });
});
