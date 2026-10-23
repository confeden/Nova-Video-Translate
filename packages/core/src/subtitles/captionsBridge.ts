/**
 * Read-only bridge to the page's YouTube player (caption track list) and to same-origin timedtext fetches, which only
 * work from the page's own origin / cookies. Same nonce pattern as the MSE bridge (capture/mseBridge.ts) but a separate
 * message tag, and the MAIN-world half is a pure reader: it patches nothing (D14).
 *
 *   MAIN world:      installCaptionsMain()
 *   isolated world:  const r = createCaptionsBridgeClient(); await r.getTracks(); await r.fetchText(url)
 */

const TAG = 'nvt-caps';

export interface CaptionTrack {
  lang: string;
  /** 'asr' = auto-generated */
  kind: string;
  name?: string;
  baseUrl: string;
  translatable: boolean;
}

export interface CaptionInfo {
  videoId?: string;
  tracks: CaptionTrack[];
  /** languages YouTube can machine-translate the translatable tracks into */
  translationLangs: string[];
  /** language of the default audio track when the player knows it */
  audioLang?: string;
  /** display name of that audio track (e.g. "русский") when the player knows it */
  audioName?: string;
  /** videoDetails of the player response (original title / uploader / description), for language detection */
  title?: string;
  author?: string;
  description?: string;
  /**
   * Query params YouTube now requires on timedtext requests (PO token + device params), read from the player's own
   * audio-track caption URLs (the same idea VOT uses). Absent = the player has not produced a token yet.
   */
  urlParams?: Record<string, string>;
}

export interface CaptionsReader {
  /** null = no reader answers (not YouTube / MAIN half missing) */
  getTracks(timeoutMs?: number): Promise<CaptionInfo | null>;
  /** same-origin GET of a timedtext URL */
  fetchText(url: string, timeoutMs?: number): Promise<{ status: number; text: string }>;
  dispose?(): void;
}

type ToMain = { t: 'hello'; nonce: string } | { t: 'tracks'; nonce: string; id: number } | { t: 'fetch'; nonce: string; id: number; url: string };
type ToIso =
  | { t: 'tracks-r'; nonce: string; id: number; info: CaptionInfo | null }
  | { t: 'fetch-r'; nonce: string; id: number; status: number; text: string };

interface Env {
  postMessage(msg: unknown, targetOrigin: string): void;
  addEventListener(type: 'message', fn: (e: MessageEvent) => void): void;
  removeEventListener(type: 'message', fn: (e: MessageEvent) => void): void;
}

function originOf(win: Env): string {
  const l = (win as unknown as { location?: { origin?: string } }).location;
  return l?.origin && l.origin !== 'null' ? l.origin : '*';
}

interface PlayerLike {
  getPlayerResponse?: () => unknown;
  getVideoData?: () => { video_id?: string };
  getAudioTrack?: () => { getLanguageInfo?: () => { id?: string; name?: string }; captionTracks?: { url?: string }[] } | undefined;
}

