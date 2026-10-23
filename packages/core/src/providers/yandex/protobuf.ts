/** Minimal protobuf wire encoder/decoder (varint, fixed64 double, length-delimited). No dependencies. */

const te = new TextEncoder();
const td = new TextDecoder();

export function concat(...parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function varint(n: number | bigint): Uint8Array {
  let v = BigInt(n);
  const o: number[] = [];
  while (v > 0x7fn) {
    o.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  o.push(Number(v));
  return Uint8Array.from(o);
}

const tag = (field: number, wire: number) => varint((field << 3) | wire);

export const fStr = (field: number, s: string): Uint8Array => fBytes(field, te.encode(s));
export const fBytes = (field: number, b: Uint8Array): Uint8Array => concat(tag(field, 2), varint(b.length), b);
export const fVar = (field: number, n: number): Uint8Array => concat(tag(field, 0), varint(n));
export const fBool = (field: number, v: boolean): Uint8Array => fVar(field, v ? 1 : 0);
export function fDbl(field: number, d: number): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, d, true);
  return concat(tag(field, 1), b);
}

export type PbValue = number | Uint8Array;
export type PbMessage = Record<number, PbValue[]>;

/** Decode a message into {fieldNo: [values]}. varint -> number, fixed64 -> double, fixed32 -> float, len -> bytes. */
export function decode(buf: Uint8Array): PbMessage {
  const out: PbMessage = {};
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let p = 0;
  const rv = (): number => {
    let r = 0n;
    let s = 0n;
    for (;;) {
      if (p >= buf.length) throw new Error('protobuf: truncated varint');
      const b = buf[p++]!;
      r |= BigInt(b & 0x7f) << s;
      if (!(b & 0x80)) break;
      s += 7n;
    }
    return Number(r);
  };
  while (p < buf.length) {
    const t = rv();
    const f = Math.floor(t / 8);
    const w = t & 7;
    let v: PbValue;
    if (w === 0) v = rv();
    else if (w === 1) {
      v = dv.getFloat64(p, true);
      p += 8;
    } else if (w === 2) {
      const l = rv();
      if (p + l > buf.length) throw new Error('protobuf: truncated field');
      v = buf.subarray(p, p + l);
      p += l;
    } else if (w === 5) {
      v = dv.getFloat32(p, true);
      p += 4;
    } else break;
    (out[f] ||= []).push(v);
  }
  return out;
}

export function getStr(m: PbMessage, f: number): string | undefined {
  const v = m[f]?.[0];
  return v instanceof Uint8Array ? td.decode(v) : undefined;
}

export function getNum(m: PbMessage, f: number): number | undefined {
  const v = m[f]?.[0];
  return typeof v === 'number' ? v : undefined;
}
