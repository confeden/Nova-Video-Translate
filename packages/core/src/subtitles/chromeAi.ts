import { diag } from '../diag';
import type { AudioChunk, SubtitleCue } from '../providers/types';
import { encodeWav, resampleInt16 } from '../providers/gemini/translate';
import { spreadSentences, splitSentences } from './cues';
import { SubtitleUnavailable, type ChunkSource, type CueTranslator } from './types';

/** Chrome built-in AI globals (Translator, LanguageDetector, LanguageModel), typed loosely: the APIs are still moving. */
export interface ChromeAiEnv {
  Translator?: {
    availability(o: { sourceLanguage: string; targetLanguage: string }): Promise<string>;
    create(o: { sourceLanguage: string; targetLanguage: string }): Promise<{ translate(text: string): Promise<string>; destroy?(): void }>;
  };
  LanguageDetector?: {
    availability(): Promise<string>;
    create(): Promise<{ detect(text: string): Promise<{ detectedLanguage: string; confidence: number }[]>; destroy?(): void }>;
  };
  LanguageModel?: {
    availability(o?: unknown): Promise<string>;
    create(o?: unknown): Promise<{ prompt(input: unknown, opts?: { signal?: AbortSignal }): Promise<string>; destroy?(): void }>;
  };
}

const env = (): ChromeAiEnv => globalThis as unknown as ChromeAiEnv;

/** Languages the Prompt API can hear/answer in today (Chrome docs: English, Japanese, Spanish). */
export const PROMPT_AUDIO_LANGS = ['en', 'ja', 'es'];

/** Plain facts about what this browser offers, for diagnostics and the report. */
export async function chromeAiFacts(e: ChromeAiEnv = env()): Promise<Record<string, string>> {
  const out: Record<string, string> = {
    Translator: e.Translator ? 'present' : 'absent',
    LanguageDetector: e.LanguageDetector ? 'present' : 'absent',
    LanguageModel: e.LanguageModel ? 'present' : 'absent',
  };
  try {
    if (e.Translator) out.translatorEnRu = await e.Translator.availability({ sourceLanguage: 'en', targetLanguage: 'ru' });
  } catch (x) {
    out.translatorEnRu = `error ${String(x).slice(0, 60)}`;
  }
  try {
    if (e.LanguageDetector) out.detector = await e.LanguageDetector.availability();
  } catch (x) {
    out.detector = `error ${String(x).slice(0, 60)}`;
  }
  try {
    if (e.LanguageModel) out.promptAudio = await e.LanguageModel.availability({ expectedInputs: [{ type: 'audio' }], expectedOutputs: [{ type: 'text', languages: ['en'] }] });
  } catch (x) {
    out.promptAudio = `error ${String(x).slice(0, 60)}`;
  }
  return out;
}

export async function detectLanguage(text: string, e: ChromeAiEnv = env()): Promise<string | undefined> {
  if (!e.LanguageDetector || !text.trim()) return undefined;
  try {
    if ((await e.LanguageDetector.availability()) !== 'available') return undefined;
    const d = await e.LanguageDetector.create();
    try {
      const r = (await d.detect(text))[0];
      return r && r.confidence >= 0.5 ? r.detectedLanguage.split('-')[0] : undefined;
    } finally {
      d.destroy?.();
    }
  } catch {
    return undefined;
  }
}

/** Free local text translation (Translator API) to Russian. */
export class ChromeCueTranslator implements CueTranslator {
  readonly id = 'chrome-ai' as const;
  readonly label = 'Chrome AI';
  private readonly cache = new Map<string, Promise<{ translate(text: string): Promise<string> }>>();
  constructor(private readonly getEnv: () => ChromeAiEnv = env) {}

  async isAvailable(sourceLang: string): Promise<boolean> {
    const T = this.getEnv().Translator;
    if (!T || !sourceLang) return false;
    try {
      return (await T.availability({ sourceLanguage: sourceLang, targetLanguage: 'ru' })) === 'available';
    } catch {
      return false;
    }
  }

  private translatorFor(lang: string): Promise<{ translate(text: string): Promise<string> }> {
    let p = this.cache.get(lang);
    if (!p) {
      p = this.getEnv().Translator!.create({ sourceLanguage: lang, targetLanguage: 'ru' });
      p.catch(() => this.cache.delete(lang));
      this.cache.set(lang, p);
    }
    return p;
  }

