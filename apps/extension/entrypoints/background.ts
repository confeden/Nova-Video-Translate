import { browser, type Browser } from 'wxt/browser';
import { diag, buildAuthUrl, checkYandexToken, createCodeVerifier, createState, createYandexProviders, describeLoginError, exchangeCode, handleCacheMessage, IdbCache, isCacheMessage, startCacheMaintenance, YANDEX_OAUTH } from '@nvt/core';
import { fromB64, logPath, swFetchTransport, toB64, type SwState, type WireReq, type WireRes } from '../utils/swTransport';
import { YANDEX_AUTH_KEY, YANDEX_LOGIN_ERROR_KEY, type YandexAuth } from '../utils/settings';
import { handleLocalTtsMessage } from '../utils/localtts/background';

/**
 * Yandex's balancer answers HTTP 402 to any request carrying Origin or Sec-Fetch-Mode: cors (gotcha G4).
 * A service-worker fetch always carries them, so a (session) DNR ruleset removes Origin and rewrites
 * Sec-Fetch-Mode for the Yandex hosts (API + mp3 storage).
 */
const RULE_ID = 1;
const YANDEX_DOMAINS = ['api.browser.yandex.ru', 'mds.yandex.net'];

function yandexRule(): Browser.declarativeNetRequest.Rule {
  return {
    id: RULE_ID,
    priority: 1,
    action: {
      type: 'modifyHeaders' as Browser.declarativeNetRequest.RuleActionType,
      requestHeaders: [
        { header: 'Origin', operation: 'remove' as Browser.declarativeNetRequest.HeaderOperation },
        { header: 'Sec-Fetch-Mode', operation: 'set' as Browser.declarativeNetRequest.HeaderOperation, value: 'no-cors' },
      ],
    },
    condition: {
      requestDomains: YANDEX_DOMAINS,
      resourceTypes: ['xmlhttprequest', 'other'] as Browser.declarativeNetRequest.ResourceType[],
    },
  };
}

/**
 * SESSION rules, re-installed on every service-worker start: verified in a fresh Yandex Browser profile that
 * updateDynamicRules failed with "Internal error while updating dynamic rules" (nothing was ever installed => every
 * Yandex call got 402) while updateSessionRules worked. Any stale dynamic rule from older versions is removed.
 */
async function installRules(): Promise<void> {
  await browser.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [RULE_ID] }).catch(() => {});
  await browser.declarativeNetRequest.updateSessionRules({ removeRuleIds: [RULE_ID], addRules: [yandexRule()] });
}

/** Requests must not leave before the rules are in place (a worker woken by a message could otherwise race them). */
const rulesReady: Promise<void> = installRules().catch((e) => {
  console.error('NVT: DNR rules failed', e instanceof Error ? e.message : 'error');
});

interface SwJob {
  ac: AbortController;
  t0: number;
  stage: 'rules' | 'fetch' | 'encode';
  path: string;
}
const inflight = new Map<string, SwJob>();
/** a request the page forgot about (lost abort message) must not hang the worker forever */
const SW_HARD_CAP_MS = 150_000;

async function handleHttp(req: WireReq): Promise<WireRes> {
  const ac = new AbortController();
  const swRecvAt = Date.now();
  const path = logPath(req.url);
  const job: SwJob = { ac, t0: swRecvAt, stage: 'rules', path };
  inflight.set(req.id, job);
  const cap = setTimeout(() => ac.abort(), SW_HARD_CAP_MS);
  let swFetchAt: number | undefined;
  try {
    await rulesReady;
    job.stage = 'fetch';
    swFetchAt = Date.now();
    diag.log('sw-fetch-start', { id: req.id, m: req.method, path, deliver: req.sentAt ? swRecvAt - req.sentAt : undefined, rulesMs: swFetchAt - swRecvAt });
    const res = await swFetchTransport({
      url: req.url,
      method: req.method,
      headers: req.headers,
      body: req.bodyB64 ? fromB64(req.bodyB64) : undefined,
      signal: ac.signal,
    });
    const swDoneAt = Date.now();
    diag.log('sw-fetch-end', { id: req.id, path, status: res.status, ms: swDoneAt - swFetchAt, bytes: res.body.length });
    job.stage = 'encode';
    return { ok: true, status: res.status, headers: res.headers, bodyB64: toB64(res.body), swRecvAt, swFetchAt, swDoneAt, bytes: res.body.length };
  } catch (e) {
    const swDoneAt = Date.now();
    const error = (e as Error)?.message ?? String(e);
    diag.log('sw-fetch-err', { id: req.id, path, stage: job.stage, ms: swDoneAt - (swFetchAt ?? swRecvAt), err: error.slice(0, 100) });
    return { ok: false, error, swRecvAt, swFetchAt, swDoneAt };
  } finally {
    clearTimeout(cap);
    inflight.delete(req.id);
  }
}

function swState(): SwState {
  const now = Date.now();
  return { now, reqs: [...inflight.entries()].map(([id, j]) => ({ id, ageS: Math.round((now - j.t0) / 100) / 10, stage: j.stage, path: j.path })) };
}

// ---- Yandex OAuth (PKCE, D12): verifier/state live in storage.session until the code comes back ----
const OAUTH_SESSION_KEY = 'nvt.oauthPending';
const OAUTH_TTL_MS = 10 * 60_000;
let lastCode = '';