/** Pure function over the page window: caption tracks of the video the player currently shows. */
export function readCaptionInfo(doc: { getElementById(id: string): unknown }, win: unknown): CaptionInfo | null {
  const player = doc.getElementById('movie_player') as PlayerLike | null;
  let resp: unknown;
  try {
    resp = player?.getPlayerResponse?.();
  } catch {
    resp = undefined;
  }
  resp ??= (win as { ytInitialPlayerResponse?: unknown }).ytInitialPlayerResponse;
  const r = resp as
    | {
        videoDetails?: { videoId?: string; title?: string; author?: string; shortDescription?: string };
        captions?: {
          playerCaptionsTracklistRenderer?: {
            captionTracks?: { baseUrl?: string; languageCode?: string; kind?: string; name?: { simpleText?: string; runs?: { text?: string }[] }; isTranslatable?: boolean }[];
            translationLanguages?: { languageCode?: string }[];
          };
        };
      }
    | undefined;
  if (!r) return null;
  const rend = r.captions?.playerCaptionsTracklistRenderer;
  const tracks: CaptionTrack[] = [];
  for (const t of rend?.captionTracks ?? []) {
    if (!t.baseUrl || !t.languageCode) continue;
    tracks.push({
      lang: t.languageCode,
      kind: t.kind ?? '',
      name: t.name?.simpleText ?? t.name?.runs?.map((x) => x.text).join(''),
      baseUrl: t.baseUrl,
      translatable: !!t.isTranslatable,
    });
  }
  let audioLang: string | undefined;
  let audioName: string | undefined;
  try {
    const li = player?.getAudioTrack?.()?.getLanguageInfo?.();
    audioLang = li?.id?.split('.')[0];
    audioName = typeof li?.name === 'string' ? li.name : undefined;
    if (audioLang === 'und') audioLang = undefined;
  } catch {
    /* ignore */
  }
  let videoId = r.videoDetails?.videoId;
  try {
    const cur = player?.getVideoData?.().video_id;
    // the response of a previous video lingers after an SPA navigation: a mismatch means "not ready yet"
    if (cur && videoId && cur !== videoId) return null;
    videoId ??= cur;
  } catch {
    /* ignore */
  }
  return { videoId, tracks, translationLangs: (rend?.translationLanguages ?? []).map((l) => l.languageCode ?? '').filter(Boolean),
    audioLang,
    audioName,
    title: r.videoDetails?.title,
    author: r.videoDetails?.author,
    description: r.videoDetails?.shortDescription?.slice(0, 1500),
    urlParams: readUrlParams(player, win) };
}

function readUrlParams(player: PlayerLike | null, win: unknown): Record<string, string> | undefined {
  try {
    const withPot = player?.getAudioTrack?.()?.captionTracks?.find((c) => c.url?.includes('&pot='));
    const pot = withPot?.url ? /&pot=([^&]+)/.exec(withPot.url)?.[1] : undefined;
    if (!pot) return undefined;
    let v = pot;
    for (let i = 0; i < 10; i++) {
      const d = decodeURIComponent(v);
      if (d === v) break;
      v = d;
    }
    const w = win as { ytcfg?: { data_?: Record<string, unknown> }; yt?: { config_?: Record<string, unknown> } };
    const cfg = w.yt?.config_ ?? w.ytcfg?.data_;
    const params: Record<string, string> = { potc: '1', pot: v };
    if (cfg) {
      const client = (cfg.INNERTUBE_CONTEXT as { client?: { clientName?: string; clientVersion?: string } } | undefined)?.client;
      const dev = new URLSearchParams(typeof cfg.DEVICE === 'string' ? cfg.DEVICE : '');
      dev.delete('ceng');
      dev.delete('cengver');
      dev.set('c', String(client?.clientName ?? cfg.INNERTUBE_CLIENT_NAME ?? 'WEB'));
      dev.set('cver', String(client?.clientVersion ?? cfg.INNERTUBE_CLIENT_VERSION ?? ''));
      dev.set('cplayer', 'UNIPLAYER');
      dev.forEach((val, key) => {
        if (val) params[key] = val;
      });
    } else params.c = 'WEB';
    return params;
  } catch {
    return undefined;
  }
}

/** Fetches a timedtext URL, refusing anything that is not same-origin https. */
export async function fetchSameOrigin(url: string, win: { location: { href: string; origin: string } }, fetchFn: typeof fetch = fetch): Promise<{ status: number; text: string }> {
  const u = new URL(url, win.location.href);
  if (u.origin !== win.location.origin || u.protocol !== 'https:' || !u.pathname.startsWith('/api/timedtext')) return { status: 0, text: '' };
  try {
    const res = await fetchFn(u.toString(), { credentials: 'same-origin' });
    return { status: res.status, text: await res.text() };
  } catch {
    return { status: 0, text: '' };
  }
}

