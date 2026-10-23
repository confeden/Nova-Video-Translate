/**
 * Groq (OpenAI-compatible) client over the environment Transport (extension service worker / GM_xmlhttpRequest), so the
 * API key never reaches the page. Free tier is ~20 requests/min: every call goes through a sliding-window budget and a
 * Retry-After gate (D30).
 */
import { diag } from '../../diag';
import type { Transport } from '../types';
import { ProviderUnavailableError } from '../types';

export const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
/** free-tier request budget per minute used by default (limit is ~20/min: keep a small margin) */
export const GROQ_REQUESTS_PER_MIN = 18;
/** a per-minute 429 / budget wait up to this long is waited out inline; longer = surface as 'quota' with retryAfterMs */
export const GROQ_MAX_INLINE_WAIT_MS = 20_000;
/** per-request watchdog (D25 style) */
export const GROQ_REQUEST_TIMEOUT_MS = 25_000;
const AUTH_RETRY_MS = 600_000;

const enc = new TextEncoder();
const dec = new TextDecoder();

export interface RetryAfterInfo {
  ms: number;
}

/** Retry-After seconds (or HTTP-date) -> ms; falls back to x-ratelimit-reset-* style durations ("2m59.56s"), then to `def`. */
export function parseGroqRetryMs(headers: Record<string, string>, def = 30_000, now = Date.now()): number {
  const h = (k: string): string | undefined => {
    for (const [name, v] of Object.entries(headers)) if (name.toLowerCase() === k) return v;
    return undefined;
  };
  const ra = h('retry-after');
  if (ra) {
    const n = Number(ra);
    if (Number.isFinite(n) && n >= 0) return Math.ceil(n * 1000);
    const d = Date.parse(ra);
    if (Number.isFinite(d)) return Math.max(0, d - now);
  }
  for (const k of ['x-ratelimit-reset-requests', 'x-ratelimit-reset-tokens']) {
    const v = h(k);
    if (!v) continue;
    const m = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m(?!s))?(?:(\d+(?:\.\d+)?)s)?(?:(\d+(?:\.\d+)?)ms)?$/.exec(v.trim());
    if (m && (m[1] || m[2] || m[3] || m[4])) return Math.ceil(((+(m[1] ?? 0) * 60 + +(m[2] ?? 0)) * 60 + +(m[3] ?? 0)) * 1000 + +(m[4] ?? 0));
  }
  return def;
}

/** Sliding-window request budget (N per 60 s). `delayFor()` = ms to wait before the next request may go out. */
export class RequestBudget {
  private readonly stamps: number[] = [];
  constructor(
    private readonly perMin: number,
    private readonly now: () => number = Date.now,
  ) {}

  delayFor(): number {
    const t = this.now();
    while (this.stamps.length && t - this.stamps[0]! >= 60_000) this.stamps.shift();
    if (this.stamps.length < this.perMin) return 0;
    return this.stamps[this.stamps.length - this.perMin]! + 60_000 - t;
  }

  take(): void {
    this.stamps.push(this.now());
  }
}

export interface GroqClientOptions {
  transport: Transport;
  /** current API key (read per request: the user may change it); empty = no key */
  getKey(): string;
  perMin?: number;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  timeoutMs?: number;
  maxInlineWaitMs?: number;
}

export interface AsrSegmentRaw {
  start: number;
  end: number;
  text: string;
  no_speech_prob?: number;
  avg_logprob?: number;
}

export interface TranscribeResult {
  language: string;
  duration: number;
  text: string;
  segments: AsrSegmentRaw[];
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('aborted', 'AbortError'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), reject(new DOMException('aborted', 'AbortError'))), { once: true });
  });

