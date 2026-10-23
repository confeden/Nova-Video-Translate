/**
 * Waveform tail of Silero v5_ru, outside ONNX: iSTFT ('same' padding, n_fft = win = 2400, hop = 600, periodic Hann) of the vocoder's
 * complex spectrum (tts_package.package_utils.ISTFT) and, for 24 kHz, PQMF(N=2, taps=62, cutoff=0.25, beta=10) analysis band 0 with
 * the package's whole-utterance tanh guard. float64 inside; pure and dependency-free.
 */

const N_FFT = 2400;
const HOP = 600;
const BINS = N_FFT / 2 + 1;
const PAD = (N_FFT - HOP) / 2;

/** pqmf_2.H[0] / H[1] (scipy firwin(63, 0.25, ('kaiser', 10)) cosine-modulated), float32 values of the package buffers */
const PQMF_H0 = [
  1.9735623e-6, 2.324998e-5, 3.8659975e-5, -3.8572825e-20, 5.7133762e-5, 0.00032661486, 0.00036693888, -2.4075585e-19, 0.00034139166, 0.0016692557,
  0.0016496476, -8.096403e-19, 0.0012557494, 0.0056645875, 0.005215621, -1.9238254e-18, 0.0035292679, 0.015162173, 0.013376201, -3.566398e-18,
  0.008457439, 0.035448816, 0.03072654, -5.4107588e-18, 0.019265413, 0.08193732, 0.07346621, -6.8902697e-18, 0.054921996, 0.28832343, 0.41384068,
  0.19134027, -0.17141843, -0.28832343, -0.13259342, -6.8902697e-18, -0.0304307, -0.08193732, -0.04651082, -5.4107588e-18, -0.01272735, -0.035448816,
  -0.020418065, -3.566398e-18, -0.005540604, -0.015162173, -0.008520407, -1.9238254e-18, -0.002160381, -0.0056645875, -0.0030316473, -8.096403e-19,
  -0.00068330637, -0.0016692557, -0.00082419236, -2.4075585e-19, -0.00015199106, -0.00032661486, -0.00013793311, -3.8572825e-20, -1.6013486e-5,
  -2.324998e-5, -4.764601e-6,
];
const PQMF_H1 = [
  4.764601e-6, -9.6304575e-6, -1.6013486e-5, -9.312304e-20, 0.00013793311, -0.0001352883, -0.00015199106, -5.8123603e-19, 0.00082419236, -0.0006914283,
  -0.00068330637, -1.9546447e-18, 0.0030316473, -0.002346349, -0.002160381, -4.6445253e-18, 0.008520407, -0.0062803775, -0.005540604, -8.610046e-18,
  0.020418065, -0.01468338, -0.01272735, -1.3062727e-17, 0.04651082, -0.03393955, -0.0304307, -1.6634582e-17, 0.13259342, -0.11942747, -0.17141843,
  0.46193627, -0.41384068, 0.11942747, 0.054921996, -1.6634582e-17, -0.07346621, 0.03393955, 0.019265413, -1.3062727e-17, -0.03072654, 0.01468338,
  0.008457439, -8.610046e-18, -0.013376201, 0.0062803775, 0.0035292679, -4.6445253e-18, -0.005215621, 0.002346349, 0.0012557494, -1.9546447e-18,
  -0.0016496476, 0.0006914283, 0.00034139166, -5.8123603e-19, -0.00036693888, 0.0001352883, 5.7133762e-5, -9.312304e-20, -3.8659975e-5, 9.6304575e-6,
  1.9735623e-6,
];
const PQMF_PAD = 31;

// ---------------------------------------------------------------- mixed-radix complex FFT (kissfft-style, generic butterflies)

class Fft {
  private readonly factors: number[] = [];
  private readonly twRe: Float64Array;
  private readonly twIm: Float64Array;
  private readonly scrRe: Float64Array;
  private readonly scrIm: Float64Array;
  constructor(readonly n: number, inverse: boolean) {
    let m = n;
    for (const p of [4, 2, 3, 5]) {
      while (m % p === 0) {
        this.factors.push(p);
        m /= p;
      }
    }
    for (let p = 7; m > 1; p += 2) {
      while (m % p === 0) {
        this.factors.push(p);
        m /= p;
      }
    }
    this.twRe = new Float64Array(n);
    this.twIm = new Float64Array(n);
    const s = inverse ? 1 : -1;
    for (let i = 0; i < n; i++) {
      this.twRe[i] = Math.cos((2 * Math.PI * i) / n);
      this.twIm[i] = s * Math.sin((2 * Math.PI * i) / n);
    }
    const pmax = Math.max(...this.factors, 1);
    this.scrRe = new Float64Array(pmax);
    this.scrIm = new Float64Array(pmax);
  }

  run(inRe: Float64Array, inIm: Float64Array, outRe: Float64Array, outIm: Float64Array): void {
    this.work(outRe, outIm, 0, inRe, inIm, 0, 1, 0);
  }

  private work(oR: Float64Array, oI: Float64Array, o: number, iR: Float64Array, iI: Float64Array, i0: number, fstride: number, fi: number): void {
    const p = this.factors[fi]!;
    let m = this.n / fstride / p;
    if (m === 1) {
      for (let j = 0; j < p; j++) {
        oR[o + j] = iR[i0 + j * fstride]!;
        oI[o + j] = iI[i0 + j * fstride]!;
      }
    } else {
      for (let j = 0; j < p; j++) this.work(oR, oI, o + j * m, iR, iI, i0 + j * fstride, fstride * p, fi + 1);
    }
    m = this.n / fstride / p;
    const { twRe, twIm, scrRe, scrIm, n } = this;
    for (let u = 0; u < m; u++) {
      for (let q = 0; q < p; q++) {
        scrRe[q] = oR[o + u + q * m]!;
        scrIm[q] = oI[o + u + q * m]!;
      }
      for (let q1 = 0; q1 < p; q1++) {
        const k = u + q1 * m;
        let accR = scrRe[0]!;
        let accI = scrIm[0]!;
        let tw = 0;
        for (let q = 1; q < p; q++) {
          tw += fstride * k;
          while (tw >= n) tw -= n;
          const a = scrRe[q]!;
          const b = scrIm[q]!;
          accR += a * twRe[tw]! - b * twIm[tw]!;
          accI += a * twIm[tw]! + b * twRe[tw]!;
        }
        oR[o + k] = accR;
        oI[o + k] = accI;
      }
    }
  }
}

