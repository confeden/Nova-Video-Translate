import { describe, expect, it } from 'vitest';
import { fitSegments } from '../src/providers/gemini/sync';

const seg = (start: number, end: number, ttsSeconds: number) => ({ start, end, ttsSeconds, text: 't' });

describe('fitSegments', () => {
  // [name, segments, opts, expectations for first segment]
  const table: [
    string,
    ReturnType<typeof seg>[],
    Parameters<typeof fitSegments>[1],
    { rate: number; borrowed: number; end: number; reshorten?: boolean; slowdown?: boolean },
  ][] = [
    ['fits in slot', [seg(0, 4, 3), seg(10, 14, 3)], {}, { rate: 1, borrowed: 0, end: 4 }],
    ['exact fit', [seg(0, 4, 4), seg(10, 14, 3)], {}, { rate: 1, borrowed: 0, end: 4 }],
    ['borrow silence, no speed-up', [seg(0, 4, 5), seg(10, 14, 3)], {}, { rate: 1, borrowed: 1, end: 5 }],
    ['borrow capped by maxBorrow then speed up', [seg(0, 4, 6.5), seg(20, 24, 3)], {}, { rate: 6.5 / 5.5, borrowed: 1.5, end: 5.5 }],
    ['borrow limited by next start', [seg(0, 4, 5), seg(4.5, 8, 3)], {}, { rate: 5 / 4.45, borrowed: 0.45, end: 4.45 }],
    ['back-to-back: speed up exactly', [seg(0, 4, 4.8), seg(4, 8, 3)], {}, { rate: 1.2, borrowed: 0, end: 4 }],
    ['back-to-back: over maxRate -> reshorten', [seg(0, 4, 6), seg(4, 8, 3)], {}, { rate: 1.25, borrowed: 0, end: 4.8, reshorten: true }],
    ['back-to-back: over maxRate -> video slowdown', [seg(0, 4, 6), seg(4, 8, 3)], { allowReshorten: false }, { rate: 1.25, borrowed: 0, end: 4.8, slowdown: true }],
    ['short slot, long tts', [seg(0, 1, 3), seg(1.1, 5, 2)], {}, { rate: 1.25, borrowed: 0.05, end: 2.4, reshorten: true }],
    ['zero-length slot', [seg(2, 2, 1), seg(8, 10, 1)], {}, { rate: 1, borrowed: 1, end: 3 }],
    ['custom maxRate', [seg(0, 4, 5.6), seg(4, 8, 1)], { maxRate: 1.5 }, { rate: 1.4, borrowed: 0, end: 4 }],
    ['zero tts', [seg(0, 4, 0), seg(10, 12, 1)], {}, { rate: 1, borrowed: 0, end: 4 }],
  ];

  it.each(table)('%s', (_name, segs, opts, exp) => {
    const r = fitSegments(segs, opts)[0]!;
    expect(r.rate).toBeCloseTo(exp.rate, 6);
    expect(r.borrowed).toBeCloseTo(exp.borrowed, 6);
    expect(r.end).toBeCloseTo(exp.end, 6);
    expect(r.needsReshorten).toBe(exp.reshorten ?? false);
    expect(r.needsVideoSlowdown).toBe(exp.slowdown ?? false);
    expect(r.start).toBe(segs[0]!.start);
    if (exp.slowdown) expect(r.videoRate).toBe(0.9);
    else expect(r.videoRate).toBeUndefined();
  });

  it('last segment borrows into the empty tail, bounded by limitEnd', () => {
    expect(fitSegments([seg(0, 4, 5)], {})[0]!.borrowed).toBe(1);
    expect(fitSegments([seg(0, 4, 5)], { limitEnd: 4.5 })[0]!.borrowed).toBeCloseTo(0.45, 6);
  });

  it('never drops segments and keeps order/length', () => {
    const segs = [seg(0, 1, 9), seg(1, 2, 9), seg(2, 3, 9), seg(3, 4, 9)];
    const out = fitSegments(segs);
    expect(out).toHaveLength(4);
    for (const r of out) {
      expect(r.rate).toBeGreaterThanOrEqual(1);
      expect(r.rate).toBeLessThanOrEqual(1.25);
      expect(r.needsReshorten).toBe(true);
      expect(r.overflow).toBeGreaterThan(0);
    }
  });

  it('empty input', () => {
    expect(fitSegments([])).toEqual([]);
  });

  it('empty gaps: borrowing is independent per segment (no cumulative shifts)', () => {
    const out = fitSegments([seg(0, 2, 3), seg(5, 7, 3), seg(12, 14, 2)]);
    expect(out.map((r) => r.borrowed)).toEqual([1, 1, 0]);
    expect(out.map((r) => r.rate)).toEqual([1, 1, 1]);
  });
});
