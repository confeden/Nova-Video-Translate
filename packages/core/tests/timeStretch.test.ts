import { describe, expect, it } from 'vitest';
import { timeStretch } from '../src/audio/timeStretch';

const SR = 24000;
const sine = (hz: number, sec: number, sr = SR): Float32Array => Float32Array.from({ length: Math.round(sec * sr) }, (_, i) => 0.5 * Math.sin((2 * Math.PI * hz * i) / sr));
const rms = (a: Float32Array): number => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);
/** frequency from rising zero crossings */
const zcHz = (a: Float32Array, sr: number): number => {
  let first = -1;
  let last = -1;
  let n = 0;
  for (let i = 1; i < a.length; i++) {
    if (a[i - 1]! < 0 && a[i]! >= 0) {
      if (first < 0) first = i;
      last = i;
      n++;
    }
  }
  return ((n - 1) * sr) / (last - first);
};
/** voice-like test signal: 120 Hz pulse train shaped by harmonics with a slow amplitude envelope */
const voiced = (sec: number): Float32Array =>
  Float32Array.from({ length: Math.round(sec * SR) }, (_, i) => {
    const t = i / SR;
    let v = 0;
    for (let h = 1; h <= 8; h++) v += Math.sin(2 * Math.PI * 120 * h * t) / h;
    return 0.3 * v * (0.6 + 0.4 * Math.sin(2 * Math.PI * 3 * t));
  });

describe('timeStretch', () => {
  it('shortens the output by the factor', () => {
    const x = sine(150, 2);
    for (const f of [1.1, 1.25, 1.5]) expect(Math.abs(timeStretch(x, SR, f).length - x.length / f)).toBeLessThanOrEqual(1);
  });

  it('keeps the energy (RMS within 10%)', () => {
    for (const x of [sine(150, 2), voiced(2)]) {
      const y = timeStretch(x, SR, 1.25);
      expect(Math.abs(rms(y) / rms(x) - 1)).toBeLessThan(0.1);
    }
  });

  it('keeps the pitch of a 150 Hz sine (zero-crossing frequency within 3%)', () => {
    const y = timeStretch(sine(150, 2), SR, 1.25);
    expect(Math.abs(zcHz(y, SR) / 150 - 1)).toBeLessThan(0.03);
    const y2 = timeStretch(sine(150, 2, 16000), 16000, 1.5);
    expect(Math.abs(zcHz(y2, 16000) / 150 - 1)).toBeLessThan(0.03);
  });

  it('has no clicks at the joins (no sample-to-sample jump of a smooth signal)', () => {
    const x = sine(150, 2);
    const y = timeStretch(x, SR, 1.25);
    let maxStep = 0;
    for (let i = 1; i < y.length; i++) maxStep = Math.max(maxStep, Math.abs(y[i]! - y[i - 1]!));
    const refStep = 0.5 * 2 * Math.PI * (150 / SR);
    expect(maxStep).toBeLessThan(refStep * 1.5);
  });

  it('is the identity for |factor - 1| < 0.01 and for degenerate input', () => {
    const x = sine(150, 0.5);
    expect(timeStretch(x, SR, 1.005)).toBe(x);
    expect(timeStretch(x, SR, 1)).toBe(x);
    expect(timeStretch(new Float32Array(0), SR, 1.25)).toHaveLength(0);
  });

  it('handles inputs shorter than a frame', () => {
    const y = timeStretch(sine(150, 0.01), SR, 1.3);
    expect(y.length).toBe(Math.round(240 / 1.3));
    expect(y.every(Number.isFinite)).toBe(true);
  });

  it('is cheap (5 s of audio well under 100 ms)', () => {
    const x = voiced(5);
    timeStretch(x, SR, 1.25);
    const t0 = performance.now();
    timeStretch(x, SR, 1.25);
    expect(performance.now() - t0).toBeLessThan(100);
  });
});
