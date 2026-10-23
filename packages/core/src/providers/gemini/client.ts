import { KeyPool } from '../../keypool';
import { listModels, type FetchFn, type ModelInfo } from '../../models';
import { ProviderUnavailableError } from '../types';

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_RETRY_MS = 60_000;
const DAILY_RETRY_MS = 3_600_000;
const AUTH_COOLDOWN_MS = 600_000;

export interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}

export interface GenerateContentResponse {
  candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
  usageMetadata?: Record<string, unknown>;
}

export interface GeminiClientOptions {
  keys: KeyPool;
  /** injectable for tests; defaults to global fetch */
  fetch?: FetchFn;
}

/** Parses Retry-After header / RetryInfo.retryDelay ("34s") from a 429; falls back to a default. */
export function parseRetryAfterMs(headerValue: string | null | undefined, body: string): number {
  if (headerValue) {
    const s = Number(headerValue);
    if (Number.isFinite(s) && s >= 0) return Math.ceil(s * 1000);
  }
  const m = /"retryDelay"\s*:\s*"([\d.]+)s"/.exec(body);
  if (m?.[1]) return Math.ceil(Number(m[1]) * 1000);
  if (/PerDay/i.test(body)) return DAILY_RETRY_MS;
  return DEFAULT_RETRY_MS;
}

/** Per-call guards (owner diag v0.2.12: a runaway TTS generation held a slot for 140+ s and returned 14-40 MB). */
export interface GenerateLimits {
  /** wall-clock cap (ms) of the whole call; the transport request is aborted (sw-abort) and a timedOut 'network' error is thrown */
  timeoutMs?: number;
  /** response body cap (bytes); a bigger body is rejected as a 'failed' error without being parsed */
  maxBytes?: number;
}

export class GeminiClient {
  private readonly fetchFn: FetchFn;
  readonly keys: KeyPool;

  constructor(opts: GeminiClientOptions) {
    this.keys = opts.keys;
    this.fetchFn = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const key = this.keys.current();
    if (key === undefined) throw new ProviderUnavailableError('no usable Gemini key', 'gemini', 'quota');
    const wrapped: FetchFn = (url, init) => this.fetchFn(url, { ...init, signal });
    try {
      return await listModels(wrapped, key);
    } catch (e) {
      if (signal?.aborted) throw e;
      throw new ProviderUnavailableError(`ListModels failed: ${String(e)}`, 'gemini', 'network');
    }
  }

