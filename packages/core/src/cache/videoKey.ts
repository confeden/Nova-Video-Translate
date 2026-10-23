/** Stable identity of "the same video" across visits, independent of tracking noise and the page title. */

const YT_HOSTS = /^(?:www\.|m\.|music\.)?(?:youtube\.com|youtube-nocookie\.com)$/;
const KEEP_PARAMS = ['v', 'id', 'video', 'vid', 'p'];
const YT_ID = /^[A-Za-z0-9_-]{6,20}$/;

function youtubeId(u: URL): string | undefined {
  const host = u.hostname.toLowerCase();
  if (host === 'youtu.be') {
    const id = u.pathname.split('/')[1];
    return id && YT_ID.test(id) ? id : undefined;
  }
  if (!YT_HOSTS.test(host)) return undefined;
  const v = u.searchParams.get('v');
  if (v && YT_ID.test(v)) return v;
  const m = /^\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{6,20})(?:[/?]|$)/.exec(u.pathname);
  return m?.[1];
}

function parse(url: string | undefined): URL | undefined {
  if (!url) return undefined;
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

/**
 * YouTube family -> `yt:<id>`; other sites -> `u:` + origin + pathname + meaningful id params (sorted);
 * a page whose path says nothing (root) falls back to `src:` + the media URL without query.
 */
export function videoKey(video: { currentSrc?: string }, pageUrl: string): string | undefined {
  const u = parse(pageUrl);
  if (u) {
    const yt = youtubeId(u);
    if (yt) return `yt:${yt}`;
  }
  const src = parse(video.currentSrc);
  const srcKey = src && src.protocol !== 'blob:' && src.protocol !== 'data:' ? `src:${src.origin}${src.pathname}` : undefined;
  if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) return srcKey;
  const kept = KEEP_PARAMS.filter((k) => u.searchParams.has(k)).map((k) => `${k}=${u.searchParams.get(k)}`);
  const rootLike = (u.pathname === '/' || u.pathname === '') && kept.length === 0;
  if (rootLike && srcKey) return srcKey;
  return `u:${u.origin}${u.pathname}${kept.length ? `?${kept.join('&')}` : ''}`;
}

/**
 * videoKey + the media duration (whole seconds). The duration guards against a different clip played in the same
 * <video> on the same URL (YouTube ads, playlist autoplay). Live / unknown duration => undefined (never cached).
 */
export function videoCacheKey(video: { currentSrc?: string; duration?: number }, pageUrl: string): string | undefined {
  const d = video.duration;
  if (d === undefined || !Number.isFinite(d) || d <= 0) return undefined;
  const k = videoKey(video, pageUrl);
  return k ? `${k}|d${Math.round(d)}` : undefined;
}
