import { ProviderUnavailableError } from '../types';
import { alignSentences, type AlignResult } from '../../audio/align';
import { trimAndFade } from '../../audio/tailTrim';
import { responseInlineData, type GeminiClient } from './client';

/** wall-clock cap of one TTS request (owner diag v0.2.12: runaway generations ran 140+ s) */
export const TTS_TIMEOUT_MS = 45_000;
/** a TTS response may carry at most this many times the expected audio (the runaway case was ~10 min for ~330 chars) */
export const TTS_MAX_AUDIO_RATIO = 3;
export const TTS_MAX_BYTES_HARD = 4 * 1024 * 1024;
const TTS_BYTES_PER_SEC = 24000 * 2;
/** very short texts vary a lot (breaths, lead-in): their expected duration is floored for the cap */
const TTS_MIN_EXPECTED_SEC = 4;

export const TTS_SAMPLE_RATE = 24000;
export const DEFAULT_VOICE = 'Kore';
/** Measured ~0.058-0.07 s per Russian character for gemini-3.1-flash-tts-preview (research/ru_*.wav). */
export const SEC_PER_CHAR = 0.07;
/** Leak/hallucination guard: trimmed audio longer than GUARD_RATIO * expected + GUARD_SLACK_SEC is suspicious. */
export const GUARD_RATIO = 1.8;
export const GUARD_SLACK_SEC = 1.0;

export function expectedSeconds(text: string): number {
  return text.trim().length * SEC_PER_CHAR;
}
/** response-body cap (bytes of JSON with base64 pcm) for a text: 3x the expected audio, base64-adjusted, at most 4 MB */
export function ttsMaxBytes(text: string): number {
  const pcm = Math.max(expectedSeconds(text), TTS_MIN_EXPECTED_SEC) * TTS_MAX_AUDIO_RATIO * TTS_BYTES_PER_SEC;
  return Math.min(TTS_MAX_BYTES_HARD, Math.ceil((pcm * 4) / 3) + 4096);
}
export function looksTooLong(seconds: number, text: string): boolean {
  return seconds > GUARD_RATIO * expectedSeconds(text) + GUARD_SLACK_SEC;
}

export interface TtsOptions {
  voice?: string;
  /** sampling temperature for the TTS request (accepted by gemini-3.1-flash-tts-preview), default 0.2 */
  temperature?: number;
  /** fixed seed for a stable voice, default 1 (the guard retry uses seed + 1) */
  seed?: number;
  /** remove DC / trailing breath / leading silence and fade edges, default true */
  trim?: boolean;
  /** re-synthesize once when the clip is implausibly long for its text, default true */
  guard?: boolean;
  /** parallel requests, default 3 */
  concurrency?: number;
  /** total attempts per segment on transient errors, default 3 */
  attempts?: number;
  /** injectable for tests */
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  /** wall-clock cap of one request, default TTS_TIMEOUT_MS */
  timeoutMs?: number;
  /** response-body cap override (bytes); default ttsMaxBytes(text) */
  maxBytes?: number;
}

export interface TtsResult {
  pcm: Int16Array;
  sampleRate: number;
  seconds: number;
  /** still implausibly long after one retry (possible leaked instruction / ad-lib); the shorter try was kept */
  suspicious?: boolean;
}

function decodeBase64Pcm(b64: string): Int16Array {
  const bin = atob(b64);
  const n = bin.length >> 1;
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
    out[i] = v >= 0x8000 ? v - 0x10000 : v;
  }
  return out;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const EMPTY_MSG = 'tts: empty audio response';

function isTransient(e: unknown): boolean {
  return (
    e instanceof ProviderUnavailableError &&
    !e.timedOut && // a runaway / stalled request is not retried with the same text on the same slot
    (e.kind === 'network' || (e.kind === 'failed' && e.message === EMPTY_MSG))
  );
}

/** One request: the text is the ONLY thing in the input (no prefix/suffix, instructions can be read aloud). */
async function synthesizeOnce(
  client: GeminiClient,
  model: string | string[],
  text: string,
  opts: TtsOptions,
  seed: number,
): Promise<TtsResult> {
  const body = {
    contents: [{ parts: [{ text }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      temperature: opts.temperature ?? 0.2,
      seed,
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: opts.voice ?? DEFAULT_VOICE } },
      },
    },
  };
  const attempts = opts.attempts ?? 3;
  const sleep = opts.sleep ?? defaultSleep;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await client.generateContent(model, body, opts.signal, { timeoutMs: opts.timeoutMs ?? TTS_TIMEOUT_MS, maxBytes: opts.maxBytes ?? ttsMaxBytes(text) });
      const inline = responseInlineData(res);
      if (!inline) throw new ProviderUnavailableError(EMPTY_MSG, 'gemini', 'failed');
      const rateMatch = /rate=(\d+)/.exec(inline.mimeType);
      const sampleRate = rateMatch?.[1] ? Number(rateMatch[1]) : TTS_SAMPLE_RATE;
      let pcm = decodeBase64Pcm(inline.data);
      if (pcm.length === 0) throw new ProviderUnavailableError(EMPTY_MSG, 'gemini', 'failed');
      if (opts.trim !== false) pcm = trimAndFade(pcm, sampleRate);
      return { pcm, sampleRate, seconds: pcm.length / sampleRate };
    } catch (e) {
      lastErr = e;
      if (!isTransient(e) || i === attempts - 1) throw e;
      await sleep(500 * 2 ** i);
    }
  }
  throw lastErr;
}

