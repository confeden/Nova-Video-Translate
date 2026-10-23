import { diag } from '../../diag';
import { YANDEX_SOURCE_LANGS } from '../../lang/names';
import type { AudioChunk, ChunkResult, ProviderId } from '../types';
import { YANDEX_STATUS, pcmToWav, isLivelyUnavailableMessage, isLivelyVoiceAllowed, livelySourceLang, type TranslateReply, type TranslateRequest } from './client';

/**
 * Full-track mode (S24). With the REAL YouTube url Yandex answers FINISHED at once for videos it already translated, with
 * one full-length CBR mp3 that is time-aligned with the video from 0:00; any other video stays on status 6 AUDIO_REQUESTED
 * (then the chunk mode applies unchanged). A found track is kept in memory per video session and cut into cells on MP3 frame
 * boundaries; nothing is decoded until a cell is played (the scheduler decodes per cell).
 */

// ---------- MP3 frame index / slicing ----------

const BITRATES_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const BITRATES_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const RATES: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
/** frames of lead-in kept before a slice so the decoder's bit reservoir is primed; trimmed again via `skipSec` */
export const MP3_LEAD_FRAMES = 2;

export interface Mp3Index {
  /** byte offset of every audio frame, plus a final sentinel = end of the last frame */
  offsets: Uint32Array;
  frames: number;
  samplesPerFrame: number;
  sampleRate: number;
  bitrateKbps: number;
  frameSec: number;
  durationSec: number;
}

interface FrameHeader {
  len: number;
  samples: number;
  sampleRate: number;
  kbps: number;
  mpeg1: boolean;
  mono: boolean;
}

function parseHeader(b: Uint8Array, p: number): FrameHeader | undefined {
  if (p + 4 > b.length || b[p] !== 0xff || (b[p + 1]! & 0xe0) !== 0xe0) return undefined;
  const ver = (b[p + 1]! >>> 3) & 3;
  const layer = (b[p + 1]! >>> 1) & 3;
  const bri = (b[p + 2]! >>> 4) & 15;
  const sri = (b[p + 2]! >>> 2) & 3;
  const pad = (b[p + 2]! >>> 1) & 1;
  if (layer !== 1 || ver === 1 || bri === 0 || bri === 15 || sri === 3) return undefined; // Layer III, MPEG 1 / 2 / 2.5 only
  const mpeg1 = ver === 3;
  const kbps = (mpeg1 ? BITRATES_V1 : BITRATES_V2)[bri]!;
  const sampleRate = RATES[ver]![sri]!;
  const samples = mpeg1 ? 1152 : 576;
  const len = Math.floor(((samples / 8) * kbps * 1000) / sampleRate) + pad;
  if (len < 4) return undefined;
  return { len, samples, sampleRate, kbps, mpeg1, mono: ((b[p + 3]! >>> 6) & 3) === 3 };
}

/** Xing / Info / VBRI tag frame: carries no audio and must not count into the timeline. */
function isTagFrame(b: Uint8Array, p: number, h: FrameHeader): boolean {
  const side = h.mpeg1 ? (h.mono ? 17 : 32) : h.mono ? 9 : 17;
  const at = (o: number, s: string): boolean => {
    for (let i = 0; i < 4; i++) if (b[p + o + i] !== s.charCodeAt(i)) return false;
    return true;
  };
  return at(4 + side, 'Xing') || at(4 + side, 'Info') || at(36, 'VBRI');
}

/** Walks the frame headers (cheap: no decoding). Undefined = not an MP3 stream we can slice. */
export function indexMp3(bytes: Uint8Array): Mp3Index | undefined {
  let p = 0;
  if (bytes.length > 10 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    p = 10 + (((bytes[6]! & 0x7f) << 21) | ((bytes[7]! & 0x7f) << 14) | ((bytes[8]! & 0x7f) << 7) | (bytes[9]! & 0x7f));
  }
  const offs: number[] = [];
  let first: FrameHeader | undefined;
  while (p + 4 <= bytes.length) {
    const h = parseHeader(bytes, p);
    // a header must be followed by another one (or the end of the data); otherwise it was a false sync
    if (!h || (p + h.len + 4 <= bytes.length && !parseHeader(bytes, p + h.len))) {
      p++;
      continue;
    }
    if (!first) {
      first = h;
      if (isTagFrame(bytes, p, h)) {
        p += h.len;
        continue;
      }
    }
    if (h.sampleRate !== first.sampleRate || h.samples !== first.samples) {
      p += h.len; // a stream that changes format mid-way cannot be time-indexed by frame count: ignore the odd frame
      continue;
    }
    offs.push(p);
    p += h.len;
  }
  if (!first || offs.length === 0) return undefined;
  const end = Math.min(bytes.length, p);
  const offsets = new Uint32Array(offs.length + 1);
  offsets.set(offs);
  offsets[offs.length] = end;
  const frameSec = first.samples / first.sampleRate;
  return { offsets, frames: offs.length, samplesPerFrame: first.samples, sampleRate: first.sampleRate, bitrateKbps: first.kbps, frameSec, durationSec: offs.length * frameSec };
}

