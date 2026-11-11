/**
 * Progressive (non-fragmented) MP4 with AAC audio, read WITHOUT downloading the video: the sample table of the audio
 * track (moov: stsz / stsc / stco / stts / esds) tells where every audio sample lives, so a window of audio is fetched as
 * a few small Range requests and decoded as ADTS-wrapped AAC. Makes multi-hundred-MB local files translatable ahead of
 * the playhead. Pure parsing + a Range fetcher; the AAC decoder is injected by the caller (WebCodecs, see hls/aac.ts).
 */
import type { AdtsFrame } from './hls/tsDemux';

export interface Mp4AudioIndex {
  sampleRate: number;
  channels: number;
  /** AAC object type - 1 (ADTS "profile") */
  profile: number;
  /** AAC-LC frame length is fixed at 1024 samples; the table's actual per-sample durations are used when they differ */
  startsSec: Float64Array;
  offsets: Float64Array;
  sizes: Uint32Array;
  durationSec: number;
}

type Fetch = typeof fetch;

const u32 = (v: DataView, o: number): number => v.getUint32(o);
const tag = (v: DataView, o: number): string => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));

interface Box {
  type: string;
  start: number;
  dataStart: number;
  end: number;
}

function* walk(v: DataView, start: number, end: number): Generator<Box> {
  let p = start;
  while (p + 8 <= end) {
    let size = u32(v, p);
    const type = tag(v, p + 4);
    let hdr = 8;
    if (size === 1) {
      if (p + 16 > end) return;
      size = Number(v.getBigUint64(p + 8));
      hdr = 16;
    } else if (size === 0) size = end - p;
    if (size < hdr) return;
    yield { type, start: p, dataStart: p + hdr, end: Math.min(end, p + size) };
    p += size;
  }
}

const find = (v: DataView, parent: Box, type: string): Box | undefined => {
  for (const b of walk(v, parent.dataStart, parent.end)) if (b.type === type) return b;
  return undefined;
};

/** MPEG-4 descriptor length (1-4 bytes, 7 bits each) */
function descLen(v: DataView, o: number): { len: number; next: number } {
  let len = 0;
  let i = o;
  for (let k = 0; k < 4; k++) {
    const b = v.getUint8(i++);
    len = (len << 7) | (b & 0x7f);
    if (!(b & 0x80)) break;
  }
  return { len, next: i };
}

const SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/** AudioSpecificConfig of an esds box -> AAC-LC style parameters, or undefined (not AAC / unsupported object type) */
function parseEsds(v: DataView, box: Box): { sampleRate: number; channels: number; objType: number } | undefined {
  let p = box.dataStart + 4; // version + flags
  if (v.getUint8(p) !== 0x03) return undefined;
  let d = descLen(v, p + 1);
  p = d.next + 3; // ES_ID (2) + flags (1)
  if (v.getUint8(p) !== 0x04) return undefined;
  d = descLen(v, p + 1);
  p = d.next + 13; // objectTypeIndication .. avgBitrate
  if (v.getUint8(p) !== 0x05) return undefined;
  d = descLen(v, p + 1);
  const a = new Uint8Array(v.buffer, v.byteOffset + d.next, Math.min(d.len, 8));
  if (a.length < 2) return undefined;
  const objType = a[0]! >> 3;
  const fi = ((a[0]! & 7) << 1) | (a[1]! >> 7);
  const rate = SAMPLE_RATES[fi];
  const channels = (a[1]! >> 3) & 15;
  if (!rate || !channels || objType < 1 || objType > 4) return undefined; // AAC main / LC / SSR / LTP; HE-AAC (5) stays unsupported
  return { sampleRate: rate, channels, objType };
}

