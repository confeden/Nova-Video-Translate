/**
 * S1: MAIN-world tap on Media Source Extensions. Copies the audio the page's own player appends to its
 * SourceBuffers (no extra network, no signatures) and turns it into 16 kHz mono AudioChunks.
 *
 * Coexistence (rules I3 / D14): both hooks are `Proxy(apply)` wrappers that forward `this` and the arguments
 * untouched and return/throw exactly what the original does; our bookkeeping runs in try/catch and AFTER the original
 * returned. We never use `muted` / `currentTime` / `timestampOffset` setters (only the timestampOffset getter).
 * Another extension may wrap our wrapper or be wrapped by it: `uninstall()` restores the originals only when our
 * wrapper is still the outermost one; otherwise it turns the wrapper into a pure pass-through (it stays in the chain).
 *
 * Audio is stored RAW (compressed, ~16 KB/s) in a ring of the last `maxBufferedSec`; decoding happens only while the
 * tap is active, so an idle tap costs a memcpy per audio segment and no CPU.
 */
import type { AudioChunk } from '../providers/types';
import { TARGET_RATE, TimelineRing, makeChunk } from './audio';
import { concatBytes, decodeToPcm16k, type Decoder } from './decode';
import { fragmentTiming, isMp4, mp4StartsUnit, mp4UnitComplete, parseMp4Init, splitMp4, type Mp4Track } from './mp4';
import { isWebm, parseWebmClusters, parseWebmInit, webmStartsUnit, webmUnitLength, type WebmInit } from './webm';

export interface MseTapOptions {
  /** ring size for raw audio, seconds of media (default 600) */
  maxBufferedSec?: number;
  /** start decoding immediately (default true). When false call `activate()` later. */
  startActive?: boolean;
  /** override the decoder (tests) */
  decoder?: Decoder;
  /** objects holding MediaSource / SourceBuffer constructors (default globalThis) */
  target?: Record<string, unknown>;
  onEvent?: (e: MseTapEvent) => void;
}

export type MseTapEvent =
  | { type: 'buffer'; id: number; mime: string; audio: 'yes' | 'no' | 'maybe' }
  | { type: 'init'; id: number; hasAudio: boolean }
  | { type: 'segment'; id: number; startSec: number; durationSec: number; duplicate: boolean }
  | { type: 'append'; id: number; bytes: number; head: string; timestampOffset: number }
  | { type: 'decoded'; startSec: number; durationSec: number }
  | { type: 'source'; src: number; why: string; dropped: number }
  | { type: 'stale-append'; id: number; src: number; current: number }
  | { type: 'error'; where: string; message: string };

export interface MseTapStats {
  audioBuffers: number;
  segments: number;
  bufferedSec: number;
  minStartSec: number | null;
  maxEndSec: number | null;
  decoded: number;
  failed: number;
  queued: number;
  active: boolean;
  /** generation of the MediaSource whose audio the tap currently serves (0 = none seen yet) */
  source: number;
  lastError?: string;
}

export interface MseTapHandle {
  uninstall(): void;
  /** forget everything held (the page switched to another video); audio appended afterwards is kept as usual */
  reset(): void;
  /** begin (or restart) decoding everything held and arriving, ignoring audio that ends before `fromSec` */
  activate(fromSec?: number): void;
  deactivate(): void;
  stats(): MseTapStats;
}

interface SbState {
  id: number;
  /** generation of the MediaSource this SourceBuffer belongs to */
  src: number;
  mime: string;
  hint: 'yes' | 'no' | 'maybe';
  container: 'mp4' | 'webm' | 'unknown';
  init?: Uint8Array;
  mp4Audio?: Mp4Track;
  webm?: WebmInit;
  /** slices of the unit (init / fragment / cluster) currently being assembled */
  pending?: { parts: Uint8Array[]; len: number; offsetSec: number };
}

interface RawSeg {
  /** generation of the MediaSource the segment was appended to */
  src: number;
  startSec: number;
  durationSec: number;
  init: Uint8Array;
  data: Uint8Array;
}

