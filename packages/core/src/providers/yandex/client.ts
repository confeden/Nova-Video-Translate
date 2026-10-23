import { diag } from '../../diag';
import type { Transport } from '../types';
import { concat, decode, fBool, fBytes, fDbl, fStr, fVar, getNum, getStr } from './protobuf';

/**
 * Yandex Browser video-translate wire client (protocol verified by research/yandex_probe*.mjs).
 * The backend dubs arbitrary uploaded audio as long as the translate URL looks like a YouTube video
 * (a random youtu.be/<id> works): translate -> status 6 AUDIO_REQUESTED -> PUT audio -> poll -> mp3 url.
 * All requests must go out WITHOUT an Origin header and with Sec-Fetch-Mode: no-cors (gotcha G4); that is
 * the Transport's job, this client only states the intended headers.
 */

export const YANDEX_STATUS = {
  FAILED: 0,
  FINISHED: 1,
  WAITING: 2,
  LONG_WAITING: 3,
  PART_CONTENT: 5,
  AUDIO_REQUESTED: 6,
  SESSION_REQUIRED: 7,
} as const;

export interface YandexClientOptions {
  host?: string;
  userAgent?: string;
  componentVersion?: string;
  chromiumRevision?: string;
  /** HMAC key of the Vtrans-Signature header (public constant shipped with Yandex Browser / VOT) */
  hmacKey?: string;
  /** OAuth token for lively voices; only sent on /video-translation/translate when lively is requested */
  getToken?: () => string | undefined | Promise<string | undefined>;
  /** overall budget for polling, default 3 minutes */
  maxPollMs?: number;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  /** per-stage / whole-job deadlines (ms); see YANDEX_TIMEOUTS */
  timeouts?: Partial<YandexTimeouts>;
  /** in-flight heartbeat: every `heartbeatMs` while some job is older than `heartbeatAgeMs` (defaults 15 s / 30 s) */
  heartbeatMs?: number;
  heartbeatAgeMs?: number;
}

/** Watchdog deadlines. A stage that exceeds its deadline is aborted and reported as a 'network' error (timedOut). */
export interface YandexTimeouts {
  sessionMs: number;
  translateMs: number;
  uploadMs: number;
  fetchMs: number;
  /** whole translatePcm() */
  jobMs: number;
}
/** polling of a chunk job: first poll this long after the upload, then 1.5x steps capped at POLL_MAX_MS */
export const POLL_FIRST_MS = 2000;
export const POLL_MAX_MS = 4000;
export const YANDEX_TIMEOUTS: YandexTimeouts = { sessionMs: 25_000, translateMs: 25_000, uploadMs: 25_000, fetchMs: 25_000, jobMs: 90_000 };

/** VOT minChunkSize: every part of a chunked upload but the last must be at least this big (server-enforced, HTTP 400 otherwise) */
export const UPLOAD_MIN_PART_BYTES = 5_295_308;

export type YandexErrorKind = 'quota' | 'auth' | 'unsupported' | 'declined' | 'network' | 'failed';

/**
 * VOT.txt:47780 isLivelyVoiceAllowed: lively voices only for Russian output and a known source language, and
 * VOT:47773 getRequestLangForTranslation maps an unknown ('auto') source to 'en' when lively voices are wanted.
 */
export function livelySourceLang(sourceLang: string, targetLang: string): string {
  return sourceLang === 'auto' && targetLang === 'ru' ? 'en' : sourceLang;
}
export function isLivelyVoiceAllowed(sourceLang: string, targetLang: string): boolean {
  return targetLang === 'ru' && livelySourceLang(sourceLang, targetLang) !== 'auto';
}

/** VOT.txt:32529: the server answers a lively request it cannot serve with a message mentioning the standard voice. */
export function isLivelyUnavailableMessage(message?: string): boolean {
  return !!message && message.toLowerCase().includes('обычная озвучка');
}

export class YandexError extends Error {
  /** the watchdog deadline of a stage / the job expired (kind is 'network') */
  timedOut = false;
  constructor(
    message: string,
    readonly kind: YandexErrorKind,
    readonly httpStatus?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'YandexError';
  }
}

export interface TranslateRequest {
  /** pseudo-YouTube url; Yandex needs something that looks like a supported video */
  url: string;
  durationSec: number;
  sourceLang: string;
  targetLang: string;
  firstRequest: boolean;
  lively: boolean;
}

