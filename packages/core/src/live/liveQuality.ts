/**
 * Experimental 'quality' live mode (settings.liveMode): Yandex tiers are tried on live videos next to the always-running local
 * tier. Pure helpers: the delay target, the one-extra-jump rule and the sampling / backoff gate for Yandex requests.
 */
import type { ProviderId } from '../providers/types';
import { MIN_DELAY_SEC } from './liveDelay';

/** the largest delay target (s): Twitch keeps ~30 s of back-buffer, other sites (YouTube DVR) allow much more */
export const QUALITY_DELAY_CAP_TWITCH_SEC = 28;
export const QUALITY_DELAY_CAP_DEFAULT_SEC = 60;
/** a later extra jump may replay at most this many seconds */
export const QUALITY_EXTRA_JUMP_MAX_SEC = 8;
/** at most this many Yandex requests in flight on a live video (both tiers together) */
export const LIVE_YANDEX_MAX_INFLIGHT = 2;
/** Yandex results (ok or failed) collected before the latency model may stop the sending */
export const LIVE_YANDEX_PROBE_RESULTS = 6;
/** after a backoff this many results are enough to judge again */
export const LIVE_YANDEX_REPROBE_RESULTS = 3;
export const LIVE_YANDEX_BACKOFF_MS = 5 * 60_000;
/** a Yandex job of a live video is cut off after this long: a dub later than any delay target is useless */
export const LIVE_YANDEX_JOB_DEADLINE_MS = 75_000;
/** same margin as the deadline planner (planner.ts PLAN_MARGIN_SEC) */
const FIT_MARGIN_SEC = 5;

export function isTwitchHost(host: unknown): boolean {
  const h = typeof host === 'string' ? host.trim().toLowerCase().replace(/^www\./, '') : '';
  return h === 'twitch.tv' || h.endsWith('.twitch.tv');
}

export function qualityDelayCapSec(host: unknown): number {
  return isTwitchHost(host) ? QUALITY_DELAY_CAP_TWITCH_SEC : QUALITY_DELAY_CAP_DEFAULT_SEC;
}

/** the total delay to aim for: min(back-buffer without ads - 1, cap); 0 when less than MIN_DELAY_SEC would result */
export function qualityDelaySec(availableBackSec: number, host: unknown): number {
  const d = Math.min(availableBackSec - 1, qualityDelayCapSec(host));
  return d >= MIN_DELAY_SEC ? d : 0;
}

/**
 * The ONE additional jump after the first rewind: how many seconds it would replay. It reaches towards the target (cap - applied,
 * and what the back-buffer holds now), is at least MIN_DELAY_SEC and is cut to QUALITY_EXTRA_JUMP_MAX_SEC; 0 = no jump.
 */
export function qualityExtraJumpSec(availableBackSec: number, appliedSec: number, host: unknown): number {
  const want = Math.min(availableBackSec - 1, qualityDelayCapSec(host) - appliedSec);
  return want >= MIN_DELAY_SEC ? Math.min(want, QUALITY_EXTRA_JUMP_MAX_SEC) : 0;
}

export interface GateTier {
  id: ProviderId;
  /** expected latency (s) of a job of this cell's length */
  expectedSec: number;
}

export type GateReason = 'probe' | 'in-time' | 'late' | 'backoff' | 'backoff-start' | 'busy';

export interface GateDecision {
  /** Yandex tiers to start for this cell (0 or 1) */
  send: ProviderId[];
  reason: GateReason;
  /** set when a backoff started with this decision */
  backoff?: { results: number; bestExpectedSec: number; budgetSec: number };
}

/**
 * Which Yandex tier (if any) gets a live cell. Until LIVE_YANDEX_PROBE_RESULTS results exist every free slot is used (round robin over the
 * free tiers) so that the latency is MEASURED, whatever the priors say. Afterwards the latency model decides per cell (expected + margin
 * must fit before the slot); when even the best tier cannot make the whole delay budget a 5 minute backoff starts.
 */
export class YandexLiveGate {
  private results = 0;
  private backoffUntil = 0;
  private rot = 0;
  constructor(private readonly now: () => number) {}

  record(): void {
    this.results++;
  }

  resultCount(): number {
    return this.results;
  }

  inBackoff(): boolean {
    return this.now() < this.backoffUntil;
  }

  /** `tiers` = usable Yandex tiers with a free slot (priority order); `all` = every usable Yandex tier (the backoff judges those) */
  decide(o: { ttsSec: number; budgetSec: number; tiers: GateTier[]; all?: GateTier[] }): GateDecision {
    const t = this.now();
    if (t < this.backoffUntil) return { send: [], reason: 'backoff' };
    if (o.tiers.length === 0) return { send: [], reason: 'busy' };
    if (this.results < LIVE_YANDEX_PROBE_RESULTS) return { send: [o.tiers[this.rot++ % o.tiers.length]!.id], reason: 'probe' };
    const fit = o.tiers.find((x) => x.expectedSec + FIT_MARGIN_SEC <= o.ttsSec);
    if (fit) return { send: [fit.id], reason: 'in-time' };
    const best = Math.min(...(o.all ?? o.tiers).map((x) => x.expectedSec));
    if (best + FIT_MARGIN_SEC > o.budgetSec) {
      this.backoffUntil = t + LIVE_YANDEX_BACKOFF_MS;
      const results = this.results;
      this.results = LIVE_YANDEX_PROBE_RESULTS - LIVE_YANDEX_REPROBE_RESULTS;
      return { send: [], reason: 'backoff-start', backoff: { results, bestExpectedSec: best, budgetSec: o.budgetSec } };
    }
    return { send: [], reason: 'late' };
  }
}
