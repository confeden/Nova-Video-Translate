import { describe, expect, it } from 'vitest';
import { LOUD_CEILING, levelDecodedSpeech, normalizeLoudness, softLimit, type LevelState } from '../src/providers/cascade/loudness';
import { layoutSequential } from '../src/providers/cascade/segments';

/** synthetic "speech": 200 Hz tone with a slow envelope, peak `peak` */
const tone = (peak: number, sec = 1, sr = 24000): Int16Array => {
  const n = Math.round(sec * sr);
  const o = new Int16Array(n);
  for (let i = 0; i < n; i++) o[i] = Math.round(peak * 32767 * Math.sin((2 * Math.PI * 200 * i) / sr) * (0.05 + 0.95 * Math.abs(Math.sin((2 * Math.PI * 3 * i) / sr)) ** 24));
  return o;
};

describe('normalizeLoudness', () => {
  it('levels quiet and loud words inside one dub, preserving silence and the peak ceiling', () => {
    const sr = 24000;
    const samples = Float32Array.from({ length: sr * 5 }, (_, i) => {
      const amp = i < sr ? 0 : i < sr * 3 ? 0.04 : 0.7;
      return amp * Math.sin(2 * Math.PI * 200 * i / sr);
    });
    const rms = (start: number, end: number) => Math.sqrt(samples.subarray(start * sr, end * sr).reduce((s, x) => s + x * x, 0) / ((end - start) * sr));
    levelDecodedSpeech([samples], sr);
    expect(rms(0, 0.8)).toBe(0);
    expect(rms(1.5, 2.5)).toBeGreaterThan(0.14);
    expect(rms(3.5, 4.5)).toBeCloseTo(rms(1.5, 2.5), 1);
    expect(samples.every((x) => Math.abs(x) <= LOUD_CEILING + 1e-6)).toBe(true);
  });
  it('links stereo gain and does not turn digital silence into noise', () => {
    const left = Float32Array.from({ length: 24000 }, (_, i) => 0.1 * Math.sin(i / 20));
    const right = left.map((x) => x / 2);
    levelDecodedSpeech([left, right], 24000);
    expect(left[10000]).toBeCloseTo(right[10000]! * 2, 4);
    const silence = new Float32Array(1000);
    levelDecodedSpeech([silence], 24000);
    expect(silence.every((x) => x === 0)).toBe(true);
  });
  it('lifts quiet speech (peak 0.4) to Yandex-like level without clipping', () => {
    const r = normalizeLoudness(tone(0.4));
    console.log('LOUDNESS quiet', JSON.stringify(r.stats));
    expect(r.stats.rmsAfter).toBeGreaterThan(r.stats.rmsBefore * 1.3);
    expect(r.stats.peakAfter).toBeLessThanOrEqual(LOUD_CEILING + 1e-3);
    expect(r.stats.gain).toBeLessThanOrEqual(5.01);
  });
  it('very quiet input is capped at +14 dB; loud input is not boosted into clipping', () => {
    expect(normalizeLoudness(tone(0.02)).stats.gain).toBeLessThanOrEqual(5.01);
    const loud = normalizeLoudness(tone(0.99));
    expect(loud.stats.peakAfter).toBeLessThanOrEqual(LOUD_CEILING + 1e-3);
    expect(loud.stats.gain).toBeLessThanOrEqual(1.01);
  });
  it('gain is smoothed across segments (no jumps) and silence is untouched', () => {
    const st: LevelState = {};
    const g1 = normalizeLoudness(tone(0.3), st).stats.gain;
    const g2 = normalizeLoudness(tone(0.6), st).stats.gain;
    const wanted2 = normalizeLoudness(tone(0.6), {}).stats.gain;
    expect(g2).toBeGreaterThan(wanted2); // pulled toward the previous gain, not a jump to the new target
    expect(g2).toBeLessThan(g1);
    const z = new Int16Array(100);
    expect(normalizeLoudness(z).samples).toBe(z);
  });
  it('soft limiter is identity below the knee and monotone below the ceiling', () => {
    expect(softLimit(0.3)).toBe(0.3);
    let prev = 0;
    for (let x = 0; x <= 4; x += 0.05) {
      const y = softLimit(x);
      expect(y).toBeGreaterThanOrEqual(prev - 1e-12);
      expect(y).toBeLessThan(LOUD_ceil());
      prev = y;
    }
    function LOUD_ceil() {
      return LOUD_CEILING + 1e-9;
    }
  });
  it('a quiet phrase after a loud phrase is not held below its own target', () => {
    const state: LevelState = {};
    normalizeLoudness(tone(0.99), state);
    const quiet = normalizeLoudness(tone(0.2), state);
    expect(quiet.stats.rmsAfter).toBeGreaterThan(0.18);
    expect(quiet.stats.peakAfter).toBeLessThanOrEqual(LOUD_CEILING + 1e-3);
  });
});

describe('layoutSequential', () => {
  it('shifts overflow instead of cutting, with a 0.15 s gap', () => {
    const p = layoutSequential([
      { start: 0, end: 2, sec: 3 },
      { start: 2, end: 4, sec: 2 },
    ]);
    expect(p[0]).toMatchObject({ start: 0, rate: 1 });
    expect(p[0]!.end).toBeCloseTo(3);
    expect(p[1]!.start).toBeCloseTo(3.15);
    expect(p[1]!.rate).toBe(1);
  });
  it('re-syncs to the source after a large caption gap (drift does not accumulate)', () => {
    const p = layoutSequential([
      { start: 0, end: 1, sec: 3 },
      { start: 1, end: 2, sec: 3 },
      { start: 30, end: 31, sec: 1 },
    ]);
    expect(p[1]!.drift).toBeGreaterThan(2);
    expect(p[2]!.start).toBe(30);
    expect(p[2]!.drift).toBe(0);
  });
  it('beyond the 4 s drift it first speeds up (<= 1.3) and never shortens the audio', () => {
    const items = Array.from({ length: 8 }, (_, i) => ({ start: i * 2, end: i * 2 + 2, sec: 3 }));
    const p = layoutSequential(items);
    expect(Math.max(...p.map((x) => x.rate))).toBeGreaterThan(1);
    expect(Math.max(...p.map((x) => x.rate))).toBeLessThanOrEqual(1.3 + 1e-9);
    p.forEach((x, i) => expect(x.end - x.start).toBeCloseTo(3 / x.rate, 6)); // whole audio plays
    for (let i = 1; i < p.length; i++) expect(p[i]!.start).toBeGreaterThanOrEqual(p[i - 1]!.end + 0.15 - 1e-9);
  });
});
