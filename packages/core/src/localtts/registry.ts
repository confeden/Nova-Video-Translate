import { diag } from '../diag';
import { AUTO_ENGINE_ORDER, hasVoice, isLocalTtsEngineId, type LocalTtsChoice } from './catalog';
import type { LocalTtsEngine, LocalTtsEngineId } from './types';

/**
 * Default engine preference (D30): fast GPU engine first (its isAvailable() is false without WebGPU), the premium localhost
 * helper, then the CPU engines from best to worst. Apps register the engines they can host (extension: offscreen document;
 * helper: HTTP client); core never imports an implementation.
 */
export const DEFAULT_LOCAL_TTS_ORDER: LocalTtsEngineId[] = [...AUTO_ENGINE_ORDER];

/** the user's choice from the settings (`localTtsEngine` / `localTtsVoice`) */
export interface LocalTtsPreference {
  engine: LocalTtsChoice;
  voice: string;
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

  private withVoice(e: LocalTtsEngine, pref: LocalTtsPreference | undefined): LocalTtsEngine {
    const userVoice = pref?.voice && hasVoice(e.id, pref.voice) ? pref.voice : undefined;
    return {
      id: e.id,
      isAvailable: () => e.isAvailable(),
      voices: () => e.voices(),
      synth: async (req) => {
        const t0 = this.now();
        const r = await e.synth(userVoice && !hasVoice(e.id, req.voice) ? { ...req, voice: userVoice } : req);
        this.noteSynth(e.id, this.now() - t0, r.durationSec);
        return r;
      },
    };
  }
}

/** process-wide registry the apps fill in their main/content setup */
export const localTtsRegistry = new LocalTtsRegistry();
