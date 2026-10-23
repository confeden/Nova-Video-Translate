import { diag } from '../diag';
import type { KeyPool } from '../keypool';
import { listModels, pickModels, type FetchFn } from '../models';
import { GeminiClient, responseText } from '../providers/gemini/client';
import { TRANSLATE_PREFERENCES } from '../providers/gemini/provider';
import { translateChunkAudio } from '../providers/gemini/translate';
import { ProviderUnavailableError, type AudioChunk, type SubtitleCue } from '../providers/types';
import { SubtitleUnavailable, type ChunkSource, type CueTranslator } from './types';

/** Ids that can never be a text model. Same idea as the provider's NOT_TRANSLATE list. */
const NOT_TEXT = /tts|live|audio|image|transcribe|embed|imagen|veo|aqa/i;
export const BATCH_SIZE = 40;

const SCHEMA = {
  type: 'OBJECT',
  properties: { items: { type: 'ARRAY', items: { type: 'OBJECT', properties: { i: { type: 'NUMBER' }, ru: { type: 'STRING' } }, required: ['i', 'ru'] } } },
  required: ['items'],
} as const;

export function buildTranslatePrompt(sourceLang: string): string {
  return [
    `Translate these video subtitle lines from "${sourceLang}" to natural Russian.`,
    'The input is a JSON array of {"i": index, "t": text}. Return {"items":[{"i": index, "ru": translation}]} with EXACTLY one item per input line,',
    'same index, same order. Keep each translation short enough to read as a subtitle, never merge or drop lines, keep names and numbers.',
    'Return only JSON.',
  ].join('\n');
}

export function parseTranslateReply(text: string, count: number): (string | undefined)[] {
  const out: (string | undefined)[] = new Array(count).fill(undefined);
  let o: unknown;
  try {
    o = JSON.parse(text);
  } catch {
    return out;
  }
  const items = (o as { items?: { i?: unknown; ru?: unknown }[] })?.items;
  if (!Array.isArray(items)) return out;
  for (const it of items) {
    const i = Number(it?.i);
    if (Number.isInteger(i) && i >= 0 && i < count && typeof it.ru === 'string' && it.ru.trim()) out[i] = it.ru.trim();
  }
  return out;
}

export interface GeminiTextOptions {
  /** current key pool (rebuilt by the owner when keys change); undefined = no keys */
  pool: () => KeyPool | undefined;
  fetch: FetchFn;
  /** user override of the text model (Settings.geminiModels.translate), '' = auto */
  modelOverride?: () => string | undefined;
}

/** Text-only Gemini calls for subtitles: no TTS, cheap flash-lite class model (resolved via ListModels, I2). */
export class GeminiText implements CueTranslator, ChunkSource {
  readonly id = 'gemini' as const;
  readonly label = 'Gemini';
  private client?: GeminiClient;
  private clientPool?: KeyPool;
  private models?: Promise<string[]>;
  /** calls made (tests / budget accounting) */
  calls = 0;

  constructor(private readonly o: GeminiTextOptions) {}

  isConfigured(): boolean {
    return this.o.pool()?.current() !== undefined;
  }
  isAvailable(): boolean {
    return this.isConfigured();
  }
  unavailableReason(): string {
    return 'не задан ключ Gemini';
  }

  private getClient(): GeminiClient {
    const pool = this.o.pool();
    if (!pool) throw new SubtitleUnavailable('не задан ключ Gemini');
    if (!this.client || this.clientPool !== pool) {
      this.client = new GeminiClient({ keys: pool, fetch: this.o.fetch });
      this.clientPool = pool;
      this.models = undefined;
    }
    return this.client;
  }

  private async resolveModels(client: GeminiClient, signal: AbortSignal): Promise<string[]> {
    const override = this.o.modelOverride?.()?.trim();
    this.models ??= client
      .listModels(signal)
      .then((ms) => pickModels(ms.filter((m) => m.supportedGenerationMethods.includes('generateContent') && !NOT_TEXT.test(m.id)).map((m) => m.id), TRANSLATE_PREFERENCES));
    this.models.catch(() => (this.models = undefined));
    const listed = await this.models;
    const out = override ? [override, ...listed.filter((m) => m !== override)] : listed;
    if (out.length === 0) throw new SubtitleUnavailable('Gemini: нет подходящей модели');
    return out;
  }

  private wrap(e: unknown): never {
    if (e instanceof ProviderUnavailableError) {
      if (e.kind === 'quota') throw new SubtitleUnavailable('лимит Gemini исчерпан');
      if (e.kind === 'auth') throw new SubtitleUnavailable('ключ Gemini не принят');
    }
    throw e;
  }

  async translate(cues: SubtitleCue[], sourceLang: string, signal: AbortSignal): Promise<SubtitleCue[]> {
    const client = this.getClient();
    const out: SubtitleCue[] = [];
    for (let at = 0; at < cues.length; at += BATCH_SIZE) {
      if (signal.aborted) throw new DOMException('aborted', 'AbortError');
      const batch = cues.slice(at, at + BATCH_SIZE);
      const body = {
        contents: [{ parts: [{ text: buildTranslatePrompt(sourceLang) }, { text: JSON.stringify(batch.map((c, i) => ({ i, t: c.text }))) }] }],
        generationConfig: { responseMimeType: 'application/json', responseSchema: SCHEMA, temperature: 0.2 },
      };
      let text: string | undefined;
      try {
        this.calls++;
        const res = await client.generateContent(await this.resolveModels(client, signal), body, signal);
        text = responseText(res);
      } catch (e) {
        if (signal.aborted) throw e;
        this.wrap(e);
      }
      const ru = parseTranslateReply(text ?? '', batch.length);
      const missing = ru.filter((x) => x === undefined).length;
      diag.log('subs-gemini-translate', { batch: batch.length, missing });
      batch.forEach((c, i) => {
        if (ru[i]) out.push({ start: c.start, end: c.end, src: c.text, text: ru[i]! });
      });
    }
    return out;
  }

  /** audio -> {src, ru} segments with timings, no TTS (the voice-less half of GeminiProvider.translateChunk) */
  async transcribe(chunk: AudioChunk, signal: AbortSignal): Promise<SubtitleCue[]> {
    const client = this.getClient();
    let r;
    try {
      this.calls++;
      r = await translateChunkAudio(client, await this.resolveModels(client, signal), chunk, { signal });
    } catch (e) {
      if (signal.aborted) throw e;
      this.wrap(e);
    }
    return r.segments.map((s) => ({ start: chunk.startSec + s.start, end: chunk.startSec + s.end, src: s.src, text: s.ru }));
  }
}
