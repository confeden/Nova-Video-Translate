/**
 * Capture orchestrator: S1 MSE tap (needs the MAIN-world hook installed at document_start) -> S2 direct URL
 * -> S3 real-time tap. Every strategy yields AudioChunks on the VIDEO timeline.
 */
import type { AudioChunk } from '../providers/types';
import { diag } from '../diag';
import { Coalescer } from './audio';
import { directChunks, probeDirect, type DirectOptions } from './directUrl';
import { createMseBridgeClient, type MseBridgeClient } from './mseBridge';
import { createRealtimeTap, type RealtimeStatus } from './realtimeTap';
import { HlsCapture, type OffsetPrior, type PcmMonitorFactory } from './hls/hlsCapture';
import { fetchAudioPlaylistSession, HlsAccessError, logHlsSession, type FetchFn, type HlsSession } from './hls/twitchApi';
import { twitchChannelFromPath } from './hls/playlist';

export * from './audio';
export * from './rechunk';
export * from './mp4';
export * from './webm';
export * from './decode';
export * from './mseTap';
export * from './mseBridge';
export * from './directUrl';
export * from './realtimeTap';
export { HlsCapture } from './hls/hlsCapture';
export * from './hls/playlist';
export * from './hls/tsDemux';
export * from './hls/align';
export { fetchAudioPlaylistUrl, fetchBroadcasterLanguage, parseBroadcasterLanguage, HlsAccessError, type FetchFn as HlsFetchFn } from './hls/twitchApi';

export type CaptureKind = 'mse' | 'direct' | 'realtime' | 'hls';

/** hosts whose live player cannot be tapped (Twitch plays MSE inside a worker) but whose HLS rendition we can fetch */
export function isHlsHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^www\./, '');
  return h === 'twitch.tv' || h.endsWith('.twitch.tv');
}

/** capture strategies to try, in order, for a page host */
export function strategiesForHost(host: string): CaptureKind[] {
  return isHlsHost(host) ? ['hls', 'realtime'] : ['mse', 'direct', 'realtime'];
}

export interface CaptureOptions {
  /** target chunk length handed to providers (MSE segments are merged up to it). Default 15 s. */
  chunkSec?: number;
  /** bridge client to the MAIN-world tap; created on demand when omitted */
  bridge?: MseBridgeClient;
  /** URL override for S2 (default video.currentSrc) */
  directUrl?: string;
  /** fetch for S2 (production: proxied through the service worker, which has host permissions) */
  fetchFn?: typeof fetch;
  /** restrict the strategies tried, in order (default all) */
  strategies?: CaptureKind[];
  /** ms to wait for the MAIN-world tap to answer a ping (default 500) */
  pingTimeoutMs?: number;
  onStatus?: (s: CaptureStatus) => void;
  /** HTTP for the 'hls' strategy (service worker / GM transport); without it 'hls' is skipped */
  hlsFetch?: FetchFn;
  /** page pathname for the channel name (default location.pathname) */
  pathname?: string;
  /** monitor tap factory for HLS clock alignment (default: realtime tap of the element) */
  hlsMonitor?: PcmMonitorFactory;
}

export type CaptureStatus =
  | RealtimeStatus
  | { type: 'chosen'; kind: CaptureKind; why: string }
  | { type: 'error'; message: string }
  /** 'hls': a Twitch ad break started / ended (the playing audio is the ad: no alignment, no chunks) */
  | { type: 'ads'; active: boolean }
  /** 'hls': the clock alignment succeeded (used by the background probe that waits for hls to become usable again) */
  | { type: 'aligned' }
  /** 'hls': no correlation yet, chunks flow under a PROVISIONAL clock offset (error bound `errBoundSec`) */
  | { type: 'provisional'; offsetSec: number; errBoundSec: number }
  /** 'hls': the real alignment replaced a provisional offset; video-time slots of chunks emitted under it moved by `shiftSec` (new - old) */
  | { type: 'retime'; shiftSec: number };

