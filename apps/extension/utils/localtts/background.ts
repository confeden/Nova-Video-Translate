/**
 * Service-worker side of the local TTS engines: owns the persisted per-unit LttsState and the browser capabilities (LttsEnv),
 * creates / closes the offscreen document on demand and relays requests from content scripts and extension pages to it.
 * Hook: handleLocalTtsMessage() in background.ts.
 */
import { browser } from 'wxt/browser';
import { LASR_MSG, LTTS_ENV_KEY, LTTS_MSG, VOICE_CALIB_STORAGE_KEY, WHISPER_MODELS, lasrStateKey, allUnits, diag, engineInfo, initialState, unitById, unitFor, unitStateKey, type LocalTtsEngineId, type LttsEnv, type LttsEvent, type LttsReply, type LttsRequest, type LttsState } from '@nvt/core';

/** chrome.storage.local key of dev/mirror base-URL overrides: { [unitId]: baseUrl } (e.g. a self-hosted copy of the Silero files) */
export const LTTS_BASEURLS_KEY = 'nvt.localtts.baseUrls';

interface OffscreenApi {
  createDocument(o: { url: string; reasons: string[]; justification: string }): Promise<void>;
  closeDocument(): Promise<void>;
}
export const offscreenApi = (): OffscreenApi | undefined => (browser as unknown as { offscreen?: OffscreenApi }).offscreen;
const OFFSCREEN_PATH = 'offscreen.html';
export const offscreenUrl = (): string => browser.runtime.getURL(`/${OFFSCREEN_PATH}` as never);

// ---- persisted state (one record per download unit; serialised read-modify-write) ----
let chain: Promise<unknown> = Promise.resolve();
function mutate(unitId: string, fn: (s: LttsState) => LttsState): Promise<LttsState> {
  const p = chain.then(async () => {
    const unit = unitById(unitId);
    const key = unitStateKey(unitId);
    const got = await browser.storage.local.get(key);
    let s = got[key] as LttsState | undefined;
    if (!s || (unit && s.rev !== unit.rev)) s = initialState(unit?.total ?? 0, unit?.rev ?? '');
    const next = { ...fn(s), updatedAt: Date.now() };
    await browser.storage.local.set({ [key]: next });
    return next;
  });
  chain = p.catch(() => undefined);
  return p;
}
/** read-only (no storage write: this runs on every synth request) */
async function readState(unitId: string): Promise<LttsState> {
  const unit = unitById(unitId);
  const got = await browser.storage.local.get(unitStateKey(unitId));
  const s = got[unitStateKey(unitId)] as LttsState | undefined;
  return s && (!unit || s.rev === unit.rev) ? s : initialState(unit?.total ?? 0, unit?.rev ?? '');
}

function mutateEnv(fn: (e: LttsEnv) => LttsEnv): Promise<LttsEnv> {
  const p = chain.then(async () => {
    const got = await browser.storage.local.get(LTTS_ENV_KEY);
    const next = fn((got[LTTS_ENV_KEY] as LttsEnv | undefined) ?? {});
    await browser.storage.local.set({ [LTTS_ENV_KEY]: next });
    return next;
  });
  chain = p.catch(() => undefined);
  return p;
}

async function baseUrlOverride(unitId: string): Promise<string | undefined> {
  const got = await browser.storage.local.get(LTTS_BASEURLS_KEY);
  const v = (got[LTTS_BASEURLS_KEY] as Record<string, unknown> | undefined)?.[unitId];
  return typeof v === 'string' && /^https?:\/\//.test(v) ? v : undefined;
}

// ---- offscreen document lifecycle ----
let creating: Promise<void> | undefined;

