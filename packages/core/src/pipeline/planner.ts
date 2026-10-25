/**
 * Deadline-driven tier planning (owner diag v0.2.7: the live tier needed 75-120 s per 15 s chunk, so nothing was audible
 * for 2 minutes although standard Yandex / Gemini would have made it). Pure of DOM / network; the clock is injected.
 *
 *  - LatencyModel: EWMA of the observed request latency per tier, with priors and decay back to the prior when idle.
 *  - planCell: per cell, which tiers to start NOW so that something is audible in time.
 *  - caps / timeouts / upgrade rules used by the engine and the chain.
 */
import type { ProviderId } from '../providers/types';

/** Latency priors (s) from the owner's v0.2.7 diagnostic: live 75-120 s, standard 21-51 s, Gemini ~20 s. */
/** expected latency (s) of a cell served from a Yandex full track: a slice of bytes already in memory */
export const FULL_TRACK_LATENCY_SEC = 1;
export const TIER_PRIOR_SEC: Record<ProviderId, number> = { 'yandex-live': 90, yandex: 50, groq: 12, local: 8, gemini: 20 };
/**
 * S26 measured law of a Yandex chunk-mode job (fake id): ~10 s fixed + ~0.045 s per second of audio, whatever the chunk length
 * (5/10/15 s = 8-16 s, 257 s = 19-22 s, 604 s = 37-42 s). The priors above are for a job of YANDEX_REF_JOB_SEC; the slope
 * moves them for other durations (the EWMA is kept at the reference duration: a sample of a D-second job is normalised first).
 */
export const YANDEX_JOB_FIXED_SEC = 10;
export const YANDEX_JOB_PER_SEC = 0.045;
export const YANDEX_REF_JOB_SEC = 15;
/** cells merged into one Yandex super-chunk job at most (60 s with the 15 s grid) */
export const YANDEX_SUPER_CELLS = 4;
/** the first super-chunk job (before any batch has succeeded) is kept small: a failure costs little */
export const YANDEX_FIRST_BATCH_CELLS = 2;
/** straggler duplicate: a job older than max(factor x expected, min) gets ONE duplicate job */
export const YANDEX_DUP_FACTOR = 2;
export const YANDEX_DUP_MIN_MS = 25_000;
/** seconds per second of audio, per tier (Gemini does not scale with the chunk length in this model) */
const PER_SEC: Record<ProviderId, number> = { 'yandex-live': YANDEX_JOB_PER_SEC, yandex: YANDEX_JOB_PER_SEC, groq: 0, local: 0, gemini: 0 };
/** pure law: expected latency (s) of a good-phase Yandex job of `sec` seconds of audio */
export function yandexJobSec(sec: number): number {
  return YANDEX_JOB_FIXED_SEC + YANDEX_JOB_PER_SEC * Math.max(0, sec);
}
/** a tier is "in time" when its expected latency plus this margin fits before the slot starts */
export const PLAN_MARGIN_SEC = 5;
export const LATENCY_ALPHA = 0.4;
/** an idle tier's estimate moves halfway back to its prior after this long */
export const PRIOR_HALF_LIFE_MS = 5 * 60_000;
/** weight of the (noisy, over-estimating) server remainingTime hint before the first real sample */
export const HINT_WEIGHT = 0.15;
/** a higher tier's result replaces a playing lower-tier dub only if it arrives at least this long before the slot starts */
export const UPGRADE_LEAD_SEC = 3;
/** Gemini quota discipline */
export const GEMINI_MAX_PARALLEL = 2;
/** D30 Groq tier: free-tier ~20 req/min (an ASR call + one chat call per chunk) */
// 3: the next cells' recognition starts while the current one is still being translated (kinohub log: 2 left cells late)
export const GROQ_MAX_PARALLEL = 3;
/** D30 local tier: ASR + TTS share the user's CPU/GPU */
export const LOCAL_MAX_PARALLEL = 1;
export const JOB_TIMEOUT_MIN_MS = 60_000;
export const JOB_TIMEOUT_MAX_MS = 180_000;
/** a preferred tier whose expected latency exceeds 2 x timeToSlot + margin cannot realistically upgrade the cell: not started */
export const HOPELESS_FACTOR = 2;
/** D26 live policy: a live job's server ETA R makes the live tier's expected latency at least R + this (s) */
export const LIVE_ETA_PAD_SEC = 30;
/** a live job may run until R + this (ms) before its own deadline cuts it off */
export const LIVE_ETA_DEADLINE_PAD_MS = 60_000;
/** the live tier runs at most this many jobs at once in chunk mode */
export const LIVE_CHUNK_CAP = 1;

interface TierStat {
  ewma: number;
  lastAt: number;
  n: number;
}

