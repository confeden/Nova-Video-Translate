import { describe, expect, it } from 'vitest';
import { mergeCuesToPhrases } from '../src/ui/subtitlePhrases';

describe('mergeCuesToPhrases (0.3.5)', () => {
  it('joins fragments into a sentence', () => {
    const out = mergeCuesToPhrases([
      { start: 1, end: 1.5, text: 'Hello' },
      { start: 1.5, end: 2, text: 'there my' },
      { start: 2, end: 3, text: 'friend.' },
      { start: 3.2, end: 4, text: 'Next one' },
    ]);
    expect(out.map((c) => c.text)).toEqual(['Hello there my friend.', 'Next one']);
    expect(out[0]).toMatchObject({ start: 1, end: 3 });
  });
  it('drops the repeated part of rolling captions', () => {
    const out = mergeCuesToPhrases([
      { start: 0, end: 2, text: 'we are going' },
      { start: 2, end: 4, text: 'we are going to the store' },
    ]);
    expect(out).toEqual([{ start: 0, end: 4, text: 'we are going to the store' }]);
  });
  it('a long pause or a long phrase starts a new one', () => {
    expect(mergeCuesToPhrases([{ start: 0, end: 1, text: 'a' }, { start: 3, end: 4, text: 'b' }]).length).toBe(2);
    const many = Array.from({ length: 30 }, (_, i) => ({ start: i * 0.5, end: i * 0.5 + 0.5, text: 'w' }));
    expect(mergeCuesToPhrases(many).every((c) => c.text.split(' ').length <= 16)).toBe(true);
  });
  it('keeps the original-language line in step', () => {
    const out = mergeCuesToPhrases([{ start: 0, end: 1, text: 'Привет', src: 'Hi' }, { start: 1, end: 2, text: 'мир.', src: 'there.' }]);
    expect(out[0]).toMatchObject({ text: 'Привет мир.', src: 'Hi there.' });
  });
});
