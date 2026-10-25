import { normalizeVersion } from './semver';

export const RELEASE_REPO = 'confeden/Nova-Video-Translate';
/** /releases/latest only: tags, commits and pre-releases are never consulted. */
export const LATEST_RELEASE_API = `https://api.github.com/repos/${RELEASE_REPO}/releases/latest`;
export const RELEASE_PAGE_PREFIX = `https://github.com/${RELEASE_REPO}/`;

/** Only this repository's pages may be opened from an update notice. */
export function isReleasePageUrl(url: unknown): url is string {
  if (typeof url !== 'string' || !url.startsWith(RELEASE_PAGE_PREFIX)) return false;
  return !/[\s<>"'`]/.test(url);
}

export interface ReleaseInfo {
  /** canonical x.y.z (tag without 'v') */
  version: string;
  url: string;
}

export type ReleaseParse = { kind: 'release'; release: ReleaseInfo } | { kind: 'skip' } | { kind: 'invalid' };

/** Parses the body of GET /releases/latest. Drafts and pre-releases are skipped; anything malformed is invalid. */
export function parseLatestRelease(body: unknown): ReleaseParse {
  if (!body || typeof body !== 'object') return { kind: 'invalid' };
  const r = body as Record<string, unknown>;
  if (r.draft === true || r.prerelease === true) return { kind: 'skip' };
  const version = normalizeVersion(r.tag_name);
  if (!version) return { kind: 'invalid' };
  if (!isReleasePageUrl(r.html_url)) return { kind: 'invalid' };
  return { kind: 'release', release: { version, url: r.html_url } };
}
