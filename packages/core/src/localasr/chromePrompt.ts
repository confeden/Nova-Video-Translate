import { encodeWav } from '../providers/gemini/translate';
import type { LocalAsr, LocalAsrOptions, LocalAsrResult } from './types';

/** Chrome Prompt API (Gemini Nano) with audio input. English only; ~0.3-0.5x realtime when warm (kb/chrome-lab.md). */
interface PromptSession {
  prompt(input: unknown, opts?: { signal?: AbortSignal }): Promise<string>;
  clone?(opts?: { signal?: AbortSignal }): Promise<PromptSession>;
  destroy?(): void;
}
export interface PromptApiEnv {
  LanguageModel?: {
    availability(o?: unknown): Promise<string>;
    create(o?: unknown): Promise<PromptSession>;
  };
}

const OPTS = {
  expectedInputs: [{ type: 'audio' }, { type: 'text', languages: ['en'] }],
  expectedOutputs: [{ type: 'text', languages: ['en'] }],
};
const PROMPT = 'Transcribe the speech in this audio verbatim. Output only the transcript. If there is no speech, output exactly NO_SPEECH.';

/** splits a transcript into sentences and spreads them over the clip proportionally to their length */
function spread(text: string, durationSec: number): LocalAsrResult['segments'] {
  const parts = text.replace(/\s+/g, ' ').trim().match(/[^.!?…]+[.!?…]*\s*/g)?.map((p) => p.trim()).filter(Boolean) ?? [];
  const total = parts.reduce((a, p) => a + p.length, 0);
  if (total === 0) return [];
  let t = 0;
  return parts.map((p) => {
    const d = (durationSec * p.length) / total;
    const s = { start: t, end: t + d, text: p };
    t += d;
    return s;
  });
}

export class ChromePromptAudioAsr implements LocalAsr {
  readonly id = 'chrome-prompt-audio' as const;
  private base?: Promise<PromptSession>;

  constructor(private readonly getEnv: () => PromptApiEnv = () => globalThis as unknown as PromptApiEnv) {}

  languages(): readonly string[] {
    return ['en'];
  }

  async isAvailable(): Promise<boolean> {
    const lm = this.getEnv().LanguageModel;
    if (!lm) return false;
    try {
      return (await lm.availability(OPTS)) === 'available';
    } catch {
      return false;
    }
  }

  /** the long-lived base session is created once (50-117 s cold!) and only ever cloned: a clean clone per chunk keeps RTF low */
  private baseSession(): Promise<PromptSession> {
    this.base ??= this.getEnv().LanguageModel!.create(OPTS);
    this.base.catch(() => (this.base = undefined));
    return this.base;
  }

  async transcribe(pcm16k: Int16Array, opts: LocalAsrOptions = {}): Promise<LocalAsrResult> {
    const base = await this.baseSession();
    const session = base.clone ? await base.clone({ signal: opts.signal }) : base;
    try {
      const wav = encodeWav(pcm16k, 16000);
      const audio = new Blob([wav as BlobPart], { type: 'audio/wav' });
      const raw = await session.prompt(
        [{ role: 'user', content: [{ type: 'text', value: PROMPT }, { type: 'audio', value: audio }] }],
        { signal: opts.signal },
      );
      const text = (raw ?? '').trim();
      if (!text || /^NO_SPEECH\b/i.test(text)) return { segments: [], lang: 'en' };
      return { segments: spread(text, pcm16k.length / 16000), lang: 'en' };
    } finally {
      if (session !== base) session.destroy?.();
    }
  }

  dispose(): void {
    void this.base?.then((s) => s.destroy?.(), () => undefined);
    this.base = undefined;
  }
}
