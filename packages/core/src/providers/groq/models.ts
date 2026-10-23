import { pickModels } from '../../models';
import type { GroqClient } from './client';

/** Ordered preferences over Groq's model list (I2: ids are never matched literally; the user can override in settings). */
export const GROQ_ASR_PREFERENCES: RegExp[] = [/whisper-large-v3-turbo/, /whisper-large-v3(?!-turbo)/, /whisper/];
export const GROQ_CHAT_PREFERENCES: RegExp[] = [/llama-3\.3-70b/, /llama-?3.*70b/, /llama.*(8b|instant)/, /gpt-oss/, /llama|qwen|mixtral|gemma/];
/** ids that can never be the chat model */
const NOT_CHAT = /whisper|tts|guard|playai|embed|orpheus|safeguard/i;

/**
 * Fallback ids used ONLY when the model list cannot be fetched (5xx / offline list) and the user set no override. Clearly
 * named defaults, not product logic: the registry below is the source of truth.
 */
export const GROQ_DEFAULT_ASR_MODEL = 'whisper-large-v3-turbo';
export const GROQ_DEFAULT_CHAT_MODEL = 'llama-3.3-70b-versatile';

export type GroqModelRole = 'asr' | 'chat';

export class GroqModelRegistry {
  private cache?: Promise<string[]>;
  constructor(
    private readonly client: GroqClient,
    private readonly overrides: () => { asr?: string; chat?: string } = () => ({}),
  ) {}

  reset(): void {
    this.cache = undefined;
  }

  private list(signal?: AbortSignal): Promise<string[]> {
    const p = (this.cache ??= this.client.listModels(signal));
    p.catch(() => {
      if (this.cache === p) this.cache = undefined;
    });
    return p;
  }

  /** user override > ListModels preference > named default */
  async resolve(role: GroqModelRole, signal?: AbortSignal): Promise<string> {
    const ov = this.overrides()[role]?.trim();
    if (ov) return ov;
    try {
      const ids = await this.list(signal);
      const pool = role === 'chat' ? ids.filter((i) => !NOT_CHAT.test(i)) : ids;
      const [first] = pickModels(pool, role === 'asr' ? GROQ_ASR_PREFERENCES : GROQ_CHAT_PREFERENCES);
      if (first) return first;
    } catch (e) {
      if (signal?.aborted) throw e;
      // auth / quota must surface, not hide behind a default
      const kind = (e as { kind?: string } | undefined)?.kind;
      if (kind === 'auth' || kind === 'quota') throw e;
    }
    return role === 'asr' ? GROQ_DEFAULT_ASR_MODEL : GROQ_DEFAULT_CHAT_MODEL;
  }
}