export interface TranslateReply {
  url?: string;
  duration?: number;
  status: number;
  remainingTime?: number;
  translationId?: string;
  language?: string;
  message?: string;
  shouldRetry?: number;
  /** response tag 10: the server says the voice is a lively one */
  isLivelyVoice?: boolean;
}

export interface YandexSubtitleRef {
  language: string;
  url: string;
  translatedLanguage: string;
  translatedUrl: string;
}

export interface Session {
  uuid: string;
  secretKey: string;
  expiresAt: number;
}

export interface TranslatePcmOptions {
  signal?: AbortSignal;
  lively?: boolean;
  /** 'auto' lets Yandex detect the language */
  sourceLang?: string;
  targetLang?: string;
  /** out-parameter: filled when the translation finishes (`lively` = the server flagged the voice as lively) */
  meta?: { lively?: boolean };
  /** whole-job deadline (ms) for this call; default `timeouts.jobMs` */
  jobMs?: number;
  /** server remainingTime (s) of the first translate reply */
  onHint?(remainingSec: number): void;
  /** the job deadline is extended to at least remainingTime + this margin (ms) once the first reply reports it (D26 live policy); 0 = never */
  etaMarginMs?: number;
}

const DEFAULTS = {
  host: 'api.browser.yandex.ru',
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 YaBrowser/26.8.0.0 Safari/537.36',
  componentVersion: '26.10.0.1796',
  chromiumRevision: '1796',
  hmacKey: 'bt8xH3VOlb4mqf0nqAibnDOoiPlXsisf',
  maxPollMs: 180_000,
};

const te = new TextEncoder();
const hex = (b: ArrayBuffer): string => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');

export async function hmacSha256Hex(key: string, data: Uint8Array): Promise<string> {
  const k = await crypto.subtle.importKey('raw', te.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', k, data as BufferSource));
}

/** RIFF/WAVE, 16-bit mono PCM. */
export function pcmToWav(pcm: Int16Array, sampleRate: number): Uint8Array {
  const dataLen = pcm.length * 2;
  const out = new Uint8Array(44 + dataLen);
  const dv = new DataView(out.buffer);
  const tag = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i);
  };
  tag(0, 'RIFF');
  dv.setUint32(4, 36 + dataLen, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, 1, true); // mono
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  tag(36, 'data');
  dv.setUint32(40, dataLen, true);
  for (let i = 0; i < pcm.length; i++) dv.setInt16(44 + i * 2, pcm[i]!, true);
  return out;
}

export function encodeTranslateRequest(r: TranslateRequest): Uint8Array {
  return concat(
    fStr(3, r.url),
    fBool(5, r.firstRequest),
    fDbl(6, r.durationSec),
    fBool(7, true),
    fStr(8, r.sourceLang),
    fStr(14, r.targetLang),
    fBool(15, true),
    fVar(16, 2),
    r.lively ? fBool(18, true) : new Uint8Array(0),
  );
}

export function decodeTranslateReply(buf: Uint8Array): TranslateReply {
  const d = decode(buf);
  return {
    url: getStr(d, 1),
    duration: getNum(d, 2),
    status: getNum(d, 4) ?? 0,
    remainingTime: getNum(d, 5),
    translationId: getStr(d, 7),
    language: getStr(d, 8),
    message: getStr(d, 9),
    shouldRetry: getNum(d, 12),
    isLivelyVoice: getNum(d, 10) === 1,
  };
}

export function encodeAudioRequest(translationId: string, url: string, fileId: string, audio: Uint8Array): Uint8Array {
  // VideoTranslationAudioRequest: translationId(1) url(2) audioInfo(6){ fileId(1) audioFile(2) }
  return concat(fStr(1, translationId), fStr(2, url), fBytes(6, concat(fStr(1, fileId), fBytes(2, audio))));
}

function abortError(): Error {
  return new DOMException('Aborted', 'AbortError');
}

const isAbort = (e: unknown, signal?: AbortSignal): boolean => !!signal?.aborted || (e as { name?: string })?.name === 'AbortError';

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError());
    };
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

interface Job {
  id: number;
  t0: number;
  stage: string;
  stageAt: number;
  polls: number;
  lively: boolean;
  tid?: string;
}

