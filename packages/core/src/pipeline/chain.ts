/** Provider fall-through chain for one audio chunk (D15). Pure of DOM; clock and sleep are injectable. */
import { diag } from '../diag';
import type { AudioChunk, ChunkResult, DubProvider, ProviderContext, ProviderId } from '../providers/types';
import { ProviderUnavailableError } from '../providers/types';
import type { Settings } from '../types';

export type EngineWarningKind =
  | 'quota-exhausted'
  | 'no-provider'
  | 'auth-required'
  | 'capture-tainted'
  | 'provider-failed'
  | 'tier-declined'
  | 'already-russian'
  | 'language-unverified'
  | 'dub-late'
  | 'chunk-failed'
  | 'dub-decode-failed';

export interface EngineWarning {
  kind: EngineWarningKind;
  message: string;
  providerId?: ProviderId;
}

export const RETRY_BACKOFF_MS = 1500;
export const COOLDOWN_MS = 5 * 60_000;
export const COOLDOWN_AFTER_FAILURES = 2;
export const WARN_THROTTLE_MS = 60_000;
/** the top tier has not answered after this long: the next usable tier starts the same cell in parallel (first success wins) */
export const HEDGE_AFTER_MS = 35_000;
/** at most this many hedges run at once (a hedge doubles the load of its cell) */
export const HEDGE_MAX = 2;
/** consecutive watchdog timeouts of one tier before it is dropped for the cooldown */
export const TIMEOUTS_BEFORE_COOLDOWN = 2;

/** Mutable per-session memory shared by all chunks. */
export interface ChainState {
  /** consecutive failed chunk attempts per provider */
  failures: Map<ProviderId, number>;
  cooldownUntil: Map<ProviderId, number>;
  /** tiers skipped for the rest of the session (auth) until credentials change */
  authSkip: Set<ProviderId>;
  lastWarn: Map<string, number>;
  /** consecutive watchdog timeouts per provider (reset by a success) */
  timeouts: Map<ProviderId, number>;
  /** hedged attempts running right now */
  hedges: number;
}

export function createChainState(): ChainState {
  return { failures: new Map(), cooldownUntil: new Map(), authSkip: new Set(), lastWarn: new Map(), timeouts: new Map(), hedges: 0 };
}

