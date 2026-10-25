/**
 * LocalAsr client for the in-extension Whisper engine ('whisper-webgpu'): a thin proxy over the message protocol (the model
 * lives in the extension's offscreen document, WebGPU with a WASM fallback). Nothing is loaded or downloaded until
 * transcribe()/warmUp(); a model that was not downloaded by a user click makes the engine unavailable. The transport is
 * injected; the default one uses the `chrome` extension globals.
 */
import { diag } from '../diag';
import { ProviderUnavailableError } from '../providers/types';
import { int16ToB64 } from '../localtts/supertonic/pcm';
import { abortError } from '../localtts/supertonic/queue';
import type { LocalAsr, LocalAsrOptions, LocalAsrResult } from './types';
import { cachedDtypes, LASR_ENV_KEY, LASR_MSG, lasrStateKey, type LasrEnv, type LasrOp, type LasrReply, type LasrState, type TranscribeReplyData } from './whisperProtocol';
import { localReasons, reasonText } from './localReason';
import { WHISPER_MODELS, baseLang, isGpuDtype, pickWhisperModel, whisperModelInfo, type LocalAsrModelChoice, type WhisperModelId } from './whisperModels';

export interface LasrTransport {
  /** sends a request to the service worker and resolves with its reply (undefined = nobody answered) */
  send(op: LasrOp): Promise<unknown>;
  /** persisted download state of a model */
  readState(modelId: string): Promise<LasrState | undefined>;
  readEnv?(): Promise<LasrEnv | undefined>;
}

interface ChromeLike {
  runtime?: { sendMessage?: (m: unknown) => Promise<unknown> };
  storage?: { local?: { get: (k: string | string[]) => Promise<Record<string, unknown>> } };
}

/** transport over chrome.runtime / chrome.storage.local (MV3 promise APIs) */
export function chromeLasrTransport(): LasrTransport {
  const c = (globalThis as unknown as { chrome?: ChromeLike }).chrome;
  return {
    async send(op) {
      if (!c?.runtime?.sendMessage) throw new Error('no extension runtime');
      return c.runtime.sendMessage({ ...op, type: LASR_MSG, to: 'bg' });
    },
    async readState(modelId) {
      const key = lasrStateKey(modelId);
      const got = await c?.storage?.local?.get(key);
      return got?.[key] as LasrState | undefined;
    },
    async readEnv() {
      const got = await c?.storage?.local?.get(LASR_ENV_KEY);
      return got?.[LASR_ENV_KEY] as LasrEnv | undefined;
    },
  };
}

/** a model is usable when its files are complete for the pinned revision */
export function lasrStateIsReady(s: LasrState | undefined, modelId: string): boolean {
  const info = whisperModelInfo(modelId);
  return !!s && !!info && s.model === 'ready' && s.rev === info.revision;
}

export interface WhisperAsr extends LocalAsr {
  readonly id: 'whisper-webgpu';
  /** loads the model so the first real chunk is fast; never throws */
  warmUp(): Promise<void>;
}

let seq = 0;
const newId = (): string => `la${Date.now().toString(36)}${(seq++).toString(36)}`;
const asReply = <T>(r: unknown): LasrReply<T> => (r && typeof r === 'object' && 'ok' in r ? (r as LasrReply<T>) : { ok: false, error: 'no answer from the extension' });

/**
 * `getModel` returns the user's setting (localAsrModel). One transcribe() at a time is NOT enforced here: the offscreen
 * document serialises calls itself (the model is single-instance).
 */