const tail4 = (s?: string): string | undefined => (s ? s.slice(-4) : undefined);

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-';

export class YandexClient {
  private readonly o: typeof DEFAULTS & YandexClientOptions;
  private session?: Session;
  private sessionPending?: Promise<Session>;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly random: () => number;
  private readonly to: YandexTimeouts;
  private readonly jobs = new Map<number, Job>();
  private jobSeq = 0;
  private hbTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly transport: Transport,
    opts: YandexClientOptions = {},
  ) {
    this.o = { ...DEFAULTS, ...stripUndefined(opts) };
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? defaultSleep;
    this.random = opts.random ?? Math.random;
    this.to = { ...YANDEX_TIMEOUTS, ...stripUndefined(opts.timeouts ?? {}) };
  }

  /** Runs `fn` with a deadline: on expiry the stage is aborted (signal handed to `fn`) and a timedOut 'network' YandexError is thrown. */
  private async guarded<T>(
    stage: string,
    ms0: number,
    parent: AbortSignal | undefined,
    fn: (s: AbortSignal) => Promise<T>,
    handle?: { extendTo?: (totalMs: number) => void },
  ): Promise<T> {
    let ms = ms0;
    const startedAt = this.now();
    if (parent?.aborted) throw abortError();
    const ac = new AbortController();
    let timedOut = false;
    const onParent = (): void => ac.abort();
    parent?.addEventListener('abort', onParent, { once: true });
    const fire = (): void => {
      timedOut = true;
      ac.abort();
    };
    let timer = setTimeout(fire, ms);
    if (handle) {
      handle.extendTo = (total: number): void => {
        if (total <= ms || timedOut || ac.signal.aborted) return;
        ms = total;
        clearTimeout(timer);
        timer = setTimeout(fire, Math.max(0, total - (this.now() - startedAt)));
      };
    }
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(abortError());
      ac.signal.addEventListener('abort', onAbort, { once: true });
    });
    aborted.catch(() => {});
    try {
      return await Promise.race([fn(ac.signal), aborted]);
    } catch (e) {
      if (timedOut) {
        const err = new YandexError(`${stage}: timeout after ${ms} ms`, 'network');
        err.timedOut = true;
        throw err;
      }
      throw e;
    } finally {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onParent);
      if (onAbort) ac.signal.removeEventListener('abort', onAbort);
    }
  }

  private setStage(job: Job | undefined, stage: string): void {
    if (!job) return;
    job.stage = stage;
    job.stageAt = this.now();
  }

  /** In-flight jobs with age and last stage (also logged by the heartbeat). */
  inflightSnapshot(): Array<{ j: number; ageS: number; stage: string; stageS: number; polls: number; lively: boolean; tid?: string }> {
    const t = this.now();
    return [...this.jobs.values()].map((j) => ({
      j: j.id,
      ageS: Math.round((t - j.t0) / 100) / 10,
      stage: j.stage,
      stageS: Math.round((t - j.stageAt) / 100) / 10,
      polls: j.polls,
      lively: j.lively,
      tid: j.tid,
    }));
  }

  /** One heartbeat tick: logs `yandex-inflight` when a job is older than `heartbeatAgeMs`. Returns whether it logged. */
  heartbeat(): boolean {
    const old = this.o.heartbeatAgeMs ?? 30_000;
    const t = this.now();
    if (![...this.jobs.values()].some((j) => t - j.t0 > old)) return false;
    const snap = this.inflightSnapshot();
    diag.log('yandex-inflight', { n: snap.length, jobs: snap });
    return true;
  }

  private startJob(lively: boolean): Job {
    const job: Job = { id: ++this.jobSeq, t0: this.now(), stage: 'start', stageAt: this.now(), polls: 0, lively };
    this.jobs.set(job.id, job);
    if (!this.hbTimer) {
      const h = setInterval(() => this.heartbeat(), this.o.heartbeatMs ?? 15_000);
      (h as unknown as { unref?: () => void }).unref?.();
      this.hbTimer = h;
    }
    return job;
  }

  private endJob(job: Job): void {
    this.jobs.delete(job.id);
    if (this.jobs.size === 0 && this.hbTimer) {
      clearInterval(this.hbTimer);
      this.hbTimer = undefined;
    }
  }

  private baseHeaders(): Record<string, string> {
    const cv = this.o.componentVersion;
    return {
      'User-Agent': this.o.userAgent,
      Accept: 'application/x-protobuf',
      'Accept-Language': 'en',
      'Content-Type': 'application/x-protobuf',
      'Sec-Fetch-Mode': 'no-cors',
      Pragma: 'no-cache',
      'Cache-Control': 'no-cache',
      'sec-ch-ua': `"Not;A=Brand";v="8", "Chromium";v="150", "YaBrowser";v="${cv.slice(0, 5)}", "Yowser";v="2.5"`,
      'sec-ch-ua-full-version-list': `"Not;A=Brand";v="8.0.0.0", "Chromium";v="150.0.7871.${this.o.chromiumRevision}", "YaBrowser";v="${cv}", "Yowser";v="2.5"`,
    };
  }

  private pick(alphabet: string, n: number): string {
    return Array.from({ length: n }, () => alphabet[Math.floor(this.random() * alphabet.length)]).join('');
  }

  private async send(
    method: 'POST' | 'PUT',
    path: string,
    body: Uint8Array,
    extra: Record<string, string>,
    signal?: AbortSignal,
    job?: Job,
  ): Promise<Uint8Array> {
    const t0 = this.now();
    let res;
    try {
      res = await this.transport({
        url: `https://${this.o.host}${path}`,
        method,
        headers: { ...this.baseHeaders(), ...extra },
        body,
        signal,
      });
    } catch (e) {
      if (isAbort(e, signal)) throw abortError();
      diag.log('yandex-http-fail', { j: job?.id, path, ms: this.now() - t0, err: String((e as Error)?.message ?? e).slice(0, 100) });
      throw new YandexError(`${path}: ${(e as Error)?.message ?? e}`, 'network');
    }
    if (res.status !== 200) {
      diag.log('yandex-http-fail', { j: job?.id, path, ms: this.now() - t0, status: res.status });
      throw this.httpError(path, res.status, res.headers);
    }
    return res.body;
  }

  private httpError(path: string, status: number, headers: Record<string, string>): YandexError {
    if (status === 401) return new YandexError(`${path}: HTTP 401`, 'auth', status);
    if (status === 429) {
      const ra = Number(headers['retry-after'] ?? headers['Retry-After']);
      return new YandexError(`${path}: HTTP 429`, 'quota', status, Number.isFinite(ra) ? ra * 1000 : undefined);
    }
    // 402/403 = balancer rejected the request (Origin / Sec-Fetch-Mode, gotcha G4) or access denied
    return new YandexError(`${path}: HTTP ${status}`, 'failed', status);
  }

  /**
   * One shared in-flight creation (own deadline, NOT tied to the first caller's signal: a caller that gives up must not
   * fail the others); every caller waits on it racing its own signal.
   */
  async createSession(signal?: AbortSignal, job?: Job): Promise<Session> {
    if (this.session && this.session.expiresAt > this.now()) return this.session;
    this.setStage(job, 'session');
    this.sessionPending ??= this.guarded('session/create', this.to.sessionMs, undefined, (s) => this.doCreateSession(s, job)).finally(() => {
      this.sessionPending = undefined;
    });
    const pending = this.sessionPending;
    if (!signal) return pending;
    if (signal.aborted) throw abortError();
    let onAbort: (() => void) | undefined;
    const gone = new Promise<never>((_, reject) => {
      onAbort = () => reject(abortError());
      signal.addEventListener('abort', onAbort, { once: true });
    });
    gone.catch(() => {});
    try {
      return await Promise.race([pending, gone]);
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
  }

  invalidateSession(): void {
    this.session = undefined;
  }

  private async doCreateSession(signal?: AbortSignal, job?: Job): Promise<Session> {
    const t0 = this.now();
    const uuid = this.pick('0123456789ABCDEF', 32);
    const body = concat(fStr(1, uuid), fStr(2, 'video-translation'));
    const out = await this.send('POST', '/session/create', body, { 'Vtrans-Signature': await hmacSha256Hex(this.o.hmacKey, body) }, signal, job);
    const d = decode(out);
    const secretKey = getStr(d, 1);
    if (!secretKey) throw new YandexError('session/create: no secretKey in reply', 'failed');
    const expires = getNum(d, 2) ?? 3600;
    this.session = { uuid, secretKey, expiresAt: this.now() + Math.max(60, expires - 60) * 1000 };
    diag.log('yandex-session', { j: job?.id, http: 200, ms: this.now() - t0, ttlS: expires });
    return this.session;
  }

  private async secHeaders(s: Session, body: Uint8Array, path: string, type: 'Vtrans' | 'Vsubs' = 'Vtrans'): Promise<Record<string, string>> {
    const token = `${s.uuid}:${path}:${this.o.componentVersion}`;
    return {
      [`${type}-Signature`]: await hmacSha256Hex(this.o.hmacKey, body),
      [`Sec-${type}-Sk`]: s.secretKey,
      [`Sec-${type}-Token`]: `${await hmacSha256Hex(this.o.hmacKey, te.encode(token))}:${token}`,
    };
  }

  /**
   * /video-subtitles/get-subtitles (VOT.txt:12467). `waiting` = Yandex has no subtitles for this URL yet (measured: stays
   * true for videos Yandex never translated itself). `requestLang` = the video's source language.
   */
  async getSubtitles(videoUrl: string, requestLang: string, signal?: AbortSignal): Promise<{ waiting: boolean; subtitles: YandexSubtitleRef[] }> {
    const path = '/video-subtitles/get-subtitles';
    const session = await this.createSession(signal);
    const body = concat(fStr(1, videoUrl), fStr(2, requestLang));
    const out = decode(await this.send('POST', path, body, await this.secHeaders(session, body, path, 'Vsubs'), signal));
    const subtitles = (out[2] ?? []).filter((v): v is Uint8Array => v instanceof Uint8Array).map((b) => {
      const m = decode(b);
      return { language: getStr(m, 1) ?? '', url: getStr(m, 2) ?? '', translatedLanguage: getStr(m, 4) ?? '', translatedUrl: getStr(m, 5) ?? '' };
    });
    return { waiting: getNum(out, 1) === 1, subtitles };
  }

  async requestTranslation(req: TranslateRequest, signal?: AbortSignal, job?: Job): Promise<TranslateReply> {
    const path = '/video-translation/translate';
    const session = await this.createSession(signal, job); // has its own deadline
    return this.guarded('translate', this.to.translateMs, signal, async (s) => {
      this.setStage(job, req.firstRequest ? 'translate' : `poll-${job?.polls ?? 0}`);
      const t0 = this.now();
      const body = encodeTranslateRequest(req);
      const headers = await this.secHeaders(session, body, path);
      if (req.lively) {
        const token = await this.o.getToken?.();
        if (!token) throw new YandexError('lively voice requires an OAuth token', 'auth');
        headers.Authorization = `OAuth ${token}`;
      }
      const reply = decodeTranslateReply(await this.send('POST', path, body, headers, s, job));
      if (job) job.tid = tail4(reply.translationId) ?? job.tid;
      const line = { j: job?.id, http: 200, status: reply.status, remaining: reply.remainingTime, tid: tail4(reply.translationId), lively: req.lively, serverLively: reply.isLivelyVoice, ms: this.now() - t0 };
      if (req.firstRequest) diag.log('yandex-translate', line);
      else diag.log('yandex-poll', { ...line, n: job?.polls, elapsedMs: job ? this.now() - job.t0 : undefined });
      return reply;
    });
  }

  async uploadAudio(translationId: string, url: string, fileId: string, wav: Uint8Array, signal?: AbortSignal, job?: Job): Promise<void> {
    const path = '/video-translation/audio';
    const session = await this.createSession(signal, job);
    await this.guarded('upload', this.to.uploadMs, signal, async (s) => {
      this.setStage(job, 'upload');
      const t0 = this.now();
      const body = encodeAudioRequest(translationId, url, fileId, wav);
      await this.send('PUT', path, body, await this.secHeaders(session, body, path), s, job);
      diag.log('yandex-upload', { j: job?.id, http: 200, bytes: wav.length, ms: this.now() - t0, tid: tail4(translationId) });
    });
  }

  /**
   * Chunked upload of a COMPLETE audio under a (real) video url, VOT's partialAudioInfo protocol (research/yandex_speedup.md s.5):
   * every part but the last is exactly `partBytes` (>= UPLOAD_MIN_PART_BYTES, else HTTP 400), the last carries audioPartsLength = N
   * and starts the job. A reply to the last part that still lists missing chunks is an error (the job would never start).
   */
  async uploadAudioParts(translationId: string, url: string, wav: Uint8Array, signal?: AbortSignal, partBytes: number = UPLOAD_MIN_PART_BYTES): Promise<{ parts: number }> {
    const size = Math.max(1, partBytes);
    const n = Math.max(1, Math.ceil(wav.length / size));
    const fileId = `random-nvt-${typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)}`;
    const path = '/video-translation/audio';
    for (let i = 0; i < n; i++) {
      const last = i === n - 1;
      const part = wav.subarray(i * size, last ? wav.length : (i + 1) * size);
      const chunk = concat(
        fBytes(1, concat(i > 0 ? fVar(1, i) : new Uint8Array(0), fBytes(2, part))),
        last ? fVar(2, n) : new Uint8Array(0),
        fStr(3, fileId),
        fVar(4, 1),
      );
      const body = concat(fStr(1, translationId), fStr(2, url), fBytes(4, chunk));
      let err: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const session = await this.createSession(signal);
          const reply = await this.guarded('upload', this.to.uploadMs, signal, async (s) => {
            this.setStage(undefined, 'upload');
            const t0 = this.now();
            const raw = await this.send('PUT', path, body, await this.secHeaders(session, body, path), s);
            diag.log('yandex-upload', { part: i + 1, of: n, http: 200, bytes: part.length, ms: this.now() - t0, tid: tail4(translationId) });
            return raw;
          });
          if (last && reply.length > 0) {
            const out = decode(reply);
            if ((out[2] ?? []).length > 0) throw new YandexError(`upload incomplete: ${(out[2] ?? []).length} chunk(s) missing`, 'failed');
          }
          err = undefined;
          break;
        } catch (e) {
          if (isAbort(e, signal) || !(e instanceof YandexError) || e.kind === 'auth' || e.kind === 'failed') throw e;
          err = e;
        }
      }
      if (err) throw err;
    }
    return { parts: n };
  }

  async fetchAudio(url: string, signal?: AbortSignal, job?: Job): Promise<Uint8Array> {
    this.setStage(job, 'mp3');
    const t0 = this.now();
    const out = await this.guarded('mp3', this.to.fetchMs, signal, (s) => this.fetchAudioHops(url, s));
    diag.log('yandex-mp3', { j: job?.id, bytes: out.length, ms: this.now() - t0 });
    return out;
  }

  private async fetchAudioHops(url: string, signal?: AbortSignal): Promise<Uint8Array> {
    let cur = url;
    for (let hop = 0; hop < 5; hop++) {
      let res;
      try {
        res = await this.transport({
          url: cur,
          method: 'GET',
          headers: { 'User-Agent': this.o.userAgent, Accept: '*/*', 'Sec-Fetch-Mode': 'no-cors' },
          signal,
        });
      } catch (e) {
        if (isAbort(e, signal)) throw abortError();
        throw new YandexError(`mp3 download: ${(e as Error)?.message ?? e}`, 'network');
      }
      const loc = res.headers.location ?? res.headers.Location;
      if (res.status >= 300 && res.status < 400 && loc) {
        cur = new URL(loc, cur).toString();
        continue;
      }
      if (res.status !== 200) throw new YandexError(`mp3 download: HTTP ${res.status}`, 'failed', res.status);
      return res.body;
    }
    throw new YandexError('mp3 download: too many redirects', 'failed');
  }

  /** Full flow: PCM in, mp3 bytes out. */
  async translatePcm(pcm: Int16Array, sampleRate: number, opts: TranslatePcmOptions = {}): Promise<Uint8Array> {
    const job = this.startJob(!!opts.lively);
    diag.log('yandex-job-start', { j: job.id, lively: !!opts.lively, src: opts.sourceLang ?? 'auto', durS: Math.round(pcm.length / sampleRate), inflight: this.jobs.size });
    try {
      const handle: { extendTo?: (totalMs: number) => void } = {};
      const out = await this.guarded(
        'job',
        opts.jobMs && opts.jobMs > 0 ? opts.jobMs : this.to.jobMs,
        opts.signal,
        (s) => this.runJob(pcm, sampleRate, { ...opts, signal: s }, job, handle),
        handle,
      );
      diag.log('yandex-job-ok', { j: job.id, ms: this.now() - job.t0, bytes: out.length, polls: job.polls });
      return out;
    } catch (e) {
      const ye = e as YandexError;
      if (!isAbort(e, opts.signal) || ye.timedOut) {
        diag.log('yandex-job-fail', { j: job.id, ms: this.now() - job.t0, stage: job.stage, polls: job.polls, kind: ye.kind, timeout: !!ye.timedOut, msg: String((e as Error)?.message ?? e).slice(0, 100) });
      } else {
        diag.log('yandex-job-abort', { j: job.id, ms: this.now() - job.t0, stage: job.stage, polls: job.polls });
      }
      throw e;
    } finally {
      this.endJob(job);
    }
  }

  private async runJob(pcm: Int16Array, sampleRate: number, opts: TranslatePcmOptions, job: Job, handle?: { extendTo?: (totalMs: number) => void }): Promise<Uint8Array> {
    const { signal } = opts;
    const lively = !!opts.lively;
    const targetLang = opts.targetLang ?? 'ru';
    let sourceLang = opts.sourceLang ?? 'auto';
    if (lively) {
      if (!isLivelyVoiceAllowed(sourceLang, targetLang)) throw new YandexError(`lively voices are not available for ${sourceLang} -> ${targetLang}`, 'declined');
      sourceLang = livelySourceLang(sourceLang, targetLang);
    }
    const durationSec = pcm.length / sampleRate;
    const id = this.pick(ID_ALPHABET, 11);
    const url = `https://youtu.be/${id}`;
    const base = { url, durationSec, sourceLang, targetLang, lively };

    let reply = await this.requestTranslation({ ...base, firstRequest: true }, signal, job);
    let pollLimitMs = this.o.maxPollMs;
    if (reply.remainingTime && reply.remainingTime > 0) {
      opts.onHint?.(reply.remainingTime);
      if (opts.etaMarginMs !== undefined && opts.etaMarginMs > 0) {
        // the server ETA is the truth about this job's latency: it may finish late, it must not be cut off before that
        const need = Math.round(reply.remainingTime * 1000 + opts.etaMarginMs);
        handle?.extendTo?.(need);
        pollLimitMs = Math.max(pollLimitMs, need);
      }
    }
    let uploaded = false;
    let sessionRetried = false;
    const t0 = this.now();
    let delay = POLL_FIRST_MS;
    for (;;) {
      if (signal?.aborted) throw abortError();
      if (lively && reply.status !== YANDEX_STATUS.SESSION_REQUIRED && isLivelyUnavailableMessage(reply.message)) {
        throw new YandexError(reply.message ?? 'lively voice unavailable', 'declined');
      }
      switch (reply.status) {
        case YANDEX_STATUS.FINISHED:
          if (!reply.url) throw new YandexError('finished without audio url', 'failed');
          if (opts.meta) opts.meta.lively = !!reply.isLivelyVoice;
          return this.fetchAudio(reply.url, signal, job);
        case YANDEX_STATUS.FAILED:
          throw new YandexError(reply.message || 'translation failed', 'unsupported');
        case YANDEX_STATUS.SESSION_REQUIRED:
          // verified against the real server: a lively request with a missing / invalid token answers status 7 at once
          if (lively) throw new YandexError('Yandex rejected the OAuth token (SESSION_REQUIRED)', 'auth');
          if (sessionRetried) throw new YandexError('session rejected', 'auth');
          sessionRetried = true;
          this.invalidateSession();
          break;
        case YANDEX_STATUS.AUDIO_REQUESTED:
          if (!uploaded && reply.translationId) {
            await this.uploadAudio(reply.translationId, url, `nvt-${id}`, pcmToWav(pcm, sampleRate), signal, job);
            uploaded = true;
          }
          break;
        default:
          break;
      }
      if (this.now() - t0 > pollLimitMs) throw new YandexError('translation timed out', 'failed');
      // the server's remainingTime hint is NOT used for the sleep (measured: it made every poll wait ~10 s); it only feeds the latency model
      this.setStage(job, 'poll-wait');
      await this.sleep(delay, signal);
      delay = Math.min(POLL_MAX_MS, Math.round(delay * 1.5));
      job.polls++;
      reply = await this.requestTranslation({ ...base, firstRequest: false }, signal, job);
    }
  }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
