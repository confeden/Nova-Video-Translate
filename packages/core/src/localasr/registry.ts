import type { LocalAsr, LocalAsrEngineId } from './types';

/** Default preference: the helper (fastest, GPU), WASM Whisper, then Chrome's Prompt API (needs a 4 GB model, English only). */
export const DEFAULT_LOCAL_ASR_ORDER: LocalAsrEngineId[] = ['helper-faster-whisper', 'whisper-wasm', 'chrome-prompt-audio'];

export class LocalAsrRegistry {
  private readonly engines = new Map<LocalAsrEngineId, LocalAsr>();

  register(engine: LocalAsr): () => void {
    this.engines.set(engine.id, engine);
    return () => {
      if (this.engines.get(engine.id) === engine) this.engines.delete(engine.id);
    };
  }

  get(id: LocalAsrEngineId): LocalAsr | undefined {
    return this.engines.get(id);
  }

  list(): LocalAsr[] {
    return [...this.engines.values()];
  }

  clear(): void {
    this.engines.clear();
  }

  /** first available engine of `order` that can recognise `lang` (omitted = any) */
  async pick(order: readonly LocalAsrEngineId[] = DEFAULT_LOCAL_ASR_ORDER, lang?: string): Promise<LocalAsr | undefined> {
    for (const id of order) {
      const e = this.engines.get(id);
      if (!e) continue;
      if (lang) {
        const langs = e.languages();
        if (!langs.includes('*') && !langs.includes(lang.toLowerCase().split('-')[0]!)) continue;
      }
      try {
        if (await e.isAvailable()) return e;
      } catch {
        /* unavailable */
      }
    }
    return undefined;
  }
}

export const localAsrRegistry = new LocalAsrRegistry();
