/**
 * Live-stream delay: on a live video the playhead sits at the live edge, so the capture has no lookahead. Seeking back
 * inside the player's back-buffer (measured on Twitch: playback continues at rate 1 and stays that far behind) gives
 * the dub that much extra time. Pausing / slowing down cannot be used (Twitch destroys the buffer / forces rate 1).
 */
import { diag } from '../diag';

export interface TimeRangesLike {
  length: number;
  start(i: number): number;
  end(i: number): number;
}

export const MIN_DELAY_SEC = 3;
/** `liveDelaySec: -1` (auto) before any latency is measured: this many seconds while the 'hls' capture runs, otherwise 0 */
export const AUTO_LIVE_DELAY_SEC = 15;
export const AUTO_DELAY_MIN_SEC = 6;
export const AUTO_DELAY_MAX_SEC = 20;
/** cell grid used for live 'hls' capture (shorter than the VOD grid: the dub of a cell is ready ~chunk + pipeline after its start) */
export const LIVE_CHUNK_SEC = 8;
export const AUTO_DELAY_MARGIN_SEC = 1;

/**
 * Auto delay from the measured pipeline: the cell's last audio exists at (cell start + chunkSec) of live time and the dub
 * `latencySec` (the MEASURED end-to-end pipeline latency, e.g. ~1 s for GPU ASR + TTS) later; the playhead must still be before
 * the cell start then => delay = chunkSec + latency + 1 - lag, clamped to 6..20 s (a fast GPU needs ~10 s, not 18).
 */
export function autoDelayFromLatency(chunkSec: number, latencySec: number, lagSec = 0): number {
  if (!(latencySec > 0)) return AUTO_LIVE_DELAY_SEC;
  // the dub slot is shifted `lagSec` behind the phrase, so the pipeline has that much more time
  return Math.min(AUTO_DELAY_MAX_SEC, Math.max(AUTO_DELAY_MIN_SEC, Math.ceil(chunkSec + latencySec + AUTO_DELAY_MARGIN_SEC - Math.max(0, lagSec))));
}

/**
 * the delay to apply: an explicit setting (>= 0) wins; -1 (auto) = computed from the measured latency only while the 'hls'
 * capture runs (AUTO_LIVE_DELAY_SEC while nothing is measured), else 0
 */
export function resolveLiveDelaySec(setting: number, captureKind: string | undefined, chunkSec = LIVE_CHUNK_SEC, latencySec = 0, lagSec = 0, liveVideo = false): number {
  if (setting >= 0) return setting;
  // 'hls' (Twitch) always has lookahead; 'mse' has it from the player buffer, which on a live video is only worth using when we make room for it
  return captureKind === 'hls' || (liveVideo && captureKind === 'mse') ? autoDelayFromLatency(chunkSec, latencySec, lagSec) : 0;
}

/** one `live-delay-skip` diag line per reason per 10 s */
export class SkipLog {
  private readonly last = new Map<string, number>();
  constructor(private readonly now: () => number = Date.now) {}
  log(reason: string, data: Record<string, unknown> = {}): void {
    const t = this.now();
    const prev = this.last.get(reason);
    if (prev !== undefined && t - prev < 10_000) return;
    this.last.set(reason, t);
    diag.log('live-delay-skip', { reason, ...data });
  }
}
export const RETRY_MS = 2000;
export const GIVE_UP_MS = 60_000;
export const USER_SEEK_GUARD_MS = 5000;
const MAX_REARMS = 5;
const MAX_RAISES = 8;
/** a re-applied (raised) delay must add at least this much */
const MIN_RAISE_SEC = 2;

export interface LiveLike {
  duration: number;
  seekable?: TimeRangesLike;
}

/** live = no finite duration, or a seekable window that ends absurdly far away (Twitch: 1073741824) */
export function isLiveVideo(v: LiveLike): boolean {
  if (!Number.isFinite(v.duration) || v.duration === Infinity) return true;
  const s = v.seekable;
  return !!s && s.length > 0 && s.end(s.length - 1) > 1e8;
}

/** a live video for sure (never NaN, which a VOD reports before its metadata is loaded): infinite duration or an absurd seekable end */
export function isDefinitelyLive(v: LiveLike): boolean {
  if (v.duration === Infinity) return true;
  const s = v.seekable;
  return !!s && s.length > 0 && s.end(s.length - 1) > 1e8;
}

/**
 * Seconds the playhead can go back at time t: the buffered back-buffer, or (finite live window, e.g. a YouTube DVR stream)
 * the distance to the start of the seekable window, whichever is larger. Twitch's absurd seekable range is ignored.
 */
