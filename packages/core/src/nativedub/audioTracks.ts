/**
 * Native-dub support (S25): YouTube videos that already carry a Russian audio track (multi-audio / auto-dubbed) are
 * switched to it instead of being translated. The player API lives in the PAGE world, so the same request/response
 * bridge pattern as captionsBridge.ts is used (separate message tag, nonce from the isolated side).
 *
 * Page API relied on (all calls in try/catch, every name optional): #movie_player.getAvailableAudioTracks(),
 * .getAudioTrack(), .setAudioTrack(track), .getPlayerResponse() / window.ytInitialPlayerResponse
 * (streamingData.adaptiveFormats[].audioTrack = {id, displayName, audioIsDefault}), .getVideoData().video_id.
 */

const TAG = 'nvt-atr';

export interface AudioTrackInfo {
  id: string;
  name?: string;
  /** the track is the original / default one (YouTube marks the original-language track as default) */
  original: boolean;
  /** language code or display name says Russian */
  ru: boolean;
}

export interface AudioTracksState {
  videoId?: string;
  tracks: AudioTrackInfo[];
  /** id of the track playing now */
  currentId?: string;
  /** setAudioTrack can be called for the listed tracks (the player exposes the track objects) */
  canSelect: boolean;
}

export interface AudioTracksController {
  /** null = no reader answers (not YouTube / MAIN half missing) */
  list(timeoutMs?: number): Promise<AudioTracksState | null>;
  /** true when the player accepted the switch */
  select(id: string, timeoutMs?: number): Promise<boolean>;
  dispose?(): void;
}

/** Russian by language code prefix ('ru', 'ru.10', 'ru-RU') or by display name */
export function isRussianTrack(id: string | undefined, name: string | undefined): boolean {
  if (id && /^ru([.\-_]|$)/i.test(id.trim())) return true;
  return !!name && /russian|рус/i.test(name);
}

const ORIGINAL_NAME = /original|оригинал/i;

/** The Russian dub: a Russian track that is not just the original language of the video. Needs a real choice (>= 2 tracks). */
export function findRussianDub(st: AudioTracksState | null | undefined): AudioTrackInfo | undefined {
  if (!st || st.tracks.length < 2) return undefined;
  return st.tracks.find((t) => t.ru && !t.original);
}

interface RawTrack {
  id?: unknown;
  getId?: () => unknown;
  displayName?: unknown;
  name?: unknown;
  languageInfo?: { id?: unknown; name?: unknown };
  getLanguageInfo?: () => { id?: unknown; name?: unknown } | undefined;
  audioIsDefault?: unknown;
  isDefault?: unknown;
}

interface PlayerLike {
  getAvailableAudioTracks?: () => unknown;
  getAudioTrack?: () => unknown;
  setAudioTrack?: (t: unknown) => unknown;
  getPlayerResponse?: () => unknown;
  getVideoData?: () => { video_id?: string };
}

const s = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

interface LangInfoLike {
  id?: unknown;
  name?: unknown;
  displayName?: unknown;
  isDefault?: unknown;
  isAutoDubbed?: unknown;
}

const LANG_ID = /^[a-z]{2,3}([.\-_]|$)/i;

/** a language-info object: string `id` that looks like a language code plus a name and/or a default/auto-dubbed flag */
function looksLikeLangInfo(o: unknown): o is LangInfoLike {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
  const l = o as LangInfoLike;
  const id = s(l.id);
  if (!id || !LANG_ID.test(id)) return false;
  return s(l.name) !== undefined || s(l.displayName) !== undefined || typeof l.isDefault === 'boolean' || typeof l.isAutoDubbed === 'boolean';
}

/**
 * Language info of a live track. Known paths first (languageInfo / getLanguageInfo()); then any own property (one level
 * deep) shaped like it: YouTube's player keeps it under a minified key (`Nb` at the time of writing, it changes).
 */
function findLangInfo(r: RawTrack): LangInfoLike | undefined {
  let li: unknown;
  try {
    li = r.getLanguageInfo?.() ?? r.languageInfo;
  } catch {
    li = r.languageInfo;
  }
  if (li && typeof li === 'object' && s((li as LangInfoLike).id)) return li as LangInfoLike;
  let keys: string[] = [];
  try {
    keys = Object.keys(r);
  } catch {
    /* ignore */
  }
  for (const k of keys) {
    let v: unknown;
    try {
      v = (r as unknown as Record<string, unknown>)[k];
    } catch {
      continue;
    }
    if (looksLikeLangInfo(v)) return v;
  }
  return undefined;
}

