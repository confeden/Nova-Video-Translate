import { CascadeProvider, type CascadeOptions } from '../cascade/provider';
import { ChromeTextTranslator, type TextTranslator } from '../cascade/translate';
import { LocalAsrStage } from './asr';
import type { LocalAsrRegistry } from '../../localasr/registry';
import type { LocalAsrEngineId } from '../../localasr/types';

export interface LocalProviderOptions extends Partial<Omit<CascadeOptions, 'id' | 'label' | 'asr' | 'translators'>> {
  asrRegistry?: LocalAsrRegistry;
  asrOrder?: readonly LocalAsrEngineId[];
  /** text translators in order: default Chrome Translator; apps may add Groq chat when a key exists */
  translators?: () => TextTranslator[];
}

/**
 * Local tier (D30): captions when the platform has them (no ASR at all), else a LocalAsr engine; Chrome Translator
 * (or the supplied fallbacks; YouTube tlang is the built-in last resort for captions) and a local TTS engine.
 * usable() is false without a TTS engine, a translator, or a source of text (captions / ASR engine).
 */
export function createLocalProvider(o: LocalProviderOptions = {}): CascadeProvider {
  const chrome = new ChromeTextTranslator();
  return new CascadeProvider({
    ...o,
    id: 'local',
    label: 'Локальные модели',
    asr: new LocalAsrStage(o.asrRegistry, o.asrOrder),
    translators: o.translators ?? (() => [chrome]),
  });
}