export function availableBackSec(v: { buffered?: TimeRangesLike; seekable?: TimeRangesLike }, t: number, adEnd?: number): { sec: number; via: 'buffer' | 'dvr' } {
  const floor = adFloor(adEnd);
  const buf = backBufferSec(v.buffered, t, floor);
  const s = v.seekable;
  if (s && s.length > 0 && s.end(s.length - 1) <= 1e8) {
    for (let i = 0; i < s.length; i++) {
      if (s.start(i) <= t + 0.05 && t <= s.end(i) + 0.05) {
        const dvr = Math.max(0, t - Math.max(s.start(i), floor));
        if (dvr > buf) return { sec: dvr, via: 'dvr' };
      }
    }
  }
  return { sec: buf, via: 'buffer' };
}

/** the playhead is never rewound closer than this to the end of an ad break (the video time of the ad is not stream content) */
export const AD_FLOOR_MARGIN_SEC = 1;

/** the video time below which a rewind must not go: the end of the latest ad break + margin (-Infinity without a break, +Infinity while one runs) */
export function adFloor(adEnd: number | undefined): number {
  return adEnd === undefined || Number.isNaN(adEnd) ? -Infinity : adEnd + AD_FLOOR_MARGIN_SEC;
}

/**
 * back-buffer length at time t: t minus the start of the buffered range holding t (0 when t is not buffered), counted from the end
 * of the latest ad break (`floor`, see adFloor) when that lies inside the range. Ad region 0-31 s, t = 37 s => 5 s.
 */
export function backBufferSec(buffered: TimeRangesLike | undefined, t: number, floor = -Infinity): number {
  if (!buffered) return 0;
  for (let i = 0; i < buffered.length; i++) {
    if (buffered.start(i) <= t + 0.05 && t <= buffered.end(i) + 0.05) return Math.max(0, t - Math.max(buffered.start(i), floor));
  }
  return 0;
}

/** seconds buffered ahead of t */
export function aheadSec(buffered: TimeRangesLike | undefined, t: number): number {
  if (!buffered) return 0;
  for (let i = 0; i < buffered.length; i++) {
    if (buffered.start(i) <= t + 0.05 && t <= buffered.end(i) + 0.05) return Math.max(0, buffered.end(i) - t);
  }
  return 0;
}

/** the delay to apply: min(asked, available - 1) when that is at least MIN_DELAY_SEC, else 0 */
export function safeDelaySec(asked: number, available: number): number {
  const d = Math.min(asked, available - 1);
  return d >= MIN_DELAY_SEC ? d : 0;
}

export interface LiveDelayOptions {
  video: HTMLVideoElement;
  /** current setting (read on every attempt) */
  getDelaySec: () => number;
  /** true while seeking would be wrong (an ad break: the playing audio is not the stream) */
  suspended?: () => boolean;
  /** video time where the latest ad break ended (Infinity while one runs): the playhead is never rewound into or across it */
  adEnd?: () => number | undefined;
  /** false = do not seek yet (rewind-when-ready: nothing is dubbed, so nothing needs the delay); true / absent = go */
  gate?: () => boolean;
  /** true = apply whatever back-buffer exists (>= MIN_DELAY_SEC) at once instead of waiting for the full wanted delay */
  immediate?: () => boolean;
  /** called right BEFORE the controller moves the playhead back (the capture keeps its clock mapping) */
  onOwnSeek?: (fromCt: number, toCt: number) => void;
  now?: () => number;
}

export class LiveDelayController {
  private readonly v: HTMLVideoElement;
  private readonly now: () => number;
  private timer?: ReturnType<typeof setInterval>;
  private armedAt = 0;
  private ownUntil = 0;
  private lastUserSeekAt = -Infinity;
  private lastCt = 0;
  private rearms = 0;
  private raises = 0;
  /** seconds we have moved the playhead back in the current player buffer (0 after a player reset) */
  private applied = 0;
  private readonly skips: SkipLog;
  private done = false;
  private cancelled = false;
  private stopped = true;
  /** the seeked event of our own seek, not yet consumed by the engine */
  private ownPending = false;

  constructor(private readonly o: LiveDelayOptions) {
    this.v = o.video;
    this.now = o.now ?? Date.now;
    this.skips = new SkipLog(this.now);
  }

  /** total seconds currently applied */
  appliedSec(): number {
    return this.applied;
  }

  /** rewind-when-ready: a dub is waiting that needs the playhead back; (re)start trying now */
  requestRewind(): void {
    if (this.stopped || this.cancelled) return;
    this.arm();
    this.attempt();
  }

