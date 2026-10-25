/**
 * Model download resilience. huggingface.co is flaky/blocked for part of the users, so the pinned Whisper files are mirrored on
 * the owner's S3 (public read, prefix nvt-models/, same path layout as HF) and fetched mirror-first with an HF fallback. The cache
 * key stays the HF URL (transformers.js caches by the URL it asked for), so nothing changes for already downloaded models.
 * Public URLs only; no credentials. Dependency-free (offscreen document, tests).
 */

/** public base of the model mirror (path-style S3 URL, trailing slash); objects: <base><org>/<repo>/resolve/<rev>/<file> */
export const MODEL_MIRROR_BASE = 'https://s3.ru1.storage.beget.cloud/b04f36843373-decisive-daly/nvt-models/';
export const HF_BASE = 'https://huggingface.co/';
/** per-source attempts and the pause before each retry (ms) */
export const FETCH_BACKOFF_MS: readonly number[] = [1000, 3000, 8000];
export const ERROR_TEXT_MAX = 200;

const HF_MODEL_URL = /^https:\/\/huggingface\.co\/([^/]+\/[^/]+)\/resolve\/([0-9a-f]{40})\/(.+?)(?:\?.*)?$/;

export interface HfModelUrl {
  repo: string;
  revision: string;
  file: string;
}

/** parses a pinned-revision HF file URL (the only kind that exists on the mirror) */
export function parseHfModelUrl(url: string): HfModelUrl | undefined {
  const m = HF_MODEL_URL.exec(url);
  return m ? { repo: m[1]!, revision: m[2]!, file: m[3]! } : undefined;
}

/** sources to try in order: mirror first, huggingface.co last; undefined for a URL that is not a pinned model file */
export function modelSourceUrls(url: string, mirrorBase: string = MODEL_MIRROR_BASE): string[] | undefined {
  const p = parseHfModelUrl(url);
  if (!p) return undefined;
  const path = `${p.repo}/resolve/${p.revision}/${p.file}`;
  return [mirrorBase + path, HF_BASE + path];
}

/** statuses worth retrying on the same source; other 4xx (404 = not mirrored) move straight to the next source */
export const isRetriableStatus = (s: number): boolean => s === 408 || s === 425 || s === 429 || s >= 500;

const clip = (s: string): string => (s.length > ERROR_TEXT_MAX ? s.slice(0, ERROR_TEXT_MAX - 1) + '…' : s);

export interface ResilientFetchOptions {
  mirrorBase?: string;
  backoffMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  /** called when a source/attempt fails (diagnostics) */
  onRetry?: (info: { file: string; source: string; attempt: number; error: string }) => void;
}

class SourceError extends Error {
  constructor(
    msg: string,
    readonly status?: number,
  ) {
    super(msg);
  }
}

/**
 * Wraps fetch for transformers.js: pinned HF model URLs go mirror-first with HF fallback, 3 attempts per source (1/3/8 s
 * backoff) and, after a stream breaks mid-file, an HTTP Range resume from the received offset (also across sources: the files
 * are byte-identical). Other URLs pass through. When every source fails the error names the file and the last status/reason.
 * A 404 from every source is returned as the last 404 response (transformers.js treats optional files that way).
 */
export function createResilientFetch(base: typeof fetch, opt: ResilientFetchOptions = {}): typeof fetch {
  const backoff = opt.backoffMs ?? FETCH_BACKOFF_MS;
  const sleep = opt.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const sources = modelSourceUrls(url, opt.mirrorBase);
    const file = parseHfModelUrl(url)?.file ?? url;
    if (!sources) return base(input, init);
    const signal = init?.signal ?? undefined;

    /** opens `offset` of the file from the first source that works; remembers which source index served it */
    let srcIdx = 0;
    const open = async (offset: number): Promise<Response> => {
      let last: SourceError | undefined;
      let notFound: Response | undefined;
      for (let s = srcIdx; s < sources.length; s++) {
        const source = sources[s]!;
        const host = new URL(source).host;
        for (let attempt = 0; attempt <= backoff.length; attempt++) {
          if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
          try {
            const res = await base(source, { signal, headers: offset > 0 ? { Range: `bytes=${offset}-` } : undefined });
            if (offset > 0 ? res.status === 206 : res.ok) {
              srcIdx = s;
              return res;
            }
            if (offset === 0 && res.status === 404) notFound = res;
            if (offset > 0 && res.status === 200) throw new SourceError(`HTTP 200 to a Range request (${host})`);
            throw new SourceError(`HTTP ${res.status} ${host}`, res.status);
          } catch (e) {
            if ((e as Error)?.name === 'AbortError') throw e;
            const err = e instanceof SourceError ? e : new SourceError(`${(e as Error)?.message ?? e} (${host})`);
            last = err;
            opt.onRetry?.({ file, source: host, attempt: attempt + 1, error: err.message });
            if (err.status !== undefined && !isRetriableStatus(err.status)) break;
            if (attempt < backoff.length) await sleep(backoff[attempt]!);
          }
        }
      }
      if (notFound && last?.status === 404) return notFound;
      throw new Error(clip(`${file}: ${last?.message ?? 'download failed'}`));
    };

    const first = await open(0);
    if (!first.ok || !first.body) return first; // the 404 passthrough
    const total = Number(first.headers.get('content-length') ?? 0);
    let received = 0;
    let reader = first.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(ctl) {
        for (;;) {
          try {
            const { done, value } = await reader.read();
            if (done) {
              if (total && received < total) throw new Error(`short body ${received}/${total}`);
              return ctl.close();
            }
            received += value.byteLength;
            return ctl.enqueue(value);
          } catch (e) {
            if (signal?.aborted || (e as Error)?.name === 'AbortError') return ctl.error(e);
            // the stream broke: resume from the received offset (the next source after a failed one)
            try {
              opt.onRetry?.({ file, source: new URL(sources[srcIdx]!).host, attempt: 0, error: `stream: ${(e as Error)?.message ?? e}` });
              await sleep(backoff[0] ?? 0);
              reader = (await open(received)).body!.getReader();
            } catch (e2) {
              return ctl.error(e2);
            }
          }
        }
      },
      cancel: (r) => reader.cancel(r),
    });
    const headers = new Headers(first.headers);
    return new Response(body, { status: first.status, statusText: first.statusText, headers });
  };
}
