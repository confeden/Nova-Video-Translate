/** Reads a 16-bit mono WAV from the repo's research/ dir (undefined when absent). No @types/node: untyped handles. */
async function node(spec: string): Promise<any> {
  return import(/* @vite-ignore */ spec);
}

export async function readResearchWav(name: string): Promise<{ pcm: Int16Array; sampleRate: number } | undefined> {
  const fs = await node('node:fs');
  const path = await node('node:path');
  const url = await node('node:url');
  const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../../../..');
  const file = path.join(root, 'research', name);
  if (!fs.existsSync(file)) return undefined;
  const buf: Uint8Array = fs.readFileSync(file);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const sampleRate = dv.getUint32(24, true);
  let off = 12;
  let dataOff = 44;
  let dataLen = buf.length - 44;
  while (off + 8 <= buf.length) {
    const id = String.fromCharCode(buf[off]!, buf[off + 1]!, buf[off + 2]!, buf[off + 3]!);
    const len = dv.getUint32(off + 4, true);
    if (id === 'data') {
      dataOff = off + 8;
      dataLen = Math.min(len, buf.length - dataOff);
      break;
    }
    off += 8 + len + (len & 1);
  }
  const n = dataLen >> 1;
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) pcm[i] = dv.getInt16(dataOff + 2 * i, true);
  return { pcm, sampleRate };
}

/** Voiced-speech-like signal: harmonics of f0 with a syllable-rate amplitude modulation. */
export function voiced(sampleRate: number, seconds: number, f0: number, amp = 8000, startSec = 0): Int16Array {
  const n = Math.round(seconds * sampleRate);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    let s = 0;
    for (let h = 1; h <= 8; h++) s += Math.sin(2 * Math.PI * f0 * h * (t + startSec)) / h;
    const env = 0.6 + 0.4 * Math.sin(2 * Math.PI * 4 * t);
    out[i] = Math.round(amp * 0.5 * s * env);
  }
  return out;
}

export function silence(sampleRate: number, seconds: number): Int16Array {
  return new Int16Array(Math.round(seconds * sampleRate));
}

export function concat(...parts: Int16Array[]): Int16Array {
  const out = new Int16Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** deterministic white noise burst, clipped like the Gemini 3.8 tail artifact */
export function noiseBurst(sampleRate: number, seconds: number, amp = 17000): Int16Array {
  const n = Math.round(seconds * sampleRate);
  const out = new Int16Array(n);
  let x = 12345;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    const v = (x / 0x7fffffff - 0.5) * 2 * amp * 1.7;
    out[i] = Math.max(-32768, Math.min(32767, Math.round(v)));
  }
  return out;
}
