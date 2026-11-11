import { LASR_ENV_KEY, LASR_MSG, LOCAL_TTS_ENGINE_IDS, LTTS_ENV_KEY, LTTS_MSG, VOICE_CALIB_STORAGE_KEY, createRemoteEngine, diag, lasrStateKey, localTtsRegistry, resolveVoice, unitStateKey, type LasrEnv, type LasrState, type LasrTransport, type LttsEnv, type LttsState, type LttsTransport, type Settings, type VoiceCalibration } from '@nvt/core';
import { handleLocalAsrMessage } from '../../extension/utils/localasr/background';
import { releaseLocalAsrRuntime, startLocalAsrRuntime } from '../../extension/utils/localasr/offscreenRuntime';
import { clearAllLocalModels, handleLocalTtsMessage } from '../../extension/utils/localtts/background';
import { releaseLocalTtsRuntime, startOffscreenRuntime } from '../../extension/utils/localtts/offscreenRuntime';
import { createLocalModelPanelHost } from '../../extension/utils/localModelPanelHost';
import { configureLocalRuntimeHost, type LocalRuntimeHost } from '../../extension/utils/localRuntimeHost';
import { gmDelete, gmGet, gmResourceText, gmSet } from './gm';
import { NVT_VERSION } from './version';
import { createGmFetch } from './gmFetch';
import { RUNTIME_RESOURCES } from './runtimeResources';

const ORT_BASE = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/';
const HF_BASE = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.6/dist/';
const PIPER_BASE = 'https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/';
/** Installed by the tiny @require; the bundler must leave native module loading in the sandbox. */
declare const NVT_importModule: (url: string) => Promise<unknown>;

/** Bytes live in this site's OPFS/Cache API, so their metadata must not leak into another site's readiness. */
export function createOriginModelStorage(origin: string) {
  const keyFor = (key: string): string => `nvt.models.${encodeURIComponent(origin)}.${key}`;
  return {
    async get(keys: string | string[]): Promise<Record<string, unknown>> {
      return Object.fromEntries((typeof keys === 'string' ? [keys] : keys).map((key) => [key, gmGet(keyFor(key))]));
    },
    async set(values: Record<string, unknown>): Promise<void> {
      for (const [key, value] of Object.entries(values)) gmSet(keyFor(key), value);
    },
    async remove(keys: string | string[]): Promise<void> {
      for (const key of typeof keys === 'string' ? [keys] : keys) gmDelete(keyFor(key));
    },
  };
}

/** Resource code is pinned in the userscript header and executes in the sandbox, never in the page. */
const moduleUrls = new Map<string, string>();
function resourceModule(name: string): string {
  let url = moduleUrls.get(name);
  if (!url) {
    let source = name === 'piperModule' ? `${gmResourceText('piperJs')}\nexport default createPiperPhonemize;` : gmResourceText(name);
    if (!source) throw new Error(`missing userscript resource ${name}; reinstall NVT`);
    const originalUrl = RUNTIME_RESOURCES[name as keyof typeof RUNTIME_RESOURCES];
    // Emscripten resolves a fallback WASM URL even when wasmBinary is supplied. Relative URLs cannot use a blob: base.
    if (originalUrl) source = source.replace(/\bimport\.meta\.url\b/g, JSON.stringify(originalUrl));
    url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    moduleUrls.set(name, url);
  }
  return url;
}

