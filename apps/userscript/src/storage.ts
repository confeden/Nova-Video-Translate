import { normalizeSettings, type Settings } from '@nvt/core';
import { gmGet, gmOnChange, gmSet } from './gm';

/** Same keys and shapes as the extension's chrome.storage.local, on GM_getValue / GM_setValue. */
export const SETTINGS_KEY = 'nvt.settings';
export const YANDEX_AUTH_KEY = 'nvt.yandexAuth';
export const OAUTH_PENDING_KEY = 'nvt.oauthPending';
export const YANDEX_LOGIN_ERROR_KEY = 'nvt.yandexLoginError';
export const VOICE_STATUS_KEY = 'nvt.voiceStatus';

export interface YandexAuth {
  token: string;
  /** ms epoch; 0 = unknown */
  expiresAt: number;
  login?: string;
}

export function loadYandexAuth(): YandexAuth | null {
  const a = gmGet(YANDEX_AUTH_KEY) as Partial<YandexAuth> | null | undefined;
  if (!a || typeof a.token !== 'string' || !a.token) return null;
  return { token: a.token, expiresAt: typeof a.expiresAt === 'number' ? a.expiresAt : 0, login: typeof a.login === 'string' ? a.login : undefined };
}

export function saveYandexAuth(a: YandexAuth | null): void {
  gmSet(YANDEX_AUTH_KEY, a);
}

/** Stored settings + defaults + the Yandex token (unless expired); the token itself is not part of SETTINGS_KEY. */
export function loadSettings(): Settings {
  const s = normalizeSettings(gmGet(SETTINGS_KEY));
  const auth = loadYandexAuth();
  if (auth && (auth.expiresAt === 0 || auth.expiresAt > Date.now())) s.yandexToken = auth.token;
  return s;
}

export function saveSettings(patch: Partial<Settings>): void {
  const cur = normalizeSettings(gmGet(SETTINGS_KEY));
  const { yandexToken: _t, ...rest } = patch;
  void _t;
  gmSet(SETTINGS_KEY, normalizeSettings({ ...cur, ...rest }));
}

/** Settings (or login) changed in this tab or another one. */
export function onSettingsChanged(cb: (s: Settings) => void, onAuth?: () => void): void {
  gmOnChange(SETTINGS_KEY, () => cb(loadSettings()));
  gmOnChange(YANDEX_AUTH_KEY, () => {
    cb(loadSettings());
    onAuth?.();
  });
}
