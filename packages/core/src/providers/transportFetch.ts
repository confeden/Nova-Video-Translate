import type { Transport } from './types';

/**
 * Body -> bytes. String / binary pass through; FormData / Blob / URLSearchParams are serialised with the platform encoder
 * (multipart boundary included) and the matching content-type is set when the caller did not. Binary bodies cross the
 * extension message channel as base64 (swTransport).
 */
async function encodeBody(b: BodyInit | null | undefined, headers: Record<string, string>): Promise<Uint8Array | undefined> {
  if (b == null) return undefined;
  if (typeof b === 'string') return new TextEncoder().encode(b);
  if (b instanceof Uint8Array) return b;
  if (b instanceof ArrayBuffer) return new Uint8Array(b);
  if (ArrayBuffer.isView(b)) return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  const r = new Response(b as BodyInit);
  const ct = r.headers.get('content-type');
  if (ct && !headers['content-type']) headers['content-type'] = ct;
  return new Uint8Array(await r.arrayBuffer());
}

/** fetch()-shaped wrapper over a Transport (Gemini client / ListModels go through the service worker or GM_xmlhttpRequest). */
export function transportFetch(transport: Transport): (input: string, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const body = await encodeBody(init?.body, headers);
    const res = await transport({
      url: String(input),
      method: (init?.method ?? 'GET').toUpperCase() as 'GET' | 'POST' | 'PUT',
      headers,
      body,
      signal: init?.signal ?? undefined,
    });
    const nullBody = res.status === 204 || res.status === 304;
    return new Response(nullBody ? null : (res.body as BodyInit), { status: res.status, headers: res.headers });
  };
}
