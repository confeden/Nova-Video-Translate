/**
 * Static description of the in-browser local TTS engines (D30): groups, labels, voices, download units. Pure: used by the
 * settings UI, the registry/settings normalisation, the service worker and the offscreen runtime alike.
 * A "unit" is what one click downloads: Supertonic = one unit shared by its WebGPU and WASM engines, Silero = one unit,
 * Piper = one unit per voice (shared phonemizer data + that voice's model).
 */
import type { LocalTtsEngineId, LocalTtsVoiceInfo } from './types';
import { MODEL_FILES, SUPERTONIC_BASE_URL, SUPERTONIC_REVISION, type ModelFile } from './supertonic/constants';
import { SILERO_BASE_URL, SILERO_FALLBACK_BASE_URL, SILERO_DEFAULT_VOICE, SILERO_FILES, SILERO_REVISION, SILERO_VOICES } from './silero/constants';
import { PIPER_COMMON_FILES, PIPER_DEFAULT_VOICE, PIPER_REVISION, PIPER_VOICES, PIPER_VOICES_BASE_URL, piperVoiceFiles } from './piper/constants';

export type LocalTtsGroup = 'gpu' | 'cpu';

export interface LocalTtsEngineInfo {
  id: LocalTtsEngineId;
  group: LocalTtsGroup;
  /** Russian display name */
  label: string;
  /** Russian speed note shown next to the name */
  speedNote: string;
  needsGpu: boolean;
  voices: readonly LocalTtsVoiceInfo[];
  defaultVoice: string;
  /** the engine downloads one unit per voice */
  perVoiceUnit: boolean;
}

export interface LocalTtsUnit {
  id: string;
  /** OPFS directory family: several units may share one pack directory */
  pack: 'supertonic' | 'silero' | 'piper';
  rev: string;
  baseUrl: string;
  /** tried in order when the download from baseUrl fails */
  fallbackBaseUrls?: readonly string[];
  files: readonly ModelFile[];
  total: number;
  /** false = files cannot be fetched yet (no base URL and no absolute file URLs) */
  published: boolean;
}

const SUPERTONIC_VOICES: LocalTtsVoiceInfo[] = [
  ...['M1', 'M2', 'M3', 'M4', 'M5'].map((id) => ({ id, label: `${id} (муж.)`, gender: 'm' as const })),
  ...['F1', 'F2', 'F3', 'F4', 'F5'].map((id) => ({ id, label: `${id} (жен.)`, gender: 'f' as const })),
];

export const LOCAL_TTS_ENGINES: readonly LocalTtsEngineInfo[] = [
  { id: 'supertonic-webgpu', group: 'gpu', label: 'Supertonic 3', speedNote: 'очень быстро', needsGpu: true, voices: SUPERTONIC_VOICES, defaultVoice: 'M1', perVoiceUnit: false },
  { id: 'silero-cpu', group: 'cpu', label: 'Silero v5', speedNote: 'в реальном времени', needsGpu: false, voices: SILERO_VOICES, defaultVoice: SILERO_DEFAULT_VOICE, perVoiceUnit: false },
  { id: 'piper-wasm', group: 'cpu', label: 'Piper', speedNote: 'в реальном времени, звучит роботизированно', needsGpu: false, voices: PIPER_VOICES, defaultVoice: PIPER_DEFAULT_VOICE, perVoiceUnit: true },
  { id: 'supertonic-wasm', group: 'cpu', label: 'Supertonic 3 (без видеокарты)', speedNote: 'медленно', needsGpu: false, voices: SUPERTONIC_VOICES, defaultVoice: 'M1', perVoiceUnit: false },
];

export const LOCAL_TTS_ENGINE_IDS: readonly LocalTtsEngineId[] = LOCAL_TTS_ENGINES.map((e) => e.id);
/** value of the `localTtsEngine` setting */
export type LocalTtsChoice = 'auto' | LocalTtsEngineId;

/** automatic preference: fast GPU first, the premium helper, then CPU engines from best to worst (an unavailable one is skipped) */
export const AUTO_ENGINE_ORDER: readonly LocalTtsEngineId[] = ['supertonic-webgpu', 'helper-omnivoice', 'silero-cpu', 'piper-wasm', 'supertonic-wasm'];

export const engineInfo = (id: LocalTtsEngineId): LocalTtsEngineInfo | undefined => LOCAL_TTS_ENGINES.find((e) => e.id === id);

export const isLocalTtsEngineId = (v: unknown): v is LocalTtsEngineId => typeof v === 'string' && (AUTO_ENGINE_ORDER as readonly string[]).includes(v);

/** the voice if the engine offers it, else the engine's default ('' when the engine is unknown or has no voices) */
export function resolveVoice(id: LocalTtsEngineId, voice: string | undefined): string {
  const info = engineInfo(id);
  if (!info) return voice ?? '';
  return voice && info.voices.some((v) => v.id === voice) ? voice : info.defaultVoice;
}

/** true when `voice` is a real voice id of the engine */
export const hasVoice = (id: LocalTtsEngineId, voice: string | undefined): boolean => !!voice && !!engineInfo(id)?.voices.some((v) => v.id === voice);

const sum = (f: readonly ModelFile[]): number => f.reduce((a, x) => a + x.size, 0);
const isPublished = (baseUrl: string, files: readonly ModelFile[]): boolean => files.every((f) => !!f.url || !!baseUrl);

/** the download unit an engine needs for a voice */
export function unitFor(id: LocalTtsEngineId, voice?: string): LocalTtsUnit | undefined {
  switch (id) {
    case 'supertonic-webgpu':
    case 'supertonic-wasm':
      return { id: 'supertonic', pack: 'supertonic', rev: SUPERTONIC_REVISION, baseUrl: SUPERTONIC_BASE_URL, files: MODEL_FILES, total: sum(MODEL_FILES), published: true };
    case 'silero-cpu':
      return { id: 'silero', pack: 'silero', rev: SILERO_REVISION, baseUrl: SILERO_BASE_URL, fallbackBaseUrls: [SILERO_FALLBACK_BASE_URL], files: SILERO_FILES, total: sum(SILERO_FILES), published: isPublished(SILERO_BASE_URL, SILERO_FILES) };
    case 'piper-wasm': {
      const v = resolveVoice(id, voice);
      const files = [...PIPER_COMMON_FILES, ...piperVoiceFiles(v)];
      return { id: `piper:${v}`, pack: 'piper', rev: PIPER_REVISION, baseUrl: PIPER_VOICES_BASE_URL, files, total: sum(files), published: true };
    }
    default:
      return undefined;
  }
}

/** every unit of every engine (UI polling, state reconciliation) */
export function allUnits(): LocalTtsUnit[] {
  const out = new Map<string, LocalTtsUnit>();
  for (const e of LOCAL_TTS_ENGINES) {
    if (e.perVoiceUnit) {
      for (const v of e.voices) {
        const u = unitFor(e.id, v.id);
        if (u) out.set(u.id, u);
      }
    } else {
      const u = unitFor(e.id);
      if (u) out.set(u.id, u);
    }
  }
  return [...out.values()];
}

export const unitById = (unitId: string): LocalTtsUnit | undefined => allUnits().find((u) => u.id === unitId);

/** fixed Russian sample (3 neutral sentences, about 10 s) for the "Проверить голос" button */
export const LOCAL_TTS_SAMPLE_TEXT =
  'Сегодня мы разберём, как устроены современные электрические автомобили. Батарея хранит энергию, а двигатель превращает её в движение. В конце видео я покажу, сколько это стоит.';
