import { LTTS_ENV_KEY, LTTS_MSG, allUnits, checkYandexToken, createRemoteCache, listModels, unitStateKey, type LocalTtsEngineId, type LocalTtsPanelInfo, type LocalTtsTestResult, type LttsEnv, type LttsState, type CacheMessage, type CacheReply, type SettingsPanelHost, type TranslateStatus, type VoiceStatus } from '@nvt/core';
import { browser } from 'wxt/browser';
import { createSwTransport, transportFetch } from './swTransport';
import { loadSettings, loadYandexAuth, saveSettings, VOICE_STATUS_KEY, YANDEX_LOGIN_ERROR_KEY } from './settings';
import { NVT_VERSION } from './version';

let lttsProbed = false;
const lttsSend = (op: string, extra: Record<string, unknown> = {}): Promise<unknown> => browser.runtime.sendMessage({ type: LTTS_MSG, to: 'bg', op, ...extra });

/** Local-TTS block state: storage is read directly; the worker is asked for the first probe (WebGPU) and for stale downloads. */
async function getLocalTtsInfo(): Promise<LocalTtsPanelInfo | null> {
  const units = allUnits();
  const keys = [LTTS_ENV_KEY, ...units.map((u) => unitStateKey(u.id))];
  let got = await browser.storage.local.get(keys);
  let env = got[LTTS_ENV_KEY] as LttsEnv | undefined;
  const stale = units.some((u) => {
    const st = got[unitStateKey(u.id)] as LttsState | undefined;
    return st?.model === 'downloading' && Date.now() - st.updatedAt > 10_000;
  });
  if (!lttsProbed || !env || env.gpu === undefined || stale) {
    lttsProbed = true;
    await lttsSend('status', { probe: true }).catch(() => undefined);
    got = await browser.storage.local.get(keys);
    env = got[LTTS_ENV_KEY] as LttsEnv | undefined;
  }
  return { env: env ?? {}, units: Object.fromEntries(units.map((u) => [u.id, got[unitStateKey(u.id)] as LttsState | undefined])) };
}

/** Storage + account part of the settings panel; usable from the popup, the options page and the content script. */
export function createBaseHost(): SettingsPanelHost {
  const fetchViaSw = transportFetch(createSwTransport());
  const cache = createRemoteCache((m: CacheMessage) => browser.runtime.sendMessage(m) as Promise<CacheReply | undefined>);
  return {
    version: NVT_VERSION,
    cacheStats: () => cache.stats(),
    cacheClear: () => cache.clear(),
    getSettings: loadSettings,
    saveSettings,
    listGeminiModels: (key) => listModels(fetchViaSw, key),
    async getYandexAccount() {
      const a = await loadYandexAuth();
      return a ? { login: a.login, expiresAt: a.expiresAt } : null;
    },
    async yandexCheck() {
      const a = await loadYandexAuth();
      if (!a) return { ok: false, kind: 'rejected', message: 'Вы не вошли в Яндекс' };
      return checkYandexToken(a.token, createSwTransport());
    },
    async getYandexLoginError() {
      const got = await browser.storage.local.get(YANDEX_LOGIN_ERROR_KEY);
      const e = got[YANDEX_LOGIN_ERROR_KEY] as { message?: string } | undefined;
      return typeof e?.message === 'string' ? e.message : undefined;
    },
    async getVoiceStatus() {
      const got = await browser.storage.local.get(VOICE_STATUS_KEY);
      return (got[VOICE_STATUS_KEY] ?? {}) as VoiceStatus;
    },
    async yandexLogin() {
      // the background opens the tab: content scripts have no tabs API
      await browser.runtime.sendMessage({ type: 'nvt-oauth-begin', open: true });
    },
    async yandexLogout() {
      await browser.runtime.sendMessage({ type: 'nvt-oauth-logout' });
    },
    getLocalTtsInfo,
    // user click only: a model is never downloaded silently
    async localTtsDownload(engine: LocalTtsEngineId, voice: string) {
      await lttsSend('download', { engine, voice });
    },
    async localTtsCancel(engine: LocalTtsEngineId, voice: string) {
      await lttsSend('download-cancel', { engine, voice });
    },
    async localTtsDelete(engine: LocalTtsEngineId, voice: string) {
      await lttsSend('delete', { engine, voice });
    },
    async localTtsTest(engine: LocalTtsEngineId, voice: string, text: string): Promise<LocalTtsTestResult> {
      const r = (await lttsSend('synth', { id: `test${Date.now().toString(36)}`, engine, voice, text })) as ({ ok: true } & LocalTtsTestResult) | { ok: false; error: string } | undefined;
      if (!r || !r.ok) throw new Error(r && 'error' in r ? r.error : 'нет ответа от расширения');
      return r;
    },
  };
}

type PanelOp = 'status' | 'toggle' | 'force' | 'diag' | 'diag-clear' | 'test-cue';

/** Asks the content script(s) of the active tab; null when the tab has none (chrome:// pages, no video, ...). */
async function askTab<T>(op: PanelOp, extra: Record<string, unknown> = {}): Promise<T | null> {
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined) return null;
    return ((await browser.tabs.sendMessage(tab.id, { type: 'nvt-panel', op, ...extra })) as T | undefined) ?? null;
  } catch {
    return null;
  }
}

/** Panel host for extension pages (popup / options): translate controls and diagnostics go through the active tab. */
export function createTabHost(): SettingsPanelHost {
  return {
    ...createBaseHost(),
    getTranslateStatus: async () => (await askTab<{ status: TranslateStatus }>('status'))?.status ?? null,
    toggleTranslate: async () => (await askTab<{ status: TranslateStatus }>('toggle'))?.status ?? null,
    forceTranslate: async () => (await askTab<{ status: TranslateStatus }>('force'))?.status ?? null,
    getDiagReport: () => askTab<{ text: string; source?: string }>('diag'),
    clearDiag: async () => void (await askTab('diag-clear')),
    showTestCue: async (text) => !!(await askTab<{ ok: boolean }>('test-cue', { text }))?.ok,
  };
}
