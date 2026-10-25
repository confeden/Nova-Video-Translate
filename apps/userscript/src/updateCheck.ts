import { UPDATE_STATE_KEY, checkForUpdate, checkResultFromState, isCheckDue, type JsonFetch, type UpdateCheckResult, type UpdateState } from '@nvt/core';
import { gmGet, gmSet, gmXhr } from './gm';
import { NVT_VERSION } from './version';

const TIMEOUT_MS = 15_000;

/** The one GET of the update check via GM_xmlhttpRequest (anonymous: no cookies; @connect api.github.com in vite.config.ts). */
const fetchJson: JsonFetch = (url, headers) =>
  new Promise((resolve, reject) => {
    gmXhr({
      method: 'GET',
      url,
      headers,
      anonymous: true,
      timeout: TIMEOUT_MS,
      responseType: 'text',
      onload: (r) => {
        let body: unknown;
        try {
          body = typeof r.response === 'string' ? JSON.parse(r.response) : undefined;
        } catch {
          body = undefined;
        }
        resolve({ status: r.status, body });
      },
      onerror: () => reject(new Error('GM_xmlhttpRequest failed')),
      ontimeout: () => reject(new Error('GM_xmlhttpRequest timed out')),
    });
  });

function readState(): UpdateState | undefined {
  try {
    const st = gmGet(UPDATE_STATE_KEY) as UpdateState | null | undefined;
    return st && typeof st === 'object' ? st : undefined;
  } catch {
    return undefined;
  }
}

let running: Promise<UpdateCheckResult> | undefined;

/** Same gating as the extension (8 h, 1 h after a failure); stored in GM storage. Never rejects. */
export function runUpdateCheck(force: boolean): Promise<UpdateCheckResult> {
  if (running) return running;
  running = (async (): Promise<UpdateCheckResult> => {
    const prev = readState();
    if (!force && !isCheckDue(prev, Date.now())) return checkResultFromState(prev, NVT_VERSION);
    const next = await checkForUpdate({ fetchJson, current: NVT_VERSION, prev, now: Date.now() });
    try {
      gmSet(UPDATE_STATE_KEY, next);
    } catch {
      // GM storage unavailable: the result is still returned for this page
    }
    return checkResultFromState(next, NVT_VERSION);
  })()
    .catch((): UpdateCheckResult => ({ update: null, failed: true }))
    .finally(() => {
      running = undefined;
    });
  return running;
}
