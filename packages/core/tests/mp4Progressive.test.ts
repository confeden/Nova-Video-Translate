import { describe, expect, it } from 'vitest';
import { adtsFrame, sampleAt, type Mp4AudioIndex } from '../src/capture/mp4Progressive';

const ix = (n: number): Mp4AudioIndex => ({
  sampleRate: 44100, channels: 2, profile: 1, durationSec: n * 0.5,
  startsSec: Float64Array.from({ length: n }, (_, i) => i * 0.5), offsets: new Float64Array(n), sizes: new Uint32Array(n),
});

describe('progressive mp4 audio', () => {
  it('wraps a raw AAC sample into a valid ADTS frame', () => {
    const f = adtsFrame(new Uint8Array(10), ix(1), 1.5);
    expect([...f.data.subarray(0, 4)]).toEqual([0xff, 0xf1, 0x50, 0x80]); // LC, 44.1 kHz, stereo
    const len = ((f.data[3]! & 3) << 11) | (f.data[4]! << 3) | (f.data[5]! >> 5);
    expect(len).toBe(17);
    expect(f.pts).toBe(1.5);
  });
  it('finds the first sample at or after a time', () => {
    expect(sampleAt(ix(10), 0)).toBe(0);
    expect(sampleAt(ix(10), 2.2)).toBe(5);
    expect(sampleAt(ix(10), 99)).toBe(9);
  });
});
