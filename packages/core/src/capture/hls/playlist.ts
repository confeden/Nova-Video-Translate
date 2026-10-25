/** HLS playlist parsing for the Twitch audio_only rendition (pure, no imports). */

export interface HlsSegment {
  seq: number;
  uri: string;
  duration: number;
  /** EXT-X-PROGRAM-DATE-TIME as epoch ms, when present */
  dateMs?: number;
  /** stitched advertisement (skipped) */
  ad: boolean;
}

export interface MediaPlaylist {
  targetDuration: number;
  mediaSequence: number;
  segments: HlsSegment[];
  /** #EXT-X-TWITCH-PREFETCH uris (not yet complete; never downloaded) */
  prefetch: string[];
  ended: boolean;
  /** the playlist carries an ad DATERANGE (twitch-stitched-ad / stitched-ad* / X-TV-TWITCH-AD*); informational only: a DATERANGE can outlive its ad inside the window */
  adBreak: boolean;
  /** short descriptions of the ad DATERANGEs seen (diagnostics: 'id|start|dur') */
  adRanges: string[];
}

/** open-ended ad DATERANGE (no DURATION / PLANNED-DURATION / END-DATE): assumed this long, a stale one must not flag the live stream for ever */
export const AD_RANGE_DEFAULT_SEC = 30;

/** segment titles of ad content: the ad network ("Amazon|...") or an explicit ad tag; live content is titled "live" */
const AD_TITLE = /amazon|stitched|twitch-ad|(^|[^a-z])ads?([^a-z]|$)/i;

/**
 * Ad state of a parsed playlist: how many segments are flagged and whether the NEWEST ones (the stream's present, what the
 * player reaches next) are ads. A flagged segment older in the window (a finished break, a stale DATERANGE) says nothing.
 */
export function adSummary(pl: MediaPlaylist, newest = 1): { adSegs: number; newestIsAd: boolean; lastAdSeq: number } {
  let adSegs = 0;
  let lastAdSeq = -1;
  for (const s of pl.segments) {
    if (!s.ad) continue;
    adSegs++;
    lastAdSeq = s.seq;
  }
  const tail = pl.segments.slice(-newest);
  return { adSegs, newestIsAd: tail.some((s) => s.ad), lastAdSeq };
}

function attrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out[m[1]!] = m[3] !== undefined ? m[3] : m[2]!;
  return out;
}

export function resolveUrl(base: string, uri: string): string {
  try {
    return new URL(uri, base).href;
  } catch {
    return uri;
  }
}

interface AdRange {
  start: number;
  end: number;
}

function isAdRange(a: Record<string, string>): boolean {
  if (/twitch-stitched-ad/i.test(a.CLASS ?? '')) return true;
  if (/^stitched-ad/i.test(a.ID ?? '')) return true;
  return Object.keys(a).some((k) => k.startsWith('X-TV-TWITCH-AD'));
}

