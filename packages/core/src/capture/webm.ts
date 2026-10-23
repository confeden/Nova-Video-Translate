/** Minimal EBML/WebM parsing: TimecodeScale + audio track from the init segment, Cluster timing from media segments. */

export interface WebmInit {
  /** ns per timecode tick (default 1_000_000) */
  timecodeScale: number;
  audioTrack?: number;
  hasVideo: boolean;
  /** byte offset of the first Cluster element header, or -1 when the buffer holds no cluster */
  clusterOffset: number;
}

export interface WebmTiming {
  startSec: number;
  durationSec: number;
}

const ID = {
  Segment: 0x18538067,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  Cluster: 0x1f43b675,
  Timecode: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
  BlockDuration: 0x9b,
} as const;

interface El {
  id: number;
  start: number;
  dataStart: number;
  end: number;
  unknownSize: boolean;
}

function readId(b: Uint8Array, p: number): { id: number; len: number } | null {
  const first = b[p];
  if (first === undefined || first === 0) return null;
  let len = 1;
  while (len <= 4 && !(first & (0x80 >> (len - 1)))) len++;
  if (len > 4 || p + len > b.length) return null;
  let id = 0;
  for (let i = 0; i < len; i++) id = id * 256 + b[p + i]!;
  return { id, len };
}

function readSize(b: Uint8Array, p: number): { size: number; len: number; unknown: boolean } | null {
  const first = b[p];
  if (first === undefined || first === 0) return null;
  let len = 1;
  while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
  if (len > 8 || p + len > b.length) return null;
  let v = first & (0xff >> len);
  let allOnes = v === 0xff >> len;
  for (let i = 1; i < len; i++) {
    const x = b[p + i]!;
    if (x !== 0xff) allOnes = false;
    v = v * 256 + x;
  }
  return { size: v, len, unknown: allOnes };
}

/** Sibling elements in [start,end). An unknown-size element is yielded last and runs to `end`. */
function* elements(b: Uint8Array, start: number, end: number): Generator<El> {
  let p = start;
  while (p < end) {
    const id = readId(b, p);
    if (!id) return;
    const sz = readSize(b, p + id.len);
    if (!sz) return;
    const ds = p + id.len + sz.len;
    const e = sz.unknown ? end : Math.min(end, ds + sz.size);
    yield { id: id.id, start: p, dataStart: ds, end: e, unknownSize: sz.unknown };
    if (sz.unknown) return;
    p = e;
  }
}

function uint(b: Uint8Array, s: number, e: number): number {
  let v = 0;
  for (let i = s; i < e; i++) v = v * 256 + b[i]!;
  return v;
}

export function isWebm(b: Uint8Array): boolean {
  return b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3;
}

export function parseWebmInit(b: Uint8Array): WebmInit {
  const out: WebmInit = { timecodeScale: 1_000_000, hasVideo: false, clusterOffset: -1 };
  const walk = (s: number, e: number): boolean => {
    for (const el of elements(b, s, e)) {
      if (el.id === ID.Segment) {
        if (walk(el.dataStart, el.end)) return true;
      } else if (el.id === ID.Info) {
        for (const c of elements(b, el.dataStart, el.end)) {
          if (c.id === ID.TimecodeScale) out.timecodeScale = uint(b, c.dataStart, c.end) || out.timecodeScale;
        }
      } else if (el.id === ID.Tracks) {
        for (const te of elements(b, el.dataStart, el.end)) {
          if (te.id !== ID.TrackEntry) continue;
          let num = 0;
          let type = 0;
          for (const f of elements(b, te.dataStart, te.end)) {
            if (f.id === ID.TrackNumber) num = uint(b, f.dataStart, f.end);
            else if (f.id === ID.TrackType) type = uint(b, f.dataStart, f.end);
          }
          if (type === 2 && out.audioTrack === undefined) out.audioTrack = num;
          if (type === 1) out.hasVideo = true;
        }
      } else if (el.id === ID.Cluster) {
        out.clusterOffset = el.start;
        return true;
      }
    }
    return false;
  };
  walk(0, b.length);
  return out;
}

/** Timing of the audio blocks across all clusters in a media segment. */
export function parseWebmClusters(b: Uint8Array, timecodeScale: number, audioTrack?: number): WebmTiming | null {
  const sec = timecodeScale / 1e9;
  const times: number[] = [];
  let blockDur = 0;
  const block = (s: number, e: number, clusterTc: number): number | null => {
    const t = readSize(b, s);
    if (!t || s + t.len + 3 > e) return null;
    if (audioTrack !== undefined && t.size !== audioTrack) return null;
    let rel = (b[s + t.len]! << 8) | b[s + t.len + 1]!;
    if (rel & 0x8000) rel -= 0x10000;
    return clusterTc + rel;
  };
  const cluster = (s: number, e: number): void => {
    let tc = 0;
    for (const c of elements(b, s, e)) if (c.id === ID.Timecode) tc = uint(b, c.dataStart, c.end);
    for (const c of elements(b, s, e)) {
      if (c.id === ID.SimpleBlock) {
        const t = block(c.dataStart, c.end, tc);
        if (t !== null) times.push(t);
      } else if (c.id === ID.BlockGroup) {
        let t: number | null = null;
        let d = 0;
        for (const g of elements(b, c.dataStart, c.end)) {
          if (g.id === ID.Block) t = block(g.dataStart, g.end, tc);
          else if (g.id === ID.BlockDuration) d = uint(b, g.dataStart, g.end);
        }
        if (t !== null) {
          times.push(t);
          if (d) blockDur = d;
        }
      }
    }
  };
  const top = (s: number, e: number): void => {
    for (const el of elements(b, s, e)) {
      if (el.id === ID.Segment) top(el.dataStart, el.end);
      else if (el.id === ID.Cluster) cluster(el.dataStart, el.end);
    }
  };
  top(0, b.length);
  if (times.length === 0) return null;
  times.sort((x, y) => x - y);
  const first = times[0]!;
  const last = times[times.length - 1]!;
  const deltas = times.slice(1).map((t, i) => t - times[i]!).sort((x, y) => x - y);
  const frame = blockDur || (deltas.length ? deltas[Math.floor(deltas.length / 2)]! : 0); // median: robust to gaps
  return { startSec: first * sec, durationSec: (last - first + frame) * sec };
}

/** true when `b` starts a new unit: the EBML header (init) or a Cluster. Anything else is a continuation slice. */
export function webmStartsUnit(b: Uint8Array): boolean {
  if (isWebm(b)) return true;
  return b.length >= 4 && b[0] === 0x1f && b[1] === 0x43 && b[2] === 0xb6 && b[3] === 0x75;
}

/**
 * Number of bytes the unit starting at b[0] needs to be complete (Infinity when a Cluster has unknown size, i.e.
 * it ends only when the next unit starts). Players such as YouTube append one Cluster in many 16 KB slices.
 */
export function webmUnitLength(b: Uint8Array): number {
  let p = 0;
  if (isWebm(b)) {
    const w = parseWebmInit(b);
    if (w.clusterOffset < 0) return b.length;
    p = w.clusterOffset;
  }
  while (p < b.length) {
    const id = readId(b, p);
    if (!id || id.id !== ID.Cluster) break;
    const sz = readSize(b, p + id.len);
    if (!sz) return p + 12 > b.length ? p + 12 : b.length; // header cut mid-way: need more
    if (sz.unknown) return Infinity;
    p = p + id.len + sz.len + sz.size;
  }
  return Math.max(p, 0);
}