export interface ChainContext {
  signal: AbortSignal;
  now(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  warn(w: EngineWarning): void;
  sourceLang?: string;
  backoffMs?: number;
  cooldownMs?: number;
  /** latest settings (the user may change tiers while a chunk is in flight) */
  getSettings?(): Settings;
  /** called when a tier attempt starts (abort = cancel just that attempt) and with undefined when it ends */
  onAttempt?(id: ProviderId, abort: (() => void) | undefined): void;
  /** a tier answered with a rate-limit-like signal (HTTP 429 / 402 / 503 or kind 'quota'): the engine backs off */
  onRateSignal?(id: ProviderId, status?: number): void;
  /** hedging delay; absent / 0 = no hedging */
  hedgeAfterMs?: number;
  hedgeMax?: number;
  /** abortable delay for the hedge timer (injectable for tests; default setTimeout) */
  hedgeTimer?(ms: number, signal: AbortSignal): Promise<void>;
  /**
   * Tiers the planner wants started NOW, in priority order (first = preferred). Two or more = a race: every listed tier
   * runs at once, the first success is delivered, a higher-priority tier that is still running keeps going and reports
   * through `onLate`. One entry = that tier goes first (fall-through continues with the others). Absent = user order.
   */
  plan?: ProviderId[];
  /** tiers excluded for this chunk (never started, not even as fall-through) */
  skip?: ProviderId[];
  /** dynamic whole-job deadline (ms) of a tier's attempt (Yandex); undefined = provider default */
  deadlineMs?(id: ProviderId): number | undefined;
  /** server remainingTime hint (s) of a tier */
  onHint?(id: ProviderId, remainingSec: number): void;
  /** a tier attempt finished OK after `ms`, or was cut off by its deadline (censored) */
  onLatency?(id: ProviderId, ms: number, censored: boolean): void;
  /** a higher-priority racer finished after a lower-priority one had already been delivered */
  onLate?(win: { providerId: ProviderId; result: ChunkResult; latencyMs: number }): void;
}

const realTimer = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException('aborted', 'AbortError'));
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(new DOMException('aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });

interface Win {
  providerId: ProviderId;
  result: ChunkResult;
}

/**
 * One attempt of tier `p`. When hedging is on and `p` has not answered after `hedgeAfterMs`, the next usable tier starts the
 * same chunk in parallel; the first success wins and the loser is cancelled. If `p` fails while a hedge is running, the
 * hedge decides; if both fail the error of `p` is thrown (the normal retry / fall-through flow continues).
 */
function attemptWithHedge(
  p: DubProvider,
  tiers: DubProvider[],
  chunk: AudioChunk,
  pctx: Omit<ProviderContext, 'signal'>,
  ac: AbortController,
  ctx: ChainContext,
  state: ChainState,
  settings: Settings,
  cell: Record<string, unknown>,
): Promise<Win> {
  const mk = (prov: DubProvider, c: AbortController): Promise<Win> =>
    prov.translateChunk(chunk, { ...pctx, signal: c.signal, deadlineMs: ctx.deadlineMs?.(prov.id), onHint: (s) => ctx.onHint?.(prov.id, s) }).then((result) => ({ providerId: prov.id, result }));
  const primary = mk(p, ac);
  const after = ctx.hedgeAfterMs ?? 0;
  const later = tiers.slice(tiers.indexOf(p) + 1);
  if (after <= 0 || later.length === 0) return primary;

  return new Promise<Win>((resolve, reject) => {
    const timerAc = new AbortController();
    let hedgeAc: AbortController | undefined;
    let hedgeId: ProviderId | undefined;
    let pState: 'pending' | 'ok' | 'err' = 'pending';
    let hState: 'none' | 'pending' | 'ok' | 'err' = 'none';
    let pErr: unknown;
    let done = false;
    const onCtxAbort = (): void => hedgeAc?.abort();
    const finish = (fn: () => void): void => {
      if (done) return;
      done = true;
      timerAc.abort();
      ctx.signal.removeEventListener('abort', onCtxAbort);
      fn();
    };

    (ctx.hedgeTimer ?? realTimer)(after, timerAc.signal).then(
      () => {
        if (done || pState !== 'pending') return;
        const now = ctx.now();
        const target = later.find(
          (t) => (state.cooldownUntil.get(t.id) ?? 0) <= now && !state.authSkip.has(t.id) && t.isConfigured() && settings.voiceEnabled[t.id] !== false,
        );
        if (!target) return;
        if (state.hedges >= (ctx.hedgeMax ?? HEDGE_MAX)) {
          diag.log('hedge-skip', { ...cell, tier: p.id, hedge: target.id, active: state.hedges });
          return;
        }
        state.hedges++;
        const myAc = new AbortController();
        hedgeAc = myAc;
        hedgeId = target.id;
        hState = 'pending';
        ctx.signal.addEventListener('abort', onCtxAbort, { once: true });
        diag.log('hedge-start', { ...cell, tier: p.id, hedge: target.id, afterMs: after, active: state.hedges });
        ctx.onAttempt?.(target.id, () => myAc.abort());
        mk(target, myAc)
          .then(
            (win) => {
              hState = 'ok';
              finish(() => {
                diag.log('hedge-win', { ...cell, winner: win.providerId, loser: p.id });
                ac.abort(); // cancel the slow primary
                resolve(win);
              });
            },
            (e) => {
              hState = 'err';
              diag.log('hedge-fail', { ...cell, hedge: target.id, msg: (e instanceof Error ? e.message : String(e)).slice(0, 80) });
              if (pState === 'err') finish(() => reject(pErr));
            },
          )
          .finally(() => {
            state.hedges = Math.max(0, state.hedges - 1);
            ctx.onAttempt?.(target.id, undefined);
          });
      },
      () => {},
    );

    primary.then(
      (win) => {
        pState = 'ok';
        finish(() => {
          if (hState === 'pending') {
            diag.log('hedge-win', { ...cell, winner: win.providerId, loser: hedgeId });
            hedgeAc?.abort(); // cancel the hedge
          }
          resolve(win);
        });
      },
      (e) => {
        pState = 'err';
        pErr = e;
        if (hState !== 'pending') finish(() => reject(e));
      },
    );
  });
}

export type ChainOutcome =
  | { ok: true; providerId: ProviderId; result: ChunkResult; latencyMs: number }
  | { ok: false; /** no tier was eligible at all (cooldown/disabled), nothing was tried */ noTier?: boolean; waitMs?: number };

/** ms until the first enabled+configured tier leaves its cooldown; undefined when no tier can ever come back soon. */
export function nextAvailableInMs(providers: DubProvider[], settings: Settings, state: ChainState, now: number): number | undefined {
  let best: number | undefined;
  for (const id of settings.voiceOrder) {
    const p = providers.find((x) => x.id === id);
    if (!p || settings.voiceEnabled[id] === false || state.authSkip.has(id) || !p.isConfigured()) continue;
    const w = Math.max(0, (state.cooldownUntil.get(id) ?? 0) - now);
    if (best === undefined || w < best) best = w;
  }
  return best;
}

const statusClass = (msg: string): string | undefined => {
  const m = /HTTP (\d)\d\d/.exec(msg);
  return m ? `${m[1]}xx` : undefined;
};

/** Providers eligible right now, in the user's order. */
export function eligibleProviders(providers: DubProvider[], settings: Settings, state: ChainState, now: number): DubProvider[] {
  const out: DubProvider[] = [];
  for (const id of settings.voiceOrder) {
    const p = providers.find((x) => x.id === id);
    if (!p || out.includes(p)) continue;
    if (settings.voiceEnabled[id] === false) continue;
    if (state.authSkip.has(id)) continue;
    if ((state.cooldownUntil.get(id) ?? 0) > now) continue;
    if (!p.isConfigured()) continue;
    out.push(p);
  }
  return out;
}

function warnThrottled(state: ChainState, ctx: ChainContext, key: string, w: EngineWarning): void {
  const t = ctx.now();
  const last = state.lastWarn.get(key);
  if (last !== undefined && t - last < WARN_THROTTLE_MS) return;
  state.lastWarn.set(key, t);
  ctx.warn(w);
}

function recordFailure(id: ProviderId, state: ChainState, ctx: ChainContext): void {
  const n = (state.failures.get(id) ?? 0) + 1;
  state.failures.set(id, n);
  if (n >= COOLDOWN_AFTER_FAILURES) {
    state.cooldownUntil.set(id, ctx.now() + (ctx.cooldownMs ?? COOLDOWN_MS));
    state.failures.set(id, 0);
  }
}

type TierResult = { ok: true; providerId: ProviderId; result: ChunkResult; latencyMs: number } | { ok: false };

/** Up to two attempts of one tier with the quota / declined / auth / timeout bookkeeping. Never throws except for a cancelled `ctx.signal`. */
async function tryTier(
  p: DubProvider,
  tiers: DubProvider[],
  chunk: AudioChunk,
  settings: Settings,
  ctx: ChainContext,
  state: ChainState,
  cell: Record<string, unknown>,
  hedge: boolean,
): Promise<TierResult> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (ctx.signal.aborted) throw new DOMException('aborted', 'AbortError');
    // the user may have disabled this tier since the chain was built
    const cur = ctx.getSettings?.() ?? settings;
    if (cur.voiceEnabled[p.id] === false || !p.isConfigured() || state.authSkip.has(p.id)) {
      diag.log('tier-skip', { ...cell, tier: p.id, reason: 'disabled-meanwhile' });
      break;
    }
    if ((state.cooldownUntil.get(p.id) ?? 0) > ctx.now()) {
      // a parallel chunk already put this tier on cooldown (e.g. timeouts in a row): do not spend another attempt on it
      diag.log('tier-skip', { ...cell, tier: p.id, reason: 'cooldown' });
      break;
    }
    const ac = new AbortController();
    const link = (): void => ac.abort();
    ctx.signal.addEventListener('abort', link, { once: true });
    ctx.onAttempt?.(p.id, () => ac.abort());
    const t0 = ctx.now();
    const deadlineMs = ctx.deadlineMs?.(p.id);
    diag.log('tier-try', { ...cell, tier: p.id, attempt, deadlineS: deadlineMs ? Math.round(deadlineMs / 1000) : undefined });
    try {
      const { providerId, result } = await attemptWithHedge(
        p,
        hedge ? tiers : [p],
        chunk,
        { targetLang: 'ru', sourceLang: ctx.sourceLang, wantSubtitles: cur.subtitles === 'on' },
        ac,
        ctx,
        state,
        cur,
        cell,
      );
      state.failures.set(providerId, 0);
      state.timeouts.set(providerId, 0);
      const latencyMs = ctx.now() - t0;
      const dubSec = result.segments.reduce((n, s) => n + Math.max(0, s.end - s.start), 0);
      diag.log('tier-ok', { ...cell, tier: providerId, ms: latencyMs, segments: result.segments.length, dubSec, voice: result.voice, lang: result.sourceLang });
      ctx.onLatency?.(providerId, latencyMs, false);
      return { ok: true, providerId, result, latencyMs };
    } catch (e) {
      if (ctx.signal.aborted) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      if (ac.signal.aborted) {
        // only this attempt was cancelled (tier switched off by the user, or lost a race): fall through to the next tier
        diag.log('tier-cancelled', { ...cell, tier: p.id, ms: ctx.now() - t0 });
        break;
      }
      const kind = e instanceof ProviderUnavailableError ? e.kind : 'failed';
      const status = /HTTP (\d{3})/.exec(msg)?.[1];
      if (kind === 'quota' || status === '429' || status === '402' || status === '503') ctx.onRateSignal?.(p.id, status ? Number(status) : undefined);
      diag.log('tier-fail', { ...cell, tier: p.id, attempt, kind, http: statusClass(msg), ms: ctx.now() - t0, msg: msg.slice(0, 120) });
      if (kind === 'quota') {
        warnThrottled(state, ctx, `quota:${p.id}`, { kind: 'quota-exhausted', message: msg, providerId: p.id });
        recordFailure(p.id, state, ctx);
        break;
      }
      if (kind === 'declined') {
        // the tier is fine but will not voice this video (e.g. lively voices unavailable): no retry, skip it for a while
        state.cooldownUntil.set(p.id, ctx.now() + (ctx.cooldownMs ?? COOLDOWN_MS));
        warnThrottled(state, ctx, `declined:${p.id}`, { kind: 'tier-declined', message: msg, providerId: p.id });
        break;
      }
      if (kind === 'auth') {
        state.authSkip.add(p.id);
        ctx.warn({ kind: 'auth-required', message: msg, providerId: p.id });
        break;
      }
      if (e instanceof ProviderUnavailableError && e.timedOut) {
        const elapsed = ctx.now() - t0;
        // a job-level deadline is the planner's: it counts as a tier fault only when the job really ran that long (a slow tier
        // is not a dead tier); a stalled HTTP stage (25 s) always counts
        const jobLevel = /^job:/.test(msg);
        const counts = !jobLevel || !deadlineMs || elapsed >= deadlineMs * 0.9;
        if (jobLevel) ctx.onLatency?.(p.id, elapsed, true);
        if (p.id === 'gemini') {
          // Gemini wall-clock guard (45 s TTS / 60 s translate): this chunk fails over, but a stalled generation is no reason
          // for a tier cooldown or a retry that would hold the slot again
          diag.log('timeout-not-counted', { ...cell, tier: p.id, ms: elapsed, why: 'gemini-wall-clock' });
          break;
        }
        if (jobLevel && p.id === 'yandex-live') {
          // D26 live policy: a live job that outlives even its ETA-based deadline is late, not broken: no retry, no cooldown, no warning
          diag.log('live-late-dropped', { ...cell, tier: p.id, ms: elapsed, deadlineMs });
          break;
        }
        if (!counts) {
          diag.log('timeout-not-counted', { ...cell, tier: p.id, ms: elapsed, deadlineMs });
        } else {
          const n = (state.timeouts.get(p.id) ?? 0) + 1;
          state.timeouts.set(p.id, n);
          if (n >= TIMEOUTS_BEFORE_COOLDOWN) {
            const ms = ctx.cooldownMs ?? COOLDOWN_MS;
            state.cooldownUntil.set(p.id, ctx.now() + ms);
            state.timeouts.set(p.id, 0);
            state.failures.set(p.id, 0);
            diag.log('tier-cooldown', { ...cell, tier: p.id, why: 'timeouts-in-a-row', n, ms });
            warnThrottled(state, ctx, `failed:${p.id}`, {
              kind: 'provider-failed',
              message: `${p.label}: ${n} timeouts in a row, switching to the next source for ${Math.round(ms / 60_000)} min`,
              providerId: p.id,
            });
            break;
          }
        }
      }
      if (attempt === 0) {
        await ctx.sleep(ctx.backoffMs ?? RETRY_BACKOFF_MS, ctx.signal);
        continue;
      }
      warnThrottled(state, ctx, `failed:${p.id}`, { kind: 'provider-failed', message: msg, providerId: p.id });
      recordFailure(p.id, state, ctx);
    } finally {
      ctx.signal.removeEventListener('abort', link);
      ctx.onAttempt?.(p.id, undefined);
    }
  }
  return { ok: false };
}

