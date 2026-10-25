import { describe, expect, it } from 'vitest';
import { analyzeSpeech, placeSentences, speechOnsetSec } from '../src/localasr/speechPlacement';
import { splitPlainTranscript, whisperToSegments } from '../src/localasr/whisperText';

const SR = 16000;
/** 16 kHz clip: bursts of speech-like noise at [from,to) seconds over a faint noise floor */
function clip(durSec: number, bursts: Array<[number, number]>, floor = 0.0008): Int16Array {
  const n = Math.round(durSec * SR);
  const out = new Int16Array(n);
  let seed = 12345;
  const rnd = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296 - 0.5;
  };
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const inBurst = bursts.some(([a, b]) => t >= a && t < b);
    // syllable-like amplitude modulation inside a burst, never fully silent for > 0.1 s
    const env = inBurst ? 0.15 + 0.1 * Math.sin(2 * Math.PI * 4 * t) : floor;
    out[i] = Math.round(rnd() * 2 * env * 32767);
  }
  return out;
}

describe('analyzeSpeech', () => {
  it('silence lead-in of 4 s, then speech: onset ~4 s, offset at the clip end', () => {
    const a = analyzeSpeech(clip(8, [[4, 8]]))!;
    expect(a.structured).toBe(true);
    expect(a.onset).toBeGreaterThan(3.9);
    expect(a.onset).toBeLessThan(4.1);
    expect(a.offset).toBeGreaterThan(7.9);
    expect(a.valleys).toEqual([]);
  });
  it('speech throughout: no contrast needed to span the whole clip, onset 0', () => {
    const a = analyzeSpeech(clip(8, [[0, 8]]))!;
    expect(a.onset).toBeLessThan(0.1);
    expect(a.offset).toBeGreaterThan(7.9);
  });
  it('two bursts: onset/offset of the outer edges and one valley between', () => {
    const a = analyzeSpeech(clip(8, [[1, 2.5], [5, 7]]))!;
    expect(a.onset).toBeGreaterThan(0.9);
    expect(a.onset).toBeLessThan(1.1);
    expect(a.offset).toBeGreaterThan(6.9);
    expect(a.offset).toBeLessThan(7.1);
    expect(a.valleys).toHaveLength(1);
    expect(a.valleys[0]!.start).toBeGreaterThan(2.4);
    expect(a.valleys[0]!.end).toBeLessThan(5.1);
  });
  it('pure silence has no speech; a constant tone is unstructured (whole clip)', () => {
    expect(analyzeSpeech(new Int16Array(SR * 4))).toBeUndefined();
    expect(analyzeSpeech(clip(4, [], 0.0002))).toBeUndefined();
    const tone = new Int16Array(SR * 4).map((_, i) => Math.round(Math.sin(i / 7) * 8000));
    const a = analyzeSpeech(tone)!;
    expect(a.structured).toBe(false);
    expect(speechOnsetSec(tone)).toBe(0);
  });
  it('a 40 ms click is not speech', () => {
    expect(analyzeSpeech(clip(4, [[1, 1.04]]))).toBeUndefined();
  });
});

describe('placeSentences', () => {
  it('first sentence starts at the onset, the last ends at the offset (silence lead-in 4 s)', () => {
    const a = analyzeSpeech(clip(8, [[4, 8]]));
    const r = placeSentences(['Hello there my friend.', 'How are you doing today?'], 8, a);
    expect(r[0]!.start).toBeGreaterThan(3.9);
    expect(r[1]!.end).toBeGreaterThan(7.9);
    // proportional inside [onset, offset] (22 vs 24 chars)
    expect(r[1]!.start).toBeGreaterThan(5.8);
    expect(r[1]!.start).toBeLessThan(6.2);
    expect(r[0]!.end).toBeLessThanOrEqual(r[1]!.start);
  });
  it('speech throughout reproduces the old proportional spread over the clip', () => {
    const a = analyzeSpeech(clip(8, [[0, 8]]));
    const r = placeSentences(['aaaa.', 'bbbb.'], 8, a);
    expect(r[0]!.start).toBeLessThan(0.1);
    expect(r[1]!.start).toBeGreaterThan(3.8);
    expect(r[1]!.start).toBeLessThan(4.2);
  });
  it('two bursts: the boundary snaps to the valley and the next sentence starts where the second burst begins', () => {
    const a = analyzeSpeech(clip(8, [[1, 2.5], [5, 7]]));
    // equal lengths: the proportional boundary is at 1 + 6/2 = 4.0; the valley centre is ~3.75 (within 0.6 s)
    const r = placeSentences(['First part.', 'Other part.'].map((t) => t.padEnd(11, '.')), 8, a);
    expect(r[0]!.start).toBeGreaterThan(0.9);
    expect(r[0]!.end).toBeLessThan(2.7);
    expect(r[1]!.start).toBeGreaterThan(4.9);
    expect(r[1]!.start).toBeLessThan(5.1);
    expect(r[1]!.end).toBeGreaterThan(6.9);
  });
  it('no analysis: whole clip; empty input: nothing; never before the onset or out of order', () => {
    expect(placeSentences(['a'], 5, undefined)).toEqual([{ start: 0, end: 5, text: 'a' }]);
    expect(placeSentences([' ', ''], 5, undefined)).toEqual([]);
    const a = analyzeSpeech(clip(8, [[1, 1.8], [2.2, 3], [3.4, 4.2], [6, 7]]));
    const r = placeSentences(['One.', 'Two.', 'Three.', 'Four.', 'Five.'], 8, a);
    for (let i = 0; i < r.length; i++) {
      expect(r[i]!.start).toBeGreaterThanOrEqual(a!.onset - 1e-9);
      expect(r[i]!.end).toBeGreaterThanOrEqual(r[i]!.start);
      if (i > 0) expect(r[i]!.start).toBeGreaterThanOrEqual(r[i - 1]!.end - 1e-9);
    }
  });
});

describe('whisperToSegments with the clip PCM', () => {
  it('a text-only transcript of a clip with a 4 s lead-in is NOT placed before the speech', () => {
    const pcm = clip(8, [[4, 8]]);
    const segs = whisperToSegments({ text: ' Okay, refresh the browser. That will probably end it.' }, 8, pcm);
    expect(segs).toHaveLength(2);
    expect(segs[0]!.start).toBeGreaterThan(3.9);
    // the old behaviour (no pcm) started at 0
    expect(whisperToSegments({ text: ' Okay, refresh the browser. That will probably end it.' }, 8)[0]!.start).toBe(0);
    expect(splitPlainTranscript('x.', 8, clip(8, [[4, 8]]))[0]!.start).toBeGreaterThan(3.9);
  });
  it('timed chunks are kept as they are (pcm only matters without timestamps)', () => {
    const segs = whisperToSegments({ chunks: [{ text: ' Hi.', timestamp: [1, 2] }] }, 8, clip(8, [[4, 8]]));
    expect(segs).toEqual([{ start: 1, end: 2, text: 'Hi.' }]);
  });
});
