import { describe, expect, it } from 'vitest';
import { normalizeSettings } from '../src/settings';
import { DEFAULT_SETTINGS } from '../src/types';
import { cueDisplayText } from '../src/ui/subtitleOverlay';
import { attachOriginal, mergeCues, normalizeCues } from '../src/subtitles/cues';
import { parseJson3 } from '../src/subtitles/json3';

describe('subtitleLang', () => {
  it('defaults to original and normalises junk', () => {
    expect(DEFAULT_SETTINGS.subtitleLang).toBe('original');
    expect(normalizeSettings({}).subtitleLang).toBe('original');
    expect(normalizeSettings({ subtitleLang: 'bogus' }).subtitleLang).toBe('original');
    expect(normalizeSettings({ subtitleLang: 'translation' }).subtitleLang).toBe('translation');
  });
  it('picks the cue text, falling back to the translation', () => {
    const c = { start: 0, end: 1, src: 'Hello', text: 'ÐŸÑ€Ð¸Ð²ÐµÑ‚' };
    expect(cueDisplayText(c, 'original')).toBe('Hello');
    expect(cueDisplayText(c, 'translation')).toBe('ÐŸÑ€Ð¸Ð²ÐµÑ‚');
    expect(cueDisplayText({ start: 0, end: 1, text: 'ÐŸÑ€Ð¸Ð²ÐµÑ‚' }, 'original')).toBe('ÐŸÑ€Ð¸Ð²ÐµÑ‚');
    expect(cueDisplayText(undefined, 'original')).toBe('');
  });
  it('src survives normalizeCues', () => {
    expect(normalizeCues([{ start: 0, end: 1, src: 'a', text: 'Ð±' }])[0]!.src).toBe('a');
  });
  it('rolling auto-caption lines are translated once: only the new words survive parseJson3', () => {
    const json = JSON.stringify({
      events: [
        { tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: 'so we went to' }] },
        { tStartMs: 2000, dDurationMs: 2000, segs: [{ utf8: 'went to the boss room' }] },
        { tStartMs: 4000, dDurationMs: 2000, segs: [{ utf8: 'the boss room now' }] },
      ],
    });
    expect(parseJson3(json).map((c) => c.text)).toEqual(['so we went to', 'the boss room', 'now']);
  });
  it('a layer cue whose middle is already on screen is not shown twice', () => {
    const voice = [{ start: 0, end: 6, text: 'Привет всем' }];
    const whole = [
      { start: 0, end: 3, text: 'Привет' },
      { start: 3, end: 6, text: 'всем' },
      { start: 6, end: 8, text: 'дальше' },
    ];
    expect(mergeCues([voice, whole]).map((c) => c.text)).toEqual(['Привет всем', 'дальше']);
  });
  it('attachOriginal does not double rolling caption words', () => {
    const original = [
      { start: 0, end: 2, text: 'Hello world' },
      { start: 2, end: 4, text: 'world again' },
    ];
    const out = attachOriginal([{ start: 0, end: 4, text: 'Привет мир' }], original);
    expect(out[0]!.src).toBe('Hello world again');
  });
  it('attachOriginal gives translated cues the overlapping original text', () => {
    const original = [
      { start: 0, end: 2, text: 'Hello' },
      { start: 2, end: 4, text: 'world' },
      { start: 4, end: 6, text: 'again' },
    ];
    const translated = [
      { start: 0, end: 3, text: 'Привет' },
      { start: 3, end: 6, text: 'мир' },
      { start: 10, end: 11, text: 'позже' },
    ];
    const out = attachOriginal(translated, original);
    expect(out.map((c) => c.src)).toEqual(['Hello world', 'world again', undefined]);
    expect(out.map((c) => c.text)).toEqual(['Привет', 'мир', 'позже']);
    expect(cueDisplayText(out[0], 'original')).toBe('Hello world');
  });
});