export interface Mp3Slice {
  data: Uint8Array;
  /** seconds of lead-in at the start of `data` that the player must skip */
  skipSec: number;
}

/** Frames covering [startSec, endSec) plus MP3_LEAD_FRAMES of lead-in. Undefined when the range lies beyond the track. */
export function sliceMp3(bytes: Uint8Array, idx: Mp3Index, startSec: number, endSec: number): Mp3Slice | undefined {
  const a = Math.max(0, Math.floor(startSec / idx.frameSec + 1e-6));
  if (a >= idx.frames) return undefined;
  const b = Math.min(idx.frames, Math.max(a + 1, Math.ceil(endSec / idx.frameSec - 1e-6)));
  const lead = Math.min(MP3_LEAD_FRAMES, a);
  const data = bytes.slice(idx.offsets[a - lead]!, idx.offsets[b]!);
  return { data, skipSec: lead * idx.frameSec };
}

// ---------- FullTrack ----------

export interface FullTrack {
  tier: 'yandex' | 'yandex-live';
  bytes: Uint8Array;
  index: Mp3Index;
  durationSec: number;
  bitrate: number;
  /** the track is at least as long as the video (otherwise a PART_CONTENT track: the rest stays on chunk mode) */
  complete: boolean;
}

/** a cell is served by the track when it lies inside it (2 s tolerance for the partial last cell) */
export function trackCovers(t: FullTrack, startSec: number, durationSec: number): boolean {
  return startSec < t.durationSec - 0.5 && startSec + durationSec <= t.durationSec + 2;
}

/** The cell as a ChunkResult of the track's tier (same shape the chunk-mode Yandex tier returns: 1 segment, mp3). */
export function serveFromTrack(t: FullTrack, chunk: Pick<AudioChunk, 'startSec' | 'durationSec'>, sourceLang?: string, fromSec?: number): ChunkResult | undefined {
  const end = chunk.startSec + chunk.durationSec;
  // fromSec (tier-switch-now): only the rest of the cell, from the mp3 frame holding the playhead; the segment starts at that frame's time
  let start = chunk.startSec;
  if (fromSec !== undefined && fromSec > chunk.startSec && fromSec < end) {
    start = Math.max(chunk.startSec, Math.floor(fromSec / t.index.frameSec + 1e-6) * t.index.frameSec);
  }
  const sl = sliceMp3(t.bytes, t.index, start, end);
  if (!sl) return undefined;
  return {
    segments: [
      {
        start,
        end,
        audio: { kind: 'encoded', mime: 'audio/mpeg', data: sl.data, skipSec: sl.skipSec },
      },
    ],
    voice: t.tier === 'yandex-live' ? 'lively' : 'standard',
    sourceLang,
  };
}

// ---------- probe ----------

/** The slice of YandexClient the prober uses (fakeable). */
export interface FullTrackClientApi {
  requestTranslation(req: TranslateRequest, signal?: AbortSignal): Promise<TranslateReply>;
  fetchAudio(url: string, signal?: AbortSignal): Promise<Uint8Array>;
  /** chunked upload of a complete audio under the real url (absent = the upload feature is off) */
  uploadAudioParts?(translationId: string, url: string, wav: Uint8Array, signal?: AbortSignal, partBytes?: number): Promise<{ parts: number }>;
}

export interface UploadOptions {
  tier: 'yandex' | 'yandex-live';
  /** the real video url the translation id belongs to */
  url: string;
  /** translationId of the status-6 reply for this url and tier */
  translationId: string;
  /** the COMPLETE audio of the video, mono */
  pcm: Int16Array;
  sampleRate: number;
  signal?: AbortSignal;
  /** part size override (tests); default UPLOAD_MIN_PART_BYTES */
  partBytes?: number;
}

