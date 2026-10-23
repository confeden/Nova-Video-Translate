/**
 * Loudness leveling of local TTS output (owner: local voices were far quieter than Yandex: peaks 0.31-0.60, rms 0.05-0.10 vs
 * 0.9 / 0.15-0.25). RMS-based gain toward TARGET_RMS (cap +14 dB, floor -6 dB), smoothed across the segments of one voice so
 * levels do not jump, followed by a transparent soft limiter that never exceeds CEILING (no clipping).
 */
export const LOUD_TARGET_RMS = 0.17;
export const LOUD_CEILING = 0.89;
/** limiter knee: below it the signal is untouched */
export const LOUD_KNEE = 0.62;
export const LOUD_MAX_GAIN = 5.0; // +14 dB
export const LOUD_MIN_GAIN = 0.5;
/** weight of the new segment in the running gain */
const SMOOTH = 0.4;

export interface LevelState {
  gain?: number;
}

export interface LevelStats {
  gain: number;
  peakBefore: number;
  peakAfter: number;
  rmsBefore: number;
  rmsAfter: number;
}

const stats = (s: Int16Array): { peak: number; rms: number } => {
  let peak = 0;
  for (let i = 0; i < s.length; i++) peak = Math.max(peak, Math.abs(s[i]!));
  peak /= 32768;
  // rms over the speech part only (samples above 3% of the peak): pauses inside a sentence must not inflate the gain
  const gate = peak * 0.03 * 32768;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const a = Math.abs(s[i]!);
    if (a >= gate) {
      sum += (a / 32768) ** 2;
      n++;
    }
  }
  return { peak, rms: n > 0 ? Math.sqrt(sum / n) : 0 };
};

/** y = x below the knee, then a tanh shoulder that asymptotically reaches the ceiling */
export function softLimit(x: number, knee = LOUD_KNEE, ceil = LOUD_CEILING): number {
  const a = Math.abs(x);
  if (a <= knee) return x;
  const y = knee + (ceil - knee) * Math.tanh((a - knee) / (ceil - knee));
  return x < 0 ? -y : y;
}

/** normalizes `samples` in place-free fashion (returns a new array); `state` carries the smoothed gain between segments */
export function normalizeLoudness(samples: Int16Array, state: LevelState = {}): { samples: Int16Array; stats: LevelStats } {
  const before = stats(samples);
  if (samples.length === 0 || before.rms < 1e-4) return { samples, stats: { gain: 1, peakBefore: before.peak, peakAfter: before.peak, rmsBefore: before.rms, rmsAfter: before.rms } };
  const wanted = Math.min(LOUD_MAX_GAIN, Math.max(LOUD_MIN_GAIN, LOUD_TARGET_RMS / before.rms));
  const gain = state.gain === undefined ? wanted : state.gain * (1 - SMOOTH) + wanted * SMOOTH;
  state.gain = gain;
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const y = softLimit((samples[i]! / 32768) * gain);
    out[i] = Math.round(y < 0 ? y * 32768 : y * 32767);
  }
  const after = stats(out);
  return { samples: out, stats: { gain, peakBefore: before.peak, peakAfter: after.peak, rmsBefore: before.rms, rmsAfter: after.rms } };
}