export async function hasOffscreen(): Promise<boolean> {
  const rt = browser.runtime as unknown as { getContexts?: (f: { contextTypes: string[] }) => Promise<unknown[]> };
  if (!rt.getContexts) return false;
  try {
    return (await rt.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length > 0;
  } catch {
    return false;
  }
}

export async function ensureOffscreen(): Promise<void> {
  const api = offscreenApi();
  if (!api) throw new Error('chrome.offscreen недоступен в этом браузере');
  if (await hasOffscreen()) return;
  creating ??= api
    .createDocument({ url: OFFSCREEN_PATH, reasons: ['WORKERS'], justification: 'Local speech models (text-to-speech and Whisper recognition; onnxruntime-web / WebGPU / WASM) and their model caches' })
    .catch((e: Error) => {
      if (!/single offscreen|already exist/i.test(String(e?.message))) throw e;
    })
    .finally(() => {
      creating = undefined;
    });
  await creating;
}

async function closeOffscreen(): Promise<void> {
  try {
    await offscreenApi()?.closeDocument();
  } catch {
    /* already closed */
  }
}

/** sends to the offscreen document; retries while its listener is still registering */
export async function toOffscreen<T>(msg: object, type: string = LTTS_MSG): Promise<LttsReply<T>> {
  await ensureOffscreen();
  let last = 'no answer';
  for (let i = 0; i < 8; i++) {
    try {
      const r = (await browser.runtime.sendMessage({ ...msg, type, to: 'offscreen' })) as LttsReply<T> | undefined;
      if (r) return r;
    } catch (e) {
      last = String((e as Error)?.message ?? e);
      if (!/Receiving end does not exist|Could not establish connection|message port closed/i.test(last)) break;
    }
    await new Promise((r) => setTimeout(r, 150 * (i + 1)));
  }
  return { ok: false, error: last };
}

/** a download that the offscreen document no longer runs (browser restarted, document closed) is not "downloading" */
async function reconcile(unitId: string, s: LttsState): Promise<LttsState> {
  if (s.model === 'downloading' && !(await hasOffscreen())) return mutate(unitId, (x) => (x.model === 'downloading' ? { ...x, model: 'none' } : x));
  return s;
}

function onEvent(e: LttsEvent): void {
  const unit = 'unit' in e && e.unit ? e.unit : 'supertonic';
  switch (e.ev) {
    case 'progress':
      void mutate(unit, (s) => ({ ...s, model: 'downloading', loaded: e.loaded, total: e.total, error: undefined }));
      break;
    case 'downloaded':
      diag.log('localtts-download', { unit, bytes: e.bytes, fetched: e.fetchedBytes, ms: e.ms });
      void mutate(unit, (s) => ({ ...s, model: 'ready', loaded: s.total, error: undefined }));
      break;
    case 'error':
      void mutate(unit, (s) => ({ ...s, model: e.missing ? 'none' : s.model === 'ready' ? 'ready' : 'error', loaded: e.missing ? 0 : s.loaded, error: e.message }));
      break;
    case 'gpu':
      void mutateEnv((x) => (x.gpu === e.gpu ? x : { ...x, gpu: e.gpu }));
      break;
    case 'deleted':
      void mutate(unit, (s) => initialState(s.total, s.rev));
      break;
    case 'idle-close':
      void closeOffscreen();
      break;
  }
}

const DEFAULT_ENGINE: LocalTtsEngineId = 'supertonic-webgpu';

/** Returns true when it answers asynchronously (keep the channel open). Ignores everything that is not ours. */
export function handleLocalTtsMessage(raw: unknown, sender: { id?: string; url?: string }, sendResponse: (r: unknown) => void): boolean {
  const msg = raw as LttsRequest | undefined;
  if (!msg || msg.type !== LTTS_MSG || msg.to !== 'bg') return false;
  if (sender.id !== browser.runtime.id) return false;
  const answer = (p: Promise<unknown>): true => {
    void p.then(sendResponse, (e) => sendResponse({ ok: false, error: String((e as Error)?.message ?? e) }));
    return true;
  };
  if ((msg.op as string) === 'event') {
    if (String(sender.url ?? '').startsWith(offscreenUrl())) onEvent(msg as unknown as LttsEvent);
    return false;
  }
  const engineOf = (m: { engine?: LocalTtsEngineId }): LocalTtsEngineId => m.engine ?? DEFAULT_ENGINE;
  switch (msg.op) {
    case 'status':
      return answer((async () => {
        const hasApi = !!offscreenApi();
        let env = await mutateEnv((x) => (x.offscreen === hasApi ? x : { ...x, offscreen: hasApi }));
        for (const u of allUnits()) await reconcile(u.id, await readState(u.id));
        if (msg.probe && hasApi && env.gpu === undefined) {
          const r = await toOffscreen<{ gpu: boolean }>({ op: 'status' });
          if (r.ok) env = await mutateEnv((x) => ({ ...x, gpu: r.gpu }));
        }
        return { ok: true, env, state: await readState('supertonic') };
      })());
    case 'download':
      return answer((async () => {
        const engine = engineOf(msg);
        const unit = unitFor(engine, msg.voice);
        const info = engineInfo(engine);
        if (!unit || !info) return { ok: false, error: 'неизвестный движок' };
        if (!offscreenApi()) return { ok: false, error: 'chrome.offscreen недоступен в этом браузере' };
        const env = await mutateEnv((x) => x);
        if (info.needsGpu && env.gpu === false) return { ok: false, error: 'WebGPU недоступен' };
        const override = msg.baseUrl || (await baseUrlOverride(unit.id));
        if (!unit.published && !override) return { ok: false, error: 'модель ещё не опубликована' };
        const s = await reconcile(unit.id, await readState(unit.id));
        if (s.model === 'downloading') return { ok: true };
        await mutate(unit.id, (x) => ({ ...x, model: 'downloading', error: undefined }));
        const r = await toOffscreen({ op: 'download', engine, voice: msg.voice, baseUrl: override });
        if (!r.ok) await mutate(unit.id, (x) => ({ ...x, model: 'error', error: r.error }));
        return r;
      })());
    case 'download-cancel':
      return answer((async () => {
        const unit = unitFor(engineOf(msg), msg.voice);
        const r = await toOffscreen({ op: 'download-cancel', engine: engineOf(msg), voice: msg.voice });
        if (unit) await mutate(unit.id, (x) => (x.model === 'downloading' ? { ...x, model: 'none' } : x));
        return r;
      })());
    case 'delete':
      return answer(toOffscreen({ op: 'delete', engine: engineOf(msg), voice: msg.voice }));
    case 'clear-all':
      return false; // only clearAllLocalModels() sends it, straight to the offscreen document
    default:
      // warm / synth / abort / selftest: straight to the offscreen document
      if (msg.op === 'abort') {
        void hasOffscreen().then((has) => (has ? toOffscreen({ op: 'abort', id: msg.id }) : undefined));
        sendResponse({ ok: true });
        return false;
      }
      return answer((async () => {
        if (msg.op !== 'selftest') {
          const unit = unitFor(engineOf(msg), msg.voice);
          if (!unit || (await readState(unit.id)).model !== 'ready') return { ok: false, error: 'model not downloaded' };
        }
        return toOffscreen({ ...msg });
      })());
  }
}

/** "Delete all models": offscreen stops downloads / releases engines / wipes OPFS + Cache API, then the persisted states and voice calibrations go */
export async function clearAllLocalModels(): Promise<{ freedBytes: number }> {
  let freed = 0;
  await ensureOffscreen();
  for (const type of [LTTS_MSG, LASR_MSG]) {
    const r = await toOffscreen<{ freedBytes: number }>({ op: 'clear-all' }, type);
    if (!r.ok) throw new Error(r.error);
    freed += r.freedBytes;
  }
  const keys = [VOICE_CALIB_STORAGE_KEY, ...allUnits().map((u) => unitStateKey(u.id)), ...WHISPER_MODELS.map((m) => lasrStateKey(m.id))];
  await chain.catch(() => undefined);
  await browser.storage.local.remove(keys);
  await closeOffscreen();
  await new Promise((r) => setTimeout(r, 300)); // late events of the cancelled downloads
  await browser.storage.local.remove(keys);
  return { freedBytes: freed };
}
