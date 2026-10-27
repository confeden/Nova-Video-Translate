import { describe, expect, it } from 'vitest';
import { applyGate, noiseFloor } from '../src/playback/scheduler';

describe('dub noise floor and gate (0.3.6)', () => {
  const sr = 22050;
  const frame = Math.round(sr * 0.02);
  it('a clean silence has a very low floor, hiss has a higher one', () => {
    const clean = new Float32Array(sr).map((_, i) => (i > sr / 2 ? 0.3 * Math.sin(i / 10) : 0));
    const hiss = new Float32Array(sr).map((_, i) => (i > sr / 2 ? 0.3 * Math.sin(i / 10) : 0.003 * Math.sin(i * 1.7)));
    expect(noiseFloor(hiss, frame).floorDb).toBeGreaterThan(noiseFloor(clean, frame).floorDb + 20);
  });
  it('the gate silences quiet frames and keeps loud ones', () => {
    const x = new Float32Array(sr).map((_, i) => (i > sr / 2 ? 0.3 : 0.002));
    applyGate(x, frame, 0.004, sr);
    expect(Math.abs(x[2000]!)).toBeLessThan(1e-4);
    expect(Math.abs(x[sr - 100]!)).toBeGreaterThan(0.25);
  });
});

describe('hiss low-pass (0.3.7)', () => {
  it('a 7 kHz low-pass keeps 300 Hz and attenuates 10 kHz', async () => {
    const sr = 22050;
    const { lowPass } = await import('../src/playback/scheduler');
    const amp = (hz: number): number => {
      const x = new Float32Array(sr).map((_, i) => Math.sin((2 * Math.PI * hz * i) / sr));
      lowPass(x, sr, 7000);
      return Math.max(...x.subarray(sr / 2).map(Math.abs));
    };
    expect(amp(300)).toBeGreaterThan(0.8);
    expect(amp(10000)).toBeLessThan(0.45);
  });
});
