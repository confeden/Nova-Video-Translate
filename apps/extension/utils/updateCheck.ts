import { browser } from 'wxt/browser';
import { checkForUpdate, checkResultFromState, isCheckDue, isReleasePageUrl, UPDATE_STATE_KEY, type JsonFetch, type UpdateCheckResult, type UpdateState } from '@nvt/core';

/** alarm period; the due check (8 h, or 1 h after a failure) decides whether a request is actually made */
export const UPDATE_ALARM = 'nvt.updateCheck';
const ALARM_PERIOD_MIN = 60;
const FETCH_TIMEOUT_MS = 15_000;

/** The one GET of the update check: no cookies, no auth, Accept header only (see core checkForUpdate). */
const fetchJson: JsonFetch = async (url, headers) => {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: 'GET', headers, credentials: 'omit', cache: 'no-store', signal: ac.signal });
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
};

async function readState(): Promise<UpdateState | undefined> {
  try {
    const got = await browser.storage.local.get(UPDATE_STATE_KEY);
    const st = got[UPDATE_STATE_KEY] as UpdateState | undefined;
    return st && typeof st === 'object' ? st : undefined;
  } catch {
    return undefined;
  }
}

let running: Promise<UpdateCheckResult> | undefined;

/**
 * Runs a check when due (or always when forced) and stores the result. Concurrent callers share one request.
 * Never rejects: a failure is recorded in the state and reported as {failed:true}.
 */
export function runUpdateCheck(force: boolean): Promise<UpdateCheckResult> {
  if (running) return running;
  running = (async (): Promise<UpdateCheckResult> => {
    const current = browser.runtime.getManifest().version;
    const prev = await readState();
    if (!force && !isCheckDue(prev, Date.now())) return checkResultFromState(prev, current);
    const next = await checkForUpdate({ fetchJson, current, prev, now: Date.now() });
    try {
      await browser.storage.local.set({ [UPDATE_STATE_KEY]: next });
    } catch {
      // storage unavailable: the result is still returned for this session
    }
    return checkResultFromState(next, current);
  })()
    .catch((): UpdateCheckResult => ({ update: null, failed: true }))
    .finally(() => {
      running = undefined;
    });
  return running;
}

/** Called on every service-worker start (catch-up) and by the alarm. */
export function scheduleUpdateCheck(): void {
  void runUpdateCheck(false);
  browser.alarms
    .get(UPDATE_ALARM)
    .then((a) => {
      if (!a) return browser.alarms.create(UPDATE_ALARM, { periodInMinutes: ALARM_PERIOD_MIN });
      return undefined;
    })
    .catch(() => undefined);
}

/** Opens a release page in a new tab; anything outside this repository is refused. */
export async function openReleasePage(url: unknown): Promise<boolean> {
  if (!isReleasePageUrl(url)) return false;
  await browser.tabs.create({ url });
  return true;
}