/** multipart/form-data body (OpenAI audio API): fields + one file */
export function multipartBody(fields: Record<string, string>, file: { name: string; mime: string; data: Uint8Array }, boundary: string): Uint8Array {
  const parts: Uint8Array[] = [];
  const push = (s: string): void => void parts.push(enc.encode(s));
  for (const [k, v] of Object.entries(fields)) push(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`);
  push(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.mime}\r\n\r\n`);
  parts.push(file.data);
  push(`\r\n--${boundary}--\r\n`);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** the first balanced-looking {...} of a model answer (plain-text fallback may wrap it in prose or a code fence) */
export function extractJsonObject(raw: string): string {
  const a = raw.indexOf('{');
  const b = raw.lastIndexOf('}');
  return a >= 0 && b > a ? raw.slice(a, b + 1) : raw;
}

export class GroqClient {
  private readonly budget: RequestBudget;
  private blockedUntil = 0;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(private readonly o: GroqClientOptions) {
    this.now = o.now ?? Date.now;
    this.budget = new RequestBudget(o.perMin ?? GROQ_REQUESTS_PER_MIN, this.now);
    this.sleep = o.sleep ?? defaultSleep;
  }

  hasKey(): boolean {
    return this.o.getKey().trim().length > 0;
  }

  /** ms until the client may send again (Retry-After gate), 0 = now */
  blockedForMs(): number {
    return Math.max(0, this.blockedUntil - this.now());
  }

  /** waits out the gate / budget (<= max inline wait) or throws 'quota' with retryAfterMs */
  private async gate(signal?: AbortSignal): Promise<void> {
    const max = this.o.maxInlineWaitMs ?? GROQ_MAX_INLINE_WAIT_MS;
    for (;;) {
      const wait = Math.max(this.blockedForMs(), this.budget.delayFor());
      if (wait <= 0) return;
      if (wait > max) throw new ProviderUnavailableError(`Groq: rate limit, retry in ${Math.ceil(wait / 1000)} s`, 'groq', 'quota', wait);
      diag.log('groq-wait', { ms: wait });
      await this.sleep(wait, signal);
    }
  }

  /** one HTTP call with the watchdog; maps every failure class to a ProviderUnavailableError */
  private async call(req: { path: string; method: 'GET' | 'POST'; headers?: Record<string, string>; body?: Uint8Array; signal?: AbortSignal; retry429?: boolean }): Promise<{ headers: Record<string, string>; body: Uint8Array }> {
    const key = this.o.getKey().trim();
    if (!key) throw new ProviderUnavailableError('Groq: no API key', 'groq', 'auth');
    for (let attempt = 0; ; attempt++) {
      await this.gate(req.signal);
      const ac = new AbortController();
      const onParent = (): void => ac.abort();
      req.signal?.addEventListener('abort', onParent, { once: true });
      let timedOut = false;
      const timeoutMs = this.o.timeoutMs ?? GROQ_REQUEST_TIMEOUT_MS;
      const timer = setTimeout(() => {
        timedOut = true;
        ac.abort();
      }, timeoutMs);
      this.budget.take();
      let res: Awaited<ReturnType<Transport>>;
      try {
        res = await this.o.transport({ url: `${GROQ_BASE_URL}${req.path}`, method: req.method, headers: { authorization: `Bearer ${key}`, ...req.headers }, body: req.body, signal: ac.signal });
      } catch (e) {
        if (timedOut && !req.signal?.aborted) throw new ProviderUnavailableError(`Groq: request timeout after ${timeoutMs} ms`, 'groq', 'network', undefined, true);
        if (req.signal?.aborted) throw e;
        throw new ProviderUnavailableError(`Groq: network error: ${String((e as Error)?.message ?? e).slice(0, 100)}`, 'groq', 'network');
      } finally {
        clearTimeout(timer);
        req.signal?.removeEventListener('abort', onParent);
      }
      if (res.status >= 200 && res.status < 300) return { headers: res.headers, body: res.body };
      const text = dec.decode(res.body.subarray(0, 300));
      if (res.status === 429) {
        const ms = parseGroqRetryMs(res.headers, 30_000, this.now());
        this.blockedUntil = Math.max(this.blockedUntil, this.now() + ms);
        diag.log('groq-429', { retryMs: ms, attempt });
        // a short per-minute limit is waited out once; a long one (daily) is surfaced
        if (attempt === 0 && req.retry429 !== false && ms <= (this.o.maxInlineWaitMs ?? GROQ_MAX_INLINE_WAIT_MS)) continue;
        throw new ProviderUnavailableError(`Groq HTTP 429: rate limit, retry in ${Math.ceil(ms / 1000)} s`, 'groq', 'quota', ms);
      }
      // never include the request headers (key) in messages
      if (res.status === 401 || res.status === 403) throw new ProviderUnavailableError(`Groq HTTP ${res.status}: invalid API key`, 'groq', 'auth', AUTH_RETRY_MS);
      throw new ProviderUnavailableError(`Groq HTTP ${res.status}: ${text}`, 'groq', res.status >= 500 ? 'network' : 'failed');
    }
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    const r = await this.call({ path: '/models', method: 'GET', signal });
    try {
      const j = JSON.parse(dec.decode(r.body)) as { data?: { id?: string }[] };
      return (j.data ?? []).map((m) => m.id ?? '').filter(Boolean);
    } catch {
      throw new ProviderUnavailableError('Groq: bad model list', 'groq', 'failed');
    }
  }

  /** speech -> text with segment timestamps (verbose_json); `wav` is 16 kHz mono PCM WAV */
  async transcribe(o: { wav: Uint8Array; model: string; language?: string; signal?: AbortSignal }): Promise<TranscribeResult> {
    const boundary = `nvt${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
    const fields: Record<string, string> = { model: o.model, response_format: 'verbose_json', 'timestamp_granularities[]': 'segment', temperature: '0' };
    if (o.language) fields.language = o.language;
    const body = multipartBody(fields, { name: 'chunk.wav', mime: 'audio/wav', data: o.wav }, boundary);
    const r = await this.call({ path: '/audio/transcriptions', method: 'POST', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, body, signal: o.signal });
    let j: { language?: string; duration?: number; text?: string; segments?: AsrSegmentRaw[] };
    try {
      j = JSON.parse(dec.decode(r.body));
    } catch {
      throw new ProviderUnavailableError('Groq: invalid ASR response', 'groq', 'failed');
    }
    return {
      language: j.language ?? '',
      duration: Number(j.duration) || 0,
      text: j.text ?? '',
      segments: (j.segments ?? []).map((s) => ({ start: Number(s.start), end: Number(s.end), text: String(s.text ?? ''), no_speech_prob: s.no_speech_prob, avg_logprob: s.avg_logprob })),
    };
  }

  /** chat completion; `json` asks for a JSON object answer. Returns the message text. */
  async chat(o: { model: string; messages: ChatMessage[]; json?: boolean; temperature?: number; maxTokens?: number; reasoningEffort?: "low" | "medium" | "high"; signal?: AbortSignal }): Promise<string> {
    const body = JSON.stringify({
      model: o.model,
      messages: o.messages,
      temperature: o.temperature ?? 0.2,
      ...(o.maxTokens ? { max_tokens: o.maxTokens } : {}),
      ...(o.reasoningEffort ? { reasoning_effort: o.reasoningEffort } : {}),
      ...(o.json ? { response_format: { type: 'json_object' } } : {}),
    });
    const r = await this.call({ path: '/chat/completions', method: 'POST', headers: { 'content-type': 'application/json' }, body: enc.encode(body), signal: o.signal });
    let finish = '';
    try {
      const j = JSON.parse(dec.decode(r.body)) as { choices?: { message?: { content?: string }; finish_reason?: string }[] };
      const text = j.choices?.[0]?.message?.content;
      if (typeof text === 'string' && text.length > 0) return text;
      finish = String(j.choices?.[0]?.finish_reason ?? '');
    } catch {
      /* fallthrough */
    }
    throw new ProviderUnavailableError(`Groq: empty chat response${finish ? ` (finish=${finish})` : ''}`, 'groq', 'failed');
  }
}