export async function synthesize(
  client: GeminiClient,
  model: string | string[],
  text: string,
  opts: TtsOptions = {},
): Promise<TtsResult> {
  const seed = opts.seed ?? 1;
  const first = await synthesizeOnce(client, model, text, opts, seed);
  if (opts.guard === false || !looksTooLong(first.seconds, text)) return first;
  const second = await synthesizeOnce(client, model, text, opts, seed + 1);
  const best = second.seconds < first.seconds ? second : first;
  return looksTooLong(best.seconds, text) ? { ...best, suspicious: true } : best;
}

export interface TtsItem {
  text: string;
  /** overrides TtsOptions.voice */
  voice?: string;
}

/** Synthesizes all texts with limited concurrency; result order matches input. */
export async function synthesizeAll(
  client: GeminiClient,
  model: string | string[],
  items: (string | TtsItem)[],
  opts: TtsOptions = {},
): Promise<TtsResult[]> {
  const texts = items.map((it) => (typeof it === 'string' ? { text: it } : it));
  const results = new Array<TtsResult>(texts.length);
  let next = 0;
  let failure: unknown;
  const worker = async () => {
    while (failure === undefined) {
      const i = next++;
      if (i >= texts.length) return;
      try {
        results[i] = await synthesize(client, model, texts[i]?.text ?? '', texts[i]?.voice ? { ...opts, voice: texts[i]?.voice } : opts);
      } catch (e) {
        failure = e;
        return;
      }
    }
  };
  const n = Math.max(1, Math.min(opts.concurrency ?? 3, texts.length));
  await Promise.all(Array.from({ length: n }, worker));
  if (failure !== undefined) throw failure;
  return results;
}

export interface SettledTts {
  result?: TtsResult;
  error?: unknown;
}

/** Like synthesizeAll but never throws: every item reports its own result or error (partial success). */
export async function synthesizeAllSettled(
  client: GeminiClient,
  model: string | string[],
  items: (string | TtsItem)[],
  opts: TtsOptions = {},
): Promise<SettledTts[]> {
  const texts = items.map((it) => (typeof it === 'string' ? { text: it } : it));
  const out = new Array<SettledTts>(texts.length);
  let next = 0;
  let stop = false;
  const worker = async () => {
    while (!stop) {
      const i = next++;
      if (i >= texts.length) return;
      const t = texts[i]!;
      try {
        out[i] = { result: await synthesize(client, model, t.text, t.voice ? { ...opts, voice: t.voice } : opts) };
      } catch (e) {
        out[i] = { error: e };
        // quota/auth will not recover within this batch: stop spending requests, the rest are marked failed
        if (e instanceof ProviderUnavailableError && (e.kind === 'quota' || e.kind === 'auth')) stop = true;
        if (opts.signal?.aborted) stop = true;
      }
    }
  };
  const n = Math.max(1, Math.min(opts.concurrency ?? 3, texts.length));
  await Promise.all(Array.from({ length: n }, worker));
  for (let i = 0; i < out.length; i++) {
    out[i] ??= { error: new ProviderUnavailableError('tts skipped after quota/auth failure', 'gemini', 'quota') };
  }
  return out;
}

/**
 * Text for a multi-sentence call: text ONLY (G6: instruction text is read aloud). Each sentence ends with terminal
 * punctuation and sentences are separated by a newline, which makes the model pause between them (the pause is what
 * alignSentences finds again).
 */
export function joinSentences(texts: string[]): string {
  return texts
    .map((t) => t.trim().replace(/\s+/g, ' '))
    .map((t) => (/[.!?…]["»”)]?$/.test(t) ? t : `${t}.`))
    .join('\n');
}

export interface RunTts {
  /** per-sentence clips; undefined when the alignment was not trustworthy (caller falls back to per-sentence calls) */
  clips?: TtsResult[];
  align: AlignResult;
  /** the whole call's audio (trimmed) */
  whole: TtsResult;
}

/**
 * ONE TTS call for several consecutive sentences of the same speaker (identical timbre/intonation across them),
 * split back into per-sentence clips by silence alignment.
 */
export async function synthesizeRun(
  client: GeminiClient,
  model: string | string[],
  texts: string[],
  opts: TtsOptions = {},
): Promise<RunTts> {
  const joined = joinSentences(texts);
  const whole = await synthesize(client, model, joined, opts);
  if (texts.length === 1) {
    return { clips: [whole], align: { ok: true, confidence: 1, cuts: [], ranges: [[0, whole.pcm.length]] }, whole };
  }
  const align = alignSentences(
    whole.pcm,
    whole.sampleRate,
    texts.map((t) => t.trim().length),
  );
  if (!align.ok) return { align, whole };
  const clips: TtsResult[] = [];
  for (const [a, b] of align.ranges) {
    const part = trimAndFade(whole.pcm.slice(a, b), whole.sampleRate);
    // a clip without audible speech means the alignment is wrong
    if (part.length < 0.15 * whole.sampleRate) {
      return { align: { ...align, ok: false, reason: 'empty clip after split' }, whole };
    }
    clips.push({ pcm: part, sampleRate: whole.sampleRate, seconds: part.length / whole.sampleRate });
  }
  return { clips, align, whole };
}
