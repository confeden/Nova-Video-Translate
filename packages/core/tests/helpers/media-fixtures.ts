/** Synthetic ISO-BMFF / WebM fixtures for capture parser tests. */

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const u32 = (n: number): Uint8Array => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const u64 = (n: number): Uint8Array => concat(u32(Math.floor(n / 2 ** 32)), u32(n >>> 0));
const ascii = (s: string): Uint8Array => new Uint8Array([...s].map((c) => c.charCodeAt(0)));

export function box(type: string, ...payload: Uint8Array[]): Uint8Array {
  const body = concat(...payload);
  return concat(u32(8 + body.length), ascii(type), body);
}

/** init segment with one track */
export function mp4Init(opts: { trackId: number; timescale: number; handler: 'soun' | 'vide'; trexDur?: number; v1?: boolean }): Uint8Array {
  const v1 = !!opts.v1;
  const tkhd = box('tkhd', v1 ? concat(new Uint8Array([1, 0, 0, 7]), u64(0), u64(0), u32(opts.trackId), u32(0), u64(0)) : concat(new Uint8Array([0, 0, 0, 7]), u32(0), u32(0), u32(opts.trackId), u32(0), u32(0)));
  const mdhd = box('mdhd', v1 ? concat(new Uint8Array([1, 0, 0, 0]), u64(0), u64(0), u32(opts.timescale), u64(0)) : concat(new Uint8Array([0, 0, 0, 0]), u32(0), u32(0), u32(opts.timescale), u32(0)));
  const hdlr = box('hdlr', u32(0), u32(0), ascii(opts.handler), new Uint8Array(12));
  const trak = box('trak', tkhd, box('mdia', mdhd, hdlr));
  const trex = box('trex', u32(0), u32(opts.trackId), u32(1), u32(opts.trexDur ?? 0), u32(0), u32(0));
  return concat(box('ftyp', ascii('isom'), u32(0), ascii('isom')), box('moov', trak, box('mvex', trex)));
}

/** moof+mdat for one track. samples = per-sample durations (ticks) written into trun, or undefined to use tfhd default. */
export function mp4Fragment(opts: { trackId: number; baseTime: number; durations?: number[]; defaultDur?: number; count?: number; tfdt64?: boolean }): Uint8Array {
  let tfhdFlags = 0x020000; // default-base-is-moof
  const tfhdExtra: Uint8Array[] = [];
  if (opts.defaultDur !== undefined) {
    tfhdFlags |= 0x8;
    tfhdExtra.push(u32(opts.defaultDur));
  }
  const tfhd = box('tfhd', u32(tfhdFlags), u32(opts.trackId), ...tfhdExtra);
  const tfdt = opts.tfdt64 ? box('tfdt', new Uint8Array([1, 0, 0, 0]), u64(opts.baseTime)) : box('tfdt', new Uint8Array([0, 0, 0, 0]), u32(opts.baseTime));
  let trun: Uint8Array;
  if (opts.durations) {
    // flags: data-offset(0x1) + sample-duration(0x100) + sample-size(0x200)
    trun = box('trun', u32(0x301), u32(opts.durations.length), u32(0), ...opts.durations.flatMap((d) => [u32(d), u32(100)]));
  } else {
    trun = box('trun', u32(0x1), u32(opts.count ?? 0), u32(0));
  }
  return concat(box('moof', box('mfhd', u32(0), u32(1)), box('traf', tfhd, tfdt, trun)), box('mdat', new Uint8Array(16)));
}

// ---- WebM ------------------------------------------------------------------------------------------------

function vint(n: number, len?: number): Uint8Array {
  let l = len ?? 1;
  while (!len && n >= 2 ** (7 * l) - 1) l++;
  const out = new Uint8Array(l);
  let v = n;
  for (let i = l - 1; i >= 0; i--) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  out[0]! |= 0x80 >> (l - 1);
  return out;
}
const idBytes = (id: number): Uint8Array => {
  const b: number[] = [];
  for (let v = id; v > 0; v = Math.floor(v / 256)) b.unshift(v % 256);
  return new Uint8Array(b);
};
export function ebml(id: number, ...payload: Uint8Array[]): Uint8Array {
  const body = concat(...payload);
  return concat(idBytes(id), vint(body.length), body);
}
const uintEl = (id: number, n: number): Uint8Array => {
  const b: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) b.unshift(v % 256);
  return ebml(id, new Uint8Array(b.length ? b : [0]));
};

export function webmInit(opts: { audioTrack: number; withVideoTrack?: number; scale?: number }): Uint8Array {
  const entries = [ebml(0xae, uintEl(0xd7, opts.audioTrack), uintEl(0x83, 2))];
  if (opts.withVideoTrack) entries.unshift(ebml(0xae, uintEl(0xd7, opts.withVideoTrack), uintEl(0x83, 1)));
  const info = ebml(0x1549a966, uintEl(0x2ad7b1, opts.scale ?? 1_000_000));
  const tracks = ebml(0x1654ae6b, ...entries);
  // segment with unknown size (live-style), as real DASH webm init often has
  const segHeader = concat(idBytes(0x18538067), new Uint8Array([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]));
  return concat(ebml(0x1a45dfa3, uintEl(0x4282, 1)), segHeader, info, tracks);
}

export function webmCluster(opts: { timecode: number; blocks: Array<{ track: number; rel: number }> }): Uint8Array {
  const blocks = opts.blocks.map((b) => ebml(0xa3, vint(b.track), new Uint8Array([(b.rel >> 8) & 255, b.rel & 255, 0x80]), new Uint8Array(10)));
  return ebml(0x1f43b675, uintEl(0xe7, opts.timecode), ...blocks);
}
