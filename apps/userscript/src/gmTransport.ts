import type { Transport } from '@nvt/core';
import { gmXhr, type GmXhr } from './gm';

/**
 * Transport over GM_xmlhttpRequest. Yandex's balancer answers 402 to any request carrying Origin or
 * Sec-Fetch-Mode: cors (gotcha G4). GM requests run in the extension background, are not subject to CORS and carry no
 * page Origin; for the Yandex hosts we additionally state `Sec-Fetch-Mode: no-cors` (the same header VOT sends through
 * GM_xmlhttpRequest; Tampermonkey rewrites such "forbidden" headers via webRequest). Any caller-supplied Origin is dropped.
 */
const YANDEX_HOSTS = /(^|\.)(api\.browser\.yandex\.ru|mds\.yandex\.net)$/i;
const DEFAULT_TIMEOUT_MS = 90_000;

export function parseHeaders(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of (raw ?? '').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return out;
}

export function buildHeaders(url: string, headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() !== 'origin') out[k] = v;
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    /* leave empty */
  }
  if (YANDEX_HOSTS.test(host)) out['Sec-Fetch-Mode'] = 'no-cors';
  return out;
}

export function createGmTransport(xhr: GmXhr = gmXhr, timeoutMs = DEFAULT_TIMEOUT_MS): Transport {
  return (req) =>
    new Promise((resolve, reject) => {
      if (req.signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
      let settled = false;
      let handle: ReturnType<GmXhr>;
      const done = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        req.signal?.removeEventListener('abort', onAbort);
        fn();
      };
      const onAbort = (): void => {
        try {
          handle?.abort();
        } catch {
          /* already finished */
        }
        done(() => reject(new DOMException('Aborted', 'AbortError')));
      };
      req.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        handle = xhr({
          method: req.method,
          url: req.url,
          headers: buildHeaders(req.url, req.headers),
          data: req.body,
          responseType: 'arraybuffer',
          anonymous: true,
          timeout: timeoutMs,
          onload: (r) => {
            void (async () => {
              try {
                const resp = r.response;
                const body =
                  resp instanceof ArrayBuffer
                    ? new Uint8Array(resp)
                    : resp instanceof Blob
                      ? new Uint8Array(await resp.arrayBuffer())
                      : typeof resp === 'string'
                        ? new TextEncoder().encode(resp)
                        : new Uint8Array();
                done(() => resolve({ status: r.status, headers: parseHeaders(r.responseHeaders), body }));
              } catch (e) {
                done(() => reject(e));
              }
            })();
          },
          onerror: (e) => done(() => reject(new Error(`GM_xmlhttpRequest failed${e?.error ? `: ${e.error}` : ''}`))),
          ontimeout: () => done(() => reject(new Error('GM_xmlhttpRequest timed out'))),
          onabort: () => done(() => reject(new DOMException('Aborted', 'AbortError'))),
        });
      } catch (e) {
        done(() => reject(e));
      }
    });
}
