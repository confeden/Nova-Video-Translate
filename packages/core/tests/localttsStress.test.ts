import { describe, expect, it } from 'vitest';
import { LOCAL_TTS_SAMPLE_TEXT } from '../src/localtts/catalog';
import { SILERO_SYMBOLS } from '../src/localtts/silero/constants';
import { prepareSileroText } from '../src/localtts/silero/text';
import { VOICE_SAMPLE_TEXT_PLAIN, stressedSample } from '../src/localtts/stress';
import { VOICE_SAMPLE_TEXT } from '../src/ui/voicePicker';

const VOWELS = 'аоуыэиеяёю';
const words = (t: string): string[] => t.toLowerCase().match(/[\p{L}+]+/gu) ?? [];

describe('stressedSample', () => {
  it('plain short sample stays in sync with the voice picker', () => {
    expect(VOICE_SAMPLE_TEXT_PLAIN).toBe(VOICE_SAMPLE_TEXT);
  });
  it('silero: only symbols of the v5_ru table, text unchanged apart from "+"', () => {
    const s = stressedSample('silero-cpu');
    for (const [marked, plain] of [[s.short, VOICE_SAMPLE_TEXT], [s.long, LOCAL_TTS_SAMPLE_TEXT]] as const) {
      expect(marked.replaceAll('+', '')).toBe(plain);
      for (const c of marked.toLowerCase()) expect(SILERO_SYMBOLS.includes(c), `symbol ${c}`).toBe(true);
      expect(prepareSileroText(marked).sentence).toContain('+');
      for (const w of words(marked)) {
        const letters = w.replaceAll('+', '');
        const vowels = [...letters].filter((c) => VOWELS.includes(c)).length;
        const marks = w.split('+').length - 1;
        if (vowels >= 2 && letters !== 'её') expect(marks, w).toBe(1);
        if (marks) expect(VOWELS.includes(w[w.indexOf('+') + 1]!), w).toBe(true);
      }
    }
  });
  it('engines without a proven notation get the plain texts', () => {
    for (const id of ['piper-wasm', 'helper-omnivoice']) {
      expect(stressedSample(id)).toEqual({ short: VOICE_SAMPLE_TEXT, long: LOCAL_TTS_SAMPLE_TEXT });
    }
  });
  it('supertonic gets combining acute after the stressed vowel', () => {
    const s = stressedSample('supertonic-webgpu');
    expect(s.short).toBe('Приве́т, э́то прове́рка го́лоса.');
    expect(s.long).not.toContain('+');
  });
});
