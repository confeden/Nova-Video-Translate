import { diag, transportFetch, type Transport } from '@nvt/core';
import { browser } from 'wxt/browser';

/**
 * Transport that tunnels HTTP through the extension service worker (background.ts), where a
 * declarativeNetRequest ruleset strips Origin and sets Sec-Fetch-Mode: no-cors for Yandex hosts (gotcha G4).
 * runtime messages are JSON-serialized, so binary bodies travel as base64.
 */

export interface WireReq {
  id: string;
  url: string;
  method: 'GET' | 'POST' | 'PUT';
  headers: Record<string, string>;
  bodyB64?: string;
  /** Date.now() in the content script when the message was sent (the clock is shared on one machine) */
  sentAt?: number;
}
export interface WireRes {
  ok: boolean;
  error?: string;
  status?: number;
  headers?: Record<string, string>;
  bodyB64?: string;
  /** service-worker timings (Date.now()): handler entered, fetch started (DNR rules ready), fetch + body finished */
  swRecvAt?: number;
  swFetchAt?: number;
  swDoneAt?: number;
  /** response body bytes */
  bytes?: number;
}

/** What the service worker answers to `nvt-sw-state`: requests it is working on and the stage of each. */
export interface SwState {
  now: number;
  reqs: Array<{ id: string; ageS: number; stage: string; path: string }>;
}

/** URL without query / fragment (diag lines must never carry secrets) */
export function logPath(url: string): string {
  try {
    const u = new URL(url);
    return u.host.startsWith('api.browser.yandex') ? u.pathname : `${u.host}${u.pathname.slice(0, 40)}`;
  } catch {
    return '?';
  }
}

export function toB64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const SW_STATE_AFTER_MS = 30_000;
const SW_STATE_EVERY_MS = 15_000;
const SW_STATE_REPLY_MS = 5_000;

/** Content-script side: sends `{type:'nvt-http', req}` to the background and returns a Transport. */
export function createSwTransport(): Transport {
  let seq = 0;
  const pending = new Map<string, { t0: number; path: string }>();
  let hb: ReturnType<typeof setInterval> | undefined;

  /** a request has been waiting for a long time: ask the service worker what it is doing (proves SW suspension / message loss) */
  const probeSw = async (): Promise<void> => {
    const now = Date.now();
    if (![...pending.values()].some((p) => now - p.t0 > SW_STATE_AFTER_MS)) return;
    const mine = [...pending.entries()].map(([id, p]) => ({ id, ageS: Math.round((now - p.t0) / 100) / 10, path: p.path }));
    let sw: SwState | 'no-reply' | 'error' = 'no-reply';
    try {
      const reply = await Promise.race([
        browser.runtime.sendMessage({ type: 'nvt-sw-state' }) as Promise<SwState | undefined>,
        new Promise<undefined>((r) => setTimeout(() => r(undefined), SW_STATE_REPLY_MS)),
      ]);
      if (reply) sw = reply;
    } catch {
      sw = 'error';
    }
    diag.log('sw-inflight', { pending: mine, sw });
  };

  return async (req) => {
    if (req.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const tCall = Date.now();
    const id = `${tCall.toString(36)}-${seq++}`;
    const path = logPath(req.url);
    const wire: WireReq = {
      id,
      url: req.url,
      method: req.method,
      headers: req.headers,
      bodyB64: req.body ? toB64(req.body) : undefined,
    };
    const tSend = Date.now();
    wire.sentAt = tSend;
    diag.log('sw-req', { id, m: req.method, path, kb: Math.round((req.body?.length ?? 0) / 102.4) / 10, encMs: tSend - tCall, pending: pending.size });
    pending.set(id, { t0: tSend, path });
    hb ??= setInterval(() => void probeSw(), SW_STATE_EVERY_MS);
    const onAbort = () => void browser.runtime.sendMessage({ type: 'nvt-http-abort', id }).catch(() => {});
    req.signal?.addEventListener('abort', onAbort, { once: true });
    // the reply may never come (suspended worker / lost message): the abort of the caller must end the wait on its own
    let onAbortReject: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      onAbortReject = () => reject(new DOMException('Aborted', 'AbortError'));
      req.signal?.addEventListener('abort', onAbortReject, { once: true });
    });
    aborted.catch(() => {});
    try {
      const res = (await Promise.race([browser.runtime.sendMessage({ type: 'nvt-http', req: wire }), aborted])) as WireRes | undefined;
      const tEnd = Date.now();
      if (req.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (!res) {
        diag.log('sw-err', { id, path, ms: tEnd - tSend, err: 'no response from background' });
        throw new Error('no response from background');
      }
      if (!res.ok) {
        diag.log('sw-err', {
          id,
          path,
          ms: tEnd - tSend,
          err: String(res.error ?? '').slice(0, 100),
          deliver: res.swRecvAt ? res.swRecvAt - tSend : undefined,
          fetch: res.swFetchAt && res.swDoneAt ? res.swDoneAt - res.swFetchAt : undefined,
        });
        throw new Error(res.error ?? 'background fetch failed');
      }
      diag.log('sw-res', {
        id,
        path,
        status: res.status,
        ms: tEnd - tSend,
        deliver: res.swRecvAt ? res.swRecvAt - tSend : undefined,
        rules: res.swRecvAt && res.swFetchAt ? res.swFetchAt - res.swRecvAt : undefined,
        fetch: res.swFetchAt && res.swDoneAt ? res.swDoneAt - res.swFetchAt : undefined,
        back: res.swDoneAt ? tEnd - res.swDoneAt : undefined,
        kb: Math.round((res.bytes ?? 0) / 102.4) / 10,
      });
      return { status: res.status ?? 0, headers: res.headers ?? {}, body: res.bodyB64 ? fromB64(res.bodyB64) : new Uint8Array() };
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') diag.log('sw-abort', { id, path, afterMs: Date.now() - tSend });
      throw e;
    } finally {
      pending.delete(id);
      if (pending.size === 0 && hb) {
        clearInterval(hb);
        hb = undefined;
      }
      req.signal?.removeEventListener('abort', onAbort);
      if (onAbortReject) req.signal?.removeEventListener('abort', onAbortReject);
    }
  };
}

/** Background side: plain fetch (the DNR ruleset fixes the headers). */
export const swFetchTransport: Transport = async (req) => {
  const res = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.body as BodyInit | undefined,
    signal: req.signal,
    credentials: 'omit',
    cache: 'no-store',
  });
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => (headers[k] = v));
  return { status: res.status, headers, body: new Uint8Array(await res.arrayBuffer()) };
};

export { transportFetch };
