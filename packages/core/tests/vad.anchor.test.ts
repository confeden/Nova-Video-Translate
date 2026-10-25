import { describe, expect, it } from 'vitest';
import { anchorSentences } from '../src/localasr/anchor';
import { vadBursts } from '../src/localasr/vad';

const SR = 16000;
function synth(durSec: number, bursts: Array<[number, number]>, o: { floor?: number; bed?: number; amp?: number } = {}): Int16Array {
  const n = Math.round(durSec * SR);
  const out = new Int16Array(n);
  let seed = 777;
  const rnd = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296 - 0.5;
  };
  const floor = o.floor ?? 0.001;
  const amp = o.amp ?? 0.25;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const inB = bursts.some(([a, b]) => t >= a && t < b);
    // speech: 150 Hz tone + noise, syllabic AM 4 Hz (deep)
    const am = 0.5 + 0.5 * Math.sin(2 * Math.PI * 4 * t);
    let v = rnd() * 2 * floor;
    if (inB) v += amp * (0.15 + 0.85 * am * am) * (0.6 * Math.sin(2 * Math.PI * 150 * t) + 0.8 * rnd());
    if (o.bed) v += o.bed * Math.sin(2 * Math.PI * 440 * t);
    out[i] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
  }
  return out;
}
const near = (x: number, y: number, tol = 0.15): void => expect(Math.abs(x - y)).toBeLessThan(tol);

describe('vadBursts', () => {
  it('silence lead-in 4 s then speech', () => {
    const r = vadBursts(synth(8, [[4, 8]]));
    expect(r.bursts).toHaveLength(1);
    near(r.bursts[0]!.start, 4);
    near(r.bursts[0]!.end, 8, 0.2);
  });
  it('two bursts with a 0.6 s pause stay two', () => {
    const r = vadBursts(synth(8, [[1, 3], [3.6, 6]]));
    expect(r.bursts).toHaveLength(2);
    near(r.bursts[1]!.start, 3.6);
  });
  it('a short gap < 0.25 s is merged', () => {
    expect(vadBursts(synth(6, [[1, 2.5], [2.65, 4]])).bursts).toHaveLength(1);
  });
  it('no speech: silence, and a steady tone/music bed', () => {
    expect(vadBursts(new Int16Array(SR * 8)).bursts).toEqual([]);
    expect(vadBursts(synth(8, [], { bed: 0.2 })).bursts).toEqual([]);
  });
  it('speech over a loud steady bed is found, the bed alone is not', () => {
    const r = vadBursts(synth(8, [[3, 6]], { bed: 0.05, amp: 0.6 }));
    expect(r.bursts.length).toBeGreaterThan(0);
    expect(r.bursts[0]!.start).toBeGreaterThan(2.5);
    expect(r.bursts[r.bursts.length - 1]!.end).toBeLessThan(6.6);
  });
  it('cost per 8 s chunk is under 5 ms', () => {
    const pcm = synth(8, [[1, 3], [4, 7]]);
    vadBursts(pcm);
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) vadBursts(pcm);
    const ms = (performance.now() - t0) / 20;
    expect(ms).toBeLessThan(5);
  });
});

const B = (start: number, end: number) => ({ start, end, confidence: 1 });

describe('anchorSentences', () => {
  it('no bursts => empty', () => {
    expect(anchorSentences(['Hello there.'], [], 8)).toEqual([]);
  });
  it('"Uh oh." alone in the middle starts at its burst', () => {
    const a = anchorSentences(['Uh oh.'], [B(3.4, 4.2)], 8);
    near(a[0]!.start, 3.4, 0.01);
    expect(a[0]!.end).toBeLessThanOrEqual(4.2);
  });
  it('two bursts, 3 sentences: the 3rd starts at the 2nd burst onset', () => {
    const a = anchorSentences(['Well hello there my friend.', 'How are you.', 'I am fine today.'], [B(1, 3.5), B(4.1, 6)], 8);
    near(a[0]!.start, 1, 0.01);
    expect(a[2]!.start).toBeGreaterThanOrEqual(3.5);
    expect(a[1]!.start).toBeLessThan(4.1);
  });
  it('single long burst: proportional inside it', () => {
    const a = anchorSentences(['one two three four.', 'five six seven eight.'], [B(2, 6)], 8);
    near(a[0]!.start, 2, 0.01);
    near(a[1]!.start, 4, 0.1);
  });
  it('more bursts than sentences: sentence starts at its first burst', () => {
    const a = anchorSentences(['a b c d e f g h i j k l.'], [B(1, 2), B(2.5, 3.5), B(4, 5)], 8);
    expect(a).toHaveLength(1);
    near(a[0]!.start, 1, 0.01);
    expect(a[0]!.end).toBeLessThanOrEqual(5);
  });
  it('context bursts are excluded', () => {
    const a = anchorSentences(['New words here.'], [B(0.2, 1.4), B(2.5, 4)], 9.5, { contextSec: 1.5 });
    near(a[0]!.start, 2.5, 0.01);
    expect(anchorSentences(['x'], [B(0.2, 1.4)], 9.5, { contextSec: 1.5 })).toEqual([]);
  });
  it('regression: monotonic and inside [0, dur] on random layouts', () => {
    let seed = 5;
    const r = (): number => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (let it = 0; it < 200; it++) {
      const dur = 6 + r() * 4;
      const bs: ReturnType<typeof B>[] = [];
      let t = r() * 2;
      while (t < dur - 0.5 && bs.length < 5) {
        const len = 0.2 + r() * 2;
        bs.push(B(t, Math.min(dur, t + len)));
        t += len + 0.25 + r();
      }
      const texts = Array.from({ length: 1 + Math.floor(r() * 5) }, () => 'w '.repeat(1 + Math.floor(r() * 12)).trim() + '.');
      const out = anchorSentences(texts, bs, dur, { contextSec: r() < 0.5 ? 1.5 : 0 });
      let prev = 0;
      for (const s of out) {
        expect(s.start).toBeGreaterThanOrEqual(prev - 1e-9);
        expect(s.end).toBeGreaterThanOrEqual(s.start);
        expect(s.end).toBeLessThanOrEqual(dur + 1e-9);
        prev = s.end;
      }
    }
  });
});
