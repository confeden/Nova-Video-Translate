import { describe, expect, it } from 'vitest';
import { CueIndex } from '../src/ui/cueIndex';
import { subtitleMetrics } from '../src/ui/subtitleOverlay';

const c = (start: number, end: number, text: string) => ({ start, end, text });

describe('CueIndex', () => {
  const idx = new CueIndex([c(10, 12, 'b'), c(0, 2, 'a'), c(20, 25, 'd'), c(12, 15, 'c')]);
  it('finds cues by time regardless of input order', () => {
    expect(idx.at(0)?.text).toBe('a');
    expect(idx.at(1.99)?.text).toBe('a');
    expect(idx.at(10)?.text).toBe('b');
    expect(idx.at(12)?.text).toBe('c');
    expect(idx.at(24.9)?.text).toBe('d');
  });
  it('is undefined in gaps, before the first and after the last cue (end is exclusive)', () => {
    expect(idx.at(-1)).toBeUndefined();
    expect(idx.at(2)).toBeUndefined();
    expect(idx.at(16)).toBeUndefined();
    expect(idx.at(25)).toBeUndefined();
    expect(new CueIndex([]).at(5)).toBeUndefined();
  });
  it('overlapping cues: the latest-started active cue wins, a long earlier cue resumes after a short one', () => {
    const o = new CueIndex([c(0, 10, 'long'), c(2, 3, 'short'), c(2.5, 6, 'mid')]);
    expect(o.at(1)?.text).toBe('long');
    expect(o.at(2.2)?.text).toBe('short');
    expect(o.at(2.7)?.text).toBe('mid');
    expect(o.at(4)?.text).toBe('mid');
    expect(o.at(7)?.text).toBe('long');
    expect(o.at(10)).toBeUndefined();
  });
  it('drops empty / invalid cues', () => {
    const o = new CueIndex([c(1, 1, 'zero'), c(3, 2, 'neg'), c(0, 5, '  '), c(NaN, 4, 'nan'), c(0, 5, 'ok')]);
    expect(o.size).toBe(1);
  });
  it('handles many cues quickly', () => {
    const many = Array.from({ length: 50000 }, (_, i) => c(i, i + 0.9, `t${i}`));
    const m = new CueIndex(many);
    expect(m.at(31337.5)?.text).toBe('t31337');
    expect(m.at(31337.95)).toBeUndefined();
  });
});

describe('subtitleMetrics', () => {
  it('scales with the player', () => {
    const small = subtitleMetrics(480, 270);
    const big = subtitleMetrics(1920, 1080);
    expect(big.fontPx).toBeGreaterThan(small.fontPx);
    expect(big.bottomPx).toBeGreaterThan(small.bottomPx);
    expect(big.fontPx).toBeLessThanOrEqual(22);
    expect(small.fontPx).toBeGreaterThanOrEqual(14);
  });

  it('sits low in the frame (about 3.5% of the player height above the bottom)', () => {
    const big = subtitleMetrics(1920, 1080);
    expect(big.bottomPx).toBe(Math.round(1080 * 0.035));
    expect(big.bottomPx).toBeLessThan(1080 * 0.06);
  });
});