/**
 * Race of the planned tiers. The first success is returned. Lower-priority racers are cancelled by a higher-priority win;
 * a higher-priority racer still running when a lower one wins keeps going and reports through `ctx.onLate`.
 * Resolves undefined when every racer failed.
 */
function raceTiers(
  racers: DubProvider[],
  chunk: AudioChunk,
  settings: Settings,
  ctx: ChainContext,
  state: ChainState,
  cell: Record<string, unknown>,
): Promise<TierResult | undefined> {
  return new Promise((resolve) => {
    let winnerRank = -1;
    let pending = racers.length;
    let resolved = false;
    const acs = racers.map(() => new AbortController());
    const links = acs.map((ac) => {
      const l = (): void => ac.abort();
      ctx.signal.addEventListener('abort', l, { once: true });
      return l;
    });
    const unlink = (): void => links.forEach((l) => ctx.signal.removeEventListener('abort', l));
    diag.log('race-start', { ...cell, tiers: racers.map((r) => r.id) });
    racers.forEach((p, i) => {
      const sub: ChainContext = { ...ctx, signal: acs[i]!.signal };
      tryTier(p, racers, chunk, settings, sub, state, cell, false)
        .catch((): TierResult => ({ ok: false }))
        .then((r) => {
          pending--;
          if (r.ok) {
            if (winnerRank < 0) {
              winnerRank = i;
              // lower-priority racers are pointless now
              racers.forEach((_, j) => {
                if (j > i) acs[j]!.abort();
              });
              resolved = true;
              resolve(r);
              diag.log('race-win', { ...cell, winner: p.id, ms: r.latencyMs, higherPending: racers.slice(0, i).filter((_, j) => !acs[j]!.signal.aborted).map((x) => x.id) });
            } else if (i < winnerRank) {
              winnerRank = i;
              ctx.onLate?.({ providerId: r.providerId, result: r.result, latencyMs: r.latencyMs });
              racers.forEach((_, j) => {
                if (j > i) acs[j]!.abort();
              });
            }
          }
          if (pending === 0) {
            unlink();
            if (!resolved) resolve(undefined);
          }
        });
    });
  });
}

