import { diag } from '../diag';
import { AUTO_ENGINE_ORDER, engineInfo, hasVoice, isLocalTtsEngineId, type LocalTtsChoice } from './catalog';
import { VoiceGuard, measureVoicedF0 } from './voiceGuard';
import { CALIBRATED_ENGINES, VoicePlanner, applyCalibrationRule, calibKey, calibrateVoices, type CalibrationStore, type VoiceCalibration, type TtsGender } from './voiceMap';
import type { LocalTtsEngine, LocalTtsEngineId } from './types';

/**
 * Default engine preference (D30): fast GPU engine first (its isAvailable() is false without WebGPU), the premium localhost
 * helper, then the CPU engines from best to worst. Apps register the engines they can host (extension: offscreen document;
 * helper: HTTP client); core never imports an implementation.
 */
export const DEFAULT_LOCAL_TTS_ORDER: LocalTtsEngineId[] = [...AUTO_ENGINE_ORDER];

const genderOf = (id: LocalTtsEngineId, voice: string): 'm' | 'f' | undefined => engineInfo(id)?.voices.find((v) => v.id === voice)?.gender;

/** the user's choice from the settings (`localTtsEngine` / `localTtsVoiceMale` / `localTtsVoiceFemale`) */
export interface LocalTtsPreference {
  engine: LocalTtsChoice;
  /** legacy single voice: only the default for a synth call that names no voice */
  voice: string;
  /** voice id for male speakers; 'auto' / '' / absent = the calibrated one */
  voiceMale?: string;
  voiceFemale?: string;
}

/**
 * Order to try: the chosen engine first, then the remaining engines of `base` ('auto' = just `base`).
 * An unknown / unavailable choice therefore falls back to the automatic order.
 */
export function orderWithPreference(base: readonly LocalTtsEngineId[], choice: LocalTtsChoice | undefined): LocalTtsEngineId[] {
  if (!choice || choice === 'auto' || !isLocalTtsEngineId(choice)) return [...base];
  return [choice, ...base.filter((x) => x !== choice)];
}

/** wall-clock synth time / audio time above which a call counts as "not real-time" (queue wait included, so real engines sit well below) */
export const SLOW_RTF = 1.0;
/** consecutive slow calls before an engine is demoted in the automatic order */
export const SLOW_STREAK = 2;
/** how long a demoted engine stays behind the others (ms) before it is tried first again */
export const SLOW_COOLDOWN_MS = 5 * 60_000;

interface Health {
  streak: number;
  slowUntil: number;
}

export class LocalTtsRegistry {
  /** automatic-mode health per engine: a GPU engine that is starved by other GPU work must not stall the dub (D29: early voice) */
  private readonly health = new Map<LocalTtsEngineId, Health>();
  now: () => number = () => Date.now();
  private readonly engines = new Map<LocalTtsEngineId, LocalTtsEngine>();
  /** backstop child-voice guard: only for phrases whose source gender is unknown */
  readonly voiceGuard = new VoiceGuard();
  /** voice choice by the source speaker's gender (v0.2.44) */
  readonly planner = new VoicePlanner();
  private calibStore: CalibrationStore | undefined;
  private readonly calib = new Map<LocalTtsEngineId, VoiceCalibration>();
  private readonly calibRuns = new Map<LocalTtsEngineId, { promise?: Promise<void>; retryAt: number; done: boolean }>();
  private prefSource: (() => LocalTtsPreference | undefined) | undefined;

  /** adds (or replaces) an engine; returns a function that removes it again */
  register(engine: LocalTtsEngine): () => void {
    this.engines.set(engine.id, engine);
    return () => {
      if (this.engines.get(engine.id) === engine) this.engines.delete(engine.id);
    };
  }

  /** where the user's engine/voice choice comes from; read on every pick() so a settings change applies at once */
  setPreference(source: (() => LocalTtsPreference | undefined) | undefined): void {
    this.prefSource = source;
  }

  preference(): LocalTtsPreference | undefined {
    try {
      return this.prefSource?.();
    } catch {
      return undefined;
    }
  }

  get(id: LocalTtsEngineId): LocalTtsEngine | undefined {
    return this.engines.get(id);
  }

  list(): LocalTtsEngine[] {
    return [...this.engines.values()];
  }

  clear(): void {
    this.engines.clear();
    this.health.clear();
    this.planner.reset();
    this.calib.clear();
    this.calibRuns.clear();
    this.prefSource = undefined;
  }

  /**
   * First registered engine of the order whose isAvailable() resolves true (a throwing probe counts as unavailable). The
   * user's engine (setPreference) goes first; the returned engine applies the user's voice when the caller named none that
   * this engine knows.
   */
  async pick(order: readonly LocalTtsEngineId[] = DEFAULT_LOCAL_TTS_ORDER): Promise<LocalTtsEngine | undefined> {
    const pref = this.preference();
    let ids = orderWithPreference(order, pref?.engine);
    if (!pref || pref.engine === 'auto') {
      const t = this.now();
      const slow = (id: LocalTtsEngineId): boolean => (this.health.get(id)?.slowUntil ?? 0) > t;
      ids = [...ids.filter((id) => !slow(id)), ...ids.filter(slow)];
    }
    for (const id of ids) {
      const e = this.engines.get(id);
      if (!e) continue;
      try {
        if (await e.isAvailable()) return this.withVoice(e, pref);
      } catch {
        /* unavailable */
      }
    }
    return undefined;
  }

