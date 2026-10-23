/**
 * Capture orchestrator: S1 MSE tap (needs the MAIN-world hook installed at document_start) -> S2 direct URL
 * -> S3 real-time tap. Every strategy yields AudioChunks on the VIDEO timeline.
 */
import type { AudioChunk } from '../providers/types';
import { Coalescer } from './audio';
import { directChunks, probeDirect, type DirectOptions } from './directUrl';
import { createMseBridgeClient, type MseBridgeClient } from './mseBridge';
import { createRealtimeTap, type RealtimeStatus } from './realtimeTap';

export * from './audio';
export * from './rechunk';
export * from './mp4';
export * from './webm';
export * from './decode';
export * from './mseTap';
export * from './mseBridge';
export * from './directUrl';
export * from './realtimeTap';

export type CaptureKind = 'mse' | 'direct' | 'realtime';

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
}

export type CaptureStatus = RealtimeStatus | { type: 'chosen'; kind: CaptureKind; why: string } | { type: 'error'; message: string };

export interface Capture {
  readonly kind: CaptureKind;
  /** begin delivering chunks that end after `fromSec` (video time) */
  start(fromSec: number): Promise<void>;
  onChunk(cb: (c: AudioChunk) => void): () => void;
  stop(): void;
}

export async function createCapture(video: HTMLMediaElement, opts: CaptureOptions = {}): Promise<Capture> {
  const order = opts.strategies ?? (['mse', 'direct', 'realtime'] as CaptureKind[]);
  const chunkSec = opts.chunkSec ?? 15;
  const status = (s: CaptureStatus): void => opts.onStatus?.(s);
  const why: string[] = [];

  for (const kind of order) {
    if (kind === 'mse') {
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
