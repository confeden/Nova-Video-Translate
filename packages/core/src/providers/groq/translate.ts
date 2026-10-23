import { diag } from '../../diag';
import { ProviderUnavailableError } from '../types';
import type { TextItem, TextTranslator } from '../cascade/translate';
import { extractJsonObject, type GroqClient } from './client';
import type { GroqModelRegistry } from './models';

/** One request per batch: JSON in / JSON out with a Russian-character budget per slot (D10). */
export function buildGroqTranslatePrompt(sourceLang: string): string {
  return [
    'You are a dubbing translator. Translate each numbered segment of video speech into natural spoken Russian for voice-over.',
    sourceLang ? `The source language is "${sourceLang}".` : '',
    'Translate EVERY segment completely: never skip, merge or summarise, never add information. "max_chars" is a soft length budget for the Russian text ' +
      '(Russian speech runs 12-16 characters per second); stay near it, up to about 30% over if the faithful translation needs it, prefer tighter wording only where it costs no meaning.',
    'Reply with JSON only: {"segments":[{"i":0,"ru":"..."}, ...]} with one entry per input segment, same "i".',
  ]
    .filter(Boolean)
    .join('\n');
}

/** line protocol (no JSON mode): "<i>|<Russian>" per segment; robust against quotes / guillemets / odd lyrics that break JSON mode */
export function buildGroqLinesPrompt(sourceLang: string): string {
  return [
    'You are a dubbing translator. Translate each numbered segment of video speech into natural spoken Russian for voice-over.',
    sourceLang ? `The source language is "${sourceLang}".` : '',
    'Translate EVERY segment completely: never skip, merge or summarise, never add information. The middle number is a soft budget of Russian characters; stay near it.',
    'Input lines look like: <i>|<budget>|<source text>. Reply with exactly one line per input line, in the form: <i>|<Russian text>. No other text, no blank lines, no markdown.',
  ]
    .filter(Boolean)
    .join('\n');
}

export function parseGroqLines(raw: string, n: number): string[] {
  const out: string[] = new Array(n).fill('');
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s*[|:\t]\s*(.+?)\s*$/.exec(line);
    if (!m) continue;
    const i = Number(m[1]);
    if (i >= 0 && i < n && !out[i]) out[i] = m[2]!;
  }
  const missing = out.filter((x) => !x).length;
  if (missing > 0) throw new ProviderUnavailableError(`Groq: translation misses ${missing} of ${n} segments`, 'groq', 'failed');
  return out;
}

export function parseGroqTranslation(raw: string, n: number): string[] {
  let j: { segments?: { i?: number; ru?: string }[] };
  try {
    j = JSON.parse(extractJsonObject(raw));
  } catch {
    throw new ProviderUnavailableError('Groq: translation is not valid JSON', 'groq', 'failed');
  }
  const out: string[] = new Array(n).fill('');
  for (const s of j.segments ?? []) {
    const i = Number(s.i);
    if (Number.isInteger(i) && i >= 0 && i < n && typeof s.ru === 'string') out[i] = s.ru.trim();
  }
  const missing = out.filter((x) => !x).length;
  if (missing > 0) throw new ProviderUnavailableError(`Groq: translation misses ${missing} of ${n} segments`, 'groq', 'failed');
  return out;
}

/** Text translation through a Groq chat model (OpenAI-compatible /chat/completions): JSON mode first, plain lines when that fails. */
export class GroqChatTranslator implements TextTranslator {
  readonly id = 'groq-chat';
  constructor(
    private readonly client: GroqClient,
    private readonly models: GroqModelRegistry,
  ) {}

  async isAvailable(): Promise<boolean> {
    return this.client.hasKey();
  }

  async translate(items: readonly TextItem[], sourceLang: string, signal: AbortSignal): Promise<string[]> {
    const model = await this.models.resolve('chat', signal);
    // an explicit output budget (Cyrillic costs ~3x the tokens of English): the default cut long batches off
    // reasoning models (the registry may pick one, e.g. gpt-oss) spend max_tokens on hidden reasoning and answer with an EMPTY
    // message (finish=length): ask for low effort and leave headroom for it
    const reasoning = /gpt-oss|qwen3|deepseek-r1|reason/i.test(model);
    const maxTokens = Math.min(8000, 200 + items.length * 120 + (reasoning ? 1500 : 0));
    const effort = reasoning ? ('low' as const) : undefined;
    const lines = async (): Promise<string[]> => {
      const raw = await this.client.chat({
        model,
        temperature: 0.2,
        maxTokens,
        reasoningEffort: effort,
        signal,
        messages: [
          { role: 'system', content: buildGroqLinesPrompt(sourceLang) },
          { role: 'user', content: items.map((it, i) => `${i}|${it.maxChars}|${it.text.replace(/\s*\n\s*/g, ' ')}`).join('\n') },
        ],
      });
      return parseGroqLines(raw, items.length);
    };
    // big batches (caption pre-translation) go straight to the line protocol: JSON mode kept failing on song lyrics and costs a wasted round trip
    if (items.length >= 12) return lines();
    try {
      const payload = JSON.stringify({ segments: items.map((it, i) => ({ i, src: it.text, max_chars: it.maxChars })) });
      const raw = await this.client.chat({
        model,
        json: true,
        temperature: 0.2,
        maxTokens,
        reasoningEffort: effort,
        signal,
        messages: [
          { role: 'system', content: buildGroqTranslatePrompt(sourceLang) },
          { role: 'user', content: payload },
        ],
      });
      return parseGroqTranslation(raw, items.length);
    } catch (e) {
      // rate limits / auth / network go up to the failover; a content failure (invalid JSON, empty, missing segments) gets one more try as plain lines
      const kind = (e as { kind?: string })?.kind;
      if (signal.aborted || kind === 'quota' || kind === 'auth' || kind === 'network') throw e;
      diag.log('groq-lines-retry', { msg: String((e as Error)?.message ?? e).slice(0, 80) });
      return lines();
    }
  }
}