export class LatencyModel {
  private readonly stats = new Map<ProviderId, TierStat>();
  private readonly hints = new Map<ProviderId, number>();
  private readonly pinned = new Map<ProviderId, number>();
  /** latency floor from a server ETA (live tier): max(prior, R + pad), decays back to the prior when idle / when jobs finish faster */
  private readonly floors = new Map<ProviderId, { sec: number; at: number }>();
  constructor(
    private readonly now: () => number,
    private readonly priors: Record<ProviderId, number> = TIER_PRIOR_SEC,
    private readonly halfLifeMs = PRIOR_HALF_LIFE_MS,
  ) {}

  prior(id: ProviderId): number {
    return this.priors[id];
  }

  /** A completed request took `ms`. `censored` = the request was cut off at a deadline, the true latency is higher. Returns the new estimate (s). */
  observe(id: ProviderId, ms: number, censored = false, durSec?: number): number {
    const x = Math.max(0.5, (censored ? ms * 1.2 : ms) / 1000 - this.slope(id, durSec));
    const cur = this.stats.get(id);
    const base = cur ? this.core(id) : this.priors[id];
    const fl = this.floors.get(id);
    if (fl && !censored) {
      // a job that finished faster than the floor pulls it down (slowly)
      const total = ms / 1000;
      const now = this.floorSec(id);
      if (total < now) this.floors.set(id, { sec: Math.max(this.priors[id], now * 0.6 + total * 0.4), at: this.now() });
    }
    const alpha = cur ? LATENCY_ALPHA : 0.5;
    const ewma = base * (1 - alpha) + x * alpha;
    this.stats.set(id, { ewma, lastAt: this.now(), n: (cur?.n ?? 0) + 1 });
    return ewma;
  }

  /** Server remainingTime of the translate reply (s): weak evidence, used only until the first real sample. */
  hint(id: ProviderId, sec: number): void {
    if (sec > 0 && Number.isFinite(sec)) this.hints.set(id, sec);
  }

  /**
   * D26 live policy: the server ETA R (s) of a job's first reply is the truth about that tier's latency. The tier's expected
   * latency becomes max(prior, R + LIVE_ETA_PAD_SEC); it decays back to the prior with the idle half-life.
   */
  eta(id: ProviderId, remainingSec: number): void {
    if (!(remainingSec > 0) || !Number.isFinite(remainingSec)) return;
    this.floors.set(id, { sec: Math.max(this.priors[id], remainingSec + LIVE_ETA_PAD_SEC), at: this.now() });
  }

  /** a server ETA is on record for this tier (live tier: the scouting job has reported) */
  etaKnown(id: ProviderId): boolean {
    return this.floors.has(id);
  }

  private floorSec(id: ProviderId): number {
    const f = this.floors.get(id);
    if (!f) return 0;
    const prior = this.priors[id];
    const w = Math.pow(0.5, Math.max(0, this.now() - f.at) / this.halfLifeMs);
    return prior + (f.sec - prior) * w;
  }

  samples(id: ProviderId): number {
    return this.stats.get(id)?.n ?? 0;
  }

  /** A tier that answers from memory (Yandex full track): its estimate is fixed, priors / EWMA / hints do not apply. */
  pin(id: ProviderId, sec: number): void {
    this.pinned.set(id, sec);
  }

  unpin(id: ProviderId): void {
    this.pinned.delete(id);
  }

  /** seconds added to the reference-duration estimate for a job of `durSec` audio seconds (0 when unknown) */
  private slope(id: ProviderId, durSec?: number): number {
    if (durSec === undefined || !(durSec > 0)) return 0;
    return PER_SEC[id] * (durSec - YANDEX_REF_JOB_SEC);
  }

  /** `durSec` = audio length of the job (Yandex scales ~0.045 s per audio second); omitted = the reference duration */
  expectedSec(id: ProviderId, durSec?: number): number {
    const pin = this.pinned.get(id);
    if (pin !== undefined) return pin;
    const base = this.baseExpected(id);
    const k = this.slope(id, durSec);
    const v = k === 0 ? base : Math.max(1, base + k);
    return Math.max(v, this.floorSec(id));
  }

  /** expected latency without the ETA floor (what the EWMA is blended with) */
  private core(id: ProviderId): number {
    return this.pinned.get(id) ?? this.baseExpected(id);
  }

  private baseExpected(id: ProviderId): number {
    const prior = this.priors[id];
    const st = this.stats.get(id);
    if (!st) {
      const h = this.hints.get(id);
      if (h === undefined) return prior;
      const clipped = Math.min(2 * prior, Math.max(0.5 * prior, h));
      return prior + HINT_WEIGHT * (clipped - prior);
    }
    const idle = Math.max(0, this.now() - st.lastAt);
    const w = Math.pow(0.5, idle / this.halfLifeMs);
    return prior + (st.ewma - prior) * w;
  }

