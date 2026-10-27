import { normalizeSettings, type Settings } from '@nvt/core';
import { gmGet, gmOnChange, gmSet } from './gm';

/** Same keys and shapes as the extension's chrome.storage.local, on GM_getValue / GM_setValue. */
export const SETTINGS_KEY = 'nvt.settings';
export const YANDEX_AUTH_KEY = 'nvt.yandexAuth';
export const OAUTH_PENDING_KEY = 'nvt.oauthPending';
export const YANDEX_LOGIN_ERROR_KEY = 'nvt.yandexLoginError';
export const VOICE_STATUS_KEY = 'nvt.voiceStatus';
/** set once the stored dubLagSec 2 (old default) was moved to 1 */
const DUB_LAG_KEY = 'nvt.dubLag1';
/** set once the Gemini tier was switched off for the stored settings (0.3.0: Gemini is off by default, mirrors the extension) */
const GEMINI_OFF_KEY = 'nvt.geminiOffByDefault';
/** set once the subtitle transparency defaults moved to text 20% / background 25% (0.3.9, mirrors the extension) */
const SUB_DEFAULTS_KEY = 'nvt.subStyleDefaults39';

/** set once the autoTranslate default was moved to 'on' for the stored settings (mirrors the extension) */
const AUTO_DEFAULT_KEY = 'nvt.autoTranslateOnByDefault';
/** set once the stored liveDelaySec 0 (old default) was moved to -1 = auto */
const LIVE_AUTO_KEY = 'nvt.liveDelayAuto';

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
  if (gmGet(AUTO_DEFAULT_KEY) !== true) {
    s.autoTranslate = 'on';
    gmSet(SETTINGS_KEY, normalizeSettings(s));
    gmSet(AUTO_DEFAULT_KEY, true);
  }
  if (gmGet(LIVE_AUTO_KEY) !== true) {
    if (s.liveDelaySec === 0) {
      s.liveDelaySec = -1;
      gmSet(SETTINGS_KEY, normalizeSettings(s));
    }
    gmSet(LIVE_AUTO_KEY, true);
  }
  if (gmGet(DUB_LAG_KEY) !== true) {
    // one-time: the old default dubLagSec 2 becomes the new default 1
    if (s.dubLagSec === 2) {
      s.dubLagSec = 1;
      gmSet(SETTINGS_KEY, normalizeSettings(s));
    }
    gmSet(DUB_LAG_KEY, true);
  }
  if (gmGet(GEMINI_OFF_KEY) !== true) {
    // one-time: profiles saved while Gemini was on by default keep it on; 0.3.0 makes it off by default (the user turns it on by hand)
    s.voiceEnabled = { ...s.voiceEnabled, gemini: false };
    gmSet(SETTINGS_KEY, normalizeSettings(s));
    gmSet(GEMINI_OFF_KEY, true);
  }
  if (gmGet(SUB_DEFAULTS_KEY) !== true) {
    // one-time: untouched transparency (the old defaults 0 / 45) moves to the new defaults; a changed value stays
    const st = s.subStyle;
    if (st.textTransparency === 0 && st.bgTransparency === 45) {
      s.subStyle = { ...st, textTransparency: 20, bgTransparency: 25 };
    }
    gmSet(SETTINGS_KEY, normalizeSettings(s));
    gmSet(SUB_DEFAULTS_KEY, true);
  }
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
