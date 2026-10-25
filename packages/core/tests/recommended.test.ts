import { describe, expect, it } from 'vitest';
import { missingPieces, pairKey, recommendedLocalSetup, type InstalledPieces } from '../src/localasr/recommended';
import { normalizeSettings } from '../src/settings';
import { DEFAULT_SETTINGS } from '../src/types';
import { activeAutoText, installedFrom } from '../src/ui/localAsrSection';

const GPU = { webgpu: true, f16: true };
const CPU = { webgpu: false };

describe('recommendedLocalSetup', () => {
  it.each([
    ['gpu', GPU, 'en', 'onnx-community/whisper-small.en', 'gpu-mixed', 'supertonic-webgpu'],
    ['gpu', GPU, 'de', 'onnx-community/whisper-small', 'gpu-mixed', 'supertonic-webgpu'],
    ['gpu', GPU, undefined, 'onnx-community/whisper-small', 'gpu-mixed', 'supertonic-webgpu'],
    ['cpu', CPU, 'en', 'onnx-community/whisper-base.en', 'q8', 'silero-cpu'],
    ['cpu', CPU, 'de', 'onnx-community/whisper-base', 'q8', 'silero-cpu'],
    ['cpu', CPU, undefined, 'onnx-community/whisper-base', 'q8', 'silero-cpu'],
    ['webgpu without f16', { webgpu: true, f16: false }, 'en', 'onnx-community/whisper-base.en', 'q8', 'supertonic-webgpu'],
  ])('%s / %s', (_n, caps, lang, model, dtype, tts) => {
    for (const live of [false, true]) {
      const r = recommendedLocalSetup(caps, lang, live);
      expect(r.asr).toEqual({ modelId: model, dtype });
      expect(r.tts.engine).toBe(tts);
      expect(r.reasons.length).toBeGreaterThan(0);
      expect(r.reasons.some((x) => x.includes('Прямой эфир'))).toBe(live);
    }
  });
  it('translator: Chrome pair src->ru, pivot through en only when the direct pair is unavailable', () => {
    expect(recommendedLocalSetup(GPU, 'de', false).translator).toEqual({ pair: ['de', 'ru'], viaChrome: true });
    expect(recommendedLocalSetup(GPU, 'en', false).translator).toEqual({ pair: ['en', 'ru'], viaChrome: true });
    expect(recommendedLocalSetup(GPU, undefined, false).translator?.pair).toEqual(['en', 'ru']);
    expect(recommendedLocalSetup({ ...GPU, pairs: { [pairKey('da', 'ru')]: 'unavailable' } }, 'da-DK', false).translator).toEqual({ pair: ['da', 'ru'], pivot: 'en', viaChrome: true });
    expect(recommendedLocalSetup({ ...GPU, pairs: { [pairKey('en', 'ru')]: 'unavailable' } }, 'en', false).translator?.pivot).toBeUndefined();
  });
  it('a Russian source needs no translator', () => {
    expect(recommendedLocalSetup(GPU, 'ru', false).translator).toBeNull();
  });
});

describe('missingPieces', () => {
  const none: InstalledPieces = { asr: {}, tts: new Set(), pairs: {} };
  it('everything missing, in order translator, tts, asr', () => {
    const rec = recommendedLocalSetup(GPU, 'de', false);
    const m = missingPieces(rec, { ...none, pairs: { [pairKey('de', 'ru')]: 'downloadable' } });
    expect(m.map((p) => p.kind)).toEqual(['translator', 'tts', 'asr']);
  });
  it('installed pieces drop out; wrong dtype counts as missing', () => {
    const rec = recommendedLocalSetup(GPU, 'en', false);
    const full: InstalledPieces = { asr: { [rec.asr.modelId]: ['gpu-mixed'] }, tts: new Set(['supertonic-webgpu']), pairs: { [pairKey('en', 'ru')]: 'available' } };
    expect(missingPieces(rec, full)).toEqual([]);
    const q8only = missingPieces(rec, { ...full, asr: { [rec.asr.modelId]: ['q8'] } });
    expect(q8only).toMatchObject([{ kind: 'asr', dtype: 'gpu-mixed' }]);
  });
  it('a pivot recommendation lists both packs; unavailable/absent packs are not offered', () => {
    const rec = recommendedLocalSetup({ ...GPU, pairs: { [pairKey('da', 'ru')]: 'unavailable' } }, 'da', false);
    const m = missingPieces(rec, { asr: { [rec.asr.modelId]: ['gpu-mixed'] }, tts: new Set(['supertonic-webgpu']), pairs: { 'da-en': 'downloadable', 'en-ru': 'absent' } });
    expect(m).toMatchObject([{ kind: 'translator', src: 'da', tgt: 'en' }]);
  });
  it('panel adapter: nothing downloaded -> asr + tts missing; auto text says no active model', () => {
    const inst = installedFrom({ env: { gpu: true, f16: true, offscreen: true }, units: {} }, null, 'M1', {});
    expect(inst.tts.size).toBe(0);
    expect(inst.asr['onnx-community/whisper-small']).toEqual([]);
    expect(activeAutoText({ env: { offscreen: true }, units: {} }, 'en')).toContain('ни одна не скачана');
  });
});

describe('voiceOrder default and migration', () => {
  it('on-demand default: local before groq, gemini last', () => {
    expect(DEFAULT_SETTINGS.voiceOrder).toEqual(['yandex-live', 'yandex', 'local', 'groq', 'gemini']);
  });
  it('an untouched groq-first profile moves to the default; a customised one is kept', () => {
    expect(normalizeSettings({ voiceOrder: ['yandex-live', 'yandex', 'groq', 'local', 'gemini'] }).voiceOrder).toEqual(['yandex-live', 'yandex', 'local', 'groq', 'gemini']);
    expect(normalizeSettings({ voiceOrder: ['yandex', 'yandex-live', 'groq', 'local', 'gemini'] }).voiceOrder).toEqual(['yandex', 'yandex-live', 'groq', 'local', 'gemini']);
  });
});
