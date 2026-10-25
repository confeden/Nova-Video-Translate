/**
 * Service-worker side of the local Whisper engine: owns the persisted per-model LasrState and the browser capabilities
 * (LasrEnv), relays requests from content scripts / extension pages to the offscreen document (shared with local TTS).
 * Hook: handleLocalAsrMessage() in background.ts.
 */
import { browser } from 'wxt/browser';
import { LASR_ENV_KEY, LASR_MSG, cachedDtypes, deviceForDtype, diag, initialState, isGpuDtype, lasrStateKey, WHISPER_MODELS, whisperBytes, whisperModelInfo, type LasrEnv, type LasrEvent, type LasrReply, type LasrRequest, type LasrState } from '@nvt/core';
import { hasOffscreen, offscreenApi, offscreenUrl, toOffscreen as relay } from '../localtts/background';

const toOffscreen = <T>(msg: object): Promise<LasrReply<T>> => relay<T>(msg, LASR_MSG) as Promise<LasrReply<T>>;

// ---- persisted state (serialised read-modify-write) ----
let chain: Promise<unknown> = Promise.resolve();
const freshState = (modelId: string, env?: LasrEnv): LasrState => {
  const info = whisperModelInfo(modelId);
  return initialState(info ? whisperBytes(info, env) : 0, info?.revision ?? '');
};
function mutate(modelId: string, fn: (s: LasrState) => LasrState): Promise<LasrState> {
  const p = chain.then(async () => {
    const key = lasrStateKey(modelId);
    const got = await browser.storage.local.get([key, LASR_ENV_KEY]);
    const info = whisperModelInfo(modelId);
    let s = got[key] as LasrState | undefined;
    if (!s || (info && s.rev !== info.revision)) s = freshState(modelId, got[LASR_ENV_KEY] as LasrEnv | undefined);
    const next = { ...fn(s), updatedAt: Date.now() };
    await browser.storage.local.set({ [key]: next });
    return next;
  });
  chain = p.catch(() => undefined);
  return p;
}
/** read-only (no storage write: this runs on every transcribe request) */
async function readState(modelId: string): Promise<LasrState> {
  const key = lasrStateKey(modelId);
  const got = await browser.storage.local.get([key, LASR_ENV_KEY]);
  const info = whisperModelInfo(modelId);
  const s = got[key] as LasrState | undefined;
  return s && (!info || s.rev === info.revision) ? s : freshState(modelId, got[LASR_ENV_KEY] as LasrEnv | undefined);
}
function mutateEnv(fn: (e: LasrEnv) => LasrEnv): Promise<LasrEnv> {
  const p = chain.then(async () => {
    const got = await browser.storage.local.get(LASR_ENV_KEY);
    const next = fn((got[LASR_ENV_KEY] as LasrEnv | undefined) ?? {});
    await browser.storage.local.set({ [LASR_ENV_KEY]: next });
    return next;
  });
  chain = p.catch(() => undefined);
  return p;
}

/** a download the offscreen document no longer runs (browser restarted, document closed) is not "downloading" */
async function reconcile(modelId: string, s: LasrState): Promise<LasrState> {
  if (s.model === 'downloading' && !(await hasOffscreen())) return mutate(modelId, (x) => (x.model === 'downloading' ? { ...x, model: 'none' } : x));
  if (s.upgrade && !(await hasOffscreen())) return mutate(modelId, (x) => ({ ...x, upgrade: undefined }));
  return s;
}

function extVersion(): string {
  try {
    return browser.runtime.getManifest().version;
  } catch {
    return '?';
  }
}

