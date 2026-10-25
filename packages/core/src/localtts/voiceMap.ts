/**
 * Voice choice by the SOURCE speaker (owner v0.2.43): a male speaker gets only male voices of the engine, a female / child
 * speaker only female ones - never mixed. Pure mapping + one-time calibration of the engine's voices (v0.2.45: the male voice
 * closest to MALE_TARGET_HZ inside MALE_RANGE, the female one closest to FEMALE_TARGET_HZ inside FEMALE_RANGE - the lowest and
 * the highest voices sound cartoonish / childlike) + a per-session planner that makes a voice change follow a confirmed gender
 * change only. The user may pin a voice per gender (settings localTtsVoiceMale / localTtsVoiceFemale, 'auto' = calibrated).
 */
import { diag } from '../diag';
import { spanPitch } from '../audio/speakerGender';
import { engineInfo, unitFor } from './catalog';
import type { LocalTtsEngine, LocalTtsEngineId } from './types';

export type TtsGender = 'm' | 'f';

export interface VoiceCalibration {
  /** engine + pinned revision the numbers belong to */
  key: string;
  male?: string;
  female?: string;
  /** measured median f0 per voice id (Hz) */
  f0: Record<string, number>;
}

export interface CalibrationStore {
  get(key: string): Promise<VoiceCalibration | undefined>;
  set(key: string, value: VoiceCalibration): Promise<void>;
}

/** engines whose voices are worth calibrating (all voices are in one downloaded pack: no extra download) */
export const CALIBRATED_ENGINES: readonly LocalTtsEngineId[] = ['supertonic-webgpu'];
export const CALIB_TEXT = 'Сегодня мы разберём, как устроены современные электрические автомобили.';
const CALIB_MIN_VOICED_SEC = 0.5;

/** most adult-sounding male f0: pick the voice closest to the target inside the range (a very deep M2 90 Hz is cartoonish) */
export const MALE_TARGET_HZ = 105;
export const MALE_RANGE_HZ: readonly [number, number] = [85, 130];
/** most adult-sounding female f0 (F2/F4 above ~220 Hz sound childlike) */
export const FEMALE_TARGET_HZ = 170;
export const FEMALE_RANGE_HZ: readonly [number, number] = [150, 200];

/** voices measured on the pinned Supertonic revision (v0.2.44 report): used until the on-device calibration lands */
const PRIOR: Partial<Record<string, { m: string; f: string }>> = { 'supertonic-webgpu': { m: 'M3', f: 'F3' }, 'supertonic-wasm': { m: 'M3', f: 'F3' } };

/** storage key of the cached calibrations (extension storage.local) */
export const VOICE_CALIB_STORAGE_KEY = 'nvtVoiceCalib';

/** key of an engine's calibration in the store: engine + pinned model revision */
export const calibKey = (id: LocalTtsEngineId): string => `${id}@${unitFor(id)?.rev ?? '0'}`;

export interface CalibPick {
  male?: string;
  female?: string;
  /** which rule decided: 'range' (closest to the target inside the range) | 'nearest' (nothing in range: closest overall) | 'none' */
  maleRule: 'range' | 'nearest' | 'none';
  femaleRule: 'range' | 'nearest' | 'none';
}

function closest(voices: readonly string[], f0: Record<string, number>, target: number, range: readonly [number, number]): { id?: string; rule: 'range' | 'nearest' | 'none' } {
  const known = voices.filter((v) => f0[v] !== undefined);
  const inR = known.filter((v) => f0[v]! >= range[0] && f0[v]! <= range[1]);
  const pool = inR.length ? inR : known;
  let best: string | undefined;
  for (const v of pool) if (best === undefined || Math.abs(f0[v]! - target) < Math.abs(f0[best]! - target)) best = v;
  return { id: best, rule: best === undefined ? 'none' : inR.length ? 'range' : 'nearest' };
}

/** the calibrated voices of an engine from the measured f0 table (pure; also re-applied to calibrations cached by older versions) */
export function pickCalibrated(id: LocalTtsEngineId, f0: Record<string, number>): CalibPick {
  const voices = engineInfo(id)?.voices ?? [];
  const m = closest(voices.filter((v) => v.gender === 'm').map((v) => v.id), f0, MALE_TARGET_HZ, MALE_RANGE_HZ);
  const f = closest(voices.filter((v) => v.gender === 'f').map((v) => v.id), f0, FEMALE_TARGET_HZ, FEMALE_RANGE_HZ);
  return { ...(m.id ? { male: m.id } : {}), ...(f.id ? { female: f.id } : {}), maleRule: m.rule, femaleRule: f.rule };
}

const genderOf = (id: LocalTtsEngineId, voice: string | undefined): TtsGender | undefined => engineInfo(id)?.voices.find((v) => v.id === voice)?.gender;