/** MAIN world (document_start is fine, nothing is touched until a message arrives). */
export function installCaptionsMain(opts: { win?: Env; doc?: { getElementById(id: string): unknown } } = {}): { dispose(): void } {
  const win = opts.win ?? (globalThis as unknown as Env);
  const doc = opts.doc ?? (globalThis as unknown as { document: { getElementById(id: string): unknown } }).document;
  let nonce: string | null = null;
  const send = (m: ToIso): void => win.postMessage({ [TAG]: m }, originOf(win));
  const onMsg = (e: MessageEvent): void => {
    if (e.source !== (win as unknown) || !e.data || typeof e.data !== 'object') return;
    const m = (e.data as Record<string, ToMain | undefined>)[TAG];
    if (!m || typeof m.t !== 'string') return;
    if (m.t === 'hello') {
      nonce = String(m.nonce);
      return;
    }
    if (!nonce || m.nonce !== nonce) return;
    if (m.t === 'tracks') {
      let info: CaptionInfo | null = null;
      try {
        info = readCaptionInfo(doc, win);
      } catch {
        info = null;
      }
      send({ t: 'tracks-r', nonce, id: m.id, info });
    } else if (m.t === 'fetch') {
      const id = m.id;
      const n = nonce;
      void fetchSameOrigin(String(m.url), win as unknown as { location: { href: string; origin: string } }).then((r) => send({ t: 'fetch-r', nonce: n, id, status: r.status, text: r.text }));
    }
  };
  win.addEventListener('message', onMsg);
  return { dispose: () => win.removeEventListener('message', onMsg) };
}

export function createCaptionsBridgeClient(win: Env = globalThis as unknown as Env): CaptionsReader {
  const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const pending = new Map<number, (m: ToIso) => void>();
  let seq = 0;
  const send = (m: ToMain): void => win.postMessage({ [TAG]: m }, originOf(win));
  const onMsg = (e: MessageEvent): void => {
    if (e.source !== (win as unknown) || !e.data || typeof e.data !== 'object') return;
    const m = (e.data as Record<string, ToIso | undefined>)[TAG];
    // our own requests echo back through the same window: only replies count
    if (!m || m.nonce !== nonce || (m.t !== 'tracks-r' && m.t !== 'fetch-r')) return;
    pending.get(m.id)?.(m);
    pending.delete(m.id);
  };
  win.addEventListener('message', onMsg);
  send({ t: 'hello', nonce });
  const ask = <T extends ToIso>(make: (id: number) => ToMain, fallback: T, timeoutMs: number): Promise<T> =>
    new Promise((resolve) => {
      const id = ++seq;
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve(fallback);
      }, timeoutMs);
      pending.set(id, (m) => {
        clearTimeout(timer);
        resolve(m as T);
      });
      send(make(id));
    });
  return {
    async getTracks(timeoutMs = 800) {
      const r = await ask<Extract<ToIso, { t: 'tracks-r' }>>((id) => ({ t: 'tracks', nonce, id }), { t: 'tracks-r', nonce, id: 0, info: null }, timeoutMs);
      return r.info ?? null;
    },
    async fetchText(url, timeoutMs = 15_000) {
      const r = await ask<Extract<ToIso, { t: 'fetch-r' }>>((id) => ({ t: 'fetch', nonce, id, url }), { t: 'fetch-r', nonce, id: 0, status: 0, text: '' }, timeoutMs);
      return { status: r.status, text: r.text };
    },
    dispose() {
      win.removeEventListener('message', onMsg);
      pending.clear();
    },
  };
}

/** Same-realm reader (userscript with unsafeWindow): no postMessage at all. */
export function createLocalCaptionsReader(page: { document: { getElementById(id: string): unknown }; location: { href: string; origin: string } }): CaptionsReader {
  return {
    async getTracks() {
      try {
        return readCaptionInfo(page.document, page);
      } catch {
        return null;
      }
    },
    fetchText: (url) => fetchSameOrigin(url, page),
  };
}
