// @ts-nocheck -- Node-only test helper (no @types/node in the workspace)
import https from 'node:https';

/**
 * Transport over node:https: no Origin header, caller-supplied Sec-Fetch-Mode: no-cors (gotcha G4).
 * Does not follow redirects (YandexClient does that itself).
 */
export function nodeTransport(timeoutMs = 60_000) {
  return (req) =>
    new Promise((resolve, reject) => {
      const u = new URL(req.url);
      const headers = { ...req.headers };
      if (req.body) headers['Content-Length'] = String(req.body.length);
      const r = https.request(
        { host: u.host, path: u.pathname + u.search, method: req.method, headers, timeout: timeoutMs, signal: req.signal },
        (res) => {
          const ch = [];
          res.on('data', (d) => ch.push(d));
          res.on('end', () => {
            const h = {};
            for (const [k, v] of Object.entries(res.headers)) h[k] = Array.isArray(v) ? v.join(', ') : String(v ?? '');
            resolve({ status: res.statusCode ?? 0, headers: h, body: new Uint8Array(Buffer.concat(ch)) });
          });
        },
      );
      r.on('error', reject);
      r.on('timeout', () => r.destroy(new Error('timeout')));
      r.end(req.body ? Buffer.from(req.body) : undefined);
    });
}
