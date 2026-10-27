import { describe, expect, it } from 'vitest';
import { buildWordTimeline, currentWord, layerPositionAt, lastWordAt } from '../src/ui/subtitleOverlay';

const cues = [
  { start: 10, end: 12, text: 'hello big world' },
  { start: 14, end: 15, text: 'again' },
];

describe('scrolling layer timeline (0.3.9)', () => {
  it('words share their phrase time in proportion to length and are in order', () => {
    const w = buildWordTimeline(cues, 'original');
    expect(w.map((x) => x.text)).toEqual(['hello', 'big', 'world', 'again']);
    expect(w[0]!.t0).toBeCloseTo(10, 6);
    expect(w[2]!.t1).toBeCloseTo(12, 6);
    expect(w[3]!.t0).toBeCloseTo(14, 6);
    for (let i = 1; i < w.length; i++) expect(w[i]!.x0).toBeGreaterThanOrEqual(w[i - 1]!.x0);
  });
  it('the layer is continuous: no jump between words, flat during a pause', () => {
    const w = buildWordTimeline(cues, 'original');
    expect(layerPositionAt(w, 12.5)).toBeCloseTo(w[2]!.x1, 6); // pause after the first phrase
    expect(layerPositionAt(w, 13.5)).toBeCloseTo(w[2]!.x1, 6);
    const a = layerPositionAt(w, 10.001);
    const b = layerPositionAt(w, 10.002);
    expect(Math.abs(b - a)).toBeLessThan(0.01);
  });
  it('the word being said is found, with a short hold after it ends', () => {
    const w = buildWordTimeline(cues, 'original');
    expect(lastWordAt(w, 10.01)).toBe(0);
    expect(currentWord(w, 10.01)).toBe(0);
    expect(currentWord(w, 13.0)).toBe(-1);
  });
  it('the translation timeline uses the translated text', () => {
    const t = buildWordTimeline([{ start: 0, end: 1, text: 'ÐŸÑ€Ð¸Ð²ÐµÑ‚ Ð¼Ð¸Ñ€', src: 'hi world' }], 'translation');
    expect(t.map((x) => x.text)).toEqual(['ÐŸÑ€Ð¸Ð²ÐµÑ‚', 'Ð¼Ð¸Ñ€']);
  });
});
