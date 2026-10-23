import { diag } from '../../diag';
import type { AudioChunk } from '../types';
import { ProviderUnavailableError } from '../types';
import { responseText, type GeminiClient } from './client';
import type { SpeakerGender } from './voices';

/** Speaking budget: Russian characters per second of original slot. */
export const CHARS_PER_SEC = 14;
export const MIN_SEGMENT_SEC = 2.0;
const TARGET_RATE = 16000;

export interface TranslatedSegment {
  /** seconds relative to chunk start */
  start: number;
  end: number;
  src: string;
  ru: string;
  /** stable short speaker id within the chunk ('S1', 'S2'); '' when unknown */
  speaker?: string;
  gender?: SpeakerGender;
}

export interface TranslateResult {
  sourceLang: string;
  segments: TranslatedSegment[];
  /** why `segments` is empty (diagnostics): 'ru' source, 'no-speech' (model returned none), 'empty-ru' (segments had no translation) */
  reason?: 'ru' | 'no-speech' | 'empty-ru';
  /** segments the model returned before filtering */
  rawSegments?: number;
}

export function budgetChars(durationSec: number): number {
  return Math.round(durationSec * CHARS_PER_SEC);
}

/** Resample by linear interpolation (box-averaged when downsampling). */
export function resampleInt16(pcm: Int16Array, from: number, to: number): Int16Array {
  if (from === to) return pcm;
  const outLen = Math.max(1, Math.round((pcm.length * to) / from));
  const out = new Int16Array(outLen);
  const ratio = from / to;
  for (let i = 0; i < outLen; i++) {
    const a = i * ratio;
    const b = Math.min(pcm.length, (i + 1) * ratio);
    if (ratio > 1) {
      const lo = Math.min(pcm.length - 1, Math.floor(a));
      const hi = Math.max(lo + 1, Math.min(pcm.length, Math.ceil(b)));
      let sum = 0;
      for (let j = lo; j < hi; j++) sum += pcm[j] ?? 0;
      out[i] = Math.round(sum / (hi - lo));
    } else {
      const i0 = Math.min(pcm.length - 1, Math.floor(a));
      const i1 = Math.min(pcm.length - 1, i0 + 1);
      const f = a - i0;
      out[i] = Math.round((pcm[i0] ?? 0) * (1 - f) + (pcm[i1] ?? 0) * f);
    }
  }
  return out;
}

/** 16-bit mono PCM WAV container. */
export function encodeWav(pcm: Int16Array, sampleRate: number): Uint8Array {
  const dataLen = pcm.length * 2;
  const buf = new ArrayBuffer(44 + dataLen);
  const v = new DataView(buf);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  v.setUint32(4, 36 + dataLen, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, dataLen, true);
  for (let i = 0; i < pcm.length; i++) v.setInt16(44 + i * 2, pcm[i] ?? 0, true);
  return new Uint8Array(buf);
}

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    s += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(s);
}

export const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    source_lang: { type: 'STRING' },
    segments: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          start: { type: 'NUMBER' },
          end: { type: 'NUMBER' },
          src: { type: 'STRING' },
          ru: { type: 'STRING' },
          speaker: { type: 'STRING' },
          gender: { type: 'STRING', enum: ['male', 'female', 'child', 'unknown'] },
        },
        required: ['start', 'end', 'src', 'ru'],
      },
    },
  },
  required: ['source_lang', 'segments'],
} as const;

