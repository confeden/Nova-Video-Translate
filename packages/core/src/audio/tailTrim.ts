/**
 * TTS segment post-processing: DC removal, trailing breath/noise trim, leading silence trim, click-free fades.
 * Pure and environment-neutral.
 */

export interface TrimOptions {
  /** energy window, seconds, default 0.010 */
  windowSec?: number;
  /** end threshold relative to the loudest window (RMS), default 0.12 */
  endRatio?: number;
  /** onset threshold relative to the loudest window; lower than endRatio so soft consonants survive, default 0.06 */
  startRatio?: number;
  /** kept after the last window above endRatio, default 0.060 */
  hangoverSec?: number;
  /** leading silence longer than this is shortened, default 0.120 */
  maxLeadSec?: number;
  /** ... down to this much, default 0.060 */
  keepLeadSec?: number;
  fadeInSec?: number;
  fadeOutSec?: number;
  /** below this loudest-window RMS (int16 units, after DC removal) the input is treated as silence and returned as is, default 30 */
  silenceFloor?: number;
  /** strip the Gemini 3.8 loud tail burst (findTailBurst), default true; false only for before/after measurements */
  burst?: boolean;
}

/**
 * Gemini 3.8 TTS models (flash and flash-lite, measured research/*.wav) append a constant ~120 ms loud clipped
 * noise burst (RMS ~ -5 dBFS, louder than the speech) after a digital-silence gap at the END of every clip.
 * Because it is the loudest part, the relative-threshold trim keeps it: this detects it by shape and returns the
 * sample index where it starts, or -1 when there is none. Shape: after >= 3 near-silent windows, a run of at most
 * `maxBurstSec` of stationary (min/median >= 0.75) loud audio that reaches the end of the clip and is either
 * louder than the speech body (>= 1.1 x its 99th percentile window RMS) or clipped.
 */
export function findTailBurst(pcm: Int16Array, sampleRate: number, maxBurstSec = 0.5): number {
  const win = Math.max(1, Math.round(0.01 * sampleRate));
  const nWin = Math.ceil(pcm.length / win);
  if (nWin < 12) return -1;
  const rms = new Float64Array(nWin);
  let max = 0;
  for (let w = 0; w < nWin; w++) {
    const a = w * win;
    const b = Math.min(pcm.length, a + win);
    let e = 0;
    for (let i = a; i < b; i++) e += (pcm[i] ?? 0) ** 2;
    rms[w] = Math.sqrt(e / (b - a));
    if (rms[w]! > max) max = rms[w]!;
  }
  if (max < 1000) return -1;
  const active = max * 0.02;
  const quiet = max * 0.005;
  const maxWin = Math.round(maxBurstSec / 0.01);
  let k = nWin;
  while (k > 0 && rms[k - 1]! >= active) k--;
  const run = nWin - k;
  if (run < 3 || run > maxWin || k < 4) return -1;
  for (let i = k - 3; i < k; i++) if (rms[i]! >= quiet) return -1;
  // stationarity over the interior of the run (the first/last windows may be partial)
  const inner = Array.from(rms.subarray(k + 1, nWin - 1)).sort((x, y) => x - y);
  if (inner.length < 2) return -1;
  const median = inner[inner.length >> 1]!;
  if ((inner[0] ?? 0) < 0.75 * median) return -1;
  const body = Array.from(rms.subarray(0, k)).sort((x, y) => x - y);
  const p99 = body[Math.min(body.length - 1, Math.floor(body.length * 0.99))] ?? 0;
  let clipped = 0;
  for (let i = k * win; i < pcm.length; i++) if (Math.abs(pcm[i] ?? 0) >= 32000) clipped++;
  const clipFrac = clipped / (pcm.length - k * win);
  if (median >= 1.1 * p99 || clipFrac >= 0.005) return k * win;
  return -1;
}

export function trimAndFade(input: Int16Array, sampleRate: number, opts: TrimOptions = {}): Int16Array {
  const burstAt = opts.burst === false ? -1 : findTailBurst(input, sampleRate);
  // copy: never keep a view whose .buffer is larger than the clip
  const pcm = burstAt >= 0 ? input.slice(0, burstAt) : input;
  const win = Math.max(1, Math.round((opts.windowSec ?? 0.01) * sampleRate));
  if (pcm.length < 2 * win) return pcm.slice();

  let sum = 0;
  for (let i = 0; i < pcm.length; i++) sum += pcm[i] ?? 0;
  const dc = sum / pcm.length;

  const nWin = Math.ceil(pcm.length / win);
  const rms = new Float64Array(nWin);
  let ref = 0;
  for (let w = 0; w < nWin; w++) {
    const a = w * win;
    const b = Math.min(pcm.length, a + win);
    let e = 0;
    for (let i = a; i < b; i++) {
      const v = (pcm[i] ?? 0) - dc;
      e += v * v;
    }
    const r = Math.sqrt(e / (b - a));
    rms[w] = r;
    if (r > ref) ref = r;
  }
  if (ref < (opts.silenceFloor ?? 30)) return pcm.slice();

  const endThr = ref * (opts.endRatio ?? 0.12);
  const startThr = ref * (opts.startRatio ?? 0.06);
  let lastLoud = 0;
  for (let w = nWin - 1; w >= 0; w--) {
    if ((rms[w] ?? 0) >= endThr) {
      lastLoud = w;
      break;
    }
  }
  let firstLoud = 0;
  for (let w = 0; w < nWin; w++) {
    if ((rms[w] ?? 0) >= startThr) {
      firstLoud = w;
      break;
    }
  }
  firstLoud = Math.min(firstLoud, lastLoud);

  const hang = Math.round((opts.hangoverSec ?? 0.06) * sampleRate);
  const end = Math.min(pcm.length, (lastLoud + 1) * win + hang);
  let start = 0;
  const lead = firstLoud * win;
  if (lead > (opts.maxLeadSec ?? 0.12) * sampleRate) {
    start = Math.max(0, lead - Math.round((opts.keepLeadSec ?? 0.06) * sampleRate));
  }

  const n = end - start;
  const out = new Int16Array(n);
  const fin = Math.min(Math.round((opts.fadeInSec ?? 0.008) * sampleRate), n >> 1);
  const fout = Math.min(Math.round((opts.fadeOutSec ?? 0.04) * sampleRate), n >> 1);
  for (let i = 0; i < n; i++) {
    let v = (pcm[start + i] ?? 0) - dc;
    if (i < fin) v *= 0.5 * (1 - Math.cos((Math.PI * (i + 0.5)) / fin));
    const j = n - 1 - i;
    if (j < fout) v *= 0.5 * (1 - Math.cos((Math.PI * (j + 0.5)) / fout));
    out[i] = Math.max(-32768, Math.min(32767, Math.round(v)));
  }
  return out;
}

/** RMS of pcm[from, to) in seconds — helper for measurements and tests. */
export function rmsBetween(pcm: Int16Array, sampleRate: number, fromSec: number, toSec: number): number {
  const a = Math.max(0, Math.floor(fromSec * sampleRate));
  const b = Math.min(pcm.length, Math.floor(toSec * sampleRate));
  if (b <= a) return 0;
  let e = 0;
  for (let i = a; i < b; i++) e += (pcm[i] ?? 0) ** 2;
  return Math.sqrt(e / (b - a));
}
