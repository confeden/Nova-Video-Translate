/** Synthetic MPEG-TS / ADTS builders shared by the HLS tests. */

export function adtsFrame(payloadLen: number, sampleRate = 48000, channels = 2): Uint8Array {
  const rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000];
  const sfi = rates.indexOf(sampleRate);
  const len = 7 + payloadLen;
  const f = new Uint8Array(len);
  f[0] = 0xff;
  f[1] = 0xf1;
  f[2] = (1 << 6) | (sfi << 2) | (channels >> 2);
  f[3] = ((channels & 3) << 6) | (len >> 11);
  f[4] = (len >> 3) & 0xff;
  f[5] = ((len & 7) << 5) | 0x1f;
  f[6] = 0xfc;
  for (let i = 0; i < payloadLen; i++) f[7 + i] = (i * 7) & 0xff;
  return f;
}

function ptsBytes(sec: number): number[] {
  const pts = Math.round(sec * 90000);
  const hi = Math.floor(pts / 2 ** 30) & 7;
  const rest = pts % 2 ** 30;
  const mid = Math.floor(rest / 2 ** 15) & 0x7fff;
  const lo = rest & 0x7fff;
  return [0x21 | (hi << 1), (mid >> 7) & 0xff, ((mid & 0x7f) << 1) | 1, (lo >> 7) & 0xff, ((lo & 0x7f) << 1) | 1];
}

export function pes(ptsSec: number | undefined, payload: Uint8Array): Uint8Array {
  const hasPts = ptsSec !== undefined;
  const hdr = [0, 0, 1, 0xc0, 0, 0, 0x80, hasPts ? 0x80 : 0, hasPts ? 5 : 0, ...(hasPts ? ptsBytes(ptsSec!) : [])];
  const out = new Uint8Array(hdr.length + payload.length);
  out.set(hdr, 0);
  out.set(payload, hdr.length);
  return out;
}

function packet(pid: number, payload: Uint8Array, pusi: boolean, cc: number): Uint8Array {
  const p = new Uint8Array(188).fill(0xff);
  p[0] = 0x47;
  p[1] = (pusi ? 0x40 : 0) | (pid >> 8);
  p[2] = pid & 0xff;
  const pad = 184 - payload.length;
  if (pad === 0) {
    p[3] = 0x10 | (cc & 15);
    p.set(payload, 4);
  } else {
    p[3] = 0x30 | (cc & 15);
    p[4] = pad - 1;
    if (pad > 1) p[5] = 0;
    p.set(payload, 4 + pad);
  }
  return p;
}

function packetize(pid: number, data: Uint8Array, cc0: number): { pkts: Uint8Array[]; cc: number } {
  const pkts: Uint8Array[] = [];
  let cc = cc0;
  for (let o = 0, first = true; o < data.length; o += 184, first = false) pkts.push(packet(pid, data.subarray(o, Math.min(data.length, o + 184)), first, cc++));
  return { pkts, cc };
}

/** One TS segment: PAT + PMT + an AAC PES per `pesList` entry (each [ptsSec|undefined, adts frames]) on `audioPid`. */
export function buildTs(pesList: Array<{ pts: number | undefined; frames: Uint8Array[] }>, audioPid = 0x100): Uint8Array {
  const pmtPid = 0x1000;
  const pat = new Uint8Array([0, 0x00, 0xb0, 13, 0, 1, 0xc1, 0, 0, 0, 1, 0xe0 | (pmtPid >> 8), pmtPid & 0xff, 0, 0, 0, 0]);
  const pmt = new Uint8Array([0, 0x02, 0xb0, 18, 0, 1, 0xc1, 0, 0, 0xe0 | (audioPid >> 8), audioPid & 0xff, 0xf0, 0, 0x0f, 0xe0 | (audioPid >> 8), audioPid & 0xff, 0xf0, 0, 0, 0, 0, 0]);
  const all: Uint8Array[] = [packet(0, pat, true, 0), packet(pmtPid, pmt, true, 0)];
  let cc = 0;
  for (const e of pesList) {
    let n = 0;
    for (const f of e.frames) n += f.length;
    const payload = new Uint8Array(n);
    let o = 0;
    for (const f of e.frames) {
      payload.set(f, o);
      o += f.length;
    }
    const r = packetize(audioPid, pes(e.pts, payload), cc);
    cc = r.cc;
    all.push(...r.pkts);
  }
  const out = new Uint8Array(all.length * 188);
  all.forEach((p, i) => out.set(p, i * 188));
  return out;
}

/** A 2 s segment (about 94 frames of 1024 samples @48 kHz) split over `pesCount` PES packets. */
export function audioSegment(startPts: number, frames = 94, pesCount = 2, sampleRate = 48000): Uint8Array {
  const per = Math.ceil(frames / pesCount);
  const list: Array<{ pts: number; frames: Uint8Array[] }> = [];
  for (let i = 0; i < frames; i += per) {
    const fr: Uint8Array[] = [];
    for (let k = i; k < Math.min(frames, i + per); k++) fr.push(adtsFrame(100 + (k % 5) * 20, sampleRate));
    list.push({ pts: startPts + (i * 1024) / sampleRate, frames: fr });
  }
  return buildTs(list);
}
