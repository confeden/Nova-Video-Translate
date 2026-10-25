/**
 * Anonymous Twitch live access: GQL playback token (public web Client-ID, no cookies / OAuth) -> usher master playlist ->
 * the audio_only variant. All HTTP goes through the injected `fetchFn` (service worker / GM transport; credentials omitted).
 */
import { diag } from '../../diag';
import { parseMasterPlaylist, pickAudioOnly } from './playlist';

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

/** the public Client-ID of Twitch's own web player (not a secret) */
export const TWITCH_WEB_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
export const GQL_URL = 'https://gql.twitch.tv/gql';

const TOKEN_QUERY =
  'query PlaybackAccessToken_Template($login: String!, $isLive: Boolean!, $vodID: ID!, $isVod: Boolean!, $playerType: String!) {' +
  ' streamPlaybackAccessToken(channelName: $login, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isLive) { value signature __typename }' +
  ' videoPlaybackAccessToken(id: $vodID, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isVod) { value signature __typename } }';

export type HlsAccessReason = 'offline' | 'forbidden' | 'network' | 'no-audio-only' | 'bad-response';

export class HlsAccessError extends Error {
  constructor(
    readonly reason: HlsAccessReason,
    message: string,
  ) {
    super(message);
  }
}

export interface AccessToken {
  value: string;
  signature: string;
}

export async function fetchAccessToken(channel: string, fetchFn: FetchFn, signal?: AbortSignal): Promise<AccessToken> {
  const body = JSON.stringify({
    operationName: 'PlaybackAccessToken_Template',
    query: TOKEN_QUERY,
    variables: { isLive: true, login: channel, isVod: false, vodID: '', playerType: 'site' },
  });
  let res: Response;
  try {
    res = await fetchFn(GQL_URL, {
      method: 'POST',
      headers: { 'Client-ID': TWITCH_WEB_CLIENT_ID, 'Content-Type': 'text/plain;charset=UTF-8' },
      body,
      signal,
      credentials: 'omit',
    });
  } catch (e) {
    throw new HlsAccessError('network', `gql: ${(e as Error)?.message ?? e}`);
  }
  if (res.status === 401 || res.status === 403) throw new HlsAccessError('forbidden', `gql ${res.status}`);
  if (!res.ok) throw new HlsAccessError('bad-response', `gql ${res.status}`);
  let j: { data?: { streamPlaybackAccessToken?: { value?: string; signature?: string } | null } };
  try {
    j = await res.json();
  } catch {
    throw new HlsAccessError('bad-response', 'gql: not json');
  }
  const t = j.data?.streamPlaybackAccessToken;
  if (!t?.value || !t.signature) throw new HlsAccessError('offline', 'gql: no token (offline or restricted)');
  return { value: t.value, signature: t.signature };
}

export function usherUrl(channel: string, tok: AccessToken, rand = Math.floor(Math.random() * 1e7)): string {
  const q = new URLSearchParams({
    sig: tok.signature,
    token: tok.value,
    allow_audio_only: 'true',
    allow_source: 'true',
    player_backend: 'mediaplayer',
    playlist_include_framerate: 'true',
    p: String(rand),
    supported_codecs: 'avc1',
  });
  return `https://usher.ttvnw.net/api/channel/hls/${encodeURIComponent(channel)}.m3u8?${q.toString()}`;
}

/**
 * Expiry (epoch ms) of a playback access token: its `value` is a JSON string carrying `expires` (epoch seconds; `expires_at` / `exp`
 * are accepted too, seconds or ms). undefined when the value is not JSON or has no usable expiry.
 */
export function parseTokenExpiry(value: string): number | undefined {
  try {
    const j = JSON.parse(value) as Record<string, unknown>;
    for (const k of ['expires', 'expires_at', 'exp']) {
      const x = j[k];
      const n = typeof x === 'number' ? x : typeof x === 'string' ? Number(x) : NaN;
      if (Number.isFinite(n) && n > 1e9) return n > 1e12 ? n : n * 1000;
    }
  } catch {
    /* not JSON */
  }
  return undefined;
}

export interface HlsSession {
  /** audio_only media playlist URL */
  url: string;
  /** when the access token that created the session expires (epoch ms), undefined = unknown */
  expiresAtMs?: number;
}

/** token -> master -> the audio_only media playlist URL plus the token's expiry */
export async function fetchAudioPlaylistSession(channel: string, fetchFn: FetchFn, signal?: AbortSignal): Promise<HlsSession> {
  const tok = await fetchAccessToken(channel, fetchFn, signal);
  const url = usherUrl(channel, tok);
  let res: Response;
  try {
    res = await fetchFn(url, { signal, credentials: 'omit' });
  } catch (e) {
    throw new HlsAccessError('network', `usher: ${(e as Error)?.message ?? e}`);
  }
  if (res.status === 403 || res.status === 401) throw new HlsAccessError('forbidden', `usher ${res.status}`);
  if (res.status === 404) throw new HlsAccessError('offline', 'usher 404');
  if (!res.ok) throw new HlsAccessError('bad-response', `usher ${res.status}`);
  const text = await res.text();
  const v = pickAudioOnly(parseMasterPlaylist(text, url));
  if (!v) throw new HlsAccessError('no-audio-only', 'master has no audio_only variant');
  return { url: v.url, expiresAtMs: parseTokenExpiry(tok.value) };
}

/** token -> master -> URL of the audio_only media playlist */
export async function fetchAudioPlaylistUrl(channel: string, fetchFn: FetchFn, signal?: AbortSignal): Promise<string> {
  return (await fetchAudioPlaylistSession(channel, fetchFn, signal)).url;
}

/**
 * diag 'hls-session': a NEW anonymous token/usher session was created. Every new usher session may start with a preroll ad for an
 * anonymous viewer, so the report must show when (and why) they happen. `ageSec` = age of the token/session being replaced (null for the first); NOT named tokenAgeSec because diag redacts every key containing 'token'.
 */
export function logHlsSession(reason: string, tokenAgeSec: number | null, expiresAtMs: number | undefined, now = Date.now()): void {
  diag.log('hls-session', {
    reason,
    ageSec: tokenAgeSec === null ? null : Math.round(tokenAgeSec),
    expiresInSec: expiresAtMs === undefined ? null : Math.round((expiresAtMs - now) / 1000),
  });
}

/** the channel's broadcast language (anonymous GQL, works for offline channels too): raw Twitch code ("DA", "EN", "OTHER") or undefined */
export function parseBroadcasterLanguage(j: unknown): string | undefined {
  const l = (j as { data?: { user?: { broadcastSettings?: { language?: unknown } | null } | null } } | null)?.data?.user?.broadcastSettings?.language;
  return typeof l === 'string' && l ? l : undefined;
}

export async function fetchBroadcasterLanguage(channel: string, fetchFn: FetchFn, signal?: AbortSignal): Promise<string | undefined> {
  if (!/^[a-zA-Z0-9_]{2,25}$/.test(channel)) return undefined;
  try {
    const res = await fetchFn(GQL_URL, {
      method: 'POST',
      headers: { 'Client-ID': TWITCH_WEB_CLIENT_ID, 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({ query: `query{user(login:"${channel}"){broadcastSettings{language}}}` }),
      signal,
      credentials: 'omit',
    });
    if (!res.ok) return undefined;
    return parseBroadcasterLanguage(await res.json());
  } catch {
    return undefined;
  }
}
