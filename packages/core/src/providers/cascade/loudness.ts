/**
 * Loudness leveling of local TTS output (owner: local voices were far quieter than Yandex: peaks 0.31-0.60, rms 0.05-0.10 vs
 * 0.9 / 0.15-0.25). RMS-based gain toward TARGET_RMS (cap +14 dB, floor -6 dB), smoothed across the segments of one voice so
 * levels do not jump, followed by a transparent soft limiter that never exceeds CEILING (no clipping).
 */
export const LOUD_TARGET_RMS = 0.23;
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
  // A previous loud sentence must not hold the next quiet sentence below target.
  const gain = state.gain === undefined || wanted >= state.gain ? wanted : state.gain * (1 - SMOOTH) + wanted * SMOOTH;
  state.gain = gain;
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const y = softLimit((samples[i]! / 32768) * gain);
    out[i] = Math.round(y < 0 ? y * 32768 : y * 32767);
  }
  const after = stats(out);
  return { samples: out, stats: { gain, peakBefore: before.peak, peakAfter: after.peak, rmsBefore: before.rms, rmsAfter: after.rms } };
}

/** Offline speech leveler for ALL decoded dubs, including cached audio and remote
 * tracks. A centered 100 ms RMS window and gain lookahead lift quiet words without
 * boosting pauses or letting a previous quiet word overload the next loud one.
 * One linked gain preserves stereo balance; the user volume is applied later. */
export function levelDecodedSpeech(channels: Float32Array[], sampleRate: number): void {
  const size = channels[0]?.length ?? 0;
  if (!size || sampleRate <= 0) return;
  const step = Math.max(1, Math.round(sampleRate * 0.01));
  const count = Math.ceil(size / step);
  const power = new Float64Array(count);
  let peakRms = 0;
  for (let f = 0; f < count; f++) {
    const start = f * step;
    const end = Math.min(size, start + step);
    let sum = 0;
    for (const ch of channels) for (let i = start; i < end; i++) sum += ch[i]! * ch[i]!;
    power[f] = sum / ((end - start) * channels.length);
    peakRms = Math.max(peakRms, Math.sqrt(power[f]!));
  }
  if (peakRms < 1e-4) return;
  const floor = Math.max(0.003, peakRms * 0.02);
  const gains = new Float64Array(count);
  for (let f = 0; f < count; f++) {
    let sum = 0;
    const a = Math.max(0, f - 5);
    const b = Math.min(count, f + 6);
    for (let k = a; k < b; k++) sum += power[k]!;
    const rms = Math.sqrt(sum / (b - a));
    gains[f] = rms < floor ? 1 : Math.min(8, Math.max(0.25, 0.18 / rms));
  }
  // Smooth upward changes, then anticipate downward changes from the future.
  const release = Math.exp(-step / sampleRate / 0.12);
  const attack = Math.exp(-step / sampleRate / 0.025);
  for (let f = 1; f < count; f++) {
    const alpha = gains[f]! > gains[f - 1]! ? release : attack;
    gains[f] = alpha * gains[f - 1]! + (1 - alpha) * gains[f]!;
  }
  for (let f = count - 2; f >= 0; f--) {
    gains[f] = Math.min(gains[f]!, attack * gains[f + 1]! + (1 - attack) * gains[f]!);
  }
  for (const ch of channels) for (let i = 0; i < size; i++) {
    const f = Math.floor(i / step);
    const t = (i % step) / step;
    const gain = gains[f]! * (1 - t) + gains[Math.min(count - 1, f + 1)]! * t;
    ch[i] = softLimit(ch[i]! * gain);
  }
}