export interface Capture {
  readonly kind: CaptureKind;
  /** begin delivering chunks that end after `fromSec` (video time) */
  start(fromSec: number): Promise<void>;
  onChunk(cb: (c: AudioChunk) => void): () => void;
  stop(): void;
  /** the player rebuilt its timeline (ct jumped to ~0): any video-time mapping the capture holds is void ('hls' only) */
  invalidateClock?(why: string): void;
  /** the live-delay controller is about to seek the playhead back itself: the media timeline is unchanged, keep the video-time mapping ('hls' only) */
  noteOwnSeek?(): void;
  /** 'hls': video time where the latest ad break ended (Infinity while one runs); the playhead must not be rewound to before it. undefined = no ad seen */
  adEndSec?(): number | undefined;
  /** 'hls': the anonymous playlist carries stitched-ad segments right now (no content audio from our stream; the capture itself is healthy: no watchdog restart) */
  inGap?(): boolean;
  /** 'hls': number of playlist gap episodes so far (diag 'health') */
  gapCount?(): number;
  /** 'hls': restart the poller WITHOUT a new token / usher session (keeps the media URL and an aligned clock) */
  softRestart?(why: string): void;
  /** 'hls': speech energy of the audio the player actually plays around video time `vt` (monitor envelope); undefined = no data (scheduler onset gate) */
  onsetProbe?(vt: number): { speaking: boolean; silentForSec: number } | undefined;
}

/** a remembered good clock offset / token session is dropped after this long without use */
const HLS_MEMORY_MAX_MS = 15 * 60_000;
interface HlsChannelMemory {
  offsetSec?: number;
  offsetAt: number;
  session?: HlsSession & { at: number };
}
/**
 * Per <video> element and channel: the last good pts-videoTime offset and the token/usher session. A capture restarted on the same element
 * (watchdog, tier switch) starts from them instead of creating a new anonymous session (which may open with an ad) and re-aligning from zero.
 * A different element (the player was rebuilt) or another channel starts clean.
 */
const hlsMemory = new WeakMap<object, Map<string, HlsChannelMemory>>();
function memoryFor(video: object, channel: string): HlsChannelMemory {
  let m = hlsMemory.get(video);
  if (!m) hlsMemory.set(video, (m = new Map()));
  let c = m.get(channel);
  if (!c) m.set(channel, (c = { offsetAt: 0 }));
  return c;
}

export async function createCapture(video: HTMLMediaElement, opts: CaptureOptions = {}): Promise<Capture> {
  const order = opts.strategies ?? (['mse', 'direct', 'realtime'] as CaptureKind[]);
  const chunkSec = opts.chunkSec ?? 15;
  const status = (s: CaptureStatus): void => opts.onStatus?.(s);
  const why: string[] = [];

  for (const kind of order) {
    if (kind === 'hls') {
      const channel = twitchChannelFromPath(opts.pathname ?? (typeof location !== 'undefined' ? location.pathname : ''));
      if (!opts.hlsFetch || !channel) {
        why.push(!opts.hlsFetch ? 'hls: no transport' : 'hls: not a channel page');
        diag.log('hls-fallback', { reason: !opts.hlsFetch ? 'no-transport' : 'not-channel' });
        continue;
      }
      try {
        const mem = memoryFor(video, channel);
        const nowMs = Date.now();
        // reuse the existing session while its token is still valid (a new anonymous usher session may start with an ad)
        const reuse = mem.session && nowMs - mem.session.at < HLS_MEMORY_MAX_MS && (mem.session.expiresAtMs === undefined || mem.session.expiresAtMs - nowMs > 90_000) ? mem.session : undefined;
        let sess: HlsSession & { at: number };
        if (reuse) {
          sess = reuse;
          diag.log('hls-session-reuse', { ageSec: Math.round((nowMs - reuse.at) / 1000), expiresInSec: reuse.expiresAtMs === undefined ? null : Math.round((reuse.expiresAtMs - nowMs) / 1000) });
        } else {
          sess = { ...(await fetchAudioPlaylistSession(channel, opts.hlsFetch)), at: nowMs };
          mem.session = sess;
          logHlsSession('open', null, sess.expiresAtMs, nowMs);
        }
        const prior: OffsetPrior = {
          get: () => (mem.offsetSec !== undefined && Date.now() - mem.offsetAt < HLS_MEMORY_MAX_MS ? mem.offsetSec : undefined),
          set: (v) => {
            mem.offsetSec = v;
            mem.offsetAt = Date.now();
          },
        };
        status({ type: 'chosen', kind, why: `audio_only HLS of ${channel}` });
        return new HlsCapture({
          video,
          channel,
          fetchFn: opts.hlsFetch,
          mediaUrl: sess.url,
          mediaExpiresAtMs: sess.expiresAtMs,
          prior,
          onSession: (s) => (mem.session = { ...s, at: Date.now() }),
          monitorFactory: opts.hlsMonitor ?? defaultHlsMonitor(video),
          onStatus: status,
        });
      } catch (e) {
        const reason = e instanceof HlsAccessError ? e.reason : 'error';
        why.push(`hls: ${reason}`);
        diag.log('hls-fallback', { reason, detail: String((e as Error)?.message ?? e).slice(0, 80) });
      }
    } else if (kind === 'mse') {
      const bridge = opts.bridge ?? createMseBridgeClient();
      const stats = await bridge.ping(opts.pingTimeoutMs ?? 500);
      if (stats && stats.audioBuffers > 0) {
        status({ type: 'chosen', kind, why: `${stats.audioBuffers} audio SourceBuffer(s), ${stats.bufferedSec.toFixed(0)} s held` });
        return mseCapture(bridge, chunkSec, !opts.bridge);
      }
      if (!opts.bridge) bridge.dispose();
      why.push(stats ? 'mse: no audio SourceBuffer' : 'mse: hook not installed');
    } else if (kind === 'direct') {
      const url = opts.directUrl ?? video.currentSrc;
      const dopts: DirectOptions = { fetchFn: opts.fetchFn, chunkSec, durationSec: video.duration };
      const probe = url ? await probeDirect(url, dopts) : { supported: false, reason: 'no url' };
      if (probe.supported) {
        status({ type: 'chosen', kind, why: `${probe.kind} ${probe.size} bytes` });
        return directCapture(url, dopts, video);
      }
      why.push(`direct: ${probe.reason}`);
    } else {
      status({ type: 'chosen', kind, why: why.join('; ') || 'fallback' });
      return realtimeCapture(video, chunkSec, status);
    }
  }
  throw new Error(`no capture strategy available (${why.join('; ')})`);
}

