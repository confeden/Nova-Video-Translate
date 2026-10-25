/**
 * S2: progressive file (video.currentSrc = http(s) mp4 / webm / mp3). Downloads with Range-aware fetch and decodes
 * faster than real time.
 *  - mp4 / webm: the whole file is fetched and decoded in one go (limit `maxBytes`, default 150 MB) because
 *    decodeAudioData needs a complete container; larger files are reported unsupported.
 *  - mp3: windowed by byte range (constant-bitrate approximation: byte offset = size * t / duration), so positions
 *    are approximate for VBR files (`approx: true`).
 * Cross-origin media usually fails CORS from a content script: pass `fetchFn` that goes through the extension's
 * service worker (host permissions) in production. Positions are exact for mp4/webm.
 */
import type { AudioChunk } from '../providers/types';
import { TARGET_RATE, sliceChunks } from './audio';
import { decodeToPcm16k, yieldToMain, type Decoder } from './decode';
import { isMp4 } from './mp4';
import { isWebm } from './webm';

export type DirectKind = 'mp4' | 'webm' | 'mp3';

export interface DirectProbe {
  supported: boolean;
  kind?: DirectKind;
  size?: number;
  rangeOk?: boolean;
  reason?: string;
}

export interface DirectOptions {
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
  maxBytes?: number;
  /** length of produced chunks (default 15 s) */
  chunkSec?: number;
  /** media duration, required for mp3 windowing */
  durationSec?: number;
  /** mp3 window length (default 60 s) */
  windowSec?: number;
  decoder?: Decoder;
  onProgress?: (loaded: number, total: number | undefined) => void;
}

const DEFAULT_MAX = 150 * 1024 * 1024;

export function sniffKind(head: Uint8Array): DirectKind | null {
  if (isMp4(head)) return 'mp4';
  if (isWebm(head)) return 'webm';
  if (head.length >= 3 && head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) return 'mp3';
  if (head.length >= 2 && head[0] === 0xff && (head[1]! & 0xe0) === 0xe0) return 'mp3';
  return null;
}

/** first bytes of the body; cancels the stream so a server that ignores Range does not send the whole file */
async function readHead(res: Response): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array(await res.arrayBuffer()).subarray(0, 4096);
  const r = res.body.getReader();
  const first = await r.read();
  await r.cancel().catch(() => undefined);
  return (first.value ?? new Uint8Array(0)).subarray(0, 4096);
}

export async function probeDirect(url: string, opts: DirectOptions = {}): Promise<DirectProbe> {
  const f = opts.fetchFn ?? fetch;
  if (!/^https?:/i.test(url)) return { supported: false, reason: 'not http(s)' };
  try {
    const res = await f(url, { headers: { Range: 'bytes=0-4095' }, signal: opts.signal });
    if (!res.ok) return { supported: false, reason: `HTTP ${res.status}` };
    const rangeOk = res.status === 206;
    const cr = /\/(\d+)\s*$/.exec(res.headers.get('content-range') ?? '');
    const cl = Number(res.headers.get('content-length')) || undefined;
    const size = cr ? Number(cr[1]) : rangeOk ? undefined : cl;
    const head = await readHead(res);
    const kind = sniffKind(head);
    if (!kind) return { supported: false, size, rangeOk, reason: 'unknown container' };
    // cross-origin: Content-Range is hidden unless exposed by the server; mp4/webm are then size-checked while downloading
    if (size === undefined && kind === 'mp3') return { supported: false, kind, rangeOk, reason: 'unknown size (Content-Range not exposed)' };
    if (kind !== 'mp3' && size !== undefined && size > (opts.maxBytes ?? DEFAULT_MAX)) return { supported: false, kind, size, rangeOk, reason: 'file too large for whole-file decode' };
    if (kind === 'mp3' && !rangeOk) return { supported: false, kind, size, rangeOk, reason: 'mp3 needs Range support' };
    return { supported: true, kind, size, rangeOk };
  } catch (e) {
    return { supported: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

async function fetchBytes(url: string, f: typeof fetch, signal?: AbortSignal, range?: [number, number], maxBytes = Infinity, onProgress?: (n: number) => void): Promise<Uint8Array> {
  const res = await f(url, { headers: range ? { Range: `bytes=${range[0]}-${range[1]}` } : undefined, signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const parts: Uint8Array[] = [];
  let n = 0;
  const r = res.body.getReader();
  for (;;) {
    const { done, value } = await r.read();
    if (done) break;
    parts.push(value);
    n += value.length;
    onProgress?.(n);
    if (n > maxBytes) {
      await r.cancel().catch(() => undefined);
      throw new Error('file too large for whole-file decode');
    }
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/**
 * Async iterator of 16 kHz mono chunks covering [fromSec, end of media), produced as fast as download + decode allow.
 * Abort via `opts.signal`.
 */
export async function* directChunks(url: string, fromSec: number, opts: DirectOptions = {}): AsyncGenerator<AudioChunk> {
  const f = opts.fetchFn ?? fetch;
  const decode = opts.decoder ?? decodeToPcm16k;
  const chunkSec = opts.chunkSec ?? 15;
  const probe = await probeDirect(url, opts);
  if (!probe.supported || !probe.kind) throw new Error(`direct capture unsupported: ${probe.reason ?? 'unknown'}`);

  if (probe.kind !== 'mp3') {
    const bytes = await fetchBytes(url, f, opts.signal, undefined, opts.maxBytes ?? DEFAULT_MAX, (n) => opts.onProgress?.(n, probe.size));
    const pcm = await decode(bytes);
    for (const c of sliceChunks(pcm, 0, chunkSec, fromSec, TARGET_RATE)) {
      if (opts.signal?.aborted) return;
      yield c;
    }
    return;
  }

  const size = probe.size!;
  const dur = opts.durationSec;
  if (!dur || !Number.isFinite(dur)) throw new Error('mp3 windowing needs durationSec');
  const bps = size / dur;
  const win = opts.windowSec ?? 60;
  let t = Math.max(0, fromSec);
  while (t < dur) {
    if (opts.signal?.aborted) return;
    await yieldToMain(); // windows are decoded one after another: let the page breathe between them
    const a = Math.floor(bps * t);
    const b = Math.min(size - 1, Math.floor(bps * (t + win)) - 1);
    const bytes = await fetchBytes(url, f, opts.signal, [a, b]);
    const pcm = await decode(bytes);
    for (const c of sliceChunks(pcm, t, chunkSec)) yield c;
    opts.onProgress?.(b + 1, size);
    t += win;
  }
}
