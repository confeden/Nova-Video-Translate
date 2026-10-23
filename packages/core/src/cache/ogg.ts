/**
 * Minimal Ogg-Opus muxer (RFC 3533 / RFC 7845): one logical stream, mono or stereo, packets as produced by an
 * Opus encoder (WebCodecs AudioEncoder). Output plays through decodeAudioData in Chromium.
 */

let crcTable: Uint32Array | undefined;
function crc32Ogg(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let r = i << 24;
      for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
      crcTable[i] = r >>> 0;
    }
  }
  let crc = 0;
  for (let i = 0; i < data.length; i++) crc = ((crc << 8) ^ crcTable[((crc >>> 24) ^ data[i]!) & 0xff]!) >>> 0;
  return crc >>> 0;
}

export interface OggOpusParams {
  channels: number;
  /** original input sample rate (informational, stored in OpusHead) */
  inputRate: number;
  /** decoder pre-skip in 48 kHz samples */
  preSkip: number;
  /** Opus packets in order */
  packets: Uint8Array[];
  /** duration of each packet in 48 kHz samples (same length as packets) */
  packetSamples: number[];
  /** exact length of the audio in 48 kHz samples (trims encoder padding); default = sum of packetSamples */
  totalSamples48?: number;
  serial?: number;
}

function page(serial: number, seq: number, flags: number, granule: bigint, packets: Uint8Array[]): Uint8Array {
  const lacing: number[] = [];
  let body = 0;
  for (const p of packets) {
    let n = p.length;
    while (n >= 255) {
      lacing.push(255);
      n -= 255;
    }
    lacing.push(n);
    body += p.length;
  }
  const out = new Uint8Array(27 + lacing.length + body);
  const dv = new DataView(out.buffer);
  out.set([0x4f, 0x67, 0x67, 0x53], 0); // OggS
  out[4] = 0;
  out[5] = flags;
  dv.setBigUint64(6, BigInt.asUintN(64, granule), true);
  dv.setUint32(14, serial >>> 0, true);
  dv.setUint32(18, seq, true);
  out[26] = lacing.length;
  out.set(lacing, 27);
  let o = 27 + lacing.length;
  for (const p of packets) {
    out.set(p, o);
    o += p.length;
  }
  dv.setUint32(22, crc32Ogg(out), true);
  return out;
}

export function opusHead(channels: number, inputRate: number, preSkip: number): Uint8Array {
  const h = new Uint8Array(19);
  h.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64], 0); // OpusHead
  h[8] = 1;
  h[9] = channels;
  const dv = new DataView(h.buffer);
  dv.setUint16(10, preSkip, true);
  dv.setUint32(12, inputRate, true);
  dv.setInt16(16, 0, true); // output gain
  h[18] = 0; // mapping family 0
  return h;
}

function opusTags(): Uint8Array {
  const vendor = new TextEncoder().encode('nvt');
  const t = new Uint8Array(8 + 4 + vendor.length + 4);
  t.set([0x4f, 0x70, 0x75, 0x73, 0x54, 0x61, 0x67, 0x73], 0); // OpusTags
  const dv = new DataView(t.buffer);
  dv.setUint32(8, vendor.length, true);
  t.set(vendor, 12);
  dv.setUint32(12 + vendor.length, 0, true);
  return t;
}

const MAX_SEGMENTS = 255;

export function muxOggOpus(p: OggOpusParams): Uint8Array {
  const serial = p.serial ?? 0x4e565400;
  const pages: Uint8Array[] = [];
  let seq = 0;
  pages.push(page(serial, seq++, 0x02, 0n, [opusHead(p.channels, p.inputRate, p.preSkip)]));
  pages.push(page(serial, seq++, 0x00, 0n, [opusTags()]));

  const total48 = p.totalSamples48 ?? p.packetSamples.reduce((a, b) => a + b, 0);
  let i = 0;
  let granule = 0;
  while (i < p.packets.length) {
    const group: Uint8Array[] = [];
    let segs = 0;
    while (i < p.packets.length) {
      const len = p.packets[i]!.length;
      const need = Math.floor(len / 255) + 1;
      if (group.length > 0 && (segs + need > MAX_SEGMENTS || group.length >= 50)) break;
      group.push(p.packets[i]!);
      segs += need;
      granule += p.packetSamples[i]!;
      i++;
    }
    const last = i >= p.packets.length;
    // the last page's granule trims the encoder's padding: the decoder outputs granule - preSkip samples
    const g = last ? p.preSkip + Math.min(total48, granule) : p.preSkip + granule;
    pages.push(page(serial, seq++, last ? 0x04 : 0x00, BigInt(g), group));
  }
  if (p.packets.length === 0) pages.push(page(serial, seq++, 0x04, BigInt(p.preSkip), []));

  let size = 0;
  for (const pg of pages) size += pg.length;
  const out = new Uint8Array(size);
  let o = 0;
  for (const pg of pages) {
    out.set(pg, o);
    o += pg.length;
  }
  return out;
}

export interface ParsedOgg {
  channels: number;
  preSkip: number;
  packets: Uint8Array[];
  lastGranule: number;
  crcOk: boolean;
}

/** Tiny parser for tests / sanity checks (single logical stream, no continued packets across pages). */
export function parseOggOpus(buf: Uint8Array): ParsedOgg {
  const packets: Uint8Array[] = [];
  let o = 0;
  let crcOk = true;
  let lastGranule = 0;
  while (o + 27 <= buf.length) {
    if (buf[o] !== 0x4f || buf[o + 1] !== 0x67 || buf[o + 2] !== 0x67 || buf[o + 3] !== 0x53) throw new Error('bad OggS');
    const dv = new DataView(buf.buffer, buf.byteOffset + o);
    const nseg = buf[o + 26]!;
    let body = 0;
    for (let k = 0; k < nseg; k++) body += buf[o + 27 + k]!;
    const len = 27 + nseg + body;
    const pg = buf.slice(o, o + len);
    const stored = new DataView(pg.buffer).getUint32(22, true);
    new DataView(pg.buffer).setUint32(22, 0, true);
    if (crc32Ogg(pg) !== stored) crcOk = false;
    lastGranule = Number(dv.getBigUint64(6, true));
    let p = o + 27 + nseg;
    let cur = 0;
    for (let k = 0; k < nseg; k++) {
      const l = buf[o + 27 + k]!;
      cur += l;
      if (l < 255) {
        packets.push(buf.slice(p, p + cur));
        p += cur;
        cur = 0;
      }
    }
    o += len;
  }
  const head = packets[0]!;
  return { channels: head[9]!, preSkip: head[10]! | (head[11]! << 8), packets: packets.slice(2), lastGranule, crcOk };
}
