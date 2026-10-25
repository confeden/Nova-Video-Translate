import { checkYandexToken, listModels, mountSettingsPanel, transportFetch, type ResultCache, type SettingsPanelHost, type Transport, type VoiceStatus } from '@nvt/core';
import { oauthBegin } from './oauth';
import { gmGet } from './gm';
import { VOICE_STATUS_KEY, YANDEX_LOGIN_ERROR_KEY, loadSettings, loadYandexAuth, saveSettings, saveYandexAuth } from './storage';

import { NVT_VERSION } from './version';
import { runUpdateCheck } from './updateCheck';
import { UPDATE_STATE_KEY, isReleasePageUrl, updateFromState, type UpdateState } from '@nvt/core';

/** Storage + account part of the settings panel (GM storage); the page runtime adds the translate / diagnostics parts. */
export function createSettingsHost(transport: Transport, cache?: ResultCache): SettingsPanelHost {
  const fetchGm = transportFetch(transport);
  const host: SettingsPanelHost = {
    version: NVT_VERSION,
    cacheStats: cache ? () => cache.stats() : undefined,
    cacheClear: cache ? () => cache.clear() : undefined,
    getSettings: async () => loadSettings(),
    saveSettings: async (patch) => saveSettings(patch),
    listGeminiModels: (key) => listModels(fetchGm, key),
    async getYandexAccount() {
      const a = loadYandexAuth();
      return a ? { login: a.login, expiresAt: a.expiresAt } : null;
    },
    async yandexCheck() {
      const a = loadYandexAuth();
      if (!a) return { ok: false, kind: 'rejected', message: 'Вы не вошли в Яндекс' };
      return checkYandexToken(a.token, transport);
    },
    async getUpdate() {
      return updateFromState(gmGet(UPDATE_STATE_KEY) as UpdateState | undefined, NVT_VERSION);
    },
    checkUpdateNow: () => runUpdateCheck(true),
    async openUpdatePage(url: string) {
      if (isReleasePageUrl(url)) window.open(url, '_blank', 'noopener');
    },
    async getYandexLoginError() {
      return (gmGet(YANDEX_LOGIN_ERROR_KEY) as { message?: string } | null | undefined)?.message;
    },
    async getVoiceStatus() {
      return (gmGet(VOICE_STATUS_KEY) ?? {}) as VoiceStatus;
    },
    async yandexLogin() {
      const url = await oauthBegin();
      window.open(url, '_blank', 'noopener');
    },
    async yandexLogout() {
      saveYandexAuth(null);
    },
  };
  return host;
}
