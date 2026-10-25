import { describe, expect, it } from 'vitest';
import { normalizeSettings } from '../src/settings';
import { DEFAULT_SETTINGS } from '../src/types';
import { calibKey } from '../src/localtts/voiceMap';
import { selectionPatch, voiceListsState, voiceRowLabel } from '../src/ui/voicePicker';
import type { LocalTtsPanelInfo } from '../src/ui/localTtsSection';

const READY: LocalTtsPanelInfo = {
  env: { gpu: true, offscreen: true },
  units: { supertonic: { model: 'ready', loaded: 1, total: 1, rev: '', updatedAt: 1 } },
};

describe('voice lists visibility (never hidden)', () => {
  it('auto engine with nothing downloaded: lists are there, disabled, with the download offer', () => {
    const st = voiceListsState('auto', { env: { gpu: true, offscreen: true }, units: {} });
    expect(st.ready).toBe(false);
    expect(st.canDownload).toBe(true);
    expect(st.engine).toBe('supertonic-webgpu');
    expect(st.voices.m.map((v) => v.id)).toEqual(['M1', 'M2', 'M3', 'M4', 'M5']);
    expect(st.voices.f.map((v) => v.id)).toEqual(['F1', 'F2', 'F3', 'F4', 'F5']);
    expect(st.note).toMatch(/не скачана/);
    expect(voiceListsState('auto', null).voices.m.length).toBe(5); // no panel info at all: still shown
  });
  it('without WebGPU the rows are disabled with the reason and no download button', () => {
    const st = voiceListsState('supertonic-webgpu', { env: { gpu: false, offscreen: true }, units: {} });
    expect(st.ready).toBe(false);
    expect(st.canDownload).toBe(false);
    expect(st.note).toMatch(/WebGPU/);
  });
  it('a ready engine enables the rows; the Auto voice is the calibrated / prior one', () => {
    const pi = { ...READY, units: { supertonic: { ...READY.units.supertonic!, rev: '' } } };
    const st = voiceListsState('supertonic-wasm', { ...pi, env: { gpu: false, offscreen: true } });
    expect(st.engine).toBe('supertonic-wasm');
    expect(st.auto).toEqual({ m: 'M3', f: 'F3' });
    const cal: LocalTtsPanelInfo = { ...pi, calib: { [calibKey('supertonic-webgpu')]: { f0: { M1: 133, M2: 90, M3: 100, M4: 122, M5: 92, F1: 185, F2: 242, F3: 174, F4: 227, F5: 163 } } } };
    expect(voiceListsState('supertonic-webgpu', cal).auto).toEqual({ m: 'M3', f: 'F3' });
  });
  it('Silero: one voice per gender (eugene / xenia)', () => {
    const st = voiceListsState('silero-cpu', { env: {}, units: {} });
    expect(st.voices.m.map((v) => v.id)).toEqual(['eugene']);
    expect(st.voices.f.map((v) => v.id)).toEqual(['xenia']);
    expect(st.auto).toEqual({ m: 'eugene', f: 'xenia' });
  });
  it('row label carries the measured pitch', () => {
    expect(voiceRowLabel({ id: 'M3', label: 'M3 (муж.)', gender: 'm' }, 100)).toBe('M3 · 100 Гц');
    expect(voiceRowLabel({ id: 'M3', label: 'M3 (муж.)', gender: 'm' }, undefined)).toBe('M3 (муж.)');
  });
});

describe('selection -> settings', () => {
  it('maps a pick to its gender slot', () => {
    expect(selectionPatch('m', 'M4')).toEqual({ localTtsVoiceMale: 'M4' });
    expect(selectionPatch('f', 'auto')).toEqual({ localTtsVoiceFemale: 'auto' });
  });
  it('defaults are auto and survive normalisation', () => {
    expect([DEFAULT_SETTINGS.localTtsVoiceMale, DEFAULT_SETTINGS.localTtsVoiceFemale]).toEqual(['auto', 'auto']);
    const s = normalizeSettings({ localTtsVoiceMale: 'M4', localTtsVoiceFemale: 'F3' });
    expect([s.localTtsVoiceMale, s.localTtsVoiceFemale]).toEqual(['M4', 'F3']);
  });
  it('rejects a voice of the wrong gender or of another engine', () => {
    expect(normalizeSettings({ localTtsVoiceMale: 'F3' }).localTtsVoiceMale).toBe('auto');
    expect(normalizeSettings({ localTtsEngine: 'silero-cpu', localTtsVoiceFemale: 'F3' }).localTtsVoiceFemale).toBe('auto');
    expect(normalizeSettings({ localTtsVoiceMale: '../x' }).localTtsVoiceMale).toBe('auto');
  });
  it('migrates the single stored localTtsVoice into the slot of its gender', () => {
    const a = normalizeSettings({ localTtsEngine: 'supertonic-webgpu', localTtsVoice: 'F4' });
    expect([a.localTtsVoiceMale, a.localTtsVoiceFemale]).toEqual(['auto', 'F4']);
    const b = normalizeSettings({ localTtsEngine: 'silero-cpu', localTtsVoice: 'eugene' });
    expect([b.localTtsVoiceMale, b.localTtsVoiceFemale]).toEqual(['eugene', 'auto']);
    // explicit slots win over the legacy value
    const c = normalizeSettings({ localTtsVoice: 'M2', localTtsVoiceMale: 'M5' });
    expect(c.localTtsVoiceMale).toBe('M5');
  });
});
