/**
 * Minimal MPEG-TS audio demuxer (no imports, runs in node and in the browser): PAT -> PMT -> the first AAC (ADTS, stream
 * type 0x0F) elementary stream -> PES reassembly -> ADTS frames stamped with their PTS (seconds, 90 kHz clock).
 */

export interface AdtsFrame {
  /** presentation time of the first sample of this frame, seconds (33-bit PTS / 90000, unwrapped is the caller's job) */
  pts: number;
  sampleRate: number;
  channels: number;
  /** AAC object type - 1 (ADTS "profile"), 1 = AAC-LC */
  profile: number;
  /** complete ADTS frame including its header */
  data: Uint8Array;
}

export interface DemuxResult {
  frames: AdtsFrame[];
  audioPid: number;
  /** TS packets seen / broken (bad sync byte or transport error) */
  packets: number;
  badPackets: number;
  /** continuity counter jumps on the audio PID */
  ccErrors: number;
}

const SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/** Parses ADTS frames out of one PES payload. `pts` stamps the first frame; later ones advance by 1024 samples each. */
export function parseAdts(payload: Uint8Array, pts: number): AdtsFrame[] {
  const out: AdtsFrame[] = [];
  let i = 0;
  let t = pts;
  while (i + 7 <= payload.length) {
    if (payload[i] !== 0xff || (payload[i + 1]! & 0xf0) !== 0xf0) {
      i++; // resync inside the payload
      continue;
    }
    const profile = (payload[i + 2]! >> 6) & 3;
    const sfi = (payload[i + 2]! >> 2) & 15;
    const channels = ((payload[i + 2]! & 1) << 2) | (payload[i + 3]! >> 6);
    const len = ((payload[i + 3]! & 3) << 11) | (payload[i + 4]! << 3) | (payload[i + 5]! >> 5);
    const sampleRate = SAMPLE_RATES[sfi];
    if (!sampleRate || len < 7 || i + len > payload.length) break;
    out.push({ pts: t, sampleRate, channels: channels || 2, profile, data: payload.subarray(i, i + len) });
    t += 1024 / sampleRate;
    i += len;
  }
  return out;
}

function readPts(b: Uint8Array, o: number): number {
  const hi = (b[o]! >> 1) & 7;
  const mid = (b[o + 1]! << 8) | b[o + 2]!;
  const lo = (b[o + 3]! << 8) | b[o + 4]!;
  // 33 bits: hi(3) | mid>>1 (15) | lo>>1 (15); arithmetic, not shifts (JS shifts are 32-bit)
  return (hi * 2 ** 30 + (mid >> 1) * 2 ** 15 + (lo >> 1)) / 90000;
}

/** PES packet -> {pts, payload}; undefined when it is not a well-formed audio PES */
function parsePes(pes: Uint8Array): { pts: number | undefined; payload: Uint8Array } | undefined {
  if (pes.length < 9 || pes[0] !== 0 || pes[1] !== 0 || pes[2] !== 1) return undefined;
  const flags = pes[7]!;
  const hdrLen = pes[8]!;
  const start = 9 + hdrLen;
  if (start > pes.length) return undefined;
  const pts = flags & 0x80 && pes.length >= 14 ? readPts(pes, 9) : undefined;
  return { pts, payload: pes.subarray(start) };
}

export function demuxAudio(ts: Uint8Array): DemuxResult {
  const res: DemuxResult = { frames: [], audioPid: -1, packets: 0, badPackets: 0, ccErrors: 0 };
  let pmtPid = -1;
  let audioPid = -1;
  let parts: Uint8Array[] = [];
  let partsLen = 0;
  let lastCc = -1;
  let lastPts: number | undefined;
  let lastFrameEnd: number | undefined;

  const flush = (): void => {
    if (partsLen === 0) return;
    const pes = new Uint8Array(partsLen);
    let o = 0;
    for (const p of parts) {
      pes.set(p, o);
      o += p.length;
    }
    parts = [];
    partsLen = 0;
    const parsed = parsePes(pes);
    if (!parsed) return;
    // a PES without PTS continues the previous frame run
    const pts = parsed.pts ?? lastFrameEnd;
    if (pts === undefined) return;
    const frames = parseAdts(parsed.payload, pts);
    if (frames.length > 0) {
      const last = frames[frames.length - 1]!;
      lastFrameEnd = last.pts + 1024 / last.sampleRate;
      lastPts = pts;
    }
    for (const f of frames) res.frames.push(f);
  };

  // find the first sync byte that is repeated every 188 bytes
  let base = 0;
  while (base < Math.min(188, ts.length) && !(ts[base] === 0x47 && (base + 188 >= ts.length || ts[base + 188] === 0x47))) base++;

  for (let p = base; p + 188 <= ts.length; p += 188) {
    res.packets++;
    if (ts[p] !== 0x47 || ts[p + 1]! & 0x80) {
      res.badPackets++;
      continue;
    }
    const pusi = (ts[p + 1]! & 0x40) !== 0;
    const pid = ((ts[p + 1]! & 0x1f) << 8) | ts[p + 2]!;
    const afc = (ts[p + 3]! >> 4) & 3;
    const cc = ts[p + 3]! & 15;
    let o = p + 4;
    if (afc & 2) o += 1 + ts[o]!;
    if (!(afc & 1) || o >= p + 188) continue;
    const payload = ts.subarray(o, p + 188);

    if (pid === 0 && pmtPid < 0) {
      // PAT: pointer field, then table; first non-zero program number -> PMT pid
      const t = pusi ? 1 + payload[0]! : 0;
      const secLen = ((payload[t + 1]! & 0x0f) << 8) | payload[t + 2]!;
      for (let q = t + 8; q + 4 <= t + 3 + secLen - 4 && q + 4 <= payload.length; q += 4) {
        const prog = (payload[q]! << 8) | payload[q + 1]!;
        if (prog !== 0) {
          pmtPid = ((payload[q + 2]! & 0x1f) << 8) | payload[q + 3]!;
          break;
        }
      }
    } else if (pid === pmtPid && audioPid < 0) {
      const t = pusi ? 1 + payload[0]! : 0;
      const secLen = ((payload[t + 1]! & 0x0f) << 8) | payload[t + 2]!;
      const progInfo = ((payload[t + 10]! & 0x0f) << 8) | payload[t + 11]!;
      const end = Math.min(payload.length, t + 3 + secLen - 4);
      for (let q = t + 12 + progInfo; q + 5 <= end; ) {
        const type = payload[q]!;
        const epid = ((payload[q + 1]! & 0x1f) << 8) | payload[q + 2]!;
        const esInfo = ((payload[q + 3]! & 0x0f) << 8) | payload[q + 4]!;
        if (type === 0x0f) {
          audioPid = epid;
          res.audioPid = epid;
          break;
        }
        q += 5 + esInfo;
      }
    } else if (pid === audioPid) {
      if (lastCc >= 0 && !(afc === 2) && cc !== ((lastCc + 1) & 15)) res.ccErrors++;
      if (afc & 1) lastCc = cc;
      if (pusi) flush();
      parts.push(payload);
      partsLen += payload.length;
    }
  }
  flush();
  void lastPts;
  return res;
}
