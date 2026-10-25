import { LOCAL_TTS_ENGINE_IDS, VOICE_CALIB_STORAGE_KEY, createRemoteEngine, localTtsRegistry, resolveVoice, type LocalTtsEngineId, type RemoteEngine, type Settings, type VoiceCalibration } from '@nvt/core';

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
  // voice calibration (adult-sounding male / female voice by f0) is cached between sessions, keyed by engine + pinned model revision
  localTtsRegistry.setCalibrationStore({
    async get(key) {
      const got = await browser.storage.local.get(VOICE_CALIB_STORAGE_KEY);
      const all = got[VOICE_CALIB_STORAGE_KEY] as Record<string, VoiceCalibration> | undefined;
      return all?.[key];
    },
    async set(key, value) {
      const got = await browser.storage.local.get(VOICE_CALIB_STORAGE_KEY);
      await browser.storage.local.set({ [VOICE_CALIB_STORAGE_KEY]: { ...((got[VOICE_CALIB_STORAGE_KEY] as Record<string, VoiceCalibration> | undefined) ?? {}), [key]: value } });
    },
  });
  localTtsRegistry.setPreference(() => {
    const s = getSettings();
    return { engine: s.localTtsEngine, voice: s.localTtsVoice, voiceMale: s.localTtsVoiceMale, voiceFemale: s.localTtsVoiceFemale };
  });
  return {
    async warmUp() {
      try {
        const picked = await localTtsRegistry.pick();
        const e = picked && engines.get(picked.id);
        if (!e) return;
        const pref = localTtsRegistry.preference();
        await e.warmUp(pref?.voice ? resolveVoice(e.id, pref.voice) : undefined);
        void localTtsRegistry.calibrate(e.id); // background, once per engine revision
      } catch {
        /* warm-up is best effort */
      }
    },
  };
}