export interface ProbeOptions {
  tier: 'yandex' | 'yandex-live';
  /** the real video url (https://youtu.be/<id>) */
  url: string;
  durationSec: number;
  /** language detected / chosen so far; the same rules as the chunk mode decide what is sent */
  sourceLang?: string;
  signal?: AbortSignal;
  /**
   * Called once, when the first reply (or failure) is known: the engine stops holding the first cells back. For a
   * FINISHED / PART_CONTENT reply with a url it is NOT called when the reply arrives but only when the mp3 is fetched
   * and indexed (or the download failed): the track must exist before the first cells are planned. A successful probe
   * therefore resolves without a prior onFirst (the caller treats the resolution as "first reply known").
   */
  onFirst?(status: number | undefined): void;
  /** a FINISHED / PART_CONTENT reply with a url arrived and the mp3 download starts: the engine extends its hold */
  onDownload?(): void;
  /** background re-probe: exactly ONE request (WAITING is not polled here, the watcher decides when to ask again) */
  once?: boolean;
  /** value of the request's firstRequest flag for the first request of this call (default true; re-probes pass false) */
  firstRequest?: boolean;
  /** called once when the probe ends without a track (and with status 1 on success): what the last reply said */
  onReply?(info: ProbeReplyInfo): void;
}

export interface ProbeReplyInfo {
  /** last Yandex status seen (undefined = no reply: failure before any answer) */
  status?: number;
  /** server ETA of a WAITING reply, seconds */
  remainingSec?: number;
  /** the miss reason as logged ('audio-requested', 'wait-timeout', 'lively-declined', ...) */
  reason?: string;
  /** YandexError kind of a thrown error ('auth', 'network', ...) */
  errorKind?: string;
  /** translationId of the last reply (needed to upload audio for a status-6 reply) */
  translationId?: string;
}

/** background watcher (a video session): delays between re-probes of a tier that has no full track yet */
export const WATCH_WAIT_MAX_MS = 180_000;
export const WATCH_WAIT_FALLBACK_MS = 120_000;
export const WATCH_WAIT_REPEAT_MS = 30_000;
/** status 6 (audio requested): another viewer / session may have caused the translation to be prepared meanwhile */
export const WATCH_NEEDS_AUDIO_MS = 90_000;
export const WATCH_ERROR_MS = 60_000;
export const WATCH_DECLINED_MS = 120_000;

/**
 * VOT-like backoff after a reply. WAITING: the first time remainingTime when it is <= 180 s, else 120 s; every later WAITING
 * (`waitsSeen` > 0, or the initial probe already polled for minutes) every 30 s. Status 6: 60-120 s (cheap request).
 * Undefined = stop watching (auth error).
 */
export function nextWatchDelayMs(info: ProbeReplyInfo | undefined, waitsSeen: number): number | undefined {
  if (!info) return WATCH_ERROR_MS;
  if (info.errorKind === 'auth') return undefined;
  if (info.status === YANDEX_STATUS.WAITING || info.status === YANDEX_STATUS.LONG_WAITING) {
    if (waitsSeen > 0 || info.reason === 'wait-timeout') return WATCH_WAIT_REPEAT_MS;
    const r = info.remainingSec;
    return r !== undefined && r > 0 && r <= WATCH_WAIT_MAX_MS / 1000 ? Math.max(5000, Math.round(r * 1000)) : WATCH_WAIT_FALLBACK_MS;
  }
  if (info.status === YANDEX_STATUS.AUDIO_REQUESTED) return WATCH_NEEDS_AUDIO_MS;
  if (info.reason === 'lively-declined' || info.status === YANDEX_STATUS.FAILED) return WATCH_DECLINED_MS;
  if (info.reason === 'no-url') return WATCH_WAIT_REPEAT_MS;
  return WATCH_ERROR_MS;
}

export interface FullTrackProber {
  /** Resolves with the track, or undefined when there is none (status 6, failure, give-up). WAITING keeps polling in the background. */
  probe(o: ProbeOptions): Promise<FullTrack | undefined>;
  /** uploads a complete audio under the real url (status 6); absent = unsupported */
  upload?(o: UploadOptions): Promise<{ bytes: number; parts: number }>;
}

/** poll the real url while Yandex says WAITING: the cheap first window, then the background window */
export const PROBE_POLL_MS = 2500;
export const PROBE_MAX_WAIT_MS = 180_000;
export const FALLBACK_DURATION_SEC = 310;