async function oauthBegin(): Promise<string> {
  const verifier = createCodeVerifier();
  const state = createState();
  await browser.storage.session.set({ [OAUTH_SESSION_KEY]: { verifier, state, at: Date.now() } });
  return buildAuthUrl({ verifier, state });
}

async function fetchLogin(token: string): Promise<string | undefined> {
  const r = await checkYandexToken(token, swFetchTransport);
  return r.ok ? r.login : undefined;
}

const loginFailed = (message: string): Promise<void> => browser.storage.local.set({ [YANDEX_LOGIN_ERROR_KEY]: { at: Date.now(), message } });

/** Completes the login. Returns true on success; on failure stores a Russian explanation for the options page. */
async function oauthFinish(code: string, state: string): Promise<boolean> {
  const got = await browser.storage.session.get(OAUTH_SESSION_KEY);
  const p = got[OAUTH_SESSION_KEY] as { verifier: string; state: string; at: number } | undefined;
  await browser.storage.session.remove(OAUTH_SESSION_KEY);
  if (!p) {
    await loginFailed('Вход не был начат в этом браузере или сессия расширения сброшена — нажмите «Войти в Яндекс» в настройках ещё раз');
    return false;
  }
  if (p.state !== state) {
    await loginFailed('Не совпал контрольный код входа (state) — начните вход заново из настроек');
    return false;
  }
  if (Date.now() - p.at > OAUTH_TTL_MS) {
    await loginFailed('Вход не завершён за 10 минут — начните заново');
    return false;
  }
  try {
    const tok = await exchangeCode(code, p.verifier, swFetchTransport);
    const auth: YandexAuth = { token: tok.accessToken, expiresAt: tok.expiresAt, login: await fetchLogin(tok.accessToken) };
    await browser.storage.local.set({ [YANDEX_AUTH_KEY]: auth });
    await browser.storage.local.remove(YANDEX_LOGIN_ERROR_KEY);
    return true;
  } catch (e) {
    await loginFailed(describeLoginError(e));
    return false;
  }
}

/** local log sink: tools/diag-server.mjs (127.0.0.1 only) */
const DIAG_SINK = 'http://127.0.0.1:8765/log';

/** Result cache (IndexedDB of the extension origin: shared by every site; content scripts reach it via messages). */
const resultCache = new IdbCache();

export default defineBackground(() => {
  startCacheMaintenance(resultCache);
  // debugging / verification hook (used for the DNR header-rewrite test over CDP)
  (globalThis as unknown as { nvtTransport?: unknown }).nvtTransport = swFetchTransport;
  (globalThis as unknown as { __nvtSwDiag?: unknown }).__nvtSwDiag = diag;
  (globalThis as unknown as { nvtDebug?: unknown }).nvtDebug = { oauthBegin, oauthFinish, createYandexProviders, swFetchTransport };

  browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'nvt-ltts') return handleLocalTtsMessage(msg, _sender, sendResponse);
    if (isCacheMessage(msg)) {
      void handleCacheMessage(resultCache, msg).then(sendResponse);
      return true;
    }
    if (msg?.type === 'nvt-http' && msg.req) {
      void handleHttp(msg.req as WireReq).then(sendResponse);
      return true; // async response
    }
    if (msg?.type === 'nvt-diag-push' && Array.isArray(msg.entries)) {
      // the page's diagnostics go to the local sink; the sink wipes its file on a version change or after 24 h
      void fetch(DIAG_SINK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: browser.runtime.getManifest().version, page: msg.page, entries: msg.entries }),
      }).catch(() => {});
      return false;
    }
    if (msg?.type === 'nvt-sw-diag') {
      sendResponse(diag.report());
      return false;
    }
    if (msg?.type === 'nvt-sw-state') {
      sendResponse(swState());
      return false;
    }
    if (msg?.type === 'nvt-oauth-begin') {
      oauthBegin().then(
        async (url) => {
          if (msg.open) await browser.tabs.create({ url });
          sendResponse({ ok: true, url: msg.open ? undefined : url });
        },
        (e) => sendResponse({ ok: false, error: String(e) }),
      );
      return true;
    }
    if (msg?.type === 'nvt-oauth-code' && typeof msg.code === 'string' && typeof msg.state === 'string') {
      // only the genuine callback page may deliver a code
      if (!String(_sender.url ?? '').startsWith(`${YANDEX_OAUTH.redirectUri}`)) return false;
      const tabId = _sender.tab?.id;
      // the callback page can deliver the same code twice (reload): process each code once
      if (msg.code === lastCode) return false;
      lastCode = msg.code;
      oauthFinish(msg.code, msg.state)
        .then((ok) => {
          // on success the tab is no longer needed; on failure it stays so the user is not left with a vanished window
          if (ok && tabId !== undefined) void browser.tabs.remove(tabId).catch(() => {});
        })
        .catch((e) => console.error('NVT: OAuth exchange failed', e instanceof Error ? e.message : 'error'));
      return false;
    }
    if (msg?.type === 'nvt-oauth-logout') {
      void browser.storage.local.remove(YANDEX_AUTH_KEY).then(() => sendResponse({ ok: true }));
      return true;
    }
    if (msg?.type === 'nvt-http-abort' && typeof msg.id === 'string') {
      inflight.get(msg.id)?.ac.abort();
    }
    return false;
  });
  console.log('NVT background ready');
});
