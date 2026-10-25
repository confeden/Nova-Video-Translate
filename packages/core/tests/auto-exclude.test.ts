import { describe, expect, it } from 'vitest';
import { isAutoExcluded, normalizeSettings, normHost } from '../src/settings';

describe('per-site auto-translate exclusion', () => {
  it('matches the exact host (www ignored), other sites unaffected', () => {
    const s = normalizeSettings({ autoTranslate: 'on', autoTranslateExcluded: ['WWW.Twitch.tv', 'twitch.tv', 5] });
    expect(s.autoTranslateExcluded).toEqual(['twitch.tv']);
    expect(isAutoExcluded(s, 'www.twitch.tv')).toBe(true);
    expect(isAutoExcluded(s, 'youtube.com')).toBe(false);
    expect(isAutoExcluded(s, 'clips.twitch.tv')).toBe(false);
    expect(normHost(undefined)).toBe('');
  });
  it('defaults to no exclusions', () => {
    expect(normalizeSettings({}).autoTranslateExcluded).toEqual([]);
  });
});
