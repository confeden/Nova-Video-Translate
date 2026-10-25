/**
 * Child-voice guard for the local TTS (owner v0.2.42: "some childlike voice kicks in"). Short phrases and fast rates can make a
 * male Supertonic voice come out high-pitched. After a MALE voice synthesizes a phrase we estimate the median f0 of its voiced
 * part; above CHILD_F0_MALE_HZ the phrase is re-synthesized with a female voice. Since v0.2.44 this is only a BACKSTOP for
 * phrases whose SOURCE gender is unknown (voiceMap / SpeakerTracker choose the voice by the original speaker otherwise);
 * the old "lock the female voice after 3 fallbacks" is gone - the source-based state replaced it. Pure logic, no I/O.
 */
import { diag } from '../diag';
import { estimateF0 } from '../audio/pitch';
import type { LocalTtsResult } from './types';

/** a male voice with a median f0 above this is childlike (adult male speech sits at ~85-180 Hz) */
export const CHILD_F0_MALE_HZ = 185;
/** phrases with less voiced audio than this are not judged (the median is unreliable) */
export const MIN_VOICED_SEC = 0.6;
const HOP_SEC = 0.03;

/** median f0 (Hz, 0 = unknown) and the amount of voiced audio; ~2-3 ms per second of audio (12 kHz, non-overlapping frames) */
export function measureVoicedF0(samples: Int16Array, sampleRate: number): { f0: number; voicedSec: number } {
  const r = estimateF0(samples, sampleRate, { minHz: 70, maxHz: 400, frameSec: HOP_SEC, hopSec: HOP_SEC });
  return { f0: r.f0, voicedSec: r.voicedFrames * HOP_SEC };
}

export interface GuardRun {
  /** the voice the caller would use */
  voice: string;
  isMale: boolean;
  /** female voice to fall back to; absent = no fallback possible */
  femaleVoice?: string;
  chars: number;
  synth: (voice: string) => Promise<LocalTtsResult>;
}

export class VoiceGuard {
  async run(p: GuardRun): Promise<LocalTtsResult> {
    if (!p.isMale || !p.femaleVoice) return p.synth(p.voice); // explicit/auto female voice: never switched, never measured
    const r = await p.synth(p.voice);
    const m = measureVoicedF0(r.samples, r.sampleRate);
    const out: LocalTtsResult = m.f0 > 0 ? { ...r, f0Hz: Math.round(m.f0) } : r;
    if (!(m.f0 > CHILD_F0_MALE_HZ && m.voicedSec >= MIN_VOICED_SEC)) return out;
    let fem: LocalTtsResult;
    try {
      fem = await p.synth(p.femaleVoice);
    } catch {
      return out; // no female voice available now: keep the childlike take rather than drop the phrase
    }
    diag.log('tts-voice-fallback', { from: p.voice, to: p.femaleVoice, f0Hz: Math.round(m.f0), chars: p.chars });
    return { ...fem, f0Hz: Math.round(m.f0), voiceFallback: true };
  }
}
