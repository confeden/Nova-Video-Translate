/**
 * LocalTtsEngine clients as seen from the page / content script / settings page: thin proxies over the message protocol
 * (every model lives in the extension's offscreen document). One generic client serves all in-browser engines
 * (supertonic-webgpu, supertonic-wasm, silero-cpu, piper-wasm). The transport is injected; the default one uses the
 * `chrome` extension globals so `createRemoteEngine()` works in any extension context.
 */
import { diag } from '../../diag';
import { engineInfo, hasVoice, resolveVoice, unitFor } from '../catalog';
import type { LocalTtsEngine, LocalTtsEngineId, LocalTtsRequest, LocalTtsResult } from '../types';
import { SUPERTONIC_REVISION } from './constants';
import { b64ToInt16 } from './pcm';
import { abortError } from './queue';
import { LTTS_ENV_KEY, LTTS_MSG, LTTS_STATE_KEY, SUPERTONIC_ENGINE_ID, unitStateKey, type LttsEnv, type LttsOp, type LttsReply, type LttsState, type SynthReplyData, type WarmReplyData } from './protocol';

export interface LttsTransport {
  /** sends a request to the service worker and resolves with its reply (undefined = nobody answered) */
  send(op: LttsOp): Promise<unknown>;
  /** persisted state of a download unit (default 'supertonic') */
  readState(unitId?: string): Promise<LttsState | undefined>;
  readEnv?(): Promise<LttsEnv | undefined>;
}

interface ChromeLike {
  runtime?: { sendMessage?: (m: unknown) => Promise<unknown>; lastError?: unknown };
  storage?: { local?: { get: (k: string | string[]) => Promise<Record<string, unknown>> } };
}

/** transport over chrome.runtime / chrome.storage.local (MV3 promise APIs) */
export function chromeTransport(): LttsTransport {
  const c = (globalThis as unknown as { chrome?: ChromeLike }).chrome;
  return {
    async send(op) {
      if (!c?.runtime?.sendMessage) throw new Error('no extension runtime');
      return c.runtime.sendMessage({ ...op, type: LTTS_MSG, to: 'bg' });
    },
    async readState(unitId = 'supertonic') {
      const key = unitId === 'supertonic' ? LTTS_STATE_KEY : unitStateKey(unitId);
      const got = await c?.storage?.local?.get(key);
      return got?.[key] as LttsState | undefined;
    },
    async readEnv() {
      const got = await c?.storage?.local?.get(LTTS_ENV_KEY);
      return got?.[LTTS_ENV_KEY] as LttsEnv | undefined;
    },
  };
}

export interface RemoteEngine extends LocalTtsEngine {
  /** loads the model and runs the warm-up synth so the first real request is fast; never throws */
  warmUp(voice?: string): Promise<void>;
  /** persisted state of the unit this engine uses for `voice` */
  state(voice?: string): Promise<LttsState | undefined>;
}
export type SupertonicEngine = RemoteEngine & { readonly id: 'supertonic-webgpu' };

/** a unit is usable when its files are complete for the current revision and (GPU engines) WebGPU is not known to be missing */
export function stateIsUsable(s: LttsState | undefined, rev: string = SUPERTONIC_REVISION, needsGpu = true, env?: LttsEnv): boolean {
  if (!s || s.model !== 'ready' || s.rev !== rev) return false;
  if (needsGpu && (env?.gpu ?? s.gpu) === false) return false;
  return true;
}

let seq = 0;
const newId = (): string => `lt${Date.now().toString(36)}${(seq++).toString(36)}`;

const asReply = <T>(r: unknown): LttsReply<T> => (r && typeof r === 'object' && 'ok' in r ? (r as LttsReply<T>) : { ok: false, error: 'no answer from the extension' });