  /** records one finished synth call; two slow ones in a row demote the engine for SLOW_COOLDOWN_MS (automatic mode only) */
  noteSynth(id: LocalTtsEngineId, wallMs: number, audioSec: number): void {
    if (!(audioSec > 0.3)) return; // too short to judge
    const h = this.health.get(id) ?? { streak: 0, slowUntil: 0 };
    const rtf = wallMs / 1000 / audioSec;
    if (rtf > SLOW_RTF) {
      h.streak++;
      if (h.streak >= SLOW_STREAK && h.slowUntil <= this.now()) {
        h.slowUntil = this.now() + SLOW_COOLDOWN_MS;
        diag.log('localtts-demote', { engine: id, rtf: Math.round(rtf * 100) / 100, cooldownSec: SLOW_COOLDOWN_MS / 1000 });
      }
    } else {
      h.streak = 0;
      h.slowUntil = 0;
    }
    this.health.set(id, h);
  }

  /** where calibrations are cached between sessions (extension storage); optional */
  setCalibrationStore(store: CalibrationStore | undefined): void {
    this.calibStore = store;
  }

  /** the voice for a source speaker class on this engine (user's explicit voice / calibrated / catalog default); undefined = none of that gender */
  voiceFor(engine: LocalTtsEngineId, gender: TtsGender): string | undefined {
    const p = this.preference();
    const pick = gender === 'm' ? p?.voiceMale : p?.voiceFemale;
    return this.planner.voiceFor(engine, gender, { userVoice: pick && pick !== 'auto' ? pick : undefined, calibrated: this.calib.get(engine) });
  }

  /** the calibration of an engine as the pipeline uses it (selection rule applied); undefined until measured / loaded */
  calibration(engine: LocalTtsEngineId): VoiceCalibration | undefined {
    return this.calib.get(engine);
  }

  /**
   * One-time background calibration of the engine's voices (adult-sounding f0 per gender, see pickCalibrated). The measured f0
   * table is cached in the store keyed by engine + pinned model revision (the selection rule is re-applied on every load); failures are retried at most every 2 minutes. Never throws, never blocks the caller.
   */
  calibrate(id: LocalTtsEngineId): Promise<void> {
    const e = this.engines.get(id);
    if (!e || !CALIBRATED_ENGINES.includes(id)) return Promise.resolve();
    const run = this.calibRuns.get(id) ?? { retryAt: 0, done: false };
    this.calibRuns.set(id, run);
    if (run.done || run.promise || this.now() < run.retryAt) return run.promise ?? Promise.resolve();
    const key = calibKey(id);
    run.promise = (async () => {
      try {
        let c = await this.calibStore?.get(key).catch(() => undefined);
        if (!c || c.key !== key) {
          c = await calibrateVoices(e, key);
          await this.calibStore?.set(key, c).catch(() => undefined);
        }
        this.calib.set(id, applyCalibrationRule(id, c));
        run.done = true;
      } catch {
        run.retryAt = this.now() + 120_000;
      } finally {
        run.promise = undefined;
      }
    })();
    return run.promise;
  }

  private withVoice(e: LocalTtsEngine, pref: LocalTtsPreference | undefined): LocalTtsEngine {
    const userVoice = pref?.voice && hasVoice(e.id, pref.voice) ? pref.voice : undefined;
    return {
      id: e.id,
      isAvailable: () => e.isAvailable(),
      voices: () => e.voices(),
      synth: async (req) => {
        const t0 = this.now();
        if (req.srcGender && hasVoice(e.id, req.voice)) {
          // voice chosen by the source speaker: no post-synthesis judgement, the f0 is only measured for the diag
          const r = await e.synth(req);
          const m = measureVoicedF0(r.samples, r.sampleRate);
          const out = m.f0 > 0 ? { ...r, f0Hz: Math.round(m.f0) } : r;
          this.noteSynth(e.id, this.now() - t0, out.durationSec);
          return out;
        }
        const base = userVoice && !hasVoice(e.id, req.voice) ? { ...req, voice: userVoice } : req;
        const info = engineInfo(e.id);
        const voice = hasVoice(e.id, req.voice) ? req.voice! : (userVoice ?? info?.defaultVoice ?? '');
        const female = userVoice && genderOf(e.id, userVoice) === 'f' ? userVoice : (this.calib.get(e.id)?.female ?? info?.voices.find((v) => v.gender === 'f')?.id);
        const r = await this.voiceGuard.run({
          voice,
          isMale: genderOf(e.id, voice) === 'm',
          femaleVoice: female,
          chars: req.text.length,
          synth: (v) => e.synth(v === voice ? base : { ...req, voice: v }),
        });
        this.noteSynth(e.id, this.now() - t0, r.durationSec);
        return r;
      },
    };
  }
}

/** process-wide registry the apps fill in their main/content setup */
export const localTtsRegistry = new LocalTtsRegistry();
