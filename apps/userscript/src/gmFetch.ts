import { gmXhr, type GmXhr, type GmXhrHandle } from './gm';
import { buildHeaders, parseHeaders } from './gmTransport';

/** Resolve at headers, then stream bytes. Buffering a full model would trip the shared 8 s connection deadline. */
export function createGmFetch(xhr: GmXhr = gmXhr): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    if (request.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const data = request.method === 'GET' || request.method === 'HEAD' ? undefined : new Uint8Array(await request.arrayBuffer());
    return new Promise<Response>((resolve, reject) => {
      let handle: GmXhrHandle | void;
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let closed = false;
      let responded = false;
      const cleanup = (): void => { request.signal.removeEventListener('abort', abort); };
      const fail = (error: Error): void => {
        if (closed) return;
        closed = true;
        cleanup();
        if (responded) controller?.error(error);
        else reject(error);
        handle?.abort();
        void reader?.cancel().catch(() => undefined);
      };
      const abort = (): void => {
        fail(new DOMException('Aborted', 'AbortError'));
      };
      request.signal.addEventListener('abort', abort, { once: true });
      try {
        handle = xhr({
          method: request.method, url: request.url, data,
          headers: buildHeaders(request.url, Object.fromEntries(request.headers)),
          anonymous: true, fetch: true, responseType: 'stream',
          onloadstart(response) {
            if (closed) return;
            if (request.method === 'HEAD' || [204, 205, 304].includes(response.status)) {
              try {
                const result = new Response(null, { status: response.status, headers: parseHeaders(response.responseHeaders) });
                responded = true;
                closed = true;
                cleanup();
                resolve(result);
              } catch (e) { fail(e instanceof Error ? e : new Error(String(e))); }
              return;
            }
            if (!response.response || typeof (response.response as ReadableStream).getReader !== 'function') return;
            reader = (response.response as ReadableStream<Uint8Array>).getReader();
            const body = new ReadableStream<Uint8Array>({
              start(c) { controller = c; },
              async pull(c) {
                try {
                  const next = await reader!.read();
                  if (closed) return;
                  if (next.done) { closed = true; cleanup(); c.close(); }
                  else c.enqueue(next.value);
                } catch (e) { fail(e instanceof Error ? e : new Error(String(e))); }
              },
              async cancel() {
                closed = true;
                cleanup();
                handle?.abort();
                await reader?.cancel();
              },
            });
            try {
              const headers = parseHeaders(response.responseHeaders);
              // The manager exposes decoded bytes, so transport encodings and lengths are no longer authoritative.
              if (headers['content-encoding'] && headers['content-encoding'] !== 'identity') delete headers['content-length'];
              delete headers['content-encoding'];
              const result = new Response(body, { status: response.status, headers });
              responded = true;
              resolve(result);
            } catch (e) { fail(e instanceof Error ? e : new Error(String(e))); }
          },
          onload() { if (!responded) fail(new Error('GM streaming is unavailable; update Tampermonkey')); },
          onerror: (e) => fail(new Error(`GM download failed${e.error ? `: ${e.error}` : ''}`)),
          ontimeout: () => fail(new Error('GM download timed out')),
          onabort: () => fail(new DOMException('Aborted', 'AbortError')),
        });
      } catch (e) { fail(e instanceof Error ? e : new Error(String(e))); }
    });
  };
}
