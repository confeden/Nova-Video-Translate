import { CascadeProvider, type CascadeOptions } from '../cascade/provider';
import { ChromeTextTranslator, type TextTranslator } from '../cascade/translate';
import { LocalAsrStage } from './asr';
import { HybridLiveAsr, type LiveAsrMode } from './liveAsr';
import type { AsrStage } from '../cascade/provider';
import type { LocalAsrRegistry } from '../../localasr/registry';
import type { LocalAsrEngineId } from '../../localasr/types';

export interface LocalProviderOptions extends Partial<Omit<CascadeOptions, 'id' | 'label' | 'asr' | 'translators'>> {
  asrRegistry?: LocalAsrRegistry;
  asrOrder?: readonly LocalAsrEngineId[];
  /** settings.sourceLang: an explicit source language beats every automatic one */
  getSourceLang?: () => string | undefined;
  /** text translators in order: default Chrome Translator; apps may add Groq chat when a key exists */
  translators?: () => TextTranslator[];
  /** cloud recognizer for LIVE chunks (Groq Whisper); absent = always local */
  liveAsr?: { groq: AsrStage; hasKey(): boolean; mode(): LiveAsrMode };
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
    asr: ((local) => (o.liveAsr ? new HybridLiveAsr({ local, ...o.liveAsr }) : local))(new LocalAsrStage(o.asrRegistry, o.asrOrder, o.getSourceLang)),
    translators: o.translators ?? (() => [chrome]),
  });
}