let ifft: Fft | undefined;
let hann: Float64Array | undefined;
let rotRe: Float64Array | undefined;
let rotIm: Float64Array | undefined;

function window(): Float64Array {
  if (!hann) {
    hann = new Float64Array(N_FFT);
    for (let i = 0; i < N_FFT; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N_FFT); // torch.hann_window (periodic)
  }
  return hann;
}

/**
 * iSTFT of the vocoder output: re/im laid out [BINS=1201][frames] (ONNX [1,1201,F] row-major) -> 48 kHz waveform of frames*600
 * samples, identical to ISTFT(padding='same'): irfft (imag of DC/Nyquist ignored) * window, overlap-add, trim, / window envelope.
 * The real inverse FFT of size 2400 is one complex inverse FFT of size 1200 (even/odd split).
 */
export function sileroIstft(re: ArrayLike<number>, im: ArrayLike<number>, frames: number): Float64Array {
  if (frames <= 0) return new Float64Array(0);
  const M = N_FFT / 2;
  const fft = (ifft ??= new Fft(M, true));
  if (!rotRe || !rotIm) {
    rotRe = new Float64Array(M);
    rotIm = new Float64Array(M);
    for (let k = 0; k < M; k++) {
      rotRe[k] = Math.cos((2 * Math.PI * k) / N_FFT);
      rotIm[k] = Math.sin((2 * Math.PI * k) / N_FFT);
    }
  }
  const cr = rotRe;
  const ci = rotIm;
  const w = window();
  const outLen = (frames - 1) * HOP + N_FFT;
  const y = new Float64Array(outLen);
  const env = new Float64Array(outLen);
  const zr = new Float64Array(M);
  const zi = new Float64Array(M);
  const yr = new Float64Array(M);
  const yi = new Float64Array(M);
  const inv = 1 / N_FFT;
  for (let t = 0; t < frames; t++) {
    for (let k = 0; k < M; k++) {
      // E = X[k] + conj(X[M-k]),  O = (X[k] - conj(X[M-k])) * e^{2 pi i k / N},  Z = E + i O
      const ar = re[k * frames + t]!;
      const ai = k === 0 ? 0 : im[k * frames + t]!;
      const j = M - k;
      const br = re[j * frames + t]!;
      const bi = j === M ? 0 : im[j * frames + t]!;
      const er = ar + br;
      const ei = ai - bi;
      const dr = ar - br;
      const di = ai + bi;
      const or = dr * cr[k]! - di * ci[k]!;
      const oi = dr * ci[k]! + di * cr[k]!;
      zr[k] = er - oi;
      zi[k] = ei + or;
    }
    fft.run(zr, zi, yr, yi);
    const off = t * HOP;
    for (let m = 0; m < M; m++) {
      const i0 = 2 * m;
      y[off + i0]! += yr[m]! * inv * w[i0]!;
      y[off + i0 + 1]! += yi[m]! * inv * w[i0 + 1]!;
    }
    for (let i = 0; i < N_FFT; i++) env[off + i]! += w[i]! * w[i]!;
  }
  const n = outLen - 2 * PAD;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = y[PAD + i]! / env[PAD + i]!;
  return out;
}

/** 48 kHz -> 24 kHz as apply_tts(sample_rate=24000): PQMF analysis (conv1d stride 2, pad 31), tanh if any |band| > 1, band 0 */
export function sileroPqmf24k(x48: ArrayLike<number>): Float64Array {
  const L = x48.length;
  const n = Math.floor((L + 2 * PQMF_PAD - PQMF_H0.length) / 2) + 1;
  const b0 = new Float64Array(Math.max(0, n));
  let peak = 0;
  for (let j = 0; j < n; j++) {
    let s0 = 0;
    let s1 = 0;
    const base = 2 * j - PQMF_PAD;
    for (let k = 0; k < PQMF_H0.length; k++) {
      const i = base + k;
      if (i < 0 || i >= L) continue;
      const v = x48[i]!;
      s0 += PQMF_H0[k]! * v;
      s1 += PQMF_H1[k]! * v;
    }
    b0[j] = s0;
    peak = Math.max(peak, Math.abs(s0), Math.abs(s1));
  }
  if (peak > 1) for (let j = 0; j < n; j++) b0[j] = Math.tanh(b0[j]!);
  return b0;
}

/** float waveform -> Int16 like save_wav ((audio * 32767).astype(int16), i.e. truncation), clamped instead of wrapping */
export function sileroToInt16(x: ArrayLike<number>): Int16Array {
  const out = new Int16Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = Math.max(-32768, Math.min(32767, Math.trunc(x[i]! * 32767)));
  return out;
}

/** samples of 24 kHz output for `frames` acoustic frames (frames*600 at 48 kHz -> /2) */
export function sileroSamples24k(frames: number): number {
  const L = frames * HOP;
  return frames > 0 ? Math.floor((L + 2 * PQMF_PAD - PQMF_H0.length) / 2) + 1 : 0;
}