export interface MapOptions {
  /** the user's voice for THIS gender (settings localTtsVoiceMale / Female); '' / 'auto' / undefined = no explicit choice */
  userVoice?: string;
  calibrated?: Pick<VoiceCalibration, 'male' | 'female'>;
}

/**
 * The voice for a speaker class. Explicit user voice of that gender wins; otherwise the calibrated voice of that gender, else the
 * measured prior of the engine (M3 / F3), else the engine default if it has that gender, else the first voice of that gender.
 * undefined = the engine has no such voice.
 */
export function mapVoice(engine: LocalTtsEngineId, gender: TtsGender, o: MapOptions = {}): string | undefined {
  const info = engineInfo(engine);
  if (!info) return undefined;
  const ofGender = info.voices.filter((v) => v.gender === gender);
  if (ofGender.length === 0) return undefined;
  if (o.userVoice && genderOf(engine, o.userVoice) === gender) return o.userVoice;
  const cal = gender === 'm' ? o.calibrated?.male : o.calibrated?.female;
  if (cal && genderOf(engine, cal) === gender) return cal;
  const prior = PRIOR[engine]?.[gender];
  if (prior && genderOf(engine, prior) === gender) return prior;
  if (genderOf(engine, info.defaultVoice) === gender) return info.defaultVoice;
  return ofGender[0]!.id;
}

/**
 * Synthesizes CALIB_TEXT with every voice of the engine and measures its median f0; the male / female voice is then picked by
 * pickCalibrated(). Sequential (never competes with the dub for more than one call). Throws on abort.
 */
export async function calibrateVoices(engine: LocalTtsEngine, key: string, signal?: AbortSignal): Promise<VoiceCalibration> {
  const info = engineInfo(engine.id);
  const f0: Record<string, number> = {};
  for (const v of info?.voices ?? []) {
    if (signal?.aborted) throw new Error('aborted');
    try {
      const r = await engine.synth({ text: CALIB_TEXT, voice: v.id, signal });
      const p = spanPitch(r.samples, r.sampleRate);
      if (p.f0 > 0 && p.voicedSec >= CALIB_MIN_VOICED_SEC) f0[v.id] = Math.round(p.f0);
    } catch {
      if (signal?.aborted) throw new Error('aborted');
      /* this voice stays unmeasured */
    }
  }
  const pick = pickCalibrated(engine.id, f0);
  return { key, f0, ...(pick.male ? { male: pick.male } : {}), ...(pick.female ? { female: pick.female } : {}) };
}

/** applies the current selection rule to a (possibly older) stored calibration and logs 'voice-calib' */
export function applyCalibrationRule(id: LocalTtsEngineId, c: VoiceCalibration): VoiceCalibration {
  const pick = pickCalibrated(id, c.f0);
  const out: VoiceCalibration = { key: c.key, f0: c.f0, ...(pick.male ? { male: pick.male } : {}), ...(pick.female ? { female: pick.female } : {}) };
  diag.log('voice-calib', {
    engine: id,
    male: pick.male,
    maleF0: pick.male ? c.f0[pick.male] : undefined,
    maleRule: `${pick.maleRule}:${MALE_TARGET_HZ}@${MALE_RANGE_HZ[0]}-${MALE_RANGE_HZ[1]}`,
    female: pick.female,
    femaleF0: pick.female ? c.f0[pick.female] : undefined,
    femaleRule: `${pick.femaleRule}:${FEMALE_TARGET_HZ}@${FEMALE_RANGE_HZ[0]}-${FEMALE_RANGE_HZ[1]}`,
    all: c.f0,
  });
  return out;
}

/**
 * Session planner: hands out the voice for a speaker class and logs 'voice-switch'. The voice only changes when the gender
 * changes, plus once when a calibration lands (or the user's voice setting changes) and names another voice for the current gender.
 */
export class VoicePlanner {
  private last: { engine: LocalTtsEngineId; gender: TtsGender; voice: string; cal?: string } | undefined;

  reset(): void {
    this.last = undefined;
  }

  voiceFor(engine: LocalTtsEngineId, gender: TtsGender, o: MapOptions): string | undefined {
    const l = this.last;
    const calKey = `${o.userVoice ?? ''}|${o.calibrated?.male ?? ''}|${o.calibrated?.female ?? ''}`;
    if (l && l.engine === engine && l.gender === gender && l.cal === calKey) return l.voice;
    const voice = mapVoice(engine, gender, o);
    if (!voice) return undefined;
    if (l && l.engine === engine && l.voice !== voice) {
      const why = l.gender !== gender ? `gender:${l.gender}>${gender}` : 'calibrated-or-setting';
      diag.log('voice-switch', { from: l.voice, to: voice, why });
    }
    this.last = { engine, gender, voice, cal: calKey };
    return voice;
  }
}
