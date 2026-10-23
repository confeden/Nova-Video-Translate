import { describe, expect, it } from 'vitest';
import { LOUD_CEILING, normalizeLoudness, softLimit, type LevelState } from '../src/providers/cascade/loudness';
import { layoutSequential } from '../src/providers/cascade/segments';

/** synthetic "speech": 200 Hz tone with a slow envelope, peak `peak` */
const tone = (peak: number, sec = 1, sr = 24000): Int16Array => {
  const n = Math.round(sec * sr);
  const o = new Int16Array(n);
  for (let i = 0; i < n; i++) o[i] = Math.round(peak * 32767 * Math.sin((2 * Math.PI * 200 * i) / sr) * (0.05 + 0.95 * Math.abs(Math.sin((2 * Math.PI * 3 * i) / sr)) ** 24));
  return o;
};

describe('normalizeLoudness', () => {
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
