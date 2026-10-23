import { LOCAL_TTS_ENGINE_IDS, createRemoteEngine, localTtsRegistry, resolveVoice, type LocalTtsEngineId, type RemoteEngine, type Settings } from '@nvt/core';

/**
 * The in-browser LocalTtsEngines for extension contexts (content script, options page): thin clients that talk to the service
 * worker, which owns the offscreen document; nothing is loaded or downloaded until the pipeline calls synth()/warmUp().
 * Engines are singletons per context; the registry picks by the user's setting (localTtsEngine / localTtsVoice).
 */
const engines = new Map<LocalTtsEngineId, RemoteEngine>();

export function extensionLocalTtsEngine(id: LocalTtsEngineId): RemoteEngine {
  let e = engines.get(id);
  if (!e) engines.set(id, (e = createRemoteEngine(id)));
  return e;
}

/** kept for the existing callers: the Supertonic WebGPU engine */
export const createExtensionSupertonicEngine = (): RemoteEngine => extensionLocalTtsEngine('supertonic-webgpu');

/**
 * Registers every in-browser engine and wires the registry to the user's choice. Returns a handle that loads + warms up the
 * engine the registry would pick right now (a no-op when nothing is downloaded).
 */
export function registerExtensionLocalTts(getSettings: () => Settings): { warmUp(): Promise<void> } {
  for (const id of LOCAL_TTS_ENGINE_IDS) localTtsRegistry.register(extensionLocalTtsEngine(id));
  localTtsRegistry.setPreference(() => {
    const s = getSettings();
    return { engine: s.localTtsEngine, voice: s.localTtsVoice };
  });
  return {
    async warmUp() {
      try {
        const picked = await localTtsRegistry.pick();
        const e = picked && engines.get(picked.id);
        if (!e) return;
        const pref = localTtsRegistry.preference();
        await e.warmUp(pref?.voice ? resolveVoice(e.id, pref.voice) : undefined);
      } catch {
        /* warm-up is best effort */
      }
    },
  };
}
