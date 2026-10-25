/**
 * Voice-check sample texts in each local TTS engine's own stress notation. Pure; used ONLY for the "check voice" samples
 * (ui/voicePicker.ts, ui/localTtsSection.ts), never for real translations.
 *
 * Evidence per engine (see tests/localttsStress.test.ts):
 *  - silero-cpu: '+' before the stressed vowel is a real symbol of the v5_ru table (SILERO_SYMBOLS) and a pre-marked word is
 *    kept by the accentor (silero/text.ts: haveStress).
 *  - piper-wasm: espeak-ng (the front-end) has no usable mark: tested with the bundled piper_phonemize wasm, U+0301 is ignored,
 *    capitals / '+' / [[phonemes]] are read as letters or spelled out, and brackets are stripped by normalizePiperText. Plain text.
 *  - supertonic-*: the model's unicode_indexer.json (pinned revision) has an id for U+0301 (combining acute, id 146) and
 *    preprocessForModel keeps it (NFKD), so the mark reaches the model after the stressed vowel. Whether the model was TRAINED to
 *    use it is unverified (by ear).
 *  - helper-omnivoice: no stress facility (research/local_tts_helper.md). Plain text.
 */
import type { LocalTtsEngineId } from './types';
import { LOCAL_TTS_SAMPLE_TEXT } from './catalog';

export const VOICE_SAMPLE_TEXT_PLAIN = 'Привет, это проверка голоса.';

/** Silero: '+' goes right before the stressed vowel; every word with 2+ vowels is marked ('ё' is left to the engine). */
const SILERO_SHORT = 'Прив+ет, +это пров+ерка г+олоса.';
const SILERO_LONG =
  'Сег+одня мы разбер+ём, как устр+оены соврем+енные электр+ические автомоб+или. Батар+ея хран+ит эн+ергию, а дв+игатель превращ+ает её в движ+ение. В конц+е в+идео я покаж+у, ск+олько +это ст+оит.';

/** '+' before the vowel -> combining acute after it */
const toAcute = (t: string): string => t.replace(/\+(.)/gu, '$1́');

export interface StressedSample {
  short: string;
  long: string;
}

export function stressedSample(engineId: LocalTtsEngineId | string): StressedSample {
  if (engineId === 'silero-cpu') return { short: SILERO_SHORT, long: SILERO_LONG };
  if (engineId.startsWith('supertonic')) return { short: toAcute(SILERO_SHORT), long: toAcute(SILERO_LONG) };
  return { short: VOICE_SAMPLE_TEXT_PLAIN, long: LOCAL_TTS_SAMPLE_TEXT };
}