  /**
   * POST models/{model}:generateContent with key rotation on quota / auth failures.
   * With several candidate models, a model whose keys are all quota-exhausted is skipped
   * (exhaustion is remembered per key+model in the pool) and the next one is tried.
   */
  async generateContent(
    model: string | string[],
    body: unknown,
    signal?: AbortSignal,
    limits?: GenerateLimits,
  ): Promise<GenerateContentResponse> {
    if (!limits?.timeoutMs || limits.timeoutMs <= 0) return this.generateInner(model, body, signal, limits);
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const ac = new AbortController();
    let timedOut = false;
    const onParent = (): void => ac.abort();
    signal?.addEventListener('abort', onParent, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, limits.timeoutMs);
    try {
      return await this.generateInner(model, body, ac.signal, limits);
    } catch (e) {
      if (timedOut && !signal?.aborted) {
        throw new ProviderUnavailableError(`Gemini request timeout after ${limits.timeoutMs} ms`, 'gemini', 'network', undefined, true);
      }
      throw e;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onParent);
    }
  }

  private async generateInner(
    model: string | string[],
    body: unknown,
    signal?: AbortSignal,
    limits?: GenerateLimits,
  ): Promise<GenerateContentResponse> {
    if (typeof model === 'string') return this.generateOne(model, body, signal, limits);
    let shortest: number | undefined;
    let lastErr: unknown;
    let allQuota = true;
    for (const m of model) {
      try {
        return await this.generateOne(m, body, signal, limits);
      } catch (e) {
        // quota/auth/5xx-or-network on one model: try the next candidate ("high demand" 503 is per model)
        if (!(e instanceof ProviderUnavailableError) || (e.kind !== 'quota' && e.kind !== 'auth' && e.kind !== 'network')) {
          throw e;
        }
        if (signal?.aborted) throw e;
        lastErr = e;
        if (e.kind !== 'quota') allQuota = false;
        else if (e.retryAfterMs !== undefined && (shortest === undefined || e.retryAfterMs < shortest)) {
          shortest = e.retryAfterMs;
        }
      }
    }
    if (lastErr === undefined) {
      throw new ProviderUnavailableError('no Gemini model candidates', 'gemini', 'unsupported');
    }
    if (!allQuota) throw lastErr;
    throw new ProviderUnavailableError('all Gemini models exhausted', 'gemini', 'quota', shortest);
  }

  private async generateOne(
    model: string,
    body: unknown,
    signal?: AbortSignal,
    limits?: GenerateLimits,
  ): Promise<GenerateContentResponse> {
    let lastKind: 'quota' | 'auth' = 'quota';
    let lastRetry: number | undefined;
    for (;;) {
      const key = this.keys.current(model);
      if (key === undefined) {
        const wait = this.keys.retryAfterMs(model);
        throw new ProviderUnavailableError(
          'all Gemini keys exhausted',
          'gemini',
          lastKind,
          lastRetry ?? wait,
        );
      }
      let res: Response;
      try {
        res = await this.fetchFn(`${BASE_URL}/models/${model}:generateContent`, {
          method: 'POST',
          headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal,
        });
      } catch (e) {
        if (signal?.aborted) throw e;
        throw new ProviderUnavailableError(`network error: ${String(e)}`, 'gemini', 'network');
      }
      if (res.ok) {
        const max = limits?.maxBytes;
        if (max !== undefined && max > 0 && typeof res.arrayBuffer === 'function') {
          const declared = Number(res.headers?.get?.('content-length'));
          if (Number.isFinite(declared) && declared > max) {
            throw new ProviderUnavailableError(`Gemini response too large: ${declared} B > ${max} B`, 'gemini', 'failed');
          }
          let buf: ArrayBuffer;
          try {
            buf = await res.arrayBuffer();
          } catch (e) {
            if (signal?.aborted) throw e;
            throw new ProviderUnavailableError(`network error: ${String(e)}`, 'gemini', 'network');
          }
          if (buf.byteLength > max) {
            throw new ProviderUnavailableError(`Gemini response too large: ${buf.byteLength} B > ${max} B`, 'gemini', 'failed');
          }
          return JSON.parse(new TextDecoder().decode(buf)) as GenerateContentResponse;
        }
        return (await res.json()) as GenerateContentResponse;
      }

      const text = await res.text().catch(() => '');
      if (res.status === 429 || /RESOURCE_EXHAUSTED/.test(text)) {
        lastKind = 'quota';
        lastRetry = parseRetryAfterMs(res.headers.get('retry-after'), text);
        this.keys.markExhausted(key, lastRetry, model);
        continue;
      }
      if (res.status === 401 || res.status === 403 || /API_KEY_INVALID/.test(text)) {
        lastKind = 'auth';
        lastRetry = AUTH_COOLDOWN_MS;
        this.keys.markExhausted(key, AUTH_COOLDOWN_MS);
        continue;
      }
      // never include the request URL/headers (key) in messages
      const kind = res.status >= 500 ? 'network' : 'failed';
      throw new ProviderUnavailableError(
        `Gemini HTTP ${res.status}: ${text.slice(0, 300)}`,
        'gemini',
        kind,
      );
    }
  }
}

export function responseText(r: GenerateContentResponse): string | undefined {
  const parts = r.candidates?.[0]?.content?.parts ?? [];
  const t = parts.map((p) => p.text ?? '').join('');
  return t.length > 0 ? t : undefined;
}

export function responseInlineData(
  r: GenerateContentResponse,
): { mimeType: string; data: string } | undefined {
  for (const p of r.candidates?.[0]?.content?.parts ?? []) {
    if (p.inlineData?.data) return p.inlineData;
  }
  return undefined;
}