/** the opaque live id ("251;<base64url>") encodes `acont`=original|dubbed...; '' when it does not decode */
function decodeTrackId(id: string): string {
  const m = /^\d+;([A-Za-z0-9_\-]+)/.exec(id);
  if (!m) return '';
  try {
    const b64 = m[1]!.replace(/-/g, '+').replace(/_/g, '/');
    const bin = (globalThis as { atob?: (x: string) => string }).atob?.(b64 + '='.repeat((4 - (b64.length % 4)) % 4)) ?? '';
    return bin.toLowerCase();
  } catch {
    return '';
  }
}

interface Described {
  id: string;
  name?: string;
  /** certain: named "original", encoded as original in the live id, or a formats default flagged by the caller */
  strong: boolean;
  /** only a default flag said so (YouTube's isDefault on live tracks may just mean "the viewer's language") */
  weak: boolean;
}

function describe(t: unknown, defaultId?: string): Described | undefined {
  if (!t || typeof t !== 'object') return undefined;
  const r = t as RawTrack;
  const li = findLangInfo(r);
  let rawId: unknown = r.id;
  try {
    rawId ??= r.getId?.();
  } catch {
    /* ignore */
  }
  // the language id (ru.3) is the stable key: it also matches the player-response formats and getAudioTrack()
  const id = s(li?.id) ?? s(rawId);
  if (!id) return undefined;
  const name = s(r.displayName) ?? s(li?.displayName) ?? s(li?.name) ?? s(r.name);
  const decoded = decodeTrackId(s(rawId) ?? '');
  const dubbed = li?.isAutoDubbed === true || /dubbed/.test(decoded);
  const strong = !dubbed && ((!!name && ORIGINAL_NAME.test(name)) || /original/.test(decoded));
  const weak = !dubbed && (r.audioIsDefault === true || r.isDefault === true || li?.isDefault === true || (defaultId !== undefined && id === defaultId));
  return { id, name, strong, weak };
}

function fromResponse(resp: unknown): Described[] {
  const out = new Map<string, Described>();
  const fmts = (resp as { streamingData?: { adaptiveFormats?: { audioTrack?: { id?: unknown; displayName?: unknown; audioIsDefault?: unknown } }[] } } | undefined)?.streamingData?.adaptiveFormats;
  for (const f of Array.isArray(fmts) ? fmts : []) {
    const a = f?.audioTrack;
    const id = s(a?.id);
    if (!a || !id || out.has(id)) continue;
    const name = s(a.displayName);
    out.set(id, { id, name, strong: !!name && ORIGINAL_NAME.test(name), weak: a.audioIsDefault === true });
  }
  return [...out.values()];
}

/** Pure reader over the page: the audio tracks of the video the player shows and the active one. null = nothing readable. */
export function readAudioTracks(doc: { getElementById(id: string): unknown }, win: unknown): AudioTracksState | null {
  const player = doc.getElementById('movie_player') as PlayerLike | null;
  let resp: unknown;
  try {
    resp = player?.getPlayerResponse?.();
  } catch {
    resp = undefined;
  }
  resp ??= (win as { ytInitialPlayerResponse?: unknown } | undefined)?.ytInitialPlayerResponse;
  let videoId: string | undefined;
  try {
    videoId = s(player?.getVideoData?.().video_id);
  } catch {
    /* ignore */
  }
  const respVideo = s((resp as { videoDetails?: { videoId?: unknown } } | undefined)?.videoDetails?.videoId);
  // the response of the previous video lingers after an SPA navigation: a mismatch means "not ready yet"
  if (videoId && respVideo && videoId !== respVideo) resp = undefined;
  const fromFormats = fromResponse(resp);
  const defaultId = fromFormats.find((t) => t.strong || t.weak)?.id;
  let live: unknown[] = [];
  try {
    const l = player?.getAvailableAudioTracks?.();
    if (Array.isArray(l)) live = l;
  } catch {
    live = [];
  }
  const merged = new Map<string, Described>();
  const add = (d: Described | undefined): void => {
    if (!d) return;
    const prev = merged.get(d.id);
    merged.set(d.id, { id: d.id, name: d.name ?? prev?.name, strong: d.strong || !!prev?.strong, weak: d.weak || !!prev?.weak });
  };
  for (const d of fromFormats) add(d);
  for (const t of live) add(describe(t, defaultId));
  // a default flag only counts when nothing is positively named / encoded as the original (a Russian dub can be the viewer's default)
  const anyStrong = [...merged.values()].some((d) => d.strong);
  const tracks = new Map<string, AudioTrackInfo>();
  for (const d of merged.values()) tracks.set(d.id, { id: d.id, name: d.name, original: d.strong || (!anyStrong && d.weak), ru: isRussianTrack(d.id, d.name) });
  let currentId: string | undefined;
  try {
    currentId = describe(player?.getAudioTrack?.(), defaultId)?.id;
  } catch {
    /* ignore */
  }
  if (tracks.size === 0 && !currentId) return null;
  return { videoId: videoId ?? respVideo, tracks: [...tracks.values()], currentId, canSelect: live.length > 0 && typeof player?.setAudioTrack === 'function' };
}

