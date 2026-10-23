/**
 * Bridge between the MAIN-world MSE tap (page globals can only be patched there) and the isolated content-script
 * world (where the rest of NVT lives), over window.postMessage with transferable PCM.
 *
 *   MAIN world (document_start):      installMseTapMain()
 *   isolated world:                   const c = createMseBridgeClient(); await c.ping(); c.start(fromSec); c.onChunk(...)
 *
 * The nonce is chosen by the isolated side and sent in `hello`; every later message must carry it. It guards against
 * unrelated postMessage traffic and other extensions, NOT against the page itself (the page can read every message).
 */
import type { AudioChunk } from '../providers/types';
import { installMseTap, type MseTapHandle, type MseTapOptions, type MseTapStats } from './mseTap';

const TAG = 'nvt-mse';

type ToMain =
  | { t: 'hello'; nonce: string }
  | { t: 'ping'; nonce: string; id: number }
  | { t: 'start'; nonce: string; fromSec: number }
  | { t: 'stop'; nonce: string };
type ToIso =
  | { t: 'pong'; nonce: string; id: number; stats: MseTapStats }
  | { t: 'chunk'; nonce: string; startSec: number; durationSec: number; sampleRate: number; pcm: ArrayBuffer };

interface Env {
  postMessage(msg: unknown, targetOrigin: string, transfer?: Transferable[]): void;
  addEventListener(type: 'message', fn: (e: MessageEvent) => void): void;
  removeEventListener(type: 'message', fn: (e: MessageEvent) => void): void;
}

function origin(win: Env): string {
  const l = (win as unknown as { location?: { origin?: string } }).location;
  return l?.origin && l.origin !== 'null' ? l.origin : '*';
}

/** Call in the MAIN world as early as possible (manifest content script `world: "MAIN"`, `run_at: "document_start"`). */
export function installMseTapMain(
  opts: Omit<MseTapOptions, 'startActive'> & { win?: Env } = {},
): { tap: MseTapHandle; dispose(): void } {
  const win = opts.win ?? (globalThis as unknown as Env);
  let nonce: string | null = null;
  const send = (m: ToIso, transfer?: Transferable[]): void => win.postMessage({ [TAG]: m }, origin(win), transfer);
  const tap = installMseTap(
    (c) => {
      if (!nonce) return;
      const pcm = c.pcm.byteOffset === 0 && c.pcm.byteLength === c.pcm.buffer.byteLength ? c.pcm.buffer : c.pcm.slice().buffer;
      send({ t: 'chunk', nonce, startSec: c.startSec, durationSec: c.durationSec, sampleRate: c.sampleRate, pcm: pcm as ArrayBuffer }, [pcm as ArrayBuffer]);
    },
    { ...opts, startActive: false },
  );
  const onMsg = (e: MessageEvent): void => {
    if (e.source !== (win as unknown) || !e.data || typeof e.data !== 'object') return;
    const m = (e.data as Record<string, ToMain | undefined>)[TAG];
    if (!m || typeof m.t !== 'string') return;
    if (m.t === 'hello') {
      nonce = String(m.nonce);
      tap.deactivate();
      return;
    }
    if (!nonce || m.nonce !== nonce) return;
    if (m.t === 'ping') send({ t: 'pong', nonce, id: m.id, stats: tap.stats() });
    else if (m.t === 'start') tap.activate(Number(m.fromSec) || 0);
    else if (m.t === 'stop') tap.deactivate();
  };
  win.addEventListener('message', onMsg);
  return {
    tap,
    dispose() {
      win.removeEventListener('message', onMsg);
      tap.uninstall();
    },
  };
}

export interface MseBridgeClient {
  /** resolves with tap stats, or null when no MAIN-world tap answers within `timeoutMs` */
  ping(timeoutMs?: number): Promise<MseTapStats | null>;
  /** decode and deliver everything buffered that ends after `fromSec`, then keep delivering live */
  start(fromSec: number): void;
  stop(): void;
  onChunk(cb: (c: AudioChunk) => void): () => void;
  dispose(): void;
}

export function createMseBridgeClient(win: Env = globalThis as unknown as Env): MseBridgeClient {
  const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const listeners = new Set<(c: AudioChunk) => void>();
  const pings = new Map<number, (s: MseTapStats) => void>();
  let pingId = 0;
  const send = (m: ToMain): void => win.postMessage({ [TAG]: m }, origin(win));
  const onMsg = (e: MessageEvent): void => {
    if (e.source !== (win as unknown) || !e.data || typeof e.data !== 'object') return;
    const m = (e.data as Record<string, ToIso | undefined>)[TAG];
    if (!m || m.nonce !== nonce) return;
    if (m.t === 'pong') {
      pings.get(m.id)?.(m.stats);
      pings.delete(m.id);
    } else if (m.t === 'chunk') {
      const c: AudioChunk = { startSec: m.startSec, durationSec: m.durationSec, sampleRate: m.sampleRate, pcm: new Int16Array(m.pcm) };
      for (const l of listeners) l(c);
    }
  };
  win.addEventListener('message', onMsg);
  send({ t: 'hello', nonce });
  return {
    ping(timeoutMs = 500) {
      return new Promise((resolve) => {
        const id = ++pingId;
        const timer = setTimeout(() => {
          pings.delete(id);
          resolve(null);
        }, timeoutMs);
        pings.set(id, (s) => {
          clearTimeout(timer);
          resolve(s);
        });
        send({ t: 'ping', nonce, id });
      });
    },
    start: (fromSec) => send({ t: 'start', nonce, fromSec }),
    stop: () => send({ t: 'stop', nonce }),
    onChunk(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    dispose() {
      send({ t: 'stop', nonce });
      win.removeEventListener('message', onMsg);
      listeners.clear();
    },
  };
}

/**
 * Same-realm variant (userscript sandbox where the tap can be installed straight into the page's prototypes):
 * no postMessage, so the page cannot observe the PCM traffic. `opts.target` is the page window (unsafeWindow).
 * The tap stays idle until `client.start()`, like the MAIN-world one.
 */
export function installMseTapLocal(opts: Omit<MseTapOptions, 'startActive'> = {}): {
  tap: MseTapHandle;
  client: MseBridgeClient;
  dispose(): void;
} {
  const listeners = new Set<(c: AudioChunk) => void>();
  const tap = installMseTap((c) => listeners.forEach((l) => l(c)), { ...opts, startActive: false });
  const client: MseBridgeClient = {
    ping: async () => tap.stats(),
    start: (fromSec) => tap.activate(fromSec),
    stop: () => tap.deactivate(),
    onChunk(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    dispose() {
      tap.deactivate();
      listeners.clear();
    },
  };
  return { tap, client, dispose: () => tap.uninstall() };
}