/** Parses a complete `moov` box (bytes) into the sample table of the first AAC audio track; undefined when there is none. */
export function parseMp4AudioIndex(moovBytes: Uint8Array): Mp4AudioIndex | undefined {
  const v = new DataView(moovBytes.buffer, moovBytes.byteOffset, moovBytes.byteLength);
  const moov = [...walk(v, 0, v.byteLength)].find((b) => b.type === 'moov');
  if (!moov) return undefined;
  for (const trak of walk(v, moov.dataStart, moov.end)) {
    if (trak.type !== 'trak') continue;
    const mdia = find(v, trak, 'mdia');
    const hdlr = mdia && find(v, mdia, 'hdlr');
    if (!mdia || !hdlr || tag(v, hdlr.dataStart + 8) !== 'soun') continue;
    const mdhd = find(v, mdia, 'mdhd');
    const stbl = find(v, find(v, mdia, 'minf') ?? mdia, 'stbl');
    if (!mdhd || !stbl) continue;
    const timescale = u32(v, mdhd.dataStart + (v.getUint8(mdhd.dataStart) === 1 ? 20 : 12));
    const stsd = find(v, stbl, 'stsd');
    if (!stsd || timescale <= 0) continue;
    // stsd: version/flags (4) + entry count (4), then sample entries; AudioSampleEntry = 8 + 28 bytes before its child boxes
    const entry = [...walk(v, stsd.dataStart + 8, stsd.end)][0];
    if (!entry || entry.type !== 'mp4a') continue;
    const esds = find(v, { ...entry, dataStart: entry.dataStart + 28 }, 'esds');
    const asc = esds && parseEsds(v, esds);
    if (!asc) continue;
    const stsz = find(v, stbl, 'stsz');
    const stsc = find(v, stbl, 'stsc');
    const stts = find(v, stbl, 'stts');
    const co = find(v, stbl, 'stco') ?? find(v, stbl, 'co64');
    if (!stsz || !stsc || !stts || !co) continue;
    // sizes
    const fixed = u32(v, stsz.dataStart + 4);
    const count = u32(v, stsz.dataStart + 8);
    const sizes = new Uint32Array(count);
    for (let i = 0; i < count; i++) sizes[i] = fixed || u32(v, stsz.dataStart + 12 + i * 4);
    // durations -> start times
    const startsSec = new Float64Array(count);
    const nStts = u32(v, stts.dataStart + 4);
    let si = 0;
    let t = 0;
    for (let e = 0; e < nStts && si < count; e++) {
      const n = u32(v, stts.dataStart + 8 + e * 8);
      const dur = u32(v, stts.dataStart + 12 + e * 8);
      for (let k = 0; k < n && si < count; k++) {
        startsSec[si++] = t / timescale;
        t += dur;
      }
    }
    // chunk offsets + samples-per-chunk -> per-sample file offsets
    const is64 = co.type === 'co64';
    const nChunks = u32(v, co.dataStart + 4);
    const nStsc = u32(v, stsc.dataStart + 4);
    const offsets = new Float64Array(count);
    let s = 0;
    for (let c = 0; c < nChunks && s < count; c++) {
      let per = 0;
      for (let e = 0; e < nStsc; e++) {
        if (u32(v, stsc.dataStart + 8 + e * 12) <= c + 1) per = u32(v, stsc.dataStart + 12 + e * 12);
        else break;
      }
      let off = is64 ? Number(v.getBigUint64(co.dataStart + 8 + c * 8)) : u32(v, co.dataStart + 8 + c * 4);
      for (let k = 0; k < per && s < count; k++) {
        offsets[s] = off;
        off += sizes[s]!;
        s++;
      }
    }
    if (s < count || count === 0) continue;
    return { sampleRate: asc.sampleRate, channels: asc.channels, profile: asc.objType - 1, startsSec, offsets, sizes, durationSec: t / timescale };
  }
  return undefined;
}

