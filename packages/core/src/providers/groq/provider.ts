import { CascadeProvider, type CascadeOptions } from '../cascade/provider';
import { ChromeTextTranslator, type TextTranslator } from '../cascade/translate';
import type { Settings } from '../../types';
import type { Transport } from '../types';
import { GroqAsr } from './asr';
import { GroqClient } from './client';
import { GroqModelRegistry } from './models';
import { GroqChatTranslator } from './translate';

export interface GroqProviderOptions extends Partial<Omit<CascadeOptions, 'id' | 'label' | 'asr' | 'translators' | 'gate'>> {
  transport: Transport;
  /** current settings (key and model overrides are read per call) */
  getSettings(): Pick<Settings, 'groqApiKey' | 'groqModels'>;
  /** text translators tried before Groq chat; default [Chrome Translator]. Pass [] to use Groq chat only. */
  preTranslators?: TextTranslator[];
  perMin?: number;
}

export type GroqProvider = CascadeProvider & { client: GroqClient; models: GroqModelRegistry };

/** Groq tier: Groq Whisper ASR + (Chrome Translator, else Groq chat) translation + local TTS (Groq has no Russian TTS). */
export function createGroqProvider(o: GroqProviderOptions): GroqProvider {
  const client = new GroqClient({ transport: o.transport, getKey: () => o.getSettings().groqApiKey, perMin: o.perMin });
  const models = new GroqModelRegistry(client, () => o.getSettings().groqModels);
  const chat = new GroqChatTranslator(client, models);
  const pre = o.preTranslators ?? [new ChromeTextTranslator()];
  const p = new CascadeProvider({
    ...o,
    id: 'groq',
    label: 'Groq',
    asr: new GroqAsr(client, models),
    gate: () => client.hasKey(),
    translators: () => [...pre, chat],
  });
  return Object.assign(p, { client, models });
}