export function createWhisperAsr(transport: LasrTransport = chromeLasrTransport(), getModel: () => LocalAsrModelChoice = () => 'auto'): WhisperAsr {
  /** models whose files are complete, refreshed by isAvailable() (languages() is synchronous) */
  let ready = new Set<string>();
  /** ready models whose active plan is WebGPU (not marked CPU): small.en leads the auto order only for these */
  let gpuReady = new Set<string>();
  /** models that answered a request in this session (the first one pays the load) */
  const warm = new Set<string>();
  const deviceLogged = new Set<string>();
  let emptyLogged = false;

  const refresh = async (): Promise<Set<string>> => {
    const next = new Set<string>();
    const gpu = new Set<string>();
    for (const m of WHISPER_MODELS) {
      const st = await transport.readState(m.id).catch(() => undefined);
      if (lasrStateIsReady(st, m.id)) {
        next.add(m.id);
        if (st!.device === 'webgpu' && !st!.cpu && cachedDtypes(st).some((d) => isGpuDtype(d))) gpu.add(m.id);
      }
    }
    ready = next;
    gpuReady = gpu;
    return next;
  };

  return {
    id: 'whisper-webgpu',
    languages() {
      const choice = getModel();
      if (choice !== 'auto') return whisperModelInfo(choice)?.multilingual ? ['*'] : ['en'];
      return [...ready].some((id) => whisperModelInfo(id)?.multilingual) ? ['*'] : ['en'];
    },
    async isAvailable() {
      try {
        const set = await refresh();
        // the language is not known yet at probe time: any downloaded model counts, transcribe() applies the language rule
        const choice = getModel();
        return choice === 'auto' ? set.size > 0 : set.has(choice);
      } catch {
        return false;
      }
    },
    async warmUp() {
      try {
        const set = await refresh();
        const model = pickWhisperModel(getModel(), undefined, set, gpuReady) ?? pickWhisperModel(getModel(), 'en', set, gpuReady);
        if (model) await transport.send({ op: 'transcribe', id: newId(), model, pcmB64: '', lang: undefined });
      } catch {
        /* warm-up is best effort */
      }
    },
    async transcribe(pcm16k: Int16Array, opts: LocalAsrOptions = {}): Promise<LocalAsrResult> {
      if (opts.signal?.aborted) throw abortError();
      const set = await refresh();
      const model: WhisperModelId | undefined = pickWhisperModel(getModel(), opts.lang, set, gpuReady);
      if (!model) {
        localReasons.set('no-model', reasonText.noModel(baseLang(opts.lang)));
        diag.log('local-reason', { why: 'no-model', lang: baseLang(opts.lang) ?? '?', ready: set.size });
        throw new ProviderUnavailableError('no downloaded Whisper model for this language', 'local', 'unsupported');
      }
      localReasons.clear('no-model');
      const info = whisperModelInfo(model)!;
      const rid = newId();
      const tReq = Date.now();
      // English-only checkpoints must not be given a language; multilingual ones detect it unless the stream language is known
      const lang = info.multilingual ? baseLang(opts.lang) : undefined;
      const first = !warm.has(model);
      if (first) {
        localReasons.set('loading', reasonText.loading());
        diag.log('local-reason', { why: 'loading', model });
      }
      const call = transport.send({ op: 'transcribe', id: rid, model, pcmB64: int16ToB64(pcm16k), lang });
      let onAbort: (() => void) | undefined;
      const aborted = new Promise<never>((_, rej) => {
        onAbort = () => {
          void transport.send({ op: 'abort', id: rid }).catch(() => {});
          rej(abortError());
        };
        opts.signal?.addEventListener('abort', onAbort, { once: true });
      });
      try {
        const r = asReply<TranscribeReplyData>(await (opts.signal ? Promise.race([call, aborted]) : call));
        if (!r.ok) throw new Error(`whisper-webgpu: ${r.error}`);
        warm.add(model);
        localReasons.clear('loading');
        if (r.device === 'wasm') {
          localReasons.set('cpu', reasonText.cpu());
          if (first) diag.log('local-reason', { why: 'cpu', model });
        } else localReasons.clear('cpu');
        if (!deviceLogged.has(model)) {
          deviceLogged.add(model);
          diag.log('local-asr-device', { model, device: r.device, dtype: r.dtype, why: r.why ?? '?' });
        }
        const sec = pcm16k.length / 16000;
        const stats = {
          ...(r.pcmRms !== undefined ? { rms: Math.round(r.pcmRms * 10000) / 10000, peak: Math.round((r.pcmPeak ?? 0) * 1000) / 1000 } : {}),
          ...(r.rawLen !== undefined ? { rawLen: r.rawLen, raw60: r.rawHead ?? '' } : {}),
          ...(r.tsRetry ? { tsRetry: true } : {}),
        };
        diag.log('localasr-transcribe', { model, device: r.device, dtype: r.dtype, sec, ms: r.ms, rtf: sec > 0 ? r.ms / 1000 / sec : 0, wallMs: Date.now() - tReq, queueMs: r.queueMs ?? 0, segs: r.segments.length, ...(r.loadMs !== undefined ? { loadMs: r.loadMs } : {}), ...stats });
        // one diag per run of empty answers (not per chunk): the numbers that tell silence from a broken decode
        if (r.segments.length === 0) {
          if (!emptyLogged) diag.log('asr-empty', { model, sec, ms: r.ms, device: r.device, dtype: r.dtype, ...stats });
          emptyLogged = true;
        } else emptyLogged = false;
        return { segments: r.segments, lang: r.lang ?? (info.multilingual ? lang : 'en'), detected: info.multilingual && !lang, model, device: r.device };
      } catch (e) {
        localReasons.clear('loading');
        throw e;
      } finally {
        if (onAbort) opts.signal?.removeEventListener('abort', onAbort);
        void aborted.catch(() => {});
      }
    },
  };
}