  snapshot(ids: ProviderId[]): Record<string, number> {
    const o: Record<string, number> = {};
    for (const id of ids) o[id] = Math.round(this.expectedSec(id) * 10) / 10;
    return o;
  }
}

export interface PlanTier {
  id: ProviderId;
  expectedSec: number;
}

export type PlanReason = 'preferred-in-time' | 'preferred-late-fallback' | 'none-in-time-fastest' | 'single' | 'no-tier' | 'full-track' | 'live-quality';

export interface CellPlan {
  /** tiers to start now, highest priority first */
  start: ProviderId[];
  preferred?: ProviderId;
  reason: PlanReason;
  /** tiers predicted to arrive in time */
  inTime: ProviderId[];
  /** no tier is predicted to make the deadline */
  late: boolean;
  /** tiers that must not run for this cell at all, not even as a fall-through (live policy in chunk mode) */
  skip?: ProviderId[];
}

/**
 * `tiers` = usable tiers (with free capacity) in the user's priority order. Rules:
 *  1. preferred (first) predicted in time -> only it (hedging covers an overrun);
 *  2. preferred late but another tier in time -> BOTH now: the preferred (unless hopeless) and the highest-priority in-time tier
 *     (a non-Gemini tier beats Gemini: Gemini only when it is the only tier in time, quota discipline);
 *  3. nobody in time -> the fastest tier alone (a late dub still serves rewinds and the rest of the slot).
 */
export function planCell(o: { timeToSlot: number; tiers: PlanTier[]; marginSec?: number }): CellPlan {
  const margin = o.marginSec ?? PLAN_MARGIN_SEC;
  const tiers = o.tiers;
  if (tiers.length === 0) return { start: [], reason: 'no-tier', inTime: [], late: true };
  const pref = tiers[0]!;
  const inTime = tiers.filter((t) => t.expectedSec + margin <= o.timeToSlot);
  const ids = inTime.map((t) => t.id);
  if (tiers.length === 1) return { start: [pref.id], preferred: pref.id, reason: 'single', inTime: ids, late: inTime.length === 0 };
  if (inTime.includes(pref)) return { start: [pref.id], preferred: pref.id, reason: 'preferred-in-time', inTime: ids, late: false };
  if (inTime.length > 0) {
    const fb = inTime.find((t) => t.id !== 'gemini') ?? inTime[0]!;
    const hopeless = pref.expectedSec > HOPELESS_FACTOR * Math.max(0, o.timeToSlot) + margin;
    const start = hopeless ? [fb.id] : [pref.id, fb.id];
    return { start, preferred: pref.id, reason: 'preferred-late-fallback', inTime: ids, late: false };
  }
  const fastest = tiers.reduce((a, b) => (b.expectedSec < a.expectedSec ? b : a));
  return { start: [fastest.id], preferred: pref.id, reason: 'none-in-time-fastest', inTime: ids, late: true };
}

/** In-flight cap per Yandex tier: enough parallel jobs to sustain real time at the slowest expected latency. */
export function yandexTierCap(maxExpectedSec: number, chunkSec: number, minCap = 5): number {
  const n = Math.ceil(maxExpectedSec / Math.max(1, chunkSec)) + 3;
  return Math.min(10, Math.max(minCap, n));
}

/**
 * Dynamic job deadline (ms) of a Yandex job: max(60 s, min(180 s, timeToSlot + 20 s)); a job that is only for rewinds
 * (slot already over) gets the longest; never shorter than 1.4 x the tier's expected latency (a slow-but-alive tier must
 * not be cut off by its own deadline).
 */
export function jobTimeoutMs(timeToSlotSec: number, slotOver: boolean, expectedSec = 0): number {
  const base = slotOver ? JOB_TIMEOUT_MAX_MS : Math.max(JOB_TIMEOUT_MIN_MS, Math.min(JOB_TIMEOUT_MAX_MS, (timeToSlotSec + 20) * 1000));
  return Math.round(Math.min(JOB_TIMEOUT_MAX_MS, Math.max(base, expectedSec * 1400)));
}

export type UpgradeDecision = 'upgrade' | 'swap-now' | 'defer';

/**
 * A higher-priority dub of a cell arrived while a lower-priority one already covers it.
 *  upgrade  : the slot starts >= UPGRADE_LEAD_SEC from now -> replace the scheduled dub;
 *  swap-now : the slot is entirely in the past -> replace silently (rewinds get the better voice);
 *  defer    : the slot is playing / imminent -> do not touch playback now, swap in after the slot has passed.
 */
export function upgradeDecision(cellStart: number, cellEnd: number, ct: number): UpgradeDecision {
  if (cellStart - ct >= UPGRADE_LEAD_SEC) return 'upgrade';
  if (ct >= cellEnd) return 'swap-now';
  return 'defer';
}
