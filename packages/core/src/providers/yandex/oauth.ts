import type { Transport } from '../types';

/**
 * Yandex OAuth (authorization code + PKCE S256, public client) as in VOT.txt:7168-7174, 31941-32075.
 * Pure helpers: no storage, no navigation. The caller keeps `verifier` and `state` between buildAuthUrl and
 * exchangeCode. The client_id below is VOT's registered app; pass your own via `clientId`.
 */

export const YANDEX_OAUTH = {
  clientId: '1666fbe22f3749c581002a4f97b2592d',
  authUrl: 'https://oauth.yandex.ru/authorize',
  tokenUrl: 'https://oauth.yandex.ru/token',
  redirectUri: 'https://oauth.yandex.ru/verification_code',
  userInfoUrl: 'https://login.yandex.ru/info',
} as const;

export interface OAuthConfig {
  clientId?: string;
  authUrl?: string;
  tokenUrl?: string;
  redirectUri?: string;
}

export interface OAuthToken {
  accessToken: string;
  /** absolute ms epoch */
  expiresAt: number;
  refreshToken?: string;
}

export class OAuthError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'OAuthError';
  }
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function createCodeVerifier(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
}

export async function createCodeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

export function createState(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)));
}

/** Authorization link. `state` and `verifier` must be remembered by the caller until the code comes back. */
export async function buildAuthUrl(
  p: { verifier: string; state: string; now?: number } & OAuthConfig,
): Promise<string> {
  const q = new URLSearchParams({
    client_id: p.clientId ?? YANDEX_OAUTH.clientId,
    response_type: 'code',
    redirect_uri: p.redirectUri ?? YANDEX_OAUTH.redirectUri,
    et: String(p.now ?? Date.now()),
    force_confirm: '1',
    state: p.state,
    code_challenge: await createCodeChallenge(p.verifier),
    code_challenge_method: 'S256',
  });
  return `${p.authUrl ?? YANDEX_OAUTH.authUrl}?${q.toString()}`;
}

export async function exchangeCode(
  code: string,
  verifier: string,
  transport: Transport,
  cfg: OAuthConfig & { now?: () => number; signal?: AbortSignal } = {},
): Promise<OAuthToken> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: cfg.clientId ?? YANDEX_OAUTH.clientId,
    redirect_uri: cfg.redirectUri ?? YANDEX_OAUTH.redirectUri,
    code_verifier: verifier,
  }).toString();
  const res = await transport({
    url: cfg.tokenUrl ?? YANDEX_OAUTH.tokenUrl,
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new TextEncoder().encode(body),
    signal: cfg.signal,
  });
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(new TextDecoder().decode(res.body));
  } catch {
    throw new OAuthError(`Unreadable token response (HTTP ${res.status})`, undefined, res.status);
  }
  if (typeof data.error === 'string') {
    throw new OAuthError(`Token exchange rejected: ${String(data.error_description ?? '')} (${data.error})`, data.error, res.status);
  }
  if (res.status !== 200 || typeof data.access_token !== 'string') {
    throw new OAuthError(`Token exchange failed (HTTP ${res.status})`, undefined, res.status);
  }
  // a missing expires_in must not turn into "expired right now" (the token would then be silently ignored): 0 = unknown
  const expiresIn = typeof data.expires_in === 'number' && data.expires_in > 0 ? data.expires_in : 0;
  return {
    accessToken: data.access_token,
    expiresAt: expiresIn ? (cfg.now ?? Date.now)() + expiresIn * 1000 : 0,
    refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : undefined,
  };
}

/** Reads `code` / `state` from the callback page URL (VOT.txt:11090 reads location.search; the fragment is a fallback). */
export function parseOAuthCallback(search: string, hash = ''): { code: string; state: string } | null {
  const q = new URLSearchParams(search);
  const h = new URLSearchParams(hash.replace(/^#/, ''));
  const code = q.get('code') ?? h.get('code');
  const state = q.get('state') ?? h.get('state');
  return code && state ? { code, state } : null;
}

/** Russian, user-facing text for a failed login (token exchange). Never contains the code or the token. */
export function describeLoginError(e: unknown): string {
  if (e instanceof OAuthError) {
    if (e.code === 'invalid_grant') return 'Код входа недействителен или устарел — нажмите «Войти в Яндекс» ещё раз';
    if (e.code) return `Яндекс отклонил вход (${e.code}) — попробуйте ещё раз`;
    return `Яндекс ответил неожиданно (HTTP ${e.httpStatus ?? '?'}) — попробуйте ещё раз`;
  }
  return 'Не удалось связаться с Яндексом при входе — проверьте сеть и повторите';
}

export type TokenCheck =
  | { ok: true; login?: string; avatarUrl?: string }
  | { ok: false; kind: 'rejected' | 'network'; message: string };

/** GET login.yandex.ru/info with the token (VOT.txt:31996). 401 / status:error => the token is not accepted. */
export async function checkYandexToken(token: string, transport: Transport, signal?: AbortSignal): Promise<TokenCheck> {
  let res;
  try {
    res = await transport({ url: `${YANDEX_OAUTH.userInfoUrl}?format=json`, method: 'GET', headers: { Authorization: `OAuth ${token}` }, signal });
  } catch {
    return { ok: false, kind: 'network', message: 'Не удалось связаться с Яндексом — проверьте сеть' };
  }
  let j: { login?: string; display_name?: string; default_avatar_id?: string; status?: string } | undefined;
  try {
    j = JSON.parse(new TextDecoder().decode(res.body));
  } catch {
    j = undefined;
  }
  if (res.status === 401 || res.status === 403 || j?.status === 'error') {
    return { ok: false, kind: 'rejected', message: 'Токен не принят — войдите снова' };
  }
  if (res.status !== 200 || !j) return { ok: false, kind: 'network', message: `Яндекс ответил неожиданно (HTTP ${res.status})` };
  return {
    ok: true,
    login: j.login ?? j.display_name,
    avatarUrl: j.default_avatar_id ? `https://avatars.mds.yandex.net/get-yapic/${j.default_avatar_id}/islands-50` : undefined,
  };
}