export function createRemoteEngine(id: LocalTtsEngineId, transport: LttsTransport = chromeTransport()): RemoteEngine {
  const info = engineInfo(id);
  if (!info) throw new Error(`unknown local TTS engine ${id}`);
  const log = (name: string, data: Record<string, unknown>): void => diag.log(name, { engine: id, ...data });
  const logWarm = (d: { loadMs?: number; loadBytes?: number; warmMs?: number }): void => {
    if (d.loadMs !== undefined) log('localtts-load', { ms: d.loadMs, bytes: d.loadBytes ?? 0 });
    if (d.warmMs !== undefined) log('localtts-warm', { ms: d.warmMs });
  };
  const readEnv = async (): Promise<LttsEnv | undefined> => (await transport.readEnv?.().catch(() => undefined)) ?? undefined;
  /** voices whose unit is complete (per-voice engines) */
  const readyVoices = async (): Promise<string[]> => {
    if (!info.perVoiceUnit) return info.voices.map((v) => v.id);
    const env = await readEnv();
    const out: string[] = [];
    for (const v of info.voices) {
      const u = unitFor(id, v.id)!;
      if (stateIsUsable(await transport.readState(u.id).catch(() => undefined), u.rev, info.needsGpu, env)) out.push(v.id);
    }
    return out;
  };
  const voiceFor = async (want: string | undefined): Promise<string> => {
    if (!info.perVoiceUnit) return hasVoice(id, want) ? want! : info.defaultVoice;
    const ready = await readyVoices();
    return want && ready.includes(want) ? want : ready[0] ?? resolveVoice(id, want);
  };

  return {
    id,
    state: async (voice) => transport.readState(unitFor(id, resolveVoice(id, voice))!.id).catch(() => undefined),
    async isAvailable() {
      try {
        if (info.perVoiceUnit) return (await readyVoices()).length > 0;
        const u = unitFor(id)!;
        return stateIsUsable(await transport.readState(u.id), u.rev, info.needsGpu, await readEnv());
      } catch {
        return false;
      }
    },
    async voices() {
      const ready = await readyVoices().catch(() => []);
      return (ready.length ? ready : info.voices.map((v) => v.id)).slice();
    },
    async warmUp(voice) {
      try {
        const v = await voiceFor(voice);
        const u = unitFor(id, v)!;
        if (!stateIsUsable(await transport.readState(u.id), u.rev, info.needsGpu, await readEnv())) return;
        const r = asReply<WarmReplyData>(await transport.send({ op: 'warm', engine: id, voice: v }));
        if (r.ok && r.did) logWarm(r);
      } catch {
        /* warm-up is best effort */
      }
    },
    async synth(req: LocalTtsRequest): Promise<LocalTtsResult> {
      if (req.signal?.aborted) throw abortError();
      const rid = newId();
      const tReq = Date.now();
      let voice = info.perVoiceUnit ? '' : hasVoice(id, req.voice) ? req.voice! : info.defaultVoice;
      const send = (v: string): Promise<unknown> => transport.send({ op: 'synth', id: rid, engine: id, text: req.text, voice: v, targetSec: req.targetSec });
      // single-unit engines send synchronously (so an immediate abort() lands after the request); per-voice engines look the
      // downloaded voices up first and then must not send a request that was already aborted
      const call = info.perVoiceUnit
        ? voiceFor(req.voice).then((v) => {
            voice = v;
            if (req.signal?.aborted) throw abortError();
            return send(v);
          })
        : send(voice);
      let onAbort: (() => void) | undefined;
      const aborted = new Promise<never>((_, rej) => {
        onAbort = () => {
          void transport.send({ op: 'abort', id: rid }).catch(() => {});
          rej(abortError());
        };
        req.signal?.addEventListener('abort', onAbort, { once: true });
      });
      try {
        const r = asReply<SynthReplyData>(await (req.signal ? Promise.race([call, aborted]) : call));
        if (!r.ok) throw new Error(`${id}: ${r.error}`);
        logWarm(r);
        const sec = r.durationSec;
        log('localtts-synth', { voice, chars: r.chars, sec, ms: r.ms, rtf: sec > 0 ? r.ms / 1000 / sec : 0, speed: r.speed, passes: r.passes, wallMs: Date.now() - tReq, queueMs: r.queueMs ?? 0, ...(r.stages ? { stages: r.stages } : {}) });
        const samples = b64ToInt16(r.pcmB64);
        return { sampleRate: r.sampleRate, samples, durationSec: samples.length / r.sampleRate };
      } finally {
        if (onAbort) req.signal?.removeEventListener('abort', onAbort);
        void aborted.catch(() => {});
      }
    },
  };
}

/** the Supertonic WebGPU engine (kept for the existing callers / tests) */
export function createSupertonicEngine(transport: LttsTransport = chromeTransport()): SupertonicEngine {
  return createRemoteEngine(SUPERTONIC_ENGINE_ID, transport) as SupertonicEngine;
}
