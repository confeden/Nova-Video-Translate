/** Minimal ISO-BMFF (fMP4 / DASH) parsing: track timescales from the init segment, fragment timing from moof. */

export interface Mp4Track {
  id: number;
  timescale: number;
  kind: 'audio' | 'video' | 'other';
  /** trex default_sample_duration (ticks), 0 when absent */
  defaultSampleDuration: number;
}

export interface Mp4Timing {
  startSec: number;
  durationSec: number;
}

interface Box {
  type: string;
  start: number;
  dataStart: number;
  end: number;
}

function u32(v: DataView, o: number): number {
  return v.getUint32(o);
}
function u64(v: DataView, o: number): number {
  return Number(v.getBigUint64(o));
}

function* boxes(v: DataView, start: number, end: number): Generator<Box> {
  let p = start;
  while (p + 8 <= end) {
    let size = u32(v, p);
    const type = String.fromCharCode(v.getUint8(p + 4), v.getUint8(p + 5), v.getUint8(p + 6), v.getUint8(p + 7));
    let hdr = 8;
    if (size === 1) {
      if (p + 16 > end) return;
      size = u64(v, p + 8);
      hdr = 16;
    } else if (size === 0) {
      size = end - p;
    }
    if (size < hdr) return;
    yield { type, start: p, dataStart: p + hdr, end: Math.min(end, p + size) };
    p += size;
  }
}

function view(b: Uint8Array): DataView {
  return new DataView(b.buffer, b.byteOffset, b.byteLength);
}

function child(v: DataView, parent: Box, type: string): Box | undefined {
  for (const b of boxes(v, parent.dataStart, parent.end)) if (b.type === type) return b;
  return undefined;
}

/** Top-level box types in order (handy for sniffing and tests). */
export function topLevelTypes(buf: Uint8Array): string[] {
  return [...boxes(view(buf), 0, buf.byteLength)].map((b) => b.type);
}

export function isMp4(buf: Uint8Array): boolean {
  if (buf.length < 8) return false;
  const t = String.fromCharCode(buf[4]!, buf[5]!, buf[6]!, buf[7]!);
  return t === 'ftyp' || t === 'styp' || t === 'moov' || t === 'moof' || t === 'sidx';
}

/**
 * Split an appended chunk into its init part (ftyp/moov...) and media part (styp/sidx/moof/mdat...).
 * The init part ends where the first media box begins.
 */
export function splitMp4(buf: Uint8Array): { init?: Uint8Array; media?: Uint8Array } {
  const v = view(buf);
  let mediaAt = -1;
  let sawMoov = false;
  for (const b of boxes(v, 0, buf.byteLength)) {
    if (b.type === 'moov') sawMoov = true;
    if ((b.type === 'moof' || b.type === 'sidx' || b.type === 'styp') && mediaAt < 0) mediaAt = b.start;
  }
  if (!sawMoov) return mediaAt >= 0 ? { media: buf } : {};
  if (mediaAt < 0) return { init: buf };
  return { init: buf.subarray(0, mediaAt), media: buf.subarray(mediaAt) };
}

export function parseMp4Init(init: Uint8Array): Mp4Track[] {
  const v = view(init);
  const tracks: Mp4Track[] = [];
  const trex = new Map<number, number>();
  for (const moov of boxes(v, 0, init.byteLength)) {
    if (moov.type !== 'moov') continue;
    for (const b of boxes(v, moov.dataStart, moov.end)) {
      if (b.type === 'mvex') {
        for (const t of boxes(v, b.dataStart, b.end)) {
          if (t.type === 'trex' && t.end - t.dataStart >= 16) trex.set(u32(v, t.dataStart + 4), u32(v, t.dataStart + 12));
        }
      } else if (b.type === 'trak') {
        const tkhd = child(v, b, 'tkhd');
        const mdia = child(v, b, 'mdia');
        if (!tkhd || !mdia) continue;
        const id = u32(v, tkhd.dataStart + (v.getUint8(tkhd.dataStart) === 1 ? 20 : 12));
        const mdhd = child(v, mdia, 'mdhd');
        const hdlr = child(v, mdia, 'hdlr');
        if (!mdhd) continue;
        const timescale = u32(v, mdhd.dataStart + (v.getUint8(mdhd.dataStart) === 1 ? 20 : 12));
        let kind: Mp4Track['kind'] = 'other';
        if (hdlr) {
          const o = hdlr.dataStart + 8;
          const h = String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
          kind = h === 'soun' ? 'audio' : h === 'vide' ? 'video' : 'other';
        }
        tracks.push({ id, timescale, kind, defaultSampleDuration: 0 });
      }
    }
  }
  for (const t of tracks) t.defaultSampleDuration = trex.get(t.id) ?? 0;
  return tracks;
}

