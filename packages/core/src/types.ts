import type { LocalTtsChoice } from './localtts/catalog';
import type { ProviderId } from './providers/types';

export interface GeminiModels {
  /** Empty string = resolved at runtime from the model registry (ListModels + preferences). */
  translate: string;
  tts: string;
  live: string;
}

export interface GroqModels {
  /** speech recognition (whisper-class) */
  asr: string;
  /** chat model used for the en->ru text translation when Chrome's Translator is absent */
  chat: string;
}

export interface Settings {
  targetLang: 'ru';
  /** Volume applied to the original video audio while translation plays (0..1). */
  originalVolume: number;
  /** Volume of the translated voice-over (0..1). */
  translationVolume: number;
  subtitles: 'off' | 'on';
  /** Voice source priority (D15), highest first. */
  voiceOrder: ProviderId[];
  /** per-source switch; a missing id counts as enabled */
  voiceEnabled: Partial<Record<ProviderId, boolean>>;
  geminiKeys: string[];
  geminiModels: GeminiModels;
  /** Groq model overrides (I2: no hardcoded ids in product logic); empty = resolved from Groq's model list with preferences. */
  groqModels: GroqModels;
  /** Groq API key (optional, for fast speech recognition). Stored and trimmed like the Gemini keys; never logged. */
  groqApiKey: string;
  /** Yandex OAuth token of the user's own account (D12); needed by 'yandex-live'. */
  yandexToken?: string;
  autoTranslate: 'off' | 'on';
  /** What a click on the in-player NVT button does: open the settings panel or start/stop translation at once. */
  clickAction: 'settings' | 'toggle';
  /**
   * Start-up UX: 'on' = pause the video at start until the first dub covering the playhead is ready (resumed only if we
   * paused it and the user has not touched it); 'off' = the original plays at full volume until the dub joins.
   */
  prerollPause: 'off' | 'on';
  /** 'on' (default): a video detected as Russian is not translated (a second click within 10 s forces it). */
  skipRussian: 'on' | 'off';
  /** true (default): a YouTube video that already has a Russian audio track is switched to it instead of being translated (D28). */
  preferNativeDub: boolean;
  /** false (default): a chunk cell that is not complete is sent as a partial piece once it has been quiet for a while.
   *  true: a cell is held until playback has passed its end, so the rest of its audio can still arrive (later voice, fewer cut phrases). */
  holdCellsToEnd: boolean;
  /** Spoken language of the videos: 'auto' = detect (language gate), else an ISO code that bypasses the gate and is passed to providers. */
  sourceLang: string;
  /** Target length (seconds) of the audio chunks handed to providers. */
  chunkSec: number;
  /** Local result cache (Gemini output is expensive: TTS quota is the first to run out). */
  cacheEnabled: boolean;
  /** Retention in days (1..30). */
  cacheDays: number;
  /** Size cap in megabytes; oldest entries are evicted first. */
  cacheMaxMB: number;
  /** Local voice engine for the 'groq' / 'local' tiers: 'auto' = best available by the registry order. */
  localTtsEngine: LocalTtsChoice;
  /** Voice id of the chosen engine; '' = the engine's default. */
  localTtsVoice: string;
  /** Providers whose output is cached (Yandex is cached server-side by Yandex). */
  cacheProviders: ProviderId[];
}

export const DEFAULT_SETTINGS: Settings = {
  targetLang: 'ru',
  originalVolume: 0.3,
  translationVolume: 1.0,
  subtitles: 'off',
  // D30: Gemini stays in the code but is OFF by default and last
  voiceOrder: ['yandex-live', 'yandex', 'local', 'groq', 'gemini'],
  voiceEnabled: { 'yandex-live': true, yandex: true, groq: true, local: true, gemini: false },
  geminiKeys: [],
  geminiModels: { translate: '', tts: '', live: '' },
  groqModels: { asr: '', chat: '' },
  groqApiKey: '',
  autoTranslate: 'on',
  clickAction: 'settings',
  prerollPause: 'off',
  skipRussian: 'on',
  preferNativeDub: true,
  holdCellsToEnd: false,
  sourceLang: 'auto',
  chunkSec: 15,
  cacheEnabled: true,
  cacheDays: 7,
  cacheMaxMB: 300,
  cacheProviders: ['gemini', 'groq', 'local'],
  localTtsEngine: 'auto',
  localTtsVoice: '',
};

/** One timed piece of source speech and its translation. Times are in seconds. */
export interface Segment {
  start: number;
  end: number;
  src: string;
  ru: string;
}

export interface TranslateContext {
  text: string;
  targetLang: Settings['targetLang'];
  signal?: AbortSignal;
}

/** A translation backend. Resolves with the translated text. */
export interface Provider {
  name: string;
  translate(ctx: TranslateContext): Promise<string>;
}
