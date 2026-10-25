import { describe, expect, it } from 'vitest';
import { liveVideoVoiceOverride, normalizeSettings, withSiteOverride } from '../src/settings';
import { DEFAULT_SETTINGS } from '../src/types';
import { diag } from '../src/diag';
import { buildDiagReport, settingsSummary } from '../src/ui/status';
import { LiveGemini } from '../src/ui/videoController';

describe('settings', () => {
  it('autoTranslate: empty storage gives the default (on), only an explicit off stays off', () => {
    expect(normalizeSettings(undefined).autoTranslate).toBe('on');
    expect(normalizeSettings({}).autoTranslate).toBe('on');
    expect(normalizeSettings({ autoTranslate: 'junk' }).autoTranslate).toBe('on');
    expect(normalizeSettings({ autoTranslate: 'off' }).autoTranslate).toBe('off');
    expect(normalizeSettings({ autoTranslate: 'on' }).autoTranslate).toBe('on');
  });
  it('live-video override keeps cloud tiers when the host has no local provider', () => {
    expect(liveVideoVoiceOverride()).toMatchObject({ gemini: false, local: true });
    expect(liveVideoVoiceOverride(false)).toEqual({});
    expect(withSiteOverride(DEFAULT_SETTINGS, 'www.youtube.com', true, false).voiceEnabled).toEqual(DEFAULT_SETTINGS.voiceEnabled);
  });
  it('prerollPause defaults to off and only accepts on/off', () => {
    expect(normalizeSettings({}).prerollPause).toBe('off');
    expect(normalizeSettings({ prerollPause: 'on' }).prerollPause).toBe('on');
    expect(normalizeSettings({ prerollPause: 'yes' }).prerollPause).toBe('off');
  });

  it('ignores retired voice fields', () => {
    const s = normalizeSettings({ voiceMale: 'Puck', voiceFemale: 'Leda', voiceChild: 'x', geminiVoice: 'Aoede', subtitles: 'on' }) as unknown as Record<string, unknown>;
    for (const k of ['voiceMale', 'voiceFemale', 'voiceChild', 'geminiVoice']) expect(k in s).toBe(false);
    expect(s.subtitles).toBe('on');
  });
  it('clickAction defaults to settings and validates', () => {
    expect(normalizeSettings({}).clickAction).toBe('settings');
    expect(normalizeSettings({ clickAction: 'toggle' }).clickAction).toBe('toggle');
    expect(normalizeSettings({ clickAction: 'bogus' }).clickAction).toBe('settings');
  });
  it('LiveGemini signature has no voice', () => {
    const g = new LiveGemini(() => normalizeSettings({}), (async () => new Response('')) as never);
    expect(g.cacheSignature().voice).toBeUndefined();
  });
  it('diagnostic summary carries no keys or tokens', () => {
    const s = { ...normalizeSettings({ geminiKeys: ['AIzaSyDUMMYSECRET0123456789'] }), yandexToken: 'y0_SECRETTOKEN' };
    const text = buildDiagReport({ version: '9.9.9', settings: s, pageHost: 'example.com' });
    expect(text).not.toContain('AIza');
    expect(text).not.toContain('SECRET');
    expect(text).toContain('9.9.9');
    expect(text).toContain('example.com');
    expect(settingsSummary(s)).toMatchObject({ geminiCount: 1, yandexSignedIn: true, subtitles: false });
  });

  it('groqApiKey defaults to empty, trims and round-trips through storage', () => {
    expect(DEFAULT_SETTINGS.groqApiKey).toBe('');
    expect(normalizeSettings({}).groqApiKey).toBe('');
    expect(normalizeSettings({ groqApiKey: 42 }).groqApiKey).toBe('');
    const once = normalizeSettings({ groqApiKey: '  gsk_TESTONLY0000000000  ' });
    expect(once.groqApiKey).toBe('gsk_TESTONLY0000000000');
    const again = normalizeSettings(JSON.parse(JSON.stringify(once)));
    expect(again.groqApiKey).toBe('gsk_TESTONLY0000000000');
  });
  it('groqApiKey never reaches the diagnostic report or the diag log', () => {
    const s = normalizeSettings({ groqApiKey: 'gsk_TESTONLY0000000000' });
    expect(buildDiagReport({ version: '1.0.0', settings: s, pageHost: 'example.com' })).not.toContain('gsk_');
    expect(JSON.stringify(settingsSummary(s))).not.toContain('gsk_');
    diag.clear();
    diag.log('settings.saved', { groqApiKey: 'gsk_TESTONLY0000000000', groqLen: 22 });
    expect(diag.report()).not.toContain('gsk_');
    expect(diag.report()).toContain('[hidden]');
    diag.clear();
  });
});