function onEvent(e: LasrEvent): void {
  switch (e.ev) {
    case 'progress':
      if (e.upgrade) {
        void mutate(e.model, (s) => ({ ...s, upgrade: { loaded: e.loaded, total: Math.max(s.upgrade?.total ?? 0, e.total) }, upgradeError: undefined }));
        break;
      }
      void mutate(e.model, (s) => ({ ...s, model: 'downloading', loaded: e.loaded, total: Math.max(s.total, e.total), error: undefined }));
      break;
    case 'downloaded':
      diag.log('localasr-download', { model: e.model, device: e.device, dtype: e.dtype, ms: e.ms });
      void mutate(e.model, (s) => ({ ...s, model: 'ready', loaded: s.total, device: e.device, dtype: e.dtype, files: { ...(s.model === 'ready' ? s.files : undefined), [e.dtype]: true }, upgrade: undefined, upgradeError: undefined, cpu: undefined, cpuAt: undefined, cpuVer: undefined, error: undefined }));
      break;
    case 'error':
      if (e.upgrade) {
        void mutate(e.model, (s) => ({ ...s, upgrade: undefined, upgradeError: e.message }));
        break;
      }
      void mutate(e.model, (s) => ({ ...s, model: e.missing ? 'none' : s.model === 'ready' ? 'ready' : 'error', loaded: e.missing ? 0 : s.loaded, error: e.message }));
      break;
    case 'fallback':
      diag.log('localasr-fallback', { model: e.model, device: e.device, dtype: e.dtype, reason: e.reason, caps: e.diag });
      // the real error text (not an ORT pointer number): raw thrown value + the result of a direct GPUAdapter.requestDevice() probe
      diag.log('localasr-gpu-fail', { model: e.model, message: e.reason, raw: e.raw, deviceError: e.deviceError, caps: e.diag, ver: extVersion() });
      void mutate(e.model, (s) => ({ ...s, device: e.device, dtype: e.dtype, files: { ...s.files, ...(s.dtype ? { [s.dtype]: true } : {}), [e.dtype]: true }, upgradeError: e.reason, cpu: true, cpuAt: Date.now(), cpuVer: extVersion() }));
      break;
    case 'gpu-fail':
      // the GPU files are cached but the WebGPU session failed: q8 on WASM keeps serving; the real reason stays in the panel
      diag.log('localasr-gpu-fail', { model: e.model, message: e.message, raw: e.raw, deviceError: e.deviceError, caps: e.diag, ver: extVersion(), upgrade: true });
      void mutate(e.model, (s) => ({ ...s, device: 'wasm', dtype: 'q8', files: { ...s.files, 'gpu-mixed': true }, upgrade: undefined, upgradeError: e.message, cpu: true, cpuAt: Date.now(), cpuVer: extVersion() }));
      break;
    case 'device':
      diag.log('localasr-device', { model: e.model, device: e.device, dtype: e.dtype });
      void mutate(e.model, (s) => ({ ...s, device: e.device, dtype: e.dtype, files: { ...s.files, [e.dtype]: true }, upgradeError: undefined, cpu: undefined, cpuAt: undefined, cpuVer: undefined }));
      break;
    case 'deleted':
      void mutate(e.model, (s) => ({ ...freshState(e.model), total: s.total }));
      break;
    case 'gpu':
      void mutateEnv((x) => (x.gpu === e.gpu && x.f16 === e.f16 ? x : { ...x, gpu: e.gpu, f16: e.f16 }));
      break;
  }
}

