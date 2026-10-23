/** Pure PCM helpers shared by all capture strategies (no DOM, unit-testable in node). */
import type { AudioChunk } from '../providers/types';

export const TARGET_RATE = 16000;

/** Average all channels into one. */
export function downmixToMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0);
  if (channels.length === 1) return channels[0]!;
  const n = channels[0]!.length;
  const out = new Float32Array(n);
  const k = 1 / channels.length;
  for (const ch of channels) for (let i = 0; i < n; i++) out[i]! += ch[i]! * k;
  return out;
}

/**
 * Resample mono float PCM. Down-sampling uses an area average (box filter, acts as a cheap anti-alias
 * low-pass); up-sampling uses linear interpolation.
 */
export function resampleMono(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to || input.length === 0) return input;
  const outLen = Math.max(1, Math.round((input.length * to) / from));
  const out = new Float32Array(outLen);
  const ratio = from / to;
  if (ratio > 1) {
    for (let i = 0; i < outLen; i++) {
      const a = i * ratio;
      const b = Math.min(input.length, a + ratio);
      let ia = Math.floor(a);
      let sum = 0;
      let w = 0;
      while (ia < b) {
        const lo = Math.max(a, ia);
        const hi = Math.min(b, ia + 1);
        const wt = hi - lo;
        if (wt > 0) {
          sum += input[ia]! * wt;
          w += wt;
        }
        ia++;
      }
      out[i] = w > 0 ? sum / w : 0;
    }
  } else {
    for (let i = 0; i < outLen; i++) {
      const p = i * ratio;
      const i0 = Math.floor(p);
      const i1 = Math.min(input.length - 1, i0 + 1);
      const f = p - i0;
      out[i] = input[Math.min(i0, input.length - 1)]! * (1 - f) + input[i1]! * f;
    }
  }
  return out;
}

export function floatToInt16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]!));
    out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
  }
  return out;
}

export function int16ToFloat(input: Int16Array): Float32Array {
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) out[i] = input[i]! / 0x8000;
  return out;
}

/** channels (any rate) -> mono Int16 @16 kHz */
export function toMono16k(channels: Float32Array[], sampleRate: number): Int16Array {
  return floatToInt16(resampleMono(downmixToMono(channels), sampleRate, TARGET_RATE));
}

export function makeChunk(pcm: Int16Array, startSec: number, sampleRate = TARGET_RATE): AudioChunk {
  return { startSec, durationSec: pcm.length / sampleRate, sampleRate, pcm };
}

/** Cut a long PCM run into chunks of `chunkSec` (last one may be shorter), starting at `fromSec` of the run. */
export function sliceChunks(pcm: Int16Array, runStartSec: number, chunkSec: number, fromSec = runStartSec, sampleRate = TARGET_RATE): AudioChunk[] {
  const out: AudioChunk[] = [];
  const n = Math.round(chunkSec * sampleRate);
  let i = Math.max(0, Math.round((fromSec - runStartSec) * sampleRate));
  while (i < pcm.length) {
    const part = pcm.subarray(i, Math.min(pcm.length, i + n));
    out.push(makeChunk(part.slice(), runStartSec + i / sampleRate, sampleRate));
    i += n;
  }
  return out;
}

/**
 * Merges the short, ordered segments an MSE player delivers (~2-10 s) into windows of >= `minSec`.
 * A discontinuity (gap > `maxGapSec` or backwards jump) flushes the partial window as it is.
 */
export class Coalescer {
  private parts: AudioChunk[] = [];
  private sec = 0;
  constructor(
    private readonly minSec: number,
    private readonly emit: (c: AudioChunk) => void,
    private readonly maxGapSec = 0.25,
  ) {}

  push(c: AudioChunk): void {
    if (this.minSec <= 0) return this.emit(c);
    const last = this.parts[this.parts.length - 1];
    if (last) {
      const gap = c.startSec - (last.startSec + last.durationSec);
      if (gap > this.maxGapSec || gap < -this.maxGapSec) this.flush();
    }
    this.parts.push(c);
    this.sec += c.durationSec;
    if (this.sec >= this.minSec) this.flush();
  }

  flush(): void {
    if (this.parts.length === 0) return;
    const parts = this.parts;
    this.parts = [];
    this.sec = 0;
    if (parts.length === 1) return this.emit(parts[0]!);
    const sr = parts[0]!.sampleRate;
    const first = parts[0]!;
    const end = Math.max(...parts.map((p) => p.startSec + p.durationSec));
    const total = Math.round((end - first.startSec) * sr);
    const pcm = new Int16Array(total);
    for (const p of parts) {
      const off = Math.round((p.startSec - first.startSec) * sr); // overlaps overwrite, gaps stay silent
      if (off < 0) continue;
      pcm.set(p.pcm.subarray(0, Math.max(0, Math.min(p.pcm.length, total - off))), off);
    }
    this.emit({ startSec: first.startSec, durationSec: total / sr, sampleRate: sr, pcm });
  }

  reset(): void {
    this.parts = [];
    this.sec = 0;
  }
}

/** Interval store with overlap-based dedupe and a total-duration cap (oldest-inserted evicted first). */
export class TimelineRing<T extends { startSec: number; durationSec: number }> {
  private items: Array<{ item: T; seq: number }> = [];
  private seq = 0;
  private total = 0;
  constructor(
    private readonly maxSec = 600,
    /** fraction of the shorter interval that must overlap to call it a duplicate */
    private readonly dupOverlap = 0.5,
  ) {}

  /** @returns false when an existing item already covers (>= dupOverlap of) this interval */
  add(item: T): boolean {
    const a0 = item.startSec;
    const a1 = a0 + item.durationSec;
    for (const { item: o } of this.items) {
      const o0 = o.startSec;
      const o1 = o0 + o.durationSec;
      if (o0 >= a1 || o1 <= a0) continue;
      const ov = Math.min(a1, o1) - Math.max(a0, o0);
      if (ov >= this.dupOverlap * Math.min(item.durationSec, o.durationSec)) return false;
    }
    this.items.push({ item, seq: this.seq++ });
    this.total += item.durationSec;
    while (this.total > this.maxSec && this.items.length > 1) {
      let k = 0;
      for (let i = 1; i < this.items.length; i++) if (this.items[i]!.seq < this.items[k]!.seq) k = i;
      this.total -= this.items[k]!.item.durationSec;
      this.items.splice(k, 1);
    }
    return true;
  }

  /** items ordered by start time */
  sorted(): T[] {
    return this.items.map((x) => x.item).sort((p, q) => p.startSec - q.startSec);
  }

  get totalSec(): number {
    return this.total;
  }
  get size(): number {
    return this.items.length;
  }
  /** removes the items matching `pred`; returns how many */
  removeWhere(pred: (item: T) => boolean): number {
    const keep = this.items.filter((x) => !pred(x.item));
    const n = this.items.length - keep.length;
    if (n > 0) {
      this.items = keep;
      this.total = keep.reduce((a, x) => a + x.item.durationSec, 0);
    }
    return n;
  }
  clear(): void {
    this.items = [];
    this.total = 0;
  }
}