  async translateText(text: string, sourceLang: string): Promise<string> {
    return (await this.translatorFor(sourceLang)).translate(text);
  }

  async translate(cues: SubtitleCue[], sourceLang: string, signal: AbortSignal): Promise<SubtitleCue[]> {
    const t = await this.translatorFor(sourceLang);
    const out: SubtitleCue[] = [];
    for (const c of cues) {
      if (signal.aborted) throw new DOMException('aborted', 'AbortError');
      const ru = (await t.translate(c.text)).trim();
      if (ru) out.push({ start: c.start, end: c.end, src: c.text, text: ru });
    }
    return out;
  }
}

/** Chunk transcription with the Prompt API (audio input, English/Japanese/Spanish) + Translator. ~0.73x realtime (measured, Chrome 155). */
export class ChromeAudioChunkSource implements ChunkSource {
  readonly id = 'chrome-ai' as const;
  readonly label = 'Chrome AI';
  private reason = '';
  private session?: Promise<{ prompt(input: unknown, opts?: { signal?: AbortSignal }): Promise<string>; destroy?(): void }>;
  constructor(
    private readonly translator: ChromeCueTranslator,
    private readonly getEnv: () => ChromeAiEnv = env,
  ) {}

  unavailableReason(): string {
    return this.reason || 'встроенный ИИ Chrome недоступен';
  }

  async isAvailable(): Promise<boolean> {
    const e = this.getEnv();
    if (!e.LanguageModel || !e.Translator) {
      this.reason = 'в этом браузере нет встроенного ИИ Chrome (Prompt API / Translator)';
      return false;
    }
    try {
      const a = await e.LanguageModel.availability({ expectedInputs: [{ type: 'audio' }], expectedOutputs: [{ type: 'text', languages: ['en'] }] });
      if (a !== 'available') {
        this.reason = `распознавание речи Chrome недоступно (${a})`;
        return false;
      }
    } catch {
      this.reason = 'распознавание речи Chrome недоступно';
      return false;
    }
    return true;
  }

  private getSession(): NonNullable<ChromeAudioChunkSource['session']> {
    this.session ??= this.getEnv().LanguageModel!.create({
      expectedInputs: [{ type: 'audio' }, { type: 'text', languages: ['en'] }],
      expectedOutputs: [{ type: 'text', languages: ['en'] }],
    });
    this.session.catch(() => (this.session = undefined));
    return this.session;
  }

  async transcribe(chunk: AudioChunk, signal: AbortSignal): Promise<SubtitleCue[]> {
    const pcm = resampleInt16(chunk.pcm, chunk.sampleRate, 16000);
    const wav = encodeWav(pcm, 16000);
    const s = await this.getSession();
    const raw = await s.prompt(
      [{ role: 'user', content: [{ type: 'text', value: 'Transcribe the speech in this audio verbatim, in its original language. Output only the transcript. If there is no speech, output exactly NO_SPEECH.' }, { type: 'audio', value: new Blob([wav as BlobPart], { type: 'audio/wav' }) }] }],
      { signal },
    );
    const text = (raw ?? '').trim();
    if (!text || /^NO_SPEECH\b/i.test(text)) return [];
    const lang = (await detectLanguage(text, this.getEnv())) ?? 'en';
    const parts = spreadSentences(splitSentences(text), chunk.startSec, chunk.startSec + chunk.durationSec);
    if (lang === 'ru') return parts.map((p) => ({ ...p }));
    if (!PROMPT_AUDIO_LANGS.includes(lang) && lang !== 'en') diag.log('subs-chromeai-lang', { lang });
    if (!(await this.translator.isAvailable(lang))) throw new SubtitleUnavailable(`локальный переводчик Chrome не поддерживает язык «${lang}»`);
    const out: SubtitleCue[] = [];
    for (const p of parts) {
      if (signal.aborted) throw new DOMException('aborted', 'AbortError');
      const ru = (await this.translator.translateText(p.text, lang)).trim();
      if (ru) out.push({ start: p.start, end: p.end, src: p.text, text: ru });
    }
    return out;
  }
}