export function parseMediaPlaylist(text: string): MediaPlaylist {
  const lines = text.split(/\r?\n/);
  const pl: MediaPlaylist = { targetDuration: 2, mediaSequence: 0, segments: [], prefetch: [], ended: false, adBreak: false, adRanges: [] };
  const ads: AdRange[] = [];
  let dur = 0;
  let title = '';
  let dateMs: number | undefined;
  let scteOut = false;
  let seq = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-TARGETDURATION:')) pl.targetDuration = Number(line.slice(22)) || 2;
    else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      pl.mediaSequence = Number(line.slice(22)) || 0;
      seq = pl.mediaSequence;
    } else if (line.startsWith('#EXT-X-ENDLIST')) pl.ended = true;
    else if (line.startsWith('#EXT-X-DATERANGE:')) {
      const a = attrs(line.slice(17));
      if (isAdRange(a)) {
        pl.adBreak = true;
        const start = Date.parse(a['START-DATE'] ?? '');
        const d = Number(a.DURATION ?? a['PLANNED-DURATION'] ?? '');
        const endDate = Date.parse(a['END-DATE'] ?? '');
        // a range without a usable START-DATE cannot be matched to segments (their titles still can)
        if (Number.isFinite(start)) {
          const end = Number.isFinite(d) ? start + d * 1000 : Number.isFinite(endDate) ? endDate : start + AD_RANGE_DEFAULT_SEC * 1000;
          ads.push({ start, end });
        }
        if (pl.adRanges.length < 4) pl.adRanges.push(`${(a.ID ?? a.CLASS ?? '?').slice(0, 24)}|${a['START-DATE'] ?? '?'}|${a.DURATION ?? a['PLANNED-DURATION'] ?? '-'}`);
      }
    } else if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
      const t = Date.parse(line.slice(25));
      dateMs = Number.isFinite(t) ? t : undefined;
    } else if (line.startsWith('#EXT-X-SCTE35-OUT') || line.startsWith('#EXT-X-CUE-OUT')) scteOut = true;
    else if (line.startsWith('#EXT-X-SCTE35-IN') || line.startsWith('#EXT-X-CUE-IN')) scteOut = false;
    else if (line.startsWith('#EXT-X-TWITCH-PREFETCH:')) pl.prefetch.push(line.slice(23));
    else if (line.startsWith('#EXTINF:')) {
      const rest = line.slice(8);
      const c = rest.indexOf(',');
      dur = Number(c >= 0 ? rest.slice(0, c) : rest) || 0;
      title = c >= 0 ? rest.slice(c + 1).trim() : '';
    } else if (!line.startsWith('#')) {
      const inRange = dateMs !== undefined && ads.some((r) => dateMs! >= r.start && dateMs! < r.end);
      // live content segments are titled "live"; ad segments carry the ad network name ("Amazon|..."). Any OTHER title is not an ad.
      const titled = AD_TITLE.test(title);
      pl.segments.push({ seq: seq++, uri: line, duration: dur, dateMs, ad: inRange || scteOut || titled });
      if (dateMs !== undefined) dateMs += dur * 1000;
      dur = 0;
      title = '';
    }
  }
  return pl;
}

export interface MasterVariant {
  name: string;
  url: string;
  bandwidth: number;
  audioOnly: boolean;
}

export function parseMasterPlaylist(text: string, baseUrl: string): MasterVariant[] {
  const out: MasterVariant[] = [];
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  let groupName = '';
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.startsWith('#EXT-X-MEDIA:')) {
      const a = attrs(l.slice(13));
      groupName = a.NAME ?? a['GROUP-ID'] ?? '';
    } else if (l.startsWith('#EXT-X-STREAM-INF:')) {
      const a = attrs(l.slice(18));
      let j = i + 1;
      while (j < lines.length && (lines[j] === '' || lines[j]!.startsWith('#'))) j++;
      const uri = lines[j];
      if (!uri) continue;
      const name = groupName || a.VIDEO || '';
      const codecs = a.CODECS ?? '';
      const audioOnly = /audio_only/i.test(name) || /audio_only/i.test(a.VIDEO ?? '') || (codecs !== '' && !/avc1|hvc1|hev1|av01/i.test(codecs) && /mp4a/i.test(codecs));
      out.push({ name, url: resolveUrl(baseUrl, uri), bandwidth: Number(a.BANDWIDTH) || 0, audioOnly });
      i = j;
    }
  }
  return out;
}

export function pickAudioOnly(variants: MasterVariant[]): MasterVariant | undefined {
  return variants.find((v) => v.audioOnly);
}

/** Channel login from a twitch.tv pathname; undefined for non-channel pages (/videos/123, /directory, /<chan>/clip/..) */
const RESERVED = new Set([
  'videos', 'directory', 'downloads', 'jobs', 'turbo', 'store', 'settings', 'subscriptions', 'inventory', 'wallet', 'drops',
  'friends', 'messages', 'popout', 'embed', 'login', 'signup', 'search', 'p', 'prime', 'u', 'moderator', 'dashboard', 'clip',
  'clips', 'event', 'schedule', 'team', 'user', 'broadcast', 'collections', 'bits', 'following', 'ads', 'legal',
]);

export function twitchChannelFromPath(pathname: string): string | undefined {
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length === 0) return undefined;
  let first = parts[0]!.toLowerCase();
  // /popout/<channel>/chat or /moderator/<channel>
  if ((first === 'popout' || first === 'moderator') && parts[1]) first = parts[1].toLowerCase();
  else if (RESERVED.has(first)) return undefined;
  if (!/^[a-z0-9_]{2,25}$/.test(first)) return undefined;
  // /<channel>/videos, /<channel>/clip/<id> are not the live player
  const sub = (first === parts[0]!.toLowerCase() ? parts[1] : parts[2])?.toLowerCase();
  if (sub === 'videos' || sub === 'clip' || sub === 'clips' || sub === 'schedule' || sub === 'about') return undefined;
  return first;
}
