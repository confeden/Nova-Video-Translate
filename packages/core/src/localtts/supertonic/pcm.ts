/** PCM helpers: float -> int16, resampling, concatenation, base64 transport. Pure. */

export function floatToInt16(f: Float32Array): Int16Array {
  const out = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) {
    const v = Math.max(-1, Math.min(1, f[i]!));
    out[i] = Math.round(v < 0 ? v * 32768 : v * 32767);
  }
  return out;
}

/** Box-filter (anti-alias) + interpolation resampler for speech; cheap, good enough for 44.1k -> 24k. */
export function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to || input.length === 0) return input;
  const ratio = from / to;
  const n = Math.max(1, Math.floor(input.length / ratio));
  const out = new Float32Array(n);
  if (ratio > 1) {
    const cum = new Float64Array(input.length + 1);
    for (let i = 0; i < input.length; i++) cum[i + 1] = cum[i]! + input[i]!;
    // integral of the piecewise-constant signal up to position x
    const at = (x: number): number => {
      const k = Math.min(Math.floor(x), input.length);
      return cum[k]! + (k < input.length ? input[k]! * (x - k) : 0);
    };
    const half = ratio / 2;
    for (let i = 0; i < n; i++) {
      const c = (i + 0.5) * ratio;
      const a = Math.max(0, c - half);
      const b = Math.min(input.length, c + half);
      out[i] = (at(b) - at(a)) / Math.max(1e-9, b - a);
    }
  } else {
    for (let i = 0; i < n; i++) {
      const x = i * ratio;
      const k = Math.floor(x);
      const fr = x - k;
      out[i] = input[k]! * (1 - fr) + input[Math.min(k + 1, input.length - 1)]! * fr;
    }
  }
  return out;
}

/** parts joined with `gapSamples` of silence between them */
export function concatWithGaps(parts: Float32Array[], gapSamples: number): Float32Array {
  const total = parts.reduce((a, p) => a + p.length, 0) + gapSamples * Math.max(0, parts.length - 1);
  const out = new Float32Array(total);
  let o = 0;
  parts.forEach((p, i) => {
    if (i > 0) o += gapSamples;
    out.set(p, o);
    o += p.length;
  });
  return out;
}

export function int16ToB64(s: Int16Array): string {
  const bytes = new Uint8Array(s.buffer, s.byteOffset, s.byteLength);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function b64ToInt16(b64: string): Int16Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length & ~1);
  for (let i = 0; i < bytes.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}

/**
 * Edge cleanup of one synthesized clip (owner: never cut speech, the leading silence shifted timing):
 * leading silence is cut down to `leadKeepSec`, trailing DIGITAL silence (below `eps`) longer than `tailMinSec` is removed, and the end
 * gets a `fadeSec` fade-out. Nothing above the silence threshold is ever removed.
 */
export function trimEdges(f: Float32Array, sr: number, o: { eps?: number; leadKeepSec?: number; tailMinSec?: number; fadeSec?: number } = {}): Float32Array {
  const eps = o.eps ?? 0.0015;
  const keepLead = Math.round((o.leadKeepSec ?? 0.08) * sr);
  const tailMin = Math.round((o.tailMinSec ?? 0.15) * sr);
  const fade = Math.round((o.fadeSec ?? 0.06) * sr);
  let a = 0;
  while (a < f.length && Math.abs(f[a]!) < eps) a++;
  if (a >= f.length) return f; // all silence: untouched
  let b = f.length;
  while (b > a && Math.abs(f[b - 1]!) < eps) b--;
  const start = Math.max(0, a - keepLead);
  const trailing = f.length - b;
  const end = trailing > tailMin ? Math.min(f.length, b + Math.round(0.02 * sr)) : f.length;
  const out = f.slice(start, end);
  const n = Math.min(fade, out.length);
  for (let i = 0; i < n; i++) out[out.length - 1 - i] = out[out.length - 1 - i]! * (i / n);
  return out;
}