/** Returns true when it answers asynchronously (keep the channel open). Ignores everything that is not ours. */
export function handleLocalAsrMessage(raw: unknown, sender: { id?: string; url?: string }, sendResponse: (r: unknown) => void): boolean {
  const msg = raw as LasrRequest | undefined;
  if (!msg || msg.type !== LASR_MSG || msg.to !== 'bg') return false;
  if (sender.id !== browser.runtime.id) return false;
  const answer = (p: Promise<unknown>): true => {
    void p.then(sendResponse, (e) => sendResponse({ ok: false, error: String((e as Error)?.message ?? e) }));
    return true;
  };
  if ((msg.op as string) === 'event') {
    if (String(sender.url ?? '').startsWith(offscreenUrl())) onEvent(msg as unknown as LasrEvent);
    return false;
  }
  switch (msg.op) {
    case 'status':
      return answer((async () => {
        const hasApi = !!offscreenApi();
        let env = await mutateEnv((x) => (x.offscreen === hasApi ? x : { ...x, offscreen: hasApi }));
        for (const m of WHISPER_MODELS) await reconcile(m.id, await readState(m.id));
        if (msg.probe && hasApi && env.gpu === undefined) {
          const r = await toOffscreen<{ gpu: boolean; f16: boolean }>({ op: 'status' });
          if (r.ok) env = await mutateEnv((x) => ({ ...x, gpu: r.gpu, f16: r.f16 }));
        }
        return { ok: true, env };
      })());
    case 'download':
      return answer((async () => {
        if (!whisperModelInfo(msg.model)) return { ok: false, error: 'неизвестная модель' };
        if (!offscreenApi()) return { ok: false, error: 'chrome.offscreen недоступен в этом браузере' };
        const s = await reconcile(msg.model, await readState(msg.model));
        if (s.model === 'downloading') return { ok: true };
        if (msg.dtype === 'gpu-mixed') {
          // GPU upgrade of a ready model: the model keeps serving (q8/WASM) while the gpu-mixed files come down
          if (s.model !== 'ready') return { ok: false, error: 'сначала скачайте модель' };
          if (s.upgrade) return { ok: true };
          await mutate(msg.model, (x) => ({ ...x, upgrade: { loaded: 0, total: whisperModelInfo(msg.model)?.bytes['gpu-mixed'] ?? 0 }, upgradeError: undefined }));
          const r = await toOffscreen({ op: 'download', model: msg.model, dtype: 'gpu-mixed' });
          if (!r.ok) await mutate(msg.model, (x) => ({ ...x, upgrade: undefined, upgradeError: r.error }));
          return r;
        }
        await mutate(msg.model, (x) => ({ ...x, model: 'downloading', loaded: 0, error: undefined }));
        const r = await toOffscreen({ op: 'download', model: msg.model });
        if (!r.ok) await mutate(msg.model, (x) => ({ ...x, model: 'error', error: r.error }));
        return r;
      })());
    case 'download-cancel':
      return answer((async () => {
        const r = await toOffscreen({ op: 'download-cancel', model: msg.model });
        await mutate(msg.model, (x) => (x.model === 'downloading' ? { ...x, model: 'none', loaded: 0 } : x.upgrade ? { ...x, upgrade: undefined } : x));
        return r;
      })());
    case 'delete':
      return answer(toOffscreen({ op: 'delete', model: msg.model }));
    case 'abort':
      void hasOffscreen().then((has) => (has ? toOffscreen({ op: 'abort', id: msg.id }) : undefined));
      sendResponse({ ok: true });
      return false;
    case 'transcribe':
      return answer((async () => {
        const s = await readState(msg.model);
        if (s.model !== 'ready' || !s.device || !s.dtype) return { ok: false, error: 'model not downloaded' };
        // a model remembered as WASM (no GPU at download time, or one failed WebGPU session) re-tests WebGPU. The offscreen
        // document does it at most once per document life (= once per extension version and per new document), so a `cpu` mark
        // never pins the model to WASM for hours; a mark written by another version is stale and cleared here.
        const ver = extVersion();
        if (s.cpu && s.cpuVer !== ver) {
          diag.log('localasr-cpu-mark-cleared', { model: msg.model, markVer: s.cpuVer ?? null, ver, ageMin: s.cpuAt ? Math.round((Date.now() - s.cpuAt) / 60000) : null });
          void mutate(msg.model, (x) => ({ ...x, cpu: undefined, cpuAt: undefined, cpuVer: undefined }));
        }
        // WebGPU is re-tried only when GPU files are in the cache (D31: no download without a click); q8 files run on WASM, period
        const dtype = s.dtype;
        const retryGpu = deviceForDtype(dtype) === 'wasm' && cachedDtypes(s).some((d) => isGpuDtype(d));
        return toOffscreen({ ...msg, device: deviceForDtype(dtype), dtype, retryGpu, cpuAt: s.cpu && s.cpuVer === ver ? s.cpuAt : undefined, cpuVer: s.cpuVer, extVer: ver });
      })());
    default:
      return false;
  }
}
