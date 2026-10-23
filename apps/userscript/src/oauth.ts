import { YANDEX_OAUTH, buildAuthUrl, checkYandexToken, createCodeVerifier, createState, describeLoginError, exchangeCode, parseOAuthCallback, type Transport } from '@nvt/core';
import { gmGet, gmSet } from './gm';
import { OAUTH_PENDING_KEY, YANDEX_LOGIN_ERROR_KEY, saveYandexAuth, type YandexAuth } from './storage';

const TTL_MS = 10 * 60_000;

/** D12: PKCE authorization-code flow with the user's own Yandex account; the password is never seen. */
export async function oauthBegin(): Promise<string> {
  const verifier = createCodeVerifier();
  const state = createState();
  gmSet(OAUTH_PENDING_KEY, { verifier, state, at: Date.now() });
  return buildAuthUrl({ verifier, state });
}

export const isOauthCallback = (loc: Location = location): boolean =>
  loc.origin === 'https://oauth.yandex.ru' && loc.pathname.startsWith('/verification_code');

async function fetchLogin(transport: Transport, token: string): Promise<string | undefined> {
  const r = await checkYandexToken(token, transport);
  return r.ok ? r.login : undefined;
}

const loginFailed = (message: string): false => {
  gmSet(YANDEX_LOGIN_ERROR_KEY, { at: Date.now(), message });
  return false;
};

/** Runs on https://oauth.yandex.ru/verification_code*: exchanges the code from the URL and stores the token. */
export async function oauthCallback(transport: Transport, loc: Location = location): Promise<boolean> {
  const cb = parseOAuthCallback(loc.search, loc.hash);
  if (!cb) return false;
  const p = gmGet(OAUTH_PENDING_KEY) as { verifier: string; state: string; at: number } | null | undefined;
  gmSet(OAUTH_PENDING_KEY, null);
  if (!p) return loginFailed('Вход не был начат в этом браузере — нажмите «Войти в Яндекс» в настройках ещё раз');
  if (p.state !== cb.state) return loginFailed('Не совпал контрольный код входа (state) — начните вход заново из настроек');
  if (Date.now() - p.at > TTL_MS) return loginFailed('Вход не завершён за 10 минут — начните заново');
  try {
    const tok = await exchangeCode(cb.code, p.verifier, transport);
    const auth: YandexAuth = { token: tok.accessToken, expiresAt: tok.expiresAt, login: await fetchLogin(transport, tok.accessToken) };
    saveYandexAuth(auth);
    gmSet(YANDEX_LOGIN_ERROR_KEY, null);
    return true;
  } catch (e) {
    return loginFailed(describeLoginError(e));
  }
}
