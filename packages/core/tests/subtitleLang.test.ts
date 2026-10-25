import { describe, expect, it } from 'vitest';
import { normalizeSettings } from '../src/settings';
import { DEFAULT_SETTINGS } from '../src/types';
import { cueDisplayText } from '../src/ui/subtitleOverlay';
import { normalizeCues } from '../src/subtitles/cues';

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
});