/** Switches the player to the track with this id. false = not possible / the player threw. */
export function selectAudioTrack(doc: { getElementById(id: string): unknown }, id: string): boolean {
  try {
    const player = doc.getElementById('movie_player') as PlayerLike | null;
    if (!player || typeof player.setAudioTrack !== 'function') return false;
    const list = player.getAvailableAudioTracks?.();
    if (!Array.isArray(list)) return false;
    const target = list.find((t) => describe(t)?.id === id);
    if (!target) return false;
    player.setAudioTrack(target);
    return true;
  } catch {
    return false;
  }
}

// ---------- bridge ----------

type ToMain = { t: 'hello'; nonce: string } | { t: 'list'; nonce: string; id: number } | { t: 'select'; nonce: string; id: number; trackId: string };
type ToIso = { t: 'list-r'; nonce: string; id: number; state: AudioTracksState | null } | { t: 'select-r'; nonce: string; id: number; ok: boolean };

interface Env {
  postMessage(msg: unknown, targetOrigin: string): void;
  addEventListener(type: 'message', fn: (e: MessageEvent) => void): void;
  removeEventListener(type: 'message', fn: (e: MessageEvent) => void): void;
}

function originOf(win: Env): string {
  const l = (win as unknown as { location?: { origin?: string } }).location;
  return l?.origin && l.origin !== 'null' ? l.origin : '*';
}

/** MAIN world half (document_start is fine, nothing is touched until a message arrives). Patches nothing (D14). */
export function installAudioTracksMain(opts: { win?: Env; doc?: { getElementById(id: string): unknown } } = {}): { dispose(): void } {
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
    if (m.t === 'list') {
      let state: AudioTracksState | null = null;
      try {
        state = readAudioTracks(doc, win);
      } catch {
        state = null;
      }
      send({ t: 'list-r', nonce, id: m.id, state });
    } else if (m.t === 'select') {
      send({ t: 'select-r', nonce, id: m.id, ok: selectAudioTrack(doc, String(m.trackId)) });
    }
  };
  win.addEventListener('message', onMsg);
  return { dispose: () => win.removeEventListener('message', onMsg) };
}

export function createAudioTracksBridgeClient(win: Env = globalThis as unknown as Env): AudioTracksController {
  const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const pending = new Map<number, (m: ToIso) => void>();
  let seq = 0;
  const send = (m: ToMain): void => win.postMessage({ [TAG]: m }, originOf(win));
  const onMsg = (e: MessageEvent): void => {
    if (e.source !== (win as unknown) || !e.data || typeof e.data !== 'object') return;
    const m = (e.data as Record<string, ToIso | undefined>)[TAG];
    if (!m || m.nonce !== nonce || (m.t !== 'list-r' && m.t !== 'select-r')) return;
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
    async list(timeoutMs = 800) {
      const r = await ask<Extract<ToIso, { t: 'list-r' }>>((id) => ({ t: 'list', nonce, id }), { t: 'list-r', nonce, id: 0, state: null }, timeoutMs);
      return r.state ?? null;
    },
    async select(trackId, timeoutMs = 1500) {
      const r = await ask<Extract<ToIso, { t: 'select-r' }>>((id) => ({ t: 'select', nonce, id, trackId }), { t: 'select-r', nonce, id: 0, ok: false }, timeoutMs);
      return r.ok;
    },
    dispose() {
      win.removeEventListener('message', onMsg);
      pending.clear();
    },
  };
}

/** Same-realm controller (userscript with unsafeWindow): no postMessage at all. */
export function createLocalAudioTracksController(page: { document: { getElementById(id: string): unknown } }): AudioTracksController {
  return {
    async list() {
      try {
        return readAudioTracks(page.document, page);
      } catch {
        return null;
      }
    },
    async select(id) {
      return selectAudioTrack(page.document, id);
    },
  };
}