function mseCapture(bridge: MseBridgeClient, chunkSec: number, ownsBridge: boolean): Capture {
  const cbs = new Set<(c: AudioChunk) => void>();
  const co = new Coalescer(chunkSec, (c) => cbs.forEach((f) => f(c)));
  const off = bridge.onChunk((c) => co.push(c));
  return {
    kind: 'mse',
    async start(fromSec) {
      co.reset();
      bridge.start(fromSec);
    },
    onChunk(cb) {
      cbs.add(cb);
      return () => cbs.delete(cb);
    },
    stop() {
      bridge.stop();
      co.flush();
      off();
      // our own client would otherwise keep listening to window messages for the rest of the page's life
      if (ownsBridge) bridge.dispose();
    },
  };
}

function directCapture(url: string, dopts: DirectOptions, _video: HTMLMediaElement): Capture {
  const cbs = new Set<(c: AudioChunk) => void>();
  let ac: AbortController | null = null;
  return {
    kind: 'direct',
    async start(fromSec) {
      ac?.abort();
      const mine = (ac = new AbortController());
      void (async () => {
        try {
          for await (const c of directChunks(url, fromSec, { ...dopts, signal: mine.signal })) {
            if (mine.signal.aborted) return;
            cbs.forEach((f) => f(c));
          }
        } catch {
          /* aborted or failed: the caller sees no more chunks */
        }
      })();
    },
    onChunk(cb) {
      cbs.add(cb);
      return () => cbs.delete(cb);
    },
    stop() {
      ac?.abort();
    },
  };
}

function realtimeCapture(video: HTMLMediaElement, chunkSec: number, status: (s: CaptureStatus) => void): Capture {
  const tap = createRealtimeTap(video, { chunkSec });
  tap.onStatus((s) => status(s));
  return {
    kind: 'realtime',
    start: () => tap.start(),
    onChunk: (cb) => tap.onChunk(cb),
    stop: () => tap.stop(),
  };
}

function defaultHlsMonitor(video: HTMLMediaElement): PcmMonitorFactory {
  return (onPcm) => {
    const tap = createRealtimeTap(video, { chunkSec: 2, onPcm });
    return { start: () => tap.start(), stop: () => tap.stop(), onStatus: (cb) => tap.onStatus((s) => cb(s)) };
  };
}
