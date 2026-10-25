/**
 * Chrome Translator language packs: availability of a source->target pair and a user-gesture download with progress.
 * Translator.create() needs transient user activation when the pair is 'downloadable', so downloadPair() must be called from a
 * click handler of the panel. Works in the page and in extension pages (the API is a window global in both).
 */
import type { ChromeAiEnv } from '../subtitles/chromeAi';

export type PairAvailability = 'available' | 'downloadable' | 'downloading' | 'unavailable' | 'absent';

const envOf = (): ChromeAiEnv => globalThis as unknown as ChromeAiEnv;

export async function pairAvailability(src: string, tgt = 'ru', e: ChromeAiEnv = envOf()): Promise<PairAvailability> {
  if (!e.Translator) return 'absent';
  try {
    const a = await e.Translator.availability({ sourceLanguage: src, targetLanguage: tgt });
    return a === 'available' || a === 'downloadable' || a === 'downloading' ? a : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

/** Russian words for the panel row */
export const PAIR_TEXT: Record<PairAvailability, string> = {
  available: 'готов',
  downloadable: 'нужно скачать языковой пакет',
  downloading: 'языковой пакет скачивается…',
  unavailable: 'эта пара языков недоступна в Chrome',
  absent: 'в этом браузере нет встроенного переводчика Chrome',
};

/**
 * Creates the Translator (which downloads the pack) and reports 0..1 progress. Call from a click. Resolves when the pack is
 * usable; throws with the browser's message otherwise. The created translator is destroyed (the pack stays in the browser).
 */
export async function downloadPair(src: string, tgt: string, onProgress?: (fraction: number) => void, e: ChromeAiEnv = envOf()): Promise<void> {
  if (!e.Translator) throw new Error('Translator API отсутствует');
  const t = await e.Translator.create({
    sourceLanguage: src,
    targetLanguage: tgt,
    monitor(m) {
      m.addEventListener('downloadprogress', (ev) => onProgress?.(Math.max(0, Math.min(1, ev.loaded))));
    },
  });
  onProgress?.(1);
  t.destroy?.();
}
