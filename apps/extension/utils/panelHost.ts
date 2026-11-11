import { checkYandexToken, createRemoteCache, listModels, type CacheMessage, type CacheReply, type SettingsPanelHost, type TranslateStatus, type VoiceStatus } from '@nvt/core';
import { browser } from 'wxt/browser';
import { createLocalModelPanelHost } from './localModelPanelHost';
import { createSwTransport, transportFetch } from './swTransport';
import { loadSettings, loadYandexAuth, saveSettings, VOICE_STATUS_KEY, YANDEX_LOGIN_ERROR_KEY } from './settings';
import { NVT_VERSION } from './version';
import { UPDATE_STATE_KEY, updateFromState, isReleasePageUrl, isKeyPageUrl, type UpdateCheckResult, type UpdateState } from '@nvt/core';

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
    async getUpdate() {
      const got = await browser.storage.local.get(UPDATE_STATE_KEY);
      return updateFromState(got[UPDATE_STATE_KEY] as UpdateState | undefined, NVT_VERSION);
    },
    // the background runs the GET (it owns the alarm and the storage write)
    async checkUpdateNow() {
      return ((await browser.runtime.sendMessage({ type: 'nvt-update-check' })) ?? { update: null, failed: true }) as UpdateCheckResult;
    },
    async openUpdatePage(url: string) {
      if (!isReleasePageUrl(url)) return;
      const r = (await browser.runtime.sendMessage({ type: 'nvt-update-open', url })) as { ok?: boolean } | undefined;
      if (!r?.ok) throw new Error('release page refused');
    },
    async openKeyPage(url: string) {
      if (!isKeyPageUrl(url)) return;
      const r = (await browser.runtime.sendMessage({ type: 'nvt-open-key-page', url })) as { ok?: boolean } | undefined;
      if (!r?.ok) throw new Error('key page refused');
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
    ...createLocalModelPanelHost({
      storage: browser.storage.local,
      send: (type, op, extra) => browser.runtime.sendMessage({ type, to: 'bg', op, ...extra }),
      async clearModels() {
        const r = (await browser.runtime.sendMessage({ type: 'nvt-clear-models' })) as { freedBytes?: number } | undefined;
        if (!r || typeof r.freedBytes !== 'number' || r.freedBytes < 0) throw new Error('clear failed');
        return { freedBytes: r.freedBytes };
      },
    }),
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
