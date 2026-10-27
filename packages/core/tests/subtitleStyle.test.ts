import { describe, expect, it } from 'vitest';
import { DEFAULT_SUB_STYLE, hexAlpha, normalizeSubStyle, splitWords } from '../src/ui/subtitleStyle';
import { normalizeSettings } from '../src/settings';

describe('subtitle style (0.3.0)', () => {
  it('defaults keep the old look: 100%, first font, weight 500, white, centred, 2 lines', () => {
    expect(normalizeSubStyle(undefined)).toEqual(DEFAULT_SUB_STYLE);
    expect(DEFAULT_SUB_STYLE).toMatchObject({ size: 100, weight: 500, color: '#ffffff', align: 'center', lines: 2, textTransparency: 20, bgTransparency: 25 });
  });
  it('unknown values fall back, numbers are clamped', () => {
    const s = normalizeSubStyle({ size: 999, font: 42, weight: 123, color: '#123456', align: 'justify', lines: 7, ticker: 'yes', highlight: 1 });
    expect(s).toEqual({ ...DEFAULT_SUB_STYLE, size: 160, font: 4, lines: 3 });
  });
  it('keeps valid picks', () => {
    const s = normalizeSubStyle({ size: 80, font: 2, weight: 900, color: '#ffd60a', align: 'left', lines: 1, ticker: true, highlight: true, frame: false, textTransparency: 50, bgTransparency: 80 });
    expect(s).toEqual({ size: 80, font: 2, weight: 900, color: '#ffd60a', frame: false, textTransparency: 50, bgTransparency: 80, align: 'left', lines: 1, ticker: true, highlight: true });
  });
  it('a stored settings profile without subStyle gets the default; a stored one survives', () => {
    expect(normalizeSettings({}).subStyle).toEqual(DEFAULT_SUB_STYLE);
    expect(normalizeSettings({ subStyle: { size: 130 } }).subStyle.size).toBe(130);
  });
  it('gemini is off by default', () => {
    expect(normalizeSettings({}).voiceEnabled.gemini).toBe(false);
  });
  it('splitWords keeps every character and marks original-language (Latin) words', () => {
    const parts = splitWords('Hello мир, это test!');
    expect(parts.map((p) => p.text).join('')).toBe('Hello мир, это test!');
    expect(parts.filter((p) => p.hit).map((p) => p.text)).toEqual(['Hello', 'test']);
    expect(splitWords('')).toEqual([]);
  });
  it('hexAlpha builds rgba', () => {
    expect(hexAlpha('#ffd60a', 0.5)).toBe('rgba(255,214,10,0.5)');
  });
});