function concatParts(parts: Uint8Array[], len: number): Uint8Array {
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const VIDEO_CODEC = /avc|hev|hvc|vp0?[89]|av01|dvh|theora/i;
const AUDIO_CODEC = /mp4a|opus|vorbis|ac-3|ec-3|flac|mp3|mha1|alac/i;

export function classifyMime(mime: string): 'yes' | 'no' | 'maybe' {
  const m = mime.toLowerCase();
  const codecs = /codecs\s*=\s*"?([^";]*)/.exec(m)?.[1] ?? '';
  const a = AUDIO_CODEC.test(codecs);
  const v = VIDEO_CODEC.test(codecs);
  if (m.startsWith('audio/')) return 'yes';
  if (a && !v) return 'yes';
  if (v && !a) return 'no';
  if (a && v) return 'maybe';
  return m.startsWith('video/') ? 'maybe' : 'no';
}

function snapshot(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  return null;
}

const GLOBAL_KEY = '__nvtMseTap';

export function installMseTap(onChunk: (c: AudioChunk) => void, opts: MseTapOptions = {}): MseTapHandle {
  const target = (opts.target ?? globalThis) as Record<string, any>;
  const prev = target[GLOBAL_KEY] as MseTapHandle | undefined;
  if (prev) prev.uninstall();

  const decoder = opts.decoder ?? decodeToPcm16k;
  const ring = new TimelineRing<RawSeg>(opts.maxBufferedSec ?? 600);
  const states = new WeakMap<object, SbState>();
  /** audio-capable SourceBuffer id -> MediaSource generation */
  const audioIds = new Map<number, number>();
  // A page that switches video (YouTube SPA navigation reuses the same <video>) builds a NEW MediaSource. Everything held
  // from the old one is that video's audio: it must never be served for the new one (it also shadows the new segments in
  // the ring, which treats overlapping intervals as duplicates).
  const sourceIds = new WeakMap<object, number>();
  const sourceRefs = new Map<number, WeakRef<object>>();
  let srcSeq = 0;
  let curSrc = 0;
  let nextId = 1;
  let disabled = false;
  let active = opts.startActive ?? true;
  let fromSec = -Infinity;
  let queue: RawSeg[] = [];
  let draining = false;
  let epoch = 0;
  let decoded = 0;
  let failed = 0;
  let lastError: string | undefined;
  const emit = (e: MseTapEvent): void => {
    try {
      opts.onEvent?.(e);
    } catch {
      /* listener bugs must never reach the page */
    }
  };

  /** a newer MediaSource took over: drop what the older ones left (ring, queue, in-flight decodes, buffer ids) */
  const adoptSource = (src: number, why: string): void => {
    if (src <= curSrc) return;
    curSrc = src;
    const dropped = ring.size;
    ring.clear();
    queue = [];
    epoch++;
    for (const [id, s] of [...audioIds]) if (s !== src) audioIds.delete(id);
    for (const k of [...sourceRefs.keys()]) if (k < src) sourceRefs.delete(k);
    emit({ type: 'source', src, why, dropped });
  };

  /** segments of MediaSources that have been closed (detached from their element) are not served */
  const pruneClosed = (): void => {
    for (const [src, ref] of sourceRefs) {
      const ms = ref.deref() as { readyState?: string } | undefined;
      if (ms && ms.readyState !== 'closed') continue;
      sourceRefs.delete(src);
      const n = ring.removeWhere((x) => x.src === src);
      if (n > 0) {
        queue = queue.filter((x) => x.src !== src);
        epoch++;
        emit({ type: 'source', src, why: 'closed', dropped: n });
      }
    }
  };

  const drain = async (): Promise<void> => {
    if (draining) return;
    draining = true;
    const myEpoch = epoch;
    try {
      while (queue.length && active && myEpoch === epoch) {
        const seg = queue.shift()!;
        try {
          const pcm = await decoder(concatBytes(seg.init, seg.data));
          if (myEpoch !== epoch) break;
          if (pcm.length === 0) throw new Error('empty decode');
          decoded++;
          const chunk = makeChunk(pcm, seg.startSec, TARGET_RATE);
          emit({ type: 'decoded', startSec: chunk.startSec, durationSec: chunk.durationSec });
          onChunk(chunk);
        } catch (e) {
          failed++;
          lastError = e instanceof Error ? e.message : String(e);
          emit({ type: 'error', where: 'decode', message: lastError });
        }
      }
    } finally {
      draining = false;
      if (queue.length && active) void drain();
    }
  };

  const enqueue = (seg: RawSeg): void => {
    if (!active || seg.startSec + seg.durationSec <= fromSec) return;
    queue.push(seg);
    void drain();
  };

  const register = (sb: object, mime: string, ms: object | undefined): void => {
    const hint = classifyMime(mime);
    const container = /webm|matroska/i.test(mime) ? 'webm' : /mp4|m4a|aac/i.test(mime) ? 'mp4' : 'unknown';
    let src = ms ? sourceIds.get(ms) : undefined;
    if (ms && src === undefined) {
      src = ++srcSeq;
      sourceIds.set(ms, src);
      if (typeof WeakRef !== 'undefined') sourceRefs.set(src, new WeakRef(ms));
    }
    const st: SbState = { id: nextId++, src: src ?? 0, mime, hint, container };
    states.set(sb, st);
    if (hint !== 'no') {
      if (st.src > curSrc) adoptSource(st.src, 'new-mediasource');
      audioIds.set(st.id, st.src);
    }
    emit({ type: 'buffer', id: st.id, mime, audio: hint });
  };

  const noAudio = (st: SbState): void => {
    st.hint = 'no';
    st.init = undefined;
    audioIds.delete(st.id);
  };

  const MAX_PENDING = 32 * 1024 * 1024;
  const flushPending = (st: SbState): void => {
    const p = st.pending;
    st.pending = undefined;
    if (p) ingestUnit(st, p.parts.length === 1 ? p.parts[0]! : concatParts(p.parts, p.len), p.offsetSec);
  };

  /**
   * Players append one init / fragment / cluster in several slices (YouTube: 16 KB each). Slices are reassembled
   * until the unit is whole (known from its own size fields), then parsed once.
   */
  const ingest = (st: SbState, bytes: Uint8Array, offsetSec: number): void => {
    if (st.src < curSrc) {
      // a SourceBuffer of a MediaSource that has been replaced: its audio belongs to the previous video
      st.pending = undefined;
      emit({ type: 'stale-append', id: st.id, src: st.src, current: curSrc });
      return;
    }
    emit({ type: 'append', id: st.id, bytes: bytes.length, head: Array.from(bytes.subarray(0, 8), (x) => x.toString(16).padStart(2, '0')).join(''), timestampOffset: offsetSec });
    if (st.container === 'unknown') st.container = isWebm(bytes) ? 'webm' : isMp4(bytes) ? 'mp4' : 'unknown';
    if (st.container === 'unknown') return;
    const starts = st.container === 'webm' ? webmStartsUnit(bytes) : mp4StartsUnit(bytes);
    if (starts) {
      flushPending(st);
      st.pending = { parts: [bytes], len: bytes.length, offsetSec };
    } else if (st.pending) {
      st.pending.parts.push(bytes);
      st.pending.len += bytes.length;
    } else {
      return; // continuation of a unit we never saw the start of
    }
    const p = st.pending;
    if (p.len > MAX_PENDING) {
      st.pending = undefined;
      return;
    }
    const whole = p.parts.length === 1 ? p.parts[0]! : concatParts(p.parts, p.len);
    if (p.parts.length > 1) p.parts = [whole];
    const done = st.container === 'webm' ? whole.length >= webmUnitLength(whole) : mp4UnitComplete(whole);
    if (done) flushPending(st);
  };

  /** parse one complete unit (our private copy); commit a segment to the ring if it carries audio */
  const ingestUnit = (st: SbState, bytes: Uint8Array, offsetSec: number): void => {
    if (st.container === 'unknown') st.container = isWebm(bytes) ? 'webm' : isMp4(bytes) ? 'mp4' : 'unknown';
    let timing: { startSec: number; durationSec: number } | null = null;
    let media: Uint8Array | undefined;
    if (st.container === 'mp4') {
      const parts = splitMp4(bytes);
      if (parts.init) {
        const audio = parseMp4Init(parts.init).find((t) => t.kind === 'audio');
        emit({ type: 'init', id: st.id, hasAudio: !!audio });
        if (!audio) return noAudio(st);
        adoptSource(st.src, 'audio-init');
        st.init = parts.init;
        st.mp4Audio = audio;
      }
      media = parts.media;
      if (media && st.mp4Audio && st.init) timing = fragmentTiming(media, st.mp4Audio);
    } else if (st.container === 'webm') {
      if (isWebm(bytes)) {
        const wi = parseWebmInit(bytes);
        emit({ type: 'init', id: st.id, hasAudio: wi.audioTrack !== undefined });
        if (wi.audioTrack === undefined) return noAudio(st);
        adoptSource(st.src, 'audio-init');
        st.webm = wi;
        st.init = wi.clusterOffset >= 0 ? bytes.subarray(0, wi.clusterOffset) : bytes;
        media = wi.clusterOffset >= 0 ? bytes.subarray(wi.clusterOffset) : undefined;
      } else {
        media = bytes;
      }
      if (media && st.webm && st.init) timing = parseWebmClusters(media, st.webm.timecodeScale, st.webm.audioTrack);
    }
    if (!media || !timing || !st.init || timing.durationSec <= 0) return;
    if (st.src < curSrc) return;
    const seg: RawSeg = { src: st.src, startSec: timing.startSec + offsetSec, durationSec: timing.durationSec, init: st.init, data: media };
    const fresh = ring.add(seg);
    emit({ type: 'segment', id: st.id, startSec: seg.startSec, durationSec: seg.durationSec, duplicate: !fresh });
    if (fresh) enqueue(seg);
  };

  // ---- pass-through wrappers -------------------------------------------------------------------------------
  const patches: Array<{ proto: any; name: string; orig: any; proxy: any }> = [];
  const patch = (proto: any, name: string, handler: ProxyHandler<any>['apply']): void => {
    const d = proto && Object.getOwnPropertyDescriptor(proto, name);
    if (!d || typeof d.value !== 'function') return;
    const orig = d.value;
    const proxy = new Proxy(orig, { apply: handler });
    Object.defineProperty(proto, name, { ...d, value: proxy });
    patches.push({ proto, name, orig, proxy });
  };

  for (const cls of ['MediaSource', 'ManagedMediaSource']) {
    const proto = target[cls]?.prototype;
    patch(proto, 'addSourceBuffer', (fn, self, args) => {
      const sb = Reflect.apply(fn, self, args);
      if (!disabled) {
        try {
          if (sb && typeof args[0] === 'string') register(sb, args[0], self as object);
        } catch (e) {
          emit({ type: 'error', where: 'addSourceBuffer', message: String(e) });
        }
      }
      return sb;
    });
  }
  patch(target['SourceBuffer']?.prototype, 'appendBuffer', (fn, self, args) => {
    let st: SbState | undefined;
    let bytes: Uint8Array | null = null;
    let offset = 0;
    if (!disabled) {
      try {
        st = states.get(self);
        if (st && st.hint !== 'no') {
          bytes = snapshot(args[0]);
          offset = Number((self as { timestampOffset?: number }).timestampOffset) || 0; // getter only
        }
      } catch {
        bytes = null;
      }
    }
    const r = Reflect.apply(fn, self, args); // throws exactly like the original; nothing is recorded then
    if (st && bytes && !disabled) {
      try {
        ingest(st, bytes, offset);
      } catch (e) {
        lastError = String(e);
        emit({ type: 'error', where: 'ingest', message: lastError });
      }
    }
    return r;
  });

  const handle: MseTapHandle = {
    reset() {
      const dropped = ring.size;
      ring.clear();
      queue = [];
      epoch++;
      emit({ type: 'source', src: curSrc, why: 'reset', dropped });
    },
    uninstall() {
      disabled = true;
      active = false;
      epoch++;
      queue = [];
      for (const p of patches) {
        // only unwind when we are still the outermost wrapper; otherwise stay in the chain as a no-op
        if (p.proto[p.name] === p.proxy) Object.defineProperty(p.proto, p.name, { value: p.orig, writable: true, configurable: true, enumerable: false });
      }
      patches.length = 0;
      ring.clear();
      if (target[GLOBAL_KEY] === handle) delete target[GLOBAL_KEY];
    },
    activate(from = -Infinity) {
      active = true;
      fromSec = from;
      epoch++;
      pruneClosed();
      queue = ring.sorted().filter((s) => s.startSec + s.durationSec > from);
      void drain();
    },
    deactivate() {
      active = false;
      epoch++;
      queue = [];
    },
    stats() {
      pruneClosed();
      const all = ring.sorted();
      return {
        audioBuffers: audioIds.size,
        segments: ring.size,
        bufferedSec: ring.totalSec,
        minStartSec: all.length ? all[0]!.startSec : null,
        maxEndSec: all.length ? Math.max(...all.map((s) => s.startSec + s.durationSec)) : null,
        decoded,
        failed,
        queued: queue.length,
        active,
        source: curSrc,
        lastError,
      };
    },
  };
  target[GLOBAL_KEY] = handle;
  return handle;
}