async function rangeBytes(f: Fetch, url: string, a: number, b: number, signal?: AbortSignal): Promise<Uint8Array> {
  const res = await f(url, { headers: { Range: `bytes=${a}-${b}` }, signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  // a server that ignores Range answers 200 with the whole file: refuse instead of holding hundreds of MB
  if (res.status !== 206 && buf.length > b - a + 1) throw new Error('server ignores Range');
  return buf;
}

const MAX_MOOV = 64 * 1024 * 1024;

/** Finds the top-level `moov` (front or back of the file) with small Range requests and parses the audio index. */
export async function loadMp4AudioIndex(url: string, size: number, f: Fetch, signal?: AbortSignal): Promise<Mp4AudioIndex | undefined> {
  let o = 0;
  for (let hops = 0; o + 8 <= size && hops < 64; hops++) {
    const h = await rangeBytes(f, url, o, Math.min(size - 1, o + 15), signal);
    if (h.length < 8) return undefined;
    const v = new DataView(h.buffer, h.byteOffset, h.byteLength);
    let sz = u32(v, 0);
    if (sz === 1 && h.length >= 16) sz = Number(v.getBigUint64(8));
    else if (sz === 0) sz = size - o;
    if (sz < 8) return undefined;
    if (tag(v, 4) === 'moov') {
      if (sz > MAX_MOOV) return undefined;
      return parseMp4AudioIndex(await rangeBytes(f, url, o, o + sz - 1, signal));
    }
    o += sz;
  }
  return undefined;
}

/** index of the first sample starting at or after `sec` (clamped) */
export function sampleAt(ix: Mp4AudioIndex, sec: number): number {
  let lo = 0;
  let hi = ix.startsSec.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ix.startsSec[mid]! < sec) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** raw AAC sample -> ADTS frame (7-byte header, no CRC) */
export function adtsFrame(raw: Uint8Array, ix: Pick<Mp4AudioIndex, 'sampleRate' | 'channels' | 'profile'>, pts: number): AdtsFrame {
  const fi = SAMPLE_RATES.indexOf(ix.sampleRate);
  const len = raw.length + 7;
  const out = new Uint8Array(len);
  out[0] = 0xff;
  out[1] = 0xf1; // MPEG-4, layer 0, no CRC
  out[2] = ((ix.profile & 3) << 6) | ((fi & 15) << 2) | ((ix.channels >> 2) & 1);
  out[3] = ((ix.channels & 3) << 6) | ((len >> 11) & 3);
  out[4] = (len >> 3) & 0xff;
  out[5] = ((len & 7) << 5) | 0x1f;
  out[6] = 0xfc;
  out.set(raw, 7);
  return { pts, sampleRate: ix.sampleRate, channels: ix.channels, profile: ix.profile, data: out };
}

/**
 * ADTS frames of samples [from, to): consecutive samples of one mp4 chunk are contiguous, so the table is merged into
 * byte runs and fetched with a few parallel Range requests (the interleaved video stays untouched).
 */
export async function fetchAudioFrames(url: string, ix: Mp4AudioIndex, from: number, to: number, f: Fetch, signal?: AbortSignal, parallel = 6): Promise<AdtsFrame[]> {
  const runs: { a: number; b: number; i0: number; i1: number }[] = [];
  for (let i = from; i < to; i++) {
    const last = runs[runs.length - 1];
    if (last && ix.offsets[i] === last.b + 1) {
      last.b += ix.sizes[i]!;
      last.i1 = i + 1;
    } else runs.push({ a: ix.offsets[i]!, b: ix.offsets[i]! + ix.sizes[i]! - 1, i0: i, i1: i + 1 });
  }
  const frames: AdtsFrame[] = new Array(to - from);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < runs.length) {
      const r = runs[next++]!;
      const bytes = await rangeBytes(f, url, r.a, r.b, signal);
      let p = 0;
      for (let i = r.i0; i < r.i1; i++) {
        frames[i - from] = adtsFrame(bytes.subarray(p, p + ix.sizes[i]!), ix, ix.startsSec[i]!);
        p += ix.sizes[i]!;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, runs.length) }, worker));
  return frames;
}
