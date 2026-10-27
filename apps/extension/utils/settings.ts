import { normalizeSettings, type Settings } from '@nvt/core';
import { browser } from 'wxt/browser';

export { normalizeSettings };

export const SETTINGS_KEY = 'nvt.settings';
export const YANDEX_AUTH_KEY = 'nvt.yandexAuth';
/** { at, message }: why the last login attempt failed (Russian text, no secrets); removed on success */
export const YANDEX_LOGIN_ERROR_KEY = 'nvt.yandexLoginError';
/** VoiceStatus: latest Yandex-tier attempt + latest voiced chunk (written by content scripts) */
export const VOICE_STATUS_KEY = 'nvt.voiceStatus';

export interface YandexAuth {
  token: string;
  /** ms epoch; 0 = unknown */
  expiresAt: number;
  login?: string;
}

export async function loadYandexAuth(): Promise<YandexAuth | null> {
  const got = await browser.storage.local.get(YANDEX_AUTH_KEY);
  const a = got[YANDEX_AUTH_KEY] as Partial<YandexAuth> | undefined;
  if (!a || typeof a.token !== 'string' || !a.token) return null;
  return { token: a.token, expiresAt: typeof a.expiresAt === 'number' ? a.expiresAt : 0, login: typeof a.login === 'string' ? a.login : undefined };
}

/** set once the autoTranslate default was moved to 'on' for the stored settings (see loadSettings) */
const AUTO_DEFAULT_KEY = 'nvt.autoTranslateOnByDefault';
/** set once the stored liveDelaySec 0 (the old default, 0.2.28) was moved to -1 = auto */
const LIVE_AUTO_KEY = 'nvt.liveDelayAuto';
/** set once the stored dubLagSec 2 (the old default) was moved to 1 (new default for live translation) */
const DUB_LAG_KEY = 'nvt.dubLag1';
/** set once the Gemini tier was switched off for the stored settings (0.3.0: Gemini is off by default, it is very slow) */
const GEMINI_OFF_KEY = 'nvt.geminiOffByDefault';
/** set once the subtitle transparency defaults moved to text 20% / background 25% (0.3.9) */
const SUB_DEFAULTS_KEY = 'nvt.subStyleDefaults39';


/** Full settings: stored values + defaults + the Yandex token (unless expired). The token is not part of SETTINGS_KEY. */
export async function loadSettings(): Promise<Settings> {
  const got = await browser.storage.local.get([SETTINGS_KEY, AUTO_DEFAULT_KEY, LIVE_AUTO_KEY, DUB_LAG_KEY, GEMINI_OFF_KEY, SUB_DEFAULTS_KEY]);
  const s = normalizeSettings(got[SETTINGS_KEY]);
  if (got[AUTO_DEFAULT_KEY] !== true) {
    // one-time: settings saved before the default became 'on' still hold 'off' and would keep auto-translate off
    s.autoTranslate = 'on';
    await browser.storage.local.set({ [SETTINGS_KEY]: normalizeSettings(s), [AUTO_DEFAULT_KEY]: true });
  }
  if (got[LIVE_AUTO_KEY] !== true) {
    if (s.liveDelaySec === 0) s.liveDelaySec = -1;
    await browser.storage.local.set({ [SETTINGS_KEY]: normalizeSettings(s), [LIVE_AUTO_KEY]: true });
  }
  if (got[DUB_LAG_KEY] !== true) {
    if (s.dubLagSec === 2) s.dubLagSec = 1;
    await browser.storage.local.set({ [SETTINGS_KEY]: normalizeSettings(s), [DUB_LAG_KEY]: true });
  }
  if (got[GEMINI_OFF_KEY] !== true) {
    // one-time: profiles saved while Gemini was on by default keep it on; 0.3.0 makes it off by default (the user turns it on by hand)
    s.voiceEnabled = { ...s.voiceEnabled, gemini: false };
    await browser.storage.local.set({ [SETTINGS_KEY]: normalizeSettings(s), [GEMINI_OFF_KEY]: true });
  }
  if (got[SUB_DEFAULTS_KEY] !== true) {
    // one-time: untouched transparency (the old defaults 0 / 45, or no style stored) moves to the new defaults; a changed value stays
    const st = s.subStyle;
    if (st.textTransparency === 0 && st.bgTransparency === 45) {
      s.subStyle = { ...st, textTransparency: 20, bgTransparency: 25 };
    }
    await browser.storage.local.set({ [SETTINGS_KEY]: normalizeSettings(s), [SUB_DEFAULTS_KEY]: true });
  }
  const auth = await loadYandexAuth();
  if (auth && (auth.expiresAt === 0 || auth.expiresAt > Date.now())) s.yandexToken = auth.token;
  return s;
}

/** Persists a partial update (token field is ignored: it lives in YANDEX_AUTH_KEY). */
export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  const got = await browser.storage.local.get(SETTINGS_KEY);
  const cur = normalizeSettings(got[SETTINGS_KEY]);
  const { yandexToken: _t, ...rest } = patch;
  void _t;
  await browser.storage.local.set({ [SETTINGS_KEY]: normalizeSettings({ ...cur, ...rest }) });
}

/** Calls `cb` with fresh settings whenever settings or the Yandex login change. Returns an unsubscribe. */
export function onSettingsChanged(cb: (s: Settings) => void): () => void {
  const fn = (changes: Record<string, unknown>, area: string): void => {
    if (area !== 'local' || !(SETTINGS_KEY in changes || YANDEX_AUTH_KEY in changes)) return;
    void loadSettings().then(cb);
  };
  browser.storage.onChanged.addListener(fn);
  return () => browser.storage.onChanged.removeListener(fn);
}
