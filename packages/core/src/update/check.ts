import { LATEST_RELEASE_API, isReleasePageUrl, parseLatestRelease, type ReleaseInfo } from './release';
import { isNewerVersion, normalizeVersion } from './semver';

/** chrome.storage.local key (extension) / GM storage key (userscript). */
export const UPDATE_STATE_KEY = 'nvt.update';
export const UPDATE_CHECK_INTERVAL_MS = 8 * 60 * 60_000;
/** after a failed check (network, 404, rate limit, garbage) the next try is no sooner than this */
export const UPDATE_RETRY_INTERVAL_MS = 60 * 60_000;

/**
 * Stored result. `version`/`url` are present only while a NEWER release than the installed one is known.
 * `failed` marks a check that did not get a usable answer (the previous version/url are kept if still valid).
 */
export interface UpdateState {
  checkedAt: number;
  failed?: boolean;
  version?: string;
  url?: string;
}

export interface UpdateInfo {
  version: string;
  url: string;
}

export interface UpdateCheckResult {
  update: UpdateInfo | null;
  failed: boolean;
}

/** Performs one GET and returns status + parsed JSON body; the host decides transport (fetch / GM_xmlhttpRequest). */
export type JsonFetch = (url: string, headers: Record<string, string>) => Promise<{ status: number; body: unknown }>;

/** true when no check has happened yet, the clock went backwards, or the interval (8 h, or 1 h after a failure) has passed. */
export function isCheckDue(state: UpdateState | undefined, now: number): boolean {
  if (!state || !Number.isFinite(state.checkedAt)) return true;
  const elapsed = now - state.checkedAt;
  if (elapsed < 0) return true;
  return elapsed >= (state.failed ? UPDATE_RETRY_INTERVAL_MS : UPDATE_CHECK_INTERVAL_MS);
}

/** The update to show for a stored state, or null (nothing stored, not newer than `current`, or a foreign URL). */
export function updateFromState(state: UpdateState | undefined, current: string): UpdateInfo | null {
  if (!state || typeof state.version !== 'string' || !isReleasePageUrl(state.url)) return null;
  if (!isNewerVersion(state.version, current)) return null;
  return { version: normalizeVersion(state.version) ?? state.version, url: state.url };
}

export function checkResultFromState(state: UpdateState | undefined, current: string): UpdateCheckResult {
  return { update: updateFromState(state, current), failed: state?.failed === true };
}

export type CheckOutcome = { kind: 'answer'; release: ReleaseInfo | null } | { kind: 'failed' };

/** Pure state transition. Newer release => stored; same/older => no update (a stored one is dropped); failure => keep the still-valid update, mark failed. */
export function applyCheckOutcome(prev: UpdateState | undefined, outcome: CheckOutcome, current: string, now: number): UpdateState {
  if (outcome.kind === 'failed') {
    const keep = updateFromState(prev, current);
    return keep ? { checkedAt: now, failed: true, version: keep.version, url: keep.url } : { checkedAt: now, failed: true };
  }
  const rel = outcome.release;
  if (rel && isNewerVersion(rel.version, current)) return { checkedAt: now, version: rel.version, url: rel.url };
  return { checkedAt: now };
}

/** One check against GitHub. Never throws: every failure becomes {failed:true}. Sends only the GET with an Accept header. */
export async function checkForUpdate(opts: { fetchJson: JsonFetch; current: string; prev?: UpdateState; now: number }): Promise<UpdateState> {
  let outcome: CheckOutcome;
  try {
    const res = await opts.fetchJson(LATEST_RELEASE_API, { Accept: 'application/vnd.github+json' });
    const parsed = res.status === 200 ? parseLatestRelease(res.body) : { kind: 'invalid' as const };
    outcome = parsed.kind === 'invalid' ? { kind: 'failed' } : { kind: 'answer', release: parsed.kind === 'release' ? parsed.release : null };
  } catch {
    outcome = { kind: 'failed' };
  }
  return applyCheckOutcome(opts.prev, outcome, opts.current, opts.now);
}
