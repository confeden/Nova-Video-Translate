import { LASR_ENV_KEY, LASR_MSG, LTTS_ENV_KEY, LTTS_MSG, WHISPER_MODELS, VOICE_CALIB_STORAGE_KEY, allUnits, lasrStateKey, unitStateKey, type LasrEnv, type LasrState, type LocalAsrPanelInfo, type LocalTtsEngineId, type LocalTtsPanelInfo, type LocalTtsTestResult, type LttsEnv, type LttsState, type SettingsPanelHost } from '@nvt/core';

export interface LocalModelPanelPlatform {
  storage: { get(keys: string | string[]): Promise<Record<string, unknown>> };
  send(type: string, op: string, extra?: Record<string, unknown>): Promise<unknown>;
  clearModels(): Promise<{ freedBytes: number }>;
}

type LocalModelPanelHost = Pick<SettingsPanelHost,
  'getLocalAsrInfo' | 'localAsrDownload' | 'localAsrUpgrade' | 'localAsrCancel' | 'localAsrDelete' |
  'getLocalTtsInfo' | 'clearLocalModels' | 'localTtsDownload' | 'localTtsCancel' | 'localTtsDelete' | 'localTtsTest'>;

/** Shared model controls; persistence and message transport belong to the host platform. */
export function createLocalModelPanelHost(platform: LocalModelPanelPlatform): LocalModelPanelHost {
  let lttsProbed = false;
  let lttsProbeAt = 0;
  const lttsSend = (op: string, extra: Record<string, unknown> = {}): Promise<unknown> => platform.send(LTTS_MSG, op, extra);

  let lasrProbed = false;
  let lasrProbeAt = 0;
  const lasrSend = (op: string, extra: Record<string, unknown> = {}): Promise<unknown> => platform.send(LASR_MSG, op, extra);

  async function checkedModelAction(reply: Promise<unknown>): Promise<void> {
    const r = await reply as { ok?: boolean; error?: string } | undefined;
    if (!r?.ok) throw new Error(r?.error ?? 'локальный движок не ответил');
  }

  /** Local-ASR (Whisper) block state: storage is read directly; the worker is asked for the first WebGPU probe and for stale downloads. */
  async function getLocalAsrInfo(): Promise<LocalAsrPanelInfo | null> {
    const keys = [LASR_ENV_KEY, ...WHISPER_MODELS.map((m) => lasrStateKey(m.id))];
    let got = await platform.storage.get(keys);
    let env = got[LASR_ENV_KEY] as LasrEnv | undefined;
    const stale = WHISPER_MODELS.some((m) => {
      const st = got[lasrStateKey(m.id)] as LasrState | undefined;
      return st?.model === 'downloading' && Date.now() - st.updatedAt > 10_000;
    });
    if (!lasrProbed || !env || env.gpu === undefined || stale || (env.gpu === false && Date.now() - lasrProbeAt > 30_000)) {
      lasrProbed = true;
      lasrProbeAt = Date.now();
      await lasrSend('status', { probe: true }).catch(() => undefined);
      got = await platform.storage.get(keys);
      env = got[LASR_ENV_KEY] as LasrEnv | undefined;
    }
    return { env: env ?? {}, units: Object.fromEntries(WHISPER_MODELS.map((m) => [m.id, got[lasrStateKey(m.id)] as LasrState | undefined])) };
  }

  /** Local-TTS block state: storage is read directly; the worker is asked for the first probe (WebGPU) and for stale downloads. */
  async function getLocalTtsInfo(): Promise<LocalTtsPanelInfo | null> {
    const units = allUnits();
    const keys = [LTTS_ENV_KEY, VOICE_CALIB_STORAGE_KEY, ...units.map((u) => unitStateKey(u.id))];
    let got = await platform.storage.get(keys);
    let env = got[LTTS_ENV_KEY] as LttsEnv | undefined;
    const stale = units.some((u) => {
      const st = got[unitStateKey(u.id)] as LttsState | undefined;
      return st?.model === 'downloading' && Date.now() - st.updatedAt > 10_000;
    });
    if (!lttsProbed || !env || env.gpu === undefined || stale || (env.gpu === false && Date.now() - lttsProbeAt > 30_000)) {
      lttsProbed = true;
      lttsProbeAt = Date.now();
      await lttsSend('status', { probe: true }).catch(() => undefined);
      got = await platform.storage.get(keys);
      env = got[LTTS_ENV_KEY] as LttsEnv | undefined;
    }
    const calib = got[VOICE_CALIB_STORAGE_KEY] as Record<string, { f0: Record<string, number> }> | undefined;
    return { env: env ?? {}, units: Object.fromEntries(units.map((u) => [u.id, got[unitStateKey(u.id)] as LttsState | undefined])), ...(calib ? { calib } : {}) };
  }

  return {
    getLocalAsrInfo,
    // user click only: a model is never downloaded silently
    async localAsrDownload(model: string) {
      await checkedModelAction(lasrSend('download', { model }));
    },
    async localAsrUpgrade(model: string) {
      await checkedModelAction(lasrSend('download', { model, dtype: 'gpu-mixed' }));
    },
    async localAsrCancel(model: string) {
      await checkedModelAction(lasrSend('download-cancel', { model }));
    },
    async localAsrDelete(model: string) {
      await checkedModelAction(lasrSend('delete', { model }));
    },
    getLocalTtsInfo,
    clearLocalModels: () => platform.clearModels(),
    // user click only: a model is never downloaded silently
    async localTtsDownload(engine: LocalTtsEngineId, voice: string) {
      await checkedModelAction(lttsSend('download', { engine, voice }));
    },
    async localTtsCancel(engine: LocalTtsEngineId, voice: string) {
      await checkedModelAction(lttsSend('download-cancel', { engine, voice }));
    },
    async localTtsDelete(engine: LocalTtsEngineId, voice: string) {
      await checkedModelAction(lttsSend('delete', { engine, voice }));
    },
    async localTtsTest(engine: LocalTtsEngineId, voice: string, text: string): Promise<LocalTtsTestResult> {
      const r = (await lttsSend('synth', { id: `test${Date.now().toString(36)}`, engine, voice, text })) as ({ ok: true } & LocalTtsTestResult) | { ok: false; error: string } | undefined;
      if (!r || !r.ok) throw new Error(r && 'error' in r ? r.error : 'локальный движок не ответил');
      return r;
    },
  };
}