/**
 * Timing of `track` inside a media segment (one or more moof+mdat pairs): start = first tfdt,
 * duration = sum of trun sample durations over all moofs. null when it cannot be determined.
 */
export function fragmentTiming(seg: Uint8Array, track: Mp4Track): Mp4Timing | null {
  const v = view(seg);
  let base: number | null = null;
  let ticks = 0;
  for (const moof of boxes(v, 0, seg.byteLength)) {
    if (moof.type !== 'moof') continue;
    for (const traf of boxes(v, moof.dataStart, moof.end)) {
      if (traf.type !== 'traf') continue;
      const tfhd = child(v, traf, 'tfhd');
      if (!tfhd || u32(v, tfhd.dataStart + 4) !== track.id) continue;
      const tflags = u32(v, tfhd.dataStart) & 0xffffff;
      let p = tfhd.dataStart + 8;
      if (tflags & 0x1) p += 8;
      if (tflags & 0x2) p += 4;
      const defDur = tflags & 0x8 ? u32(v, p) : track.defaultSampleDuration;
      const tfdt = child(v, traf, 'tfdt');
      if (tfdt && base === null) {
        base = v.getUint8(tfdt.dataStart) === 1 ? u64(v, tfdt.dataStart + 4) : u32(v, tfdt.dataStart + 4);
      }
      for (const trun of boxes(v, traf.dataStart, traf.end)) {
        if (trun.type !== 'trun') continue;
        const f = u32(v, trun.dataStart) & 0xffffff;
        const count = u32(v, trun.dataStart + 4);
        let q = trun.dataStart + 8;
        if (f & 0x1) q += 4;
        if (f & 0x4) q += 4;
        if (!(f & 0x100)) {
          ticks += count * defDur;
          continue;
        }
        const stride = 4 + (f & 0x200 ? 4 : 0) + (f & 0x400 ? 4 : 0) + (f & 0x800 ? 4 : 0);
        for (let i = 0; i < count && q + stride <= trun.end; i++, q += stride) ticks += u32(v, q);
      }
    }
  }
  if (base === null || !track.timescale) return null;
  return { startSec: base / track.timescale, durationSec: ticks / track.timescale };
}

/** true when `buf` starts a new unit (init or a fragment) rather than continuing a split mdat. */
export function mp4StartsUnit(buf: Uint8Array): boolean {
  return isMp4(buf);
}

/**
 * Whether the appended unit is whole: every top-level box fits, and a fragment (moof) ends with its mdat.
 * Players may append one fragment in several slices.
 */
export function mp4UnitComplete(buf: Uint8Array): boolean {
  const v = view(buf);
  let p = 0;
  let sawMoof = false;
  let last = '';
  while (p + 8 <= buf.byteLength) {
    let size = u32(v, p);
    const type = String.fromCharCode(buf[p + 4]!, buf[p + 5]!, buf[p + 6]!, buf[p + 7]!);
    if (size === 1) {
      if (p + 16 > buf.byteLength) return false;
      size = u64(v, p + 8);
    } else if (size === 0) {
      return false; // to-end box: cannot know
    }
    if (size < 8 || p + size > buf.byteLength) return false;
    if (type === 'moof') sawMoof = true;
    last = type;
    p += size;
  }
  if (p !== buf.byteLength) return false;
  return !sawMoof || last === 'mdat';
}