export async function runChain(
  chunk: AudioChunk,
  providers: DubProvider[],
  settings: Settings,
  ctx: ChainContext,
  state: ChainState,
): Promise<ChainOutcome> {
  const eligible = eligibleProviders(providers, settings, state, ctx.now()).filter((p) => !ctx.skip?.includes(p.id));
  const cell = { cell: chunk.startSec, dur: chunk.durationSec, partial: !!chunk.partial };
  if (eligible.length === 0) {
    const waitMs = nextAvailableInMs(providers, settings, state, ctx.now());
    diag.log('chain-no-tier', { ...cell, waitMs });
    warnThrottled(state, ctx, 'no-provider', { kind: 'no-provider', message: 'no voice provider could translate this chunk' });
    return { ok: false, noTier: true, waitMs };
  }
  // planner order: the planned tiers first, then the rest in the user's order (plain fall-through)
  const planned = (ctx.plan ?? []).map((id) => eligible.find((t) => t.id === id)).filter((t): t is DubProvider => !!t);
  const tiers = [...planned, ...eligible.filter((t) => !planned.includes(t))];
  const tried = new Set<DubProvider>();
  if (planned.length >= 2) {
    const r = await raceTiers(planned, chunk, settings, ctx, state, cell);
    if (ctx.signal.aborted) throw new DOMException('aborted', 'AbortError');
    for (const p of planned) tried.add(p);
    if (r?.ok) return { ok: true, providerId: r.providerId, result: r.result, latencyMs: r.latencyMs };
  }
  for (const p of tiers) {
    if (tried.has(p)) continue;
    const r = await tryTier(p, tiers, chunk, settings, ctx, state, cell, true);
    if (r.ok) return { ok: true, providerId: r.providerId, result: r.result, latencyMs: r.latencyMs };
  }
  warnThrottled(state, ctx, 'no-provider', { kind: 'no-provider', message: 'no voice provider could translate this chunk' });
  diag.log('chain-failed', cell);
  return { ok: false };
}
