import { DEFAULT_LOCAL_ASR_ORDER, localAsrRegistry, type LocalAsrRegistry } from '../../localasr/registry';
import type { LocalAsr, LocalAsrEngineId } from '../../localasr/types';
import { resampleInt16 } from '../gemini/translate';
import { ProviderUnavailableError, type AudioChunk } from '../types';
import type { AsrStage } from '../cascade/provider';
import { groupPhrases, isoLang, type SourceSegment } from '../cascade/segments';

/** ASR stage over the LocalAsr registry (Chrome Prompt API audio, whisper-wasm, helper): picks the first available engine. */
export class LocalAsrStage implements AsrStage {
  readonly id = 'local-asr';
  private last?: LocalAsr;
  constructor(
    private readonly registry: LocalAsrRegistry = localAsrRegistry,
    private readonly order: readonly LocalAsrEngineId[] = DEFAULT_LOCAL_ASR_ORDER,
  ) {}

  private pick(lang?: string): Promise<LocalAsr | undefined> {
    return this.registry.pick(this.order, lang);
  }

  async available(): Promise<boolean> {
    this.last = await this.pick();
    return !!this.last;
  }

  model(): string {
    return this.last?.id ?? 'none';
  }

  async transcribe(chunk: AudioChunk, ctx: { signal: AbortSignal; sourceLang?: string }): Promise<{ segments: SourceSegment[]; sourceLang?: string }> {
    const eng = (await this.pick(ctx.sourceLang)) ?? this.last;
    if (!eng) throw new ProviderUnavailableError('no local ASR engine available', 'local', 'unsupported');
    this.last = eng;
    const pcm = resampleInt16(chunk.pcm, chunk.sampleRate, 16000);
    const r = await eng.transcribe(pcm, { lang: ctx.sourceLang, signal: ctx.signal });
    const lang = isoLang(r.lang) || (ctx.sourceLang ?? '');
    const phrases = r.segments.map((s) => ({ start: chunk.startSec + s.start, end: chunk.startSec + Math.min(s.end, chunk.durationSec), text: s.text }));
    return { segments: lang === 'ru' ? [] : groupPhrases(phrases), sourceLang: lang || undefined };
  }
}