export function createUserscriptLocalModels() {
  const storage = createOriginModelStorage(location.origin);
  const listeners: Parameters<LocalRuntimeHost['runtime']['onMessage']['addListener']>[0][] = [];
  const privilegedFetch = createGmFetch();
  const binary = async (url: string): Promise<ArrayBuffer> => {
    const response = await privilegedFetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`runtime download HTTP ${response.status}`);
    return response.arrayBuffer();
  };
  const id = 'nvt-userscript';
  const runtimeUrl = `${location.origin}/__nvt_runtime__/`;
  let started = false;
  const host: LocalRuntimeHost = {
    storage: { local: storage },
    runtime: {
      id,
      getManifest: () => ({ version: NVT_VERSION }),
      getURL: (path) => path === '/ort/' ? ORT_BASE : path === '/ort-hf/' ? HF_BASE : path === '/piper/' ? PIPER_BASE : `${runtimeUrl}${path.replace(/^\//, '')}`,
      getContexts: async () => started ? [{}] : [],
      onMessage: { addListener: (listener) => { listeners.push(listener); } },
      async sendMessage(raw) {
        const msg = raw as { type?: string; to?: string; op?: string };
        const sender = { id, url: msg.op === 'event' ? `${runtimeUrl}offscreen.html` : location.href };
        return new Promise((resolve, reject) => {
          let answered = false;
          const respond = (reply: unknown): void => { answered = true; resolve(reply); };
          try {
            let pending = false;
            if (msg.to === 'bg') {
              pending = handleLocalTtsMessage(raw, sender, respond) || handleLocalAsrMessage(raw, sender, respond);
            } else if (msg.to === 'offscreen') {
              for (const listener of listeners) pending = listener(raw, sender, respond) || pending;
            }
            if (!pending && !answered) resolve(undefined);
          } catch (e) { reject(e); }
        });
      },
    },
    offscreen: {
      async createDocument() {
        if (started) return;
        started = true;
        startOffscreenRuntime();
        startLocalAsrRuntime();
      },
      async closeDocument() {
        await Promise.all([releaseLocalTtsRuntime(), releaseLocalAsrRuntime()]);
      },
    },
    fetch: privilegedFetch,
    async loadOrt() {
      const url = resourceModule('ortBundle');
      const ort = await NVT_importModule(url) as typeof import('onnxruntime-web');
      ort.env.wasm.wasmPaths = { mjs: resourceModule('ortGlue') };
      ort.env.wasm.wasmBinary = await binary(`${ORT_BASE}ort-wasm-simd-threaded.jsep.wasm`);
      ort.env.wasm.numThreads = 1; // sites generally are not cross-origin isolated
      ort.env.wasm.initTimeout = 30_000;
      return ort;
    },
    async loadTransformers() {
      const url = resourceModule('transformersBundle');
      const tf = await NVT_importModule(url) as typeof import('@huggingface/transformers');
      const wasm = tf.env.backends.onnx.wasm!;
      wasm.wasmPaths = { mjs: resourceModule('hfGlue') };
      wasm.wasmBinary = await binary(`${HF_BASE}ort-wasm-simd-threaded.jsep.wasm`);
      wasm.numThreads = 1;
      wasm.proxy = false;
      wasm.initTimeout = 30_000;
      return tf;
    },
    async loadPiper() {
      const url = resourceModule('piperModule');
      const module = await NVT_importModule(url) as { default: (opts: Record<string, unknown>) => Promise<unknown> };
      const wasmBinary = await binary(`${PIPER_BASE}piper_phonemize.wasm`);
      return (opts: Record<string, unknown>) => module.default({ ...opts, wasmBinary });
    },
  };
  if (typeof navigator.storage?.getDirectory !== 'function' || typeof caches === 'undefined' || !globalThis.crypto?.subtle) host.offscreen = undefined;
  configureLocalRuntimeHost(host);
  const send = (type: string, op: string, extra: Record<string, unknown> = {}): Promise<unknown> => host.runtime.sendMessage({ type, to: 'bg', op, ...extra });
  const ttsTransport: LttsTransport = {
    send: (op) => send(LTTS_MSG, op.op, op),
    readState: async (unit = 'supertonic') => (await storage.get(unitStateKey(unit)))[unitStateKey(unit)] as LttsState | undefined,
    readEnv: async () => (await storage.get(LTTS_ENV_KEY))[LTTS_ENV_KEY] as LttsEnv | undefined,
  };
  const asrTransport: LasrTransport = {
    send: (op) => send(LASR_MSG, op.op, op),
    readState: async (model) => (await storage.get(lasrStateKey(model)))[lasrStateKey(model)] as LasrState | undefined,
    readEnv: async () => (await storage.get(LASR_ENV_KEY))[LASR_ENV_KEY] as LasrEnv | undefined,
  };
  return {
    asrTransport,
    panelHost: createLocalModelPanelHost({ storage, send, clearModels: clearAllLocalModels }),
    register(getSettings: () => Settings) {
      const engines = new Map(LOCAL_TTS_ENGINE_IDS.map((engine) => [engine, createRemoteEngine(engine, ttsTransport)]));
      for (const engine of engines.values()) localTtsRegistry.register(engine);
      localTtsRegistry.setCalibrationStore({
        async get(key) { return ((await storage.get(VOICE_CALIB_STORAGE_KEY))[VOICE_CALIB_STORAGE_KEY] as Record<string, VoiceCalibration> | undefined)?.[key]; },
        async set(key, value) {
          const all = (await storage.get(VOICE_CALIB_STORAGE_KEY))[VOICE_CALIB_STORAGE_KEY] as Record<string, VoiceCalibration> | undefined;
          await storage.set({ [VOICE_CALIB_STORAGE_KEY]: { ...all, [key]: value } });
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
            const engine = picked && engines.get(picked.id);
            if (!engine) return;
            const voice = localTtsRegistry.preference()?.voice;
            await engine.warmUp(voice ? resolveVoice(engine.id, voice) : undefined);
            void localTtsRegistry.calibrate(engine.id);
          } catch (e) { diag.log('localtts-warm-error', { message: e instanceof Error ? e.message : String(e) }); }
        },
      };
    },
  };
}