export function buildPrompt(durationSec: number, sourceLangHint?: string): string {
  return [
    'You are a dubbing translator. The attached audio is a fragment of a video, ' +
      `${durationSec.toFixed(1)} seconds long.`,
    sourceLangHint ? `The source language is probably "${sourceLangHint}" (verify it).` : '',
    '1. Detect the spoken language and return its ISO 639-1 code in "source_lang".',
    '2. Split the speech into sentence-level segments. "start" and "end" are seconds relative to the ' +
      'start of this audio fragment. "src" is the exact transcription.',
    `3. Merge any segment shorter than ${MIN_SEGMENT_SEC.toFixed(1)} seconds into its neighbour: very short ` +
      'slots overshoot when spoken, so avoid them.',
    '4. "ru" is the natural spoken Russian translation for voice-over. Translate EVERY spoken sentence completely: ' +
      'never skip, merge away or summarise a sentence, never drop meaning and never add information that is not in ' +
      `the original. Length guideline (soft, not a limit): about round(duration_seconds * ${CHARS_PER_SEC}) characters ` +
      'per segment, where duration_seconds = end - start; Russian speech runs 12-16 characters per second. If the ' +
      'faithful translation is longer, keep it complete (up to about 30% over) and prefer a tighter wording only where ' +
      'it costs no meaning.',
    '5. "speaker" is a short stable id of the person speaking ("S1", "S2", ...), the same id for the same voice throughout this fragment. ' +
      '"gender" is judged from the voice timbre: "male", "female", "child" or "unknown" when unsure.',
    '6. If the speech is already Russian, return source_lang "ru" and an empty string for every "ru".',
    '7. If there is no speech (silence, music, noise only), return an empty segments array and source_lang "und".',
    'Return only JSON matching the schema.',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Safety net for models that ignore the "merge short segments" instruction. */
export function mergeShortSegments(
  segs: TranslatedSegment[],
  minSec: number = MIN_SEGMENT_SEC,
): TranslatedSegment[] {
  const out: TranslatedSegment[] = [];
  let pending: TranslatedSegment | undefined;
  const join = (a: TranslatedSegment, b: TranslatedSegment): TranslatedSegment => {
    const r: TranslatedSegment = {
      start: Math.min(a.start, b.start),
      end: Math.max(a.end, b.end),
      src: `${a.src} ${b.src}`.trim(),
      ru: `${a.ru} ${b.ru}`.trim(),
    };
    const speaker = a.speaker || b.speaker;
    if (speaker) r.speaker = speaker;
    const gender = a.gender && a.gender !== 'unknown' ? a.gender : b.gender;
    if (gender) r.gender = gender;
    return r;
  };
  for (const s of segs) {
    const cur = pending ? join(pending, s) : { ...s };
    if (cur.end - cur.start < minSec) {
      pending = cur;
    } else {
      out.push(cur);
      pending = undefined;
    }
  }
  if (pending) {
    const last = out.pop();
    out.push(last ? join(last, pending) : pending);
  }
  return out;
}

function parseGender(v: unknown): SpeakerGender {
  const g = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return g === 'male' || g === 'female' || g === 'child' ? g : 'unknown';
}

export function parseTranslation(text: string, durationSec: number): TranslateResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ProviderUnavailableError('translate: model returned invalid JSON', 'gemini', 'failed');
  }
  const o = raw as { source_lang?: unknown; segments?: unknown };
  const sourceLang = typeof o.source_lang === 'string' ? o.source_lang.trim().toLowerCase() : '';
  const list = Array.isArray(o.segments) ? o.segments : [];
  const segs: TranslatedSegment[] = [];
  for (const item of list) {
    const s = item as Record<string, unknown>;
    const start = Number(s.start);
    const end = Number(s.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const a = Math.max(0, Math.min(durationSec, start));
    const b = Math.max(a, Math.min(durationSec, end));
    segs.push({
      start: a,
      end: b,
      src: typeof s.src === 'string' ? s.src.trim() : '',
      ru: typeof s.ru === 'string' ? s.ru.trim() : '',
      speaker: typeof s.speaker === 'string' ? s.speaker.trim() : '',
      gender: parseGender(s.gender),
    });
  }
  segs.sort((x, y) => x.start - y.start);
  return { sourceLang, segments: segs };
}

export interface TranslateOptions {
  sourceLangHint?: string;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  /** wall-clock cap of one translate request, default TRANSLATE_TIMEOUT_MS */
  timeoutMs?: number;
}

/** wall-clock cap of one Gemini translate request */
export const TRANSLATE_TIMEOUT_MS = 60_000;

export async function translateChunkAudio(
  client: GeminiClient,
  model: string | string[],
  chunk: AudioChunk,
  opts: TranslateOptions = {},
): Promise<TranslateResult> {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const pcm = resampleInt16(chunk.pcm, chunk.sampleRate, TARGET_RATE);
  const wav = encodeWav(pcm, TARGET_RATE);
  const duration = pcm.length / TARGET_RATE;
  const body = {
    contents: [
      {
        parts: [
          { text: buildPrompt(duration, opts.sourceLangHint) },
          { inlineData: { mimeType: 'audio/wav', data: toBase64(wav) } },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
      temperature: 0.3,
    },
  };
  let res: Awaited<ReturnType<GeminiClient['generateContent']>> | undefined;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await client.generateContent(model, body, opts.signal, { timeoutMs: opts.timeoutMs ?? TRANSLATE_TIMEOUT_MS });
      break;
    } catch (e) {
      const transient = e instanceof ProviderUnavailableError && e.kind === 'network' && !e.timedOut;
      if (!transient || attempt >= 2) throw e;
      await (opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(1500 * (attempt + 1));
    }
  }
  const text = responseText(res);
  if (text === undefined) {
    throw new ProviderUnavailableError('translate: empty model response', 'gemini', 'failed');
  }
  const parsed = parseTranslation(text, duration);
  const ms = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0);
  const done = (r: TranslateResult): TranslateResult => {
    const speech = r.segments.reduce((a, x) => a + (x.end - x.start), 0);
    const ruChars = r.segments.reduce((a, x) => a + x.ru.length, 0);
    const expected = r.segments.reduce((a, x) => a + budgetChars(x.end - x.start), 0);
    diag.log('gemini-translate', {
      segments: r.segments.length,
      raw: parsed.segments.length,
      source_lang: parsed.sourceLang,
      reason: r.reason,
      chunkSec: Math.round(duration * 10) / 10,
      speechSec: Math.round(speech * 10) / 10,
      ruChars,
      expectedChars: expected,
      charsPerSec: speech > 0 ? Math.round((ruChars / speech) * 10) / 10 : 0,
      ms,
    });
    return r;
  };
  if (parsed.sourceLang.startsWith('ru')) return done({ sourceLang: 'ru', segments: [], reason: 'ru', rawSegments: parsed.segments.length });
  const usable = parsed.segments.filter((s) => s.ru.length > 0 && s.end > s.start);
  const merged = mergeShortSegments(usable);
  // 'und' = the model's "no speech" marker: not a language the rest of the system should see
  const lang = parsed.sourceLang === 'und' || parsed.sourceLang === 'none' ? '' : parsed.sourceLang;
  const reason = merged.length > 0 ? undefined : parsed.segments.length === 0 ? 'no-speech' : 'empty-ru';
  return done({ sourceLang: lang, segments: merged, reason, rawSegments: parsed.segments.length });
}
