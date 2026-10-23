import { diag } from '../../diag';
import { encodeWav, resampleInt16 } from '../gemini/translate';
import type { AudioChunk } from '../types';
import type { AsrStage } from '../cascade/provider';
import { groupPhrases, isoLang, type SourceSegment } from '../cascade/segments';
import type { GroqClient } from './client';
import type { GroqModelRegistry } from './models';

/** Whisper hallucinations on silence: segments the model itself flags as non-speech */
export function isLikelyNoise(s: { no_speech_prob?: number; avg_logprob?: number }): boolean {
  return (s.no_speech_prob ?? 0) > 0.8 || ((s.no_speech_prob ?? 0) > 0.5 && (s.avg_logprob ?? 0) < -1);
}

/** Groq Whisper ASR stage: 16 kHz mono WAV -> verbose_json segments -> sentence slots on the video timeline. */
export class GroqAsr implements AsrStage {
  readonly id = 'groq-whisper';
  private lastModel = '';
  constructor(
    private readonly client: GroqClient,
    private readonly models: GroqModelRegistry,
  ) {}

  async available(): Promise<boolean> {
    return this.client.hasKey();
  }

  model(): string {
    return this.lastModel || 'asr';
  }

  async transcribe(chunk: AudioChunk, ctx: { signal: AbortSignal; sourceLang?: string }): Promise<{ segments: SourceSegment[]; sourceLang?: string }> {
    const model = await this.models.resolve('asr', ctx.signal);
    this.lastModel = model;
    const wav = encodeWav(resampleInt16(chunk.pcm, chunk.sampleRate, 16000), 16000);
    const hint = ctx.sourceLang && /^[a-z]{2,3}$/i.test(ctx.sourceLang) ? ctx.sourceLang.toLowerCase() : undefined;
    const r = await this.client.transcribe({ wav, model, language: hint, signal: ctx.signal });
    const lang = isoLang(r.language) || hint || '';
    const kept = r.segments.filter((s) => s.text.trim() && !isLikelyNoise(s) && s.end > s.start);
    if (kept.length < r.segments.length) diag.log('groq-asr-filtered', { dropped: r.segments.length - kept.length, of: r.segments.length });
    const phrases = kept.map((s) => ({ start: chunk.startSec + s.start, end: chunk.startSec + Math.min(s.end, chunk.durationSec), text: s.text }));
    return { segments: lang === 'ru' ? [] : groupPhrases(phrases), sourceLang: lang || undefined };
  }
}