  /** the wanted delay grew (latency measured): move further back, if the back-buffer allows (called periodically) */
  reapply(): void {
    if (this.stopped || this.cancelled || !this.done || this.raises >= MAX_RAISES) return;
    if (this.applied <= 0 || this.o.getDelaySec() - this.applied < MIN_RAISE_SEC) return;
    this.raises++;
    diag.log('live-delay-raise', { from: this.applied, wanted: this.o.getDelaySec(), n: this.raises });
    this.arm();
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.lastCt = this.v.currentTime;
    this.v.addEventListener('seeking', this.onSeeking);
    this.v.addEventListener('emptied', this.onEmptied);
    this.v.addEventListener('timeupdate', this.onTime);
    this.arm();
    this.attempt();
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = undefined;
    this.v.removeEventListener('seeking', this.onSeeking);
    this.v.removeEventListener('emptied', this.onEmptied);
    this.v.removeEventListener('timeupdate', this.onTime);
  }

  /** true once for the seeked event caused by our own seek (the engine restarts the capture window then) */
  takeOwnSeek(): boolean {
    const own = this.ownPending && this.now() < this.ownUntil;
    this.ownPending = false;
    return own;
  }

  /** our own seek is under way / its seeked event is not consumed yet (a ct drop now is not a player reset) */
  ownSeekPending(): boolean {
    return this.ownPending && this.now() < this.ownUntil;
  }

  private arm(): void {
    this.armedAt = this.now();
    this.done = false;
    clearInterval(this.timer);
    this.timer = setInterval(() => this.attempt(), RETRY_MS);
  }

  private disarm(): void {
    this.done = true;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private rearm(why: string): void {
    if (this.cancelled || this.rearms >= MAX_REARMS) return;
    this.rearms++;
    this.applied = 0; // a new player buffer: nothing is applied in it
    diag.log('live-delay-rearm', { why, n: this.rearms });
    this.arm();
  }

  private readonly onSeeking = (): void => {
    if (this.now() < this.ownUntil) return;
    const ct = this.v.currentTime;
    if (ct < 2 && this.lastCt > 20) {
      this.lastCt = ct;
      this.rearm('player-reset');
      return;
    }
    this.lastUserSeekAt = this.now();
    this.cancelled = true; // the user chose a position: leave it alone
    this.disarm();
  };

  private readonly onEmptied = (): void => {
    if (this.lastCt > 20) this.rearm('emptied');
    else this.skips.log('emptied-ignored', { lastCt: this.lastCt });
  };

  private readonly onTime = (): void => {
    const ct = this.v.currentTime;
    if (ct < 2 && this.lastCt > 20 && this.done) this.rearm('time-reset');
    this.lastCt = ct;
  };

  private attempt(): void {
    if (this.stopped || this.done || this.cancelled) return;
    if (this.o.gate && !this.o.gate()) return;
    const v = this.v;
    const t = this.now();
    if (this.o.suspended?.()) return this.skips.log('ads', { ct: v.currentTime });
    if (v.paused || v.ended) return this.skips.log(v.ended ? 'ended' : 'paused', { ct: v.currentTime });
    if (t - this.lastUserSeekAt < USER_SEEK_GUARD_MS) return this.skips.log('user-seek-guard');
    const asked = Math.max(0, Math.min(60, this.o.getDelaySec()));
    const need = asked - this.applied;
    if (asked < MIN_DELAY_SEC || (this.applied > 0 && need < MIN_RAISE_SEC)) {
      this.skips.log('setting<3', { asked, applied: this.applied });
      this.disarm();
      return;
    }
    const ct = v.currentTime;
    const adEnd = this.o.adEnd?.();
    const avail = availableBackSec(v, ct, adEnd);
    const available = avail.sec;
    const delay = Math.min(need, available - 1);
    const waited = t - this.armedAt;
    const immediate = this.o.immediate?.() ?? false;
    if (delay < MIN_DELAY_SEC || (!immediate && delay < need && waited < GIVE_UP_MS)) {
      if (waited >= GIVE_UP_MS) {
        diag.log('live-delay', { asked, applied: this.applied, available, aheadAfter: aheadSec(v.buffered, ct), gaveUp: true });
        this.disarm();
      } else this.skips.log('no-backbuffer', { ...(adEnd !== undefined && Number.isFinite(adEnd) ? { adEnd: Math.round(adEnd * 10) / 10 } : {}), via: avail.via, available: Math.round(available * 10) / 10, need, ct: Math.round(ct * 10) / 10 });
      return;
    }
    this.ownUntil = t + 3000;
    this.ownPending = true;
    this.o.onOwnSeek?.(ct, ct - delay);
    v.currentTime = ct - delay;
    this.lastCt = v.currentTime;
    this.applied += delay;
    diag.log('live-delay', { asked, applied: delay, total: this.applied, available, via: avail.via, aheadAfter: aheadSec(v.buffered, v.currentTime), ...(immediate ? { mode: 'rewind-ready' } : {}), ...(adEnd !== undefined && Number.isFinite(adEnd) ? { adEnd: Math.round(adEnd * 10) / 10 } : {}) });
    this.disarm();
  }
}