export interface FullTrackProberOptions {
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  pollMs?: number;
  maxWaitMs?: number;
}

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('aborted', 'AbortError'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(new DOMException('aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/** Source language as the chunk mode decides it (provider.ts): a supported detected language, else 'auto'; lively maps 'auto' -> 'en'. */
function probeLang(tier: ProbeOptions['tier'], sourceLang: string | undefined): string | undefined {
  const sl = sourceLang && sourceLang !== 'ru' && YANDEX_SOURCE_LANGS.has(sourceLang) ? sourceLang : 'auto';
  if (tier === 'yandex') return sl;
  if (!isLivelyVoiceAllowed(sl, 'ru')) return undefined;
  return livelySourceLang(sl, 'ru');
}

export function createFullTrackProber(client: FullTrackClientApi, o: FullTrackProberOptions = {}): FullTrackProber {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? defaultSleep;
  const pollMs = o.pollMs ?? PROBE_POLL_MS;
  const maxWaitMs = o.maxWaitMs ?? PROBE_MAX_WAIT_MS;
  return {
    upload: client.uploadAudioParts
      ? async (u: UploadOptions): Promise<{ bytes: number; parts: number }> => {
          const t0 = now();
          const wav = pcmToWav(u.pcm, u.sampleRate);
          const { parts } = await client.uploadAudioParts!(u.translationId, u.url, wav, u.signal, u.partBytes);
          diag.log('audio-upload', { tier: u.tier, bytes: wav.length, parts, sec: Math.round((u.pcm.length / u.sampleRate) * 10) / 10, ms: now() - t0 });
          return { bytes: wav.length, parts };
        }
      : undefined,
    async probe(p: ProbeOptions): Promise<FullTrack | undefined> {
      const t0 = now();
      let firstSeen = false;
      const first = (status: number | undefined): void => {
        if (firstSeen) return;
        firstSeen = true;
        p.onFirst?.(status);
      };
      let lastStatus: number | undefined;
      let lastRemaining: number | undefined;
      let lastTid: string | undefined;
      const miss = (reason: string, errorKind?: string): undefined => {
        diag.log('fulltrack-miss', { tier: p.tier, reason, ms: now() - t0 });
        first(undefined);
        p.onReply?.({ status: lastStatus, remainingSec: lastRemaining, reason, errorKind, translationId: lastTid });
        return undefined;
      };
      const lang = probeLang(p.tier, p.sourceLang);
      if (!lang) return miss('lively-not-allowed');
      const lively = p.tier === 'yandex-live';
      const base = { url: p.url, durationSec: p.durationSec > 0 && Number.isFinite(p.durationSec) ? p.durationSec : FALLBACK_DURATION_SEC, sourceLang: lang, targetLang: 'ru', lively };
      let firstRequest = p.firstRequest ?? true;
      try {
        for (;;) {
          const t1 = now();
          const r = await client.requestTranslation({ ...base, firstRequest }, p.signal);
          firstRequest = false;
          lastStatus = r.status;
          lastRemaining = r.remainingTime;
          lastTid = r.translationId;
          diag.log('fulltrack-probe', { tier: p.tier, status: r.status, ms: now() - t1, remaining: r.remainingTime, lively: r.isLivelyVoice });
          const download = (r.status === YANDEX_STATUS.FINISHED || r.status === YANDEX_STATUS.PART_CONTENT) && !!r.url;
          if (download) p.onDownload?.();
          else first(r.status);
          if (lively && r.status !== YANDEX_STATUS.SESSION_REQUIRED && isLivelyUnavailableMessage(r.message)) return miss('lively-declined');
          if (r.status === YANDEX_STATUS.FINISHED || r.status === YANDEX_STATUS.PART_CONTENT) {
            if (!r.url) return miss('no-url');
            if (lively && !r.isLivelyVoice) return miss('not-lively');
            const t2 = now();
            const bytes = await client.fetchAudio(r.url, p.signal);
            const index = indexMp3(bytes);
            if (!index || index.durationSec < 1) return miss('bad-mp3');
            const track: FullTrack = {
              tier: p.tier,
              bytes,
              index,
              durationSec: index.durationSec,
              bitrate: index.bitrateKbps,
              complete: index.durationSec >= base.durationSec - 5,
            };
            diag.log('fulltrack-ok', { tier: p.tier, bytes: bytes.length, durSec: Math.round(index.durationSec * 10) / 10, kbps: index.bitrateKbps, complete: track.complete, ms: now() - t2, totalMs: now() - t0 });
            p.onReply?.({ status: r.status });
            return track;
          }
          if (r.status === YANDEX_STATUS.WAITING || r.status === YANDEX_STATUS.LONG_WAITING) {
            if (p.once) return miss('waiting');
            if (now() - t0 > maxWaitMs) return miss('wait-timeout');
            await sleep(pollMs, p.signal);
            continue;
          }
          return miss(r.status === YANDEX_STATUS.AUDIO_REQUESTED ? 'audio-requested' : `status-${r.status}`);
        }
      } catch (e) {
        if (p.signal?.aborted) {
          first(undefined);
          return undefined;
        }
        return miss(`error: ${String((e as Error)?.message ?? e).slice(0, 80)}`, (e as { kind?: string })?.kind);
      }
    },
  };
}
