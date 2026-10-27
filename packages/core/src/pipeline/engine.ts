/** TranslationEngine: capture -> prioritised chunk queue -> provider chain -> scheduler. */
import { Rechunker } from '../capture/rechunk';
import { diag } from '../diag';
import { createCapture as defaultCreateCapture, isHlsHost, strategiesForHost, type Capture, type CaptureKind, type CaptureStatus } from '../capture';
import { DubScheduler, type BufferedRange, type DubSchedulerOptions } from '../playback/scheduler';
import type { AudioChunk, DubProvider, DubSegment, ProviderId, SubtitleCue } from '../providers/types';
import type { Settings } from '../types';
import { siteVoiceOverride, withSiteOverride } from '../settings';
import { LIVE_CHUNK_SEC, LiveDelayController, availableBackSec, SkipLog, isDefinitelyLive, isLiveVideo, resolveLiveDelaySec } from '../live/liveDelay';
import {
  LIVE_YANDEX_JOB_DEADLINE_MS,
  LIVE_YANDEX_MAX_INFLIGHT,
  YandexLiveGate,
  qualityDelayCapSec,
  qualityDelaySec,
  qualityExtraJumpSec,
} from '../live/liveQuality';
import { localReasons, reasonText } from '../localasr';
import { speechOnsetSec } from '../localasr/speechPlacement';
import { PASS_CONFIDENCE, SKIP_CONFIDENCE, type LangVerdict } from '../lang/detect';
import type { LangVerdictStore } from '../lang/store';
import { findRussianDub, type AudioTracksController } from '../nativedub';
import { FALLBACK_DURATION_SEC, WATCH_WAIT_REPEAT_MS, indexMp3, nextWatchDelayMs, serveFromTrack, sliceMp3, trackCovers, type FullTrack, type FullTrackProber, type ProbeReplyInfo } from '../providers/yandex/fullTrack';
import { createChainState, eligibleProviders, runChain, type ChainOutcome, type ChainState, type EngineWarning } from './chain';
import {
  FULL_TRACK_LATENCY_SEC,
  GEMINI_MAX_PARALLEL,
  GROQ_MAX_PARALLEL,
  LOCAL_MAX_PARALLEL,
  LatencyModel,
  TIER_PRIOR_SEC,
  YANDEX_DUP_FACTOR,
  YANDEX_DUP_MIN_MS,
  YANDEX_FIRST_BATCH_CELLS,
  YANDEX_SUPER_CELLS,
  jobTimeoutMs,
  planCell,
  PLAN_MARGIN_SEC,
  LIVE_CHUNK_CAP,
  upgradeDecision,
  UPGRADE_LEAD_SEC,
  yandexTierCap,
  type CellPlan,
} from './planner';

/** the background hls probe: how often it starts while realtime is the fallback, and how long one try lasts */
export const HLS_PROBE_EVERY_MS = 30_000;
export const HLS_PROBE_RUN_MS = 45_000;

/** watchdog (long-session self-healing): tick period, thresholds, minimum gap between restarts, health line period */
export const WATCHDOG_TICK_MS = 5_000;
export const STALL_NO_CHUNK_SEC = 25;
export const STALL_NO_DUB_SEC = 60;
export const STALL_CALIBRATING_SEC = 100;
export const STALL_RESTART_GAP_MS = 30_000;
export const HEALTH_EVERY_MS = 30_000;
/** consecutive dubs that arrived already in the past, on a live realtime capture, before the watchdog tries to restore hls */
export const STALL_LATE_DUBS = 3;
/** the ads state held longer than this is treated as stuck (the DOM evidence is polled every 500 ms, so a real break never lasts this long) */
export const ADS_STUCK_SEC = 300;
/** a playlist 'gap' (stitched-ad segments skipped while the player shows no ad) longer than this is not waiting for an ad to end: restart for a new usher session. Stitched ads are ~30 s, so 5 min of silence was the bug */
export const GAP_STUCK_SEC = 45;
/** chunk RMS above this counts as speech for the 'no dub although speech exists' watchdog */
export const SPEECH_RMS = 0.01;

export type EngineState = 'idle' | 'starting' | 'translating' | 'buffering' | 'skipped-ru' | 'native-dub' | 'error' | 'stopped';

/**
 * Extra info of a state change. While the first dub is not audible yet the state stays 'starting' and `preparing` is set
 * (UI text: "Подготовка перевода…", with `etaSec` = estimated seconds until the first dub joins and `prerollPaused` =
 * the video is held paused by prerollPause).
 */
export interface EngineStateDetail {
  provider?: ProviderId;
  captureKind?: string;
  preparing?: boolean;
  etaSec?: number;
  prerollPaused?: boolean;
  /** nothing voiced for SLOW_START_HINT_MS while 'starting' on a Yandex tier: 'wait' = still waiting, 'switch' = another source was tried (hedge / cooldown) */
  slow?: 'wait' | 'switch';
  /** tier expected to deliver the first dub (the fastest planned one) while `preparing` */
  etaProvider?: ProviderId;
  /** the user's top tier is not the one voicing now: it takes over later (e.g. Gemini now, live voices later) */
  later?: ProviderId;
}

/** What the engine knows about the spoken language of the video (for the status line). */
export interface LanguageInfo {
  lang?: string;
  confidence: number;
  /** signal tag (see lang/detect.ts) */
  how: string;
  /** nothing trustworthy yet: translation runs and the first provider result decides */
  unverified: boolean;
  /** the video is Russian and was not translated */
  skipped?: boolean;
  /** Russian video translated anyway (forced or skipRussian off) */
  forced?: boolean;
}

export interface EngineEvents {
  onLanguage?(info: LanguageInfo): void;
  onState?(s: EngineState, detail?: EngineStateDetail): void;
  onWarning?(w: EngineWarning): void;
  onSubtitles?(cues: SubtitleCue[]): void;
  /** a chunk was voiced: which tier, and (when the provider knows) whether the voice is a lively one */
  onVoice?(v: { providerId: ProviderId; voice?: 'lively' | 'standard' }): void;
  /** every rechunked chunk (partial or not), before it enters the provider chain; for subtitle sources */
  onChunk?(chunk: AudioChunk): void;
  /** segments of every successful provider result, after the chain picked a tier */
  onSegments?(segments: DubSegment[], providerId: ProviderId): void;
}

/** The slice of DubScheduler the engine uses (fakeable). */
export interface SchedulerLike {
  onStarve?: (atVideoTime: number) => void;
  addSegments(segments: DubSegment[]): void;
  start(): void;
  dispose(): void;
  setVolume(v: number): void;
  /** dub lag changed in the settings panel */
  setDubLagSec?(v: number): void;
  getBuffered?(): BufferedRange[];
  /** drop matching segments (a playing one fades out); used when a tier is switched off */
  removeSegmentsWhere?(pred: (seg: DubSegment) => boolean, opts?: { fadeSec?: number; reason?: string }): number;
  /** re-time matching segments by deltaSec without dropping them (a provisional clock offset was corrected) */
  shiftSegmentsWhere?(pred: (seg: DubSegment) => boolean, deltaSec: number, opts?: { reason?: string; maxPlayingMoveSec?: number }): number;
}

export interface EngineDeps {
  /** 0.3.6: the cell's source words are censored (captions placeholder): the Yandex tiers are not used there when another tier exists */
  censored?: (startSec: number, durSec: number) => boolean;
  /** page host for per-site tier overrides (default location.hostname) */
  host?: string;
  video: HTMLVideoElement;
  audioCtx: AudioContext;
  providers: DubProvider[];
  settings: Settings;
  events?: EngineEvents;
  createCapture?: typeof defaultCreateCapture;
  createScheduler?: (video: HTMLVideoElement, audioCtx: AudioContext, opts: DubSchedulerOptions) => SchedulerLike;
  now?: () => number;
  /** abortable delay; default setTimeout (inject for tests) */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** wait before re-queueing a chunk no tier could translate (default 5000) */
  retryDelayMs?: number;
  /** max chunks in flight for the Yandex tiers (default YANDEX_MAX_PARALLEL) */
  maxParallelYandex?: number;
  /** delay before the next tier is hedged against a silent top tier (default HEDGE_AFTER_MS; 0 = off) */
  hedgeAfterMs?: number;
  hedgeTimer?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** timer of the slow-start hint (default real setTimeout; separate from `sleep` so test sleeps are unaffected) */
  hintSleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** override of SLOW_START_HINT_MS */
  slowStartMs?: number;
  /** cell length of the live 'hls' capture (default LIVE_CHUNK_SEC; tests use the VOD grid) */
  liveChunkSec?: number;
  /** how often the background hls probe runs while the capture is the realtime fallback (default HLS_PROBE_EVERY_MS) */
  hlsProbeEveryMs?: number;
  /** how long one probe tries to align before it gives up (default HLS_PROBE_RUN_MS) */
  hlsProbeRunMs?: number;
  /** watchdog tick period (default WATCHDOG_TICK_MS; tests call watchdogTick() themselves) */
  watchdogMs?: number;
  /** reload the local ASR (reset the offscreen queue / model) when the watchdog restarts a stalled pipeline */
  resetLocalAsr?: () => Promise<void>;
  /** override of the per-tier latency priors (s), mainly for tests */
  latencyPriors?: Partial<Record<ProviderId, number>>;
  /** early language gate: absent = no gate (everything is translated, the provider decides) */
  detectLanguage?: () => Promise<LangVerdict>;
  /** remembers 'ru' verdicts per video so rewatching costs nothing */
  langStore?: LangVerdictStore;
  /** Yandex full-track probe (real YouTube url -> an already translated video arrives as one mp3); absent = chunk mode only */
  fullTrack?: FullTrackProber;
  /** stable video identity (`yt:<id>` for YouTube); the full-track probe runs for YouTube only */
  videoKey?: () => string | undefined;
  /** how long the first cells wait for the first probe reply (default PROBE_RACE_MS) */
  probeRaceMs?: number;
  /** page-world YouTube audio tracks (native Russian dub, D28); absent = the feature is off for this host */
  audioTracks?: AudioTracksController;
  /** abortable delay of the native-dub watcher (default real setTimeout; separate from `sleep` so test sleeps are unaffected) */
  nativePoll?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** extra hold while a FINISHED url downloads (default PROBE_DOWNLOAD_HOLD_MS) */
  probeDownloadHoldMs?: number;
  /** abortable delay between background re-probes of a tier without a full track (default real setTimeout; separate from `sleep`) */
  probeWatchSleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** S26: cells merged into one Yandex super-chunk job at most (default YANDEX_SUPER_CELLS; <= 1 = off) */
  yandexSuperCells?: number;
  /** abortable delay before a straggling Yandex batch job gets its duplicate (default real setTimeout) */
  dupTimer?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** abortable delay between coverage re-checks of the captured audio before an upload (default real setTimeout; separate from the other sleeps) */
  uploadPollSleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** override of UPLOAD_MAX_SEC (tests) */
  uploadMaxSec?: number;
  /** override of the upload part size in bytes (tests) */
  uploadPartBytes?: number;
}

export interface EngineStartOptions {
  /** translate even a video detected as Russian */
  force?: boolean;
}

/** longest video whose captured audio is kept for a complete-audio upload (16 kHz mono int16: 900 s = 28.8 MB) */
export const UPLOAD_MAX_SEC = 900;
/** how often the coverage of the captured audio is re-checked while it fills (MSE buffering) */
export const UPLOAD_CHECK_MS = 5000;
/** give up waiting for complete coverage after this long (a later status-6 re-probe asks again) */
export const UPLOAD_WAIT_MAX_MS = 20 * 60_000;
/** after an upload a status 6 is re-checked this often, this many times, before the usual 90 s */
const POST_UPLOAD_SIX_TRIES = 6;

/** Gemini: lower, per-key quota */
const CONCURRENCY = 2;
/** lower bound of the per-tier Yandex in-flight cap (the real cap grows with the expected latency, see yandexTierCap) */
export const YANDEX_MAX_PARALLEL = 5;
/** after this long in 'starting' with nothing voiced the panel says Yandex answers slowly */
export const SLOW_START_HINT_MS = 40_000;
/** a cell is "on time" when its slot starts at least this long after the expected arrival of its dub */
const START_MARGIN_SEC = 3;
/** rewind-when-ready: the playhead goes back to this long before the late dub's slot */
const REWIND_MARGIN_SEC = 1;
/**
 * rewind policy (hls, auto delay): ONE seek per session part. A further jump only after >= EXTRA_REWIND_LATE_RUN consecutive late dubs and
 * >= EXTRA_REWIND_MIN_GAP_MS since the last seek, by at most EXTRA_REWIND_MAX_SEC (each seek replays audio the viewer already heard).
 */
const EXTRA_REWIND_LATE_RUN = 3;
const EXTRA_REWIND_MIN_GAP_MS = 60_000;
const EXTRA_REWIND_MAX_SEC = 6;
const EXTRA_REWIND_MIN_SEC = 3;
/** quality mode: the single extra jump waits at least this long after the first rewind (the back-buffer must have grown) */
const QUALITY_EXTRA_MIN_GAP_MS = 20_000;
/** a provisional-offset correction never moves a dub that is playing right now by more than this */
const RETIME_PLAYING_MAX_MOVE_SEC = 1;
/** soft restarts (poller only, same session) the watchdog tries before it recreates the whole capture */
const MAX_SOFT_RESTARTS = 2;
/** a real clock alignment moving provisional dubs by more than this re-times them */
const RETIME_MIN_SEC = 1.5;
/** a hedge (same tier overran its own expectation) starts after this multiple of the tier's expected latency */
const HEDGE_OVERRUN = 1.5;
const HEDGE_MIN_MS = 15_000;
/** a late dub is still worth a request when at least this much of the cell is left on arrival */
const LATE_TAIL_SEC = 3;
/** queued cells beyond this: the ones that would arrive entirely late are dropped (farthest first) */
const MAX_QUEUED = 10;
/** after a rate-limit-like answer the parallelism is halved for this long */
const RATE_BACKOFF_MS = 60_000;
/** prerollPause: give up waiting and resume the video after this long */
const PREROLL_MAX_MS = 60_000;
/** a live HLS stream (Twitch) cannot be waited for as long: the preroll pause is capped here, counted from its start */
export const PREROLL_LIVE_MAX_MS = 15_000;
/** live capture: this many consecutive cells without speech end the preroll pause at once (nothing will come to wait for) */
export const PREROLL_EMPTY_RELEASE = 2;
/** short wait between "dub ready" and resuming, so the scheduler has decoded the first segment */
const PREROLL_RESUME_DELAY_MS = 250;
const MAX_CHUNK_RETRIES = 3;
/** a chunk nobody could voice because every tier was cooling down is re-queued this many times (waits are not "attempts") */
const MAX_NOTIER_WAITS = 20;
const STALE_SEC = 1;
/** the first cells are held back at most this long for the first reply of the full-track probe */
export const PROBE_RACE_MS = 1500;
/** the first cells wait at most this long for a FINISHED url's mp3 to download (only while such a download runs) */
export const PROBE_DOWNLOAD_HOLD_MS = 6000;
/** cells ahead of the playhead that are created straight from a full track (no capture needed) */
export const TRACK_AHEAD_SEC = 90;
/** how often the native-dub watcher reads the active audio track */
export const NATIVE_POLL_MS = 2000;
/** cells this far behind the playhead are still upgraded when a better full track arrives (rewinds) */
const UPGRADE_BEHIND_SEC = 120;
/** completed chunks kept so a tier switch can re-voice them (memory: ~0.5 MB each) */
const KEEP_CHUNKS = 24;
const REVOICE_CELLS = 4;
/** results faster than this are cache hits or failures, not a latency sample */
const MIN_LATENCY_SAMPLE_MS = 2000;

interface CellResult {
  segments: DubSegment[];
  voice?: 'lively' | 'standard';
  sourceLang?: string;
  subtitles?: SubtitleCue[];
}

interface Task {
  chunk: AudioChunk;
  status: 'queued' | 'running' | 'waiting';
  attempts: number;
  noTierWaits: number;
  ctrl: AbortController;
  /** tier attempt most recently started (diag) */
  provider?: ProviderId;
  /** re-voicing a cell that already has audio: failures are silent, the old audio stays */
  revoice?: boolean;
  /** a failed super-chunk job sent this cell back: it runs on its own from now on */
  noBatch?: boolean;
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
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
}

function defaultScheduler(video: HTMLVideoElement, ctx: AudioContext, opts: DubSchedulerOptions): SchedulerLike {
  return new DubScheduler(video, ctx, opts);
}

export class TranslationEngine {
  private _state: EngineState = 'idle';
  private _active?: ProviderId;
  private settings: Settings;
  /** the settings as given (before the site / live-video voice override) */
  private rawSettings: Settings;
  /** the video is a live stream (infinite duration, Twitch, or YouTube isLive): cloud tiers are off, live delay applies */
  private liveVideo = false;
  private readonly chain = createChainState();
  private readonly tasks = new Map<number, Task>();
  private readonly doneRanges = new Map<number, number>();
  private readonly inflight = new Set<Task>();
  private capture?: Capture;
  private offChunk?: () => void;
  private bufTimer?: ReturnType<typeof setInterval>;
  private rechunker?: Rechunker;
  private scheduler?: SchedulerLike;
  private schedStarted = false;
  private segments: DubSegment[] = [];
  /** tier that voiced each finished cell (key = chunk startSec) */
  private readonly cellProvider = new Map<number, ProviderId>();
  /** finished chunks kept for re-voicing after a tier switch */
  private readonly kept = new Map<number, AudioChunk>();
  private usable = new Set<ProviderId>();
  /** Yandex full tracks found for this video (memory only, D17), by tier */
  private readonly tracks = new Map<ProviderId, FullTrack>();
  /** the probe's first reply is still awaited (and the race window is open): cells are not started yet */
  private probePending = false;
  private probeCtrl = new AbortController();
  /** Yandex tiers whose real-url probe was started in this session (startFullTrack) */
  private probedTiers = new Set<ProviderId>();
  /** number of cells swapped to a better full track (for the settings-switch diag) */
  private upgradeCount = 0;
  /** background re-probe loops (one per tier, key = the probe signal of the session that started it) */
  private readonly watching = new Map<ProviderId, AbortSignal>();
  /** real url of the video this session probes (YouTube only) */
  private probeUrl?: string;
  private nativeCtrl?: AbortController;
  /** complete-audio archive of the video (raw capture chunks, 16 kHz mono), for the real-id upload */
  private archive?: { pcm: Int16Array; rate: number; cov: Array<[number, number]>; durSec: number; maxEndSec: number };
  /** tiers whose complete audio has been uploaded under the real id this session (never twice) */
  private readonly uploaded = new Set<ProviderId>();
  /** tiers for which the upload is permanently skipped this session (too long / no id / mismatch) */
  private readonly uploadSkipped = new Set<ProviderId>();
  private uploadLock: Promise<unknown> = Promise.resolve();
  private readonly tierStates = new Map<string, string>();
  /** per-tier latency estimates (EWMA with priors) */
  private readonly model: LatencyModel;
  /** every tier attempt in flight (also racers that outlive their task), key `cell:tier` */
  private readonly liveAttempts = new Map<string, { id: ProviderId; abort: () => void }>();
  /** better-tier results that arrived too late for playback: swapped in after their slot has passed (rewinds) */
  private readonly pendingSwaps = new Map<number, { from: ProviderId; to: ProviderId; dur: number; segments: DubSegment[]; voice?: 'lively' | 'standard' }>();
  /** the tier expected to deliver the first audible dub, and when/what it was expected */
  private prep?: { id: ProviderId; at: number; expectedSec: number; cell: number };
  private lastWarnAt = new Map<string, number>();
  private cues: SubtitleCue[] = [];
  private sourceLang?: string;
  private forced = false;
  /** language not confirmed yet: the first provider result re-checks it */
  private unverified = false;
  private langInfo?: LanguageInfo;
  private excluded = new Set<CaptureKind>();
  /** a Twitch ad break is running (reported by the 'hls' capture or its probe): no live-delay seeks, the panel says why nothing is dubbed */
  private adsActive = false;
  /** background probe that brings 'hls' back after it was given up for 'realtime' (alignment kept failing outside an ad break) */
  private hlsProbeTimer?: ReturnType<typeof setTimeout>;
  private hlsProbe?: Capture;
  private gen = 0;
  /**
   * Bumped by every start() and every teardown(): an async continuation (probe, provider call, late race winner, cache
   * write) that captured an older value belongs to a previous video session and is dropped ('stale-drop').
   */
  private session = 0;
  /** identity of the video this session started on (deps.videoKey at start); a different key later = SPA navigation */
  private startKey?: string;
  private listening = false;
  private lastKey = '';
  /** a dub covering the playhead exists (the first dub has joined) */
  private dubReady = false;
  private startedAt = 0;
  private hintCtrl = new AbortController();
  private firstRequestAt = 0;
  private rateCap = 0;
  private rateUntil = 0;
  // prerollPause bookkeeping
  private prerollActive = false;
  private pausedByUs = false;
  private selfPlay = false;
  private prerollCtrl?: AbortController;
  private prerollAt = 0;
  /** consecutive cells that came back without any speech (reset by a voiced cell and by every capture start) */
  private emptyRun = 0;
  private liveDelay?: LiveDelayController;
  private yandexSkipLogAt = -Infinity;
  /** cancel functions of the live-Yandex job cutoff timers, by attempt key */
  private readonly capTimers = new Map<string, () => void>();
  /** 'quality' live mode: sampling / backoff of Yandex requests, and the single extra jump already done */
  private yandexGate = new YandexLiveGate(() => (this.deps.now ?? Date.now)());
  private qualityExtraDone = false;
  private liveSkips?: SkipLog;
  /**
   * rewind-when-ready: video-time slot (start + lag) of the first dub that arrived too late for its slot; the playhead is moved back
   * by what that dub needs (limited by the ad-aware back-buffer) instead of waiting for a full back-buffer before translating
   */
  private rewindSlot?: number;
  /** rewind policy: seeks done by the live-delay controller in this session, when the last one happened, and an extra jump being requested */
  private rewinds = 0;
  private lastRewindAt = -Infinity;
  private extraRewindSec = 0;
  private extraRewindAt = -Infinity;
  /** segments produced from chunks stamped with a provisional clock offset, and the cells they belong to (cell -> duration) */
  private provSegs = new WeakSet<DubSegment>();
  private provCells = new Map<number, number>();
  /** the real alignment's shift (new - provisional) once known; later results of provisional chunks are shifted by it */
  private provShift?: number;
  /** time-to-first-dub bookkeeping (diag 'ttfd'): ad time, capture alignment, first ASR result */
  private ttfd: { logged: boolean; adMs: number; adSince?: number; alignAt?: number; asrMs?: number } = { logged: false, adMs: 0 };
  /** consecutive voiced chunks whose segments were all already in the past on arrival */
  private lateRun = 0;
  // ---- watchdog / health ----
  private wdTimer?: ReturnType<typeof setInterval>;
  private wd = { chunksOut: 0, dubs: 0, capOpenedAt: 0, lastChunkAt: 0, lastDubAt: 0, speechSinceDub: undefined as number | undefined, playSince: undefined as number | undefined, lastRestartAt: -Infinity, lastHealthAt: 0, adsSince: undefined as number | undefined, lateDubs: 0, gapSince: undefined as number | undefined, gapLogged: false, softRestarts: 0 };
  /** last error of start()/capture switching, for the UI */
  lastError?: string;

  /** playhead at the previous timeupdate / seeked (detects the Twitch player rebuilding its timeline) */
  private lastCt = 0;

  /**
   * The live player rebuilt its buffer (pause/resume on Twitch: currentTime jumps to ~0 and the whole video clock is new). Every
   * cell, dub and mapping keyed in the OLD clock is void: left alone, old dubs would play at their old times in the new clock
   * (wrong content, early or late) and new cells with the same keys would be dropped as 'done'.
   * @returns true when a reset was handled
   */
  private checkTimelineReset(ct: number): boolean {
    const prev = this.lastCt;
    this.lastCt = ct;
    if (this.capture?.kind !== 'hls' || !(prev > 20) || !(ct < 2) || this.liveDelay?.ownSeekPending()) return false;
    diag.log('timeline-reset', { ct, prev });
    this.abortTasks();
    this.doneRanges.clear();
    this.kept.clear();
    this.cellProvider.clear();
    this.pendingSwaps.clear();
    this.scheduler?.removeSegmentsWhere?.(() => true, { fadeSec: 0.1, reason: 'timeline-reset' });
    this.segments = [];
    this.cues = [];
    this.dubReady = false;
    this.provCells.clear();
    this.provShift = undefined;
    this.provSegs = new WeakSet();
    // a new player timeline: the next late dub may rewind once again
    this.rewindSlot = undefined;
    this.extraRewindSec = 0;
    this.rechunker?.reset(ct);
    this.capture.invalidateClock?.('engine-reset');
    this.capture.start(ct).catch((e) => this.fail(e));
    this.updateReady();
    return true;
  }

  private readonly onSeeked = (): void => {
    if (this._state !== 'starting' && this._state !== 'translating' && this._state !== 'buffering') return;
    const ct = this.deps.video.currentTime;
    if (this.liveDelay?.takeOwnSeek()) {
      this.lastCt = ct;
      // our own live-delay seek: the capture window restarts at the new position, the session and its queued cells stay
      this.rechunker?.reset(ct);
      this.capture?.start(ct).catch((e) => this.fail(e));
      this.feedFromTrack();
      this.pump();
      this.updateReady();
      return;
    }
    if (this.checkTimelineReset(ct)) return;
    const cs = this.cellSec();
    let near = false;
    for (const [s, e] of this.doneRanges) if (ct >= s - cs && ct <= e + cs) near = true;
    for (const t of this.tasks.values()) {
      if (ct >= t.chunk.startSec - cs && ct <= t.chunk.startSec + t.chunk.durationSec + cs) near = true;
    }
    if (near) {
      this.feedFromTrack();
      this.pump();
      this.updateReady();
      return;
    }
    this.abortTasks();
    this.cues = [];
    this.dubReady = false;
    const cap = this.capture;
    this.rechunker?.reset(ct);
    if (cap) cap.start(ct).catch((e) => this.fail(e));
    this.feedFromTrack();
    this.pump();
    this.updateReady();
  };

  private readonly onTimeUpdate = (): void => {
    if (this._state === 'starting' || this._state === 'translating' || this._state === 'buffering') {
      if (this.checkTimelineReset(this.deps.video.currentTime)) return;
    } else this.lastCt = this.deps.video.currentTime;
    if (this.tracks.size > 0) {
      this.feedFromTrack();
      this.pump();
    }
    if (!this.dubReady) this.updateReady();
    if (this.pendingSwaps.size > 0) this.flushSwaps();
  };

  /** the user pressed play while we hold the video paused for the preroll: they are in charge now */
  private readonly onPlayEvent = (): void => {
    if (this.selfPlay || !this.prerollActive) return;
    diag.log('preroll-cancel', { reason: 'user-play', ct: this.deps.video.currentTime });
    this.endPreroll();
    this.pausedByUs = false;
    this.emitPreparing();
  };

  private hasLocalProvider(): boolean {
    return this.deps.providers.some((p) => p.id === 'local');
  }

  constructor(private readonly deps: EngineDeps) {
    this.rawSettings = deps.settings;
    this.settings = withSiteOverride(deps.settings, this.hostName());
    this.model = new LatencyModel(() => (deps.now ?? Date.now)(), { ...TIER_PRIOR_SEC, ...deps.latencyPriors });
  }

  get state(): EngineState {
    return this._state;
  }
  /** live stream (start-time detection incl. the YouTube isLive bridge flag, or the element right now) */
  get live(): boolean {
    return this.isLive();
  }
  get activeProvider(): ProviderId | undefined {
    return this._active;
  }

  get language(): LanguageInfo | undefined {
    return this.langInfo;
  }

  async start(opts: EngineStartOptions = {}): Promise<void> {
    if (this._state === 'starting' || this._state === 'translating' || this._state === 'buffering' || this._state === 'native-dub') return;
    this.reset();
    const gen = ++this.gen;
    this.session++;
    this.startKey = this.deps.videoKey?.();
    this.startedAt = (this.deps.now ?? Date.now)();
    this.forced = !!opts.force;
    this.setState('starting');
    if (!(await this.languageGate(gen)) || gen !== this.gen) return;
    if (await this.tryNativeDub(gen)) return;
    if (gen !== this.gen) return;
    await this.beginTranslation(gen);
  }

  /** Live video (not Twitch: that one is a host rule): the cloud tiers are not requested, the live delay may apply. Decided once per start. */
  private async detectLiveVideo(gen: number): Promise<void> {
    const v = this.deps.video;
    let via: string | undefined = isDefinitelyLive(v) ? 'duration' : undefined;
    if (!via && this.deps.videoKey?.()?.startsWith('yt:')) {
      try {
        if ((await this.deps.audioTracks?.list())?.live) via = 'yt-isLive';
      } catch {
        /* no reader */
      }
      if (gen !== this.gen) return;
      if (!via) {
        const root = (v as { closest?: (q: string) => Element | null }).closest?.('.html5-video-player');
        if (root?.querySelector('.ytp-time-display.ytp-live')) via = 'ytp-live';
      }
    }
    if (!via) return;
    this.liveVideo = true;
    const before = this.settings;
    this.settings = withSiteOverride(this.rawSettings, this.hostName(), true, this.hasLocalProvider());
    const cloud = (['yandex-live', 'yandex', 'groq', 'gemini'] as ProviderId[]).some((id) => before.voiceEnabled[id] !== false);
    diag.log('live-video', { via, cloudOff: cloud });
    // informative only when the user's own chain had cloud voices that are now off
    if (cloud && !siteVoiceOverride(this.hostName()) && this.settings.liveMode !== 'quality') localReasons.set('live', reasonText.live());
  }

  /** the translation proper: providers, probes, capture (everything after the language gate and the native-dub check) */
  private async beginTranslation(gen: number): Promise<void> {
    await this.detectLiveVideo(gen);
    if (gen !== this.gen) return;
    await Promise.all(this.deps.providers.map((p) => (p.probe ? p.probe().catch(() => undefined) : undefined)));
    if (gen !== this.gen) return;
    this.usable = this.computeUsable();
    if (this.liveVideo && this.settings.liveMode === 'quality') {
      this.yandexGate = new YandexLiveGate(() => (this.deps.now ?? Date.now)());
      this.qualityExtraDone = false;
      diag.log('live-quality', { yandex: this.yandexUsable(), tiers: [...this.usable], capSec: qualityDelayCapSec(this.hostName()) });
      if (!this.yandexUsable()) localReasons.set('quality-slow', reasonText.qualitySlow());
    }
    diag.log('engine-start', {
      t: this.deps.video.currentTime,
      chunkSec: this.cellSec(),
      order: this.settings.voiceOrder.join('>'),
      usable: [...this.usable],
      authSkip: [...this.chain.authSkip],
      // why a tier of the chain is not used right away (no waiting for it): disabled in the settings / needs sign-in (no token) / not configured
      skipped: Object.fromEntries(
        this.deps.providers
          .filter((p) => !this.usable.has(p.id))
          .map((p) => [p.id, this.settings.voiceEnabled[p.id] === false ? 'disabled' : this.chain.authSkip.has(p.id) ? 'auth' : p.id === 'yandex-live' && !this.settings.yandexToken ? 'no-token' : 'not-configured']),
      ),
      first: this.topUsable(this.usable) ?? null,
      voice: this.settings.voiceEnabled,
      yandexToken: !!this.settings.yandexToken,
      ctx: this.deps.audioCtx.state,
    });
    this.startFullTrack(gen);
    this.scheduler = (this.deps.createScheduler ?? defaultScheduler)(this.deps.video, this.deps.audioCtx, this.schedOpts());
    this.deps.video.addEventListener('seeked', this.onSeeked);
    this.deps.video.addEventListener('timeupdate', this.onTimeUpdate);
    this.deps.video.addEventListener('playing', this.onTimeUpdate);
    this.deps.video.addEventListener('play', this.onPlayEvent);
    this.listening = true;
    this.startWatchdog();
    // explicit delay (>= 3 s) starts now; liveDelaySec < 0 (auto) waits until the 'hls' capture is running (ensureLiveDelay)
    if (this.settings.liveDelaySec >= 3) this.ensureLiveDelay();
    this.beginPreroll(gen);
    // re-emit the preparing state once the slow-start threshold passes (and every 5 s after, for wait -> switch changes)
    let ticks = 0;
    const hintTick = (): void => {
      if (gen !== this.gen || this.dubReady || this._state !== 'starting' || ++ticks > 200) return;
      if ((this.deps.now ?? Date.now)() - this.startedAt < (this.deps.slowStartMs ?? SLOW_START_HINT_MS)) return;
      this.emitPreparing();
      (this.deps.hintSleep ?? defaultSleep)(5000, this.hintCtrl.signal).then(hintTick, () => {});
    };
    this.hintCtrl.abort();
    this.hintCtrl = new AbortController();
    (this.deps.hintSleep ?? defaultSleep)(this.deps.slowStartMs ?? SLOW_START_HINT_MS, this.hintCtrl.signal).then(hintTick, () => {});
    try {
      const cap = await this.openCapture(gen);
      if (gen !== this.gen) {
        cap?.stop();
        return;
      }
      if (!cap) return;
      this.rechunker?.reset(this.deps.video.currentTime);
      await cap.start(this.deps.video.currentTime);
      this.ensureLiveDelay();
    } catch (e) {
      if (gen === this.gen) this.fail(e);
    }
  }

  /** Cell grid in seconds: the live 'hls' capture uses a shorter one (settings.chunkSec stays the VOD grid). */
  private cellSec(): number {
    const hls = this.capture ? this.capture.kind === 'hls' : isHlsHost(this.hostName()) && !this.excluded.has('hls');
    return hls ? Math.min(this.settings.chunkSec, this.deps.liveChunkSec ?? LIVE_CHUNK_SEC) : this.settings.chunkSec;
  }

  /** Live delay in seconds for the current setting and capture: explicit value, or auto (-1) = from the measured latency with the 'hls' capture, else 0. */
  effectiveLiveDelaySec(): number {
    if (this.qualityLive() && this.settings.liveDelaySec < 0) return this.qualityTotalDelaySec();
    return resolveLiveDelaySec(this.settings.liveDelaySec, this.capture?.kind, this.cellSec(), this.latencySec(), this.lagSec(), this.isLive());
  }

  /** 'quality' live mode is on for this video and a Yandex tier can take part (otherwise it behaves as 'fast') */
  private qualityLive(): boolean {
    return this.liveVideo && this.settings.liveMode === 'quality' && this.yandexUsable();
  }

  /** total delay target of the quality mode: what is applied plus what the ad-aware back-buffer still holds, up to the site's cap */
  private qualityTotalDelaySec(): number {
    const applied = this.liveDelay?.appliedSec() ?? 0;
    const v = this.deps.video;
    const avail = availableBackSec(v, v.currentTime, this.capture?.adEndSec?.()).sec;
    const cap = qualityDelayCapSec(this.hostName());
    return Math.min(cap, applied + qualityDelaySec(avail, this.hostName()));
  }

  /** a live stream: detected at start (liveVideo) or reported by the element right now */
  private isLive(): boolean {
    return this.liveVideo || isLiveVideo(this.deps.video);
  }

  /** Dub lag (s): the slot of a phrase is its start + this (the scheduler shifts its timeline by the same amount). */
  private lagSec(): number {
    const v = this.settings.dubLagSec;
    return typeof v === 'number' && Number.isFinite(v) ? Math.min(6, Math.max(0, v)) : 0;
  }

  /** auto live delay on the 'hls' capture (Twitch): translate at once, rewind when the first dub is ready (the player's back-buffer is short and holds ads) */
  private rewindWhenReady(): boolean {
    return this.settings.liveDelaySec < 0 && (this.capture?.kind === 'hls' || this.qualityLive());
  }

  /**
   * The total delay the controller should apply. Explicit setting / already rewound: the effective (auto) delay. Rewind-when-ready, first
   * rewind: only what the late dub needs = how far past its slot the playhead is + a 1 s margin.
   */
  private liveDelayWantedSec(): number {
    const eff = this.effectiveLiveDelaySec();
    if (!this.rewindWhenReady()) return eff;
    // exactly ONE rewind per session part: once something is applied the wanted total stays there (no incremental re-seeks that replay
    // content the viewer already heard); only an explicitly requested extra jump adds to it
    const applied = this.liveDelay?.appliedSec() ?? 0;
    if (applied > 0) return applied + this.extraRewindSec;
    if (this.rewindSlot === undefined) return 0;
    if (this.qualityLive() && this.settings.liveDelaySec < 0) return eff; // quality: straight to the largest safe delay, not only what this dub needs
    return Math.min(60, Math.max(0, this.deps.video.currentTime - this.rewindSlot + REWIND_MARGIN_SEC));
  }

  /**
   * rewind-when-ready: a dub just became ready. When its slot is already (nearly) gone, ask the live-delay controller to move the
   * playhead back so it can still be heard. The controller limits the rewind to the ad-aware back-buffer.
   */
  private maybeRewindForDub(segments: DubSegment[]): void {
    const ld = this.liveDelay;
    if (!ld || !this.rewindWhenReady() || segments.length === 0) return;
    if (ld.appliedSec() > 0) return this.maybeExtraRewind(ld);
    const slot = Math.min(...segments.map((x) => x.start)) + this.lagSec();
    const ct = this.deps.video.currentTime;
    const needed = ct - slot + REWIND_MARGIN_SEC;
    // quality mode: the first dub (local) is the cue to move to the largest safe delay even when its slot is still ahead (Yandex needs the time)
    if (needed < 3 && !this.qualityLive()) return; // the slot is still ahead: nothing to catch up
    this.rewindSlot = slot;
    diag.log('rewind-ready', { slot: Math.round(slot * 100) / 100, ct: Math.round(ct * 100) / 100, neededSec: Math.round(needed * 10) / 10, adEnd: this.capture?.adEndSec?.() ?? null });
    ld.requestRewind();
  }

  /**
   * After the one rewind: another (small) jump only when dubs keep arriving late (>= 3 in a row), >= 60 s after the last seek, and the
   * measured pipeline says more delay would help (auto delay > what is applied). Never more than EXTRA_REWIND_MAX_SEC.
   */
  private maybeExtraRewind(ld: LiveDelayController): void {
    const now = this.nowMs();
    if (this.qualityLive() && this.settings.liveDelaySec < 0) return this.maybeQualityExtraJump(ld, now);
    if (this.lateRun < EXTRA_REWIND_LATE_RUN || now - this.lastRewindAt < EXTRA_REWIND_MIN_GAP_MS) return;
    if (this.extraRewindSec > 0 && now - this.extraRewindAt < 70_000) return;
    const want = Math.min(EXTRA_REWIND_MAX_SEC, this.effectiveLiveDelaySec() - ld.appliedSec());
    if (want < EXTRA_REWIND_MIN_SEC) return;
    this.extraRewindSec = want;
    this.extraRewindAt = now;
    diag.log('rewind-extra', { sec: Math.round(want * 10) / 10, lateRun: this.lateRun, sinceLastSec: Math.round((now - this.lastRewindAt) / 1000), applied: ld.appliedSec() });
    ld.requestRewind();
  }

  /**
   * Quality mode: ONE more jump after the first rewind, only when the back-buffer has grown (target not reached) and the jump replays
   * at most QUALITY_EXTRA_JUMP_MAX_SEC. Never repeated.
   */
  private maybeQualityExtraJump(ld: LiveDelayController, now: number): void {
    if (this.qualityExtraDone || this.extraRewindSec > 0 || now - this.lastRewindAt < QUALITY_EXTRA_MIN_GAP_MS) return;
    const v = this.deps.video;
    const avail = availableBackSec(v, v.currentTime, this.capture?.adEndSec?.()).sec;
    const sec = qualityExtraJumpSec(avail, ld.appliedSec(), this.hostName());
    if (sec <= 0) return;
    this.qualityExtraDone = true;
    this.extraRewindSec = sec;
    this.extraRewindAt = now;
    diag.log('rewind-extra', { mode: 'quality', sec: Math.round(sec * 10) / 10, applied: ld.appliedSec(), available: Math.round(avail * 10) / 10 });
    ld.requestRewind();
  }

  /** (Re)evaluates whether the live-delay controller should run: it needs a live video and an effective delay >= 3 s. Cheap; called periodically. */
  private ensureLiveDelay(): void {
    const skip = (this.liveSkips ??= new SkipLog(this.deps.now));
    // an ad break: the playing audio is the ad, the playhead must not be moved (the controller itself is suspended too)
    if (this.adsActive) return skip.log('ads');
    const v = this.deps.video;
    // the Twitch player has no finite duration while it plays, but right after a pause/rebuild it can report anything: the 'hls' capture exists for live only
    const live = this.isLive() || this.capture?.kind === 'hls';
    const eff = this.effectiveLiveDelaySec();
    const want = live && (eff >= 3 || (this.qualityLive() && this.settings.liveDelaySec < 0));
    if (!want) {
      if (!live) skip.log('not-live', { duration: v.duration, seekableEnd: v.seekable && v.seekable.length > 0 ? v.seekable.end(v.seekable.length - 1) : null });
      else if (this.settings.liveDelaySec >= 0 && this.settings.liveDelaySec < 3) skip.log('setting<3', { setting: this.settings.liveDelaySec });
      else skip.log('capture-no-lookahead', { kind: this.capture?.kind ?? null, setting: this.settings.liveDelaySec });
    }
    if (want && !this.liveDelay) {
      this.liveDelay = new LiveDelayController({
        video: v,
        getDelaySec: () => this.liveDelayWantedSec(),
        suspended: () => this.adsActive,
        // never rewind into or across an ad break (the video time of the ad is not stream content)
        adEnd: () => this.capture?.adEndSec?.(),
        // auto (-1): rewind-when-ready, nothing is moved until a dub is waiting for it
        gate: () => !this.rewindWhenReady() || this.rewindSlot !== undefined,
        immediate: () => this.rewindWhenReady(),
        onOwnSeek: () => {
          this.capture?.noteOwnSeek?.();
          this.rewinds++;
          this.lastRewindAt = this.nowMs();
          this.extraRewindSec = 0;
        },
        now: this.deps.now,
      });
      this.liveDelay.start();
    } else if (!want && this.liveDelay && this.settings.liveDelaySec < 0) {
      this.liveDelay.stop();
      this.liveDelay = undefined;
    } else if (want && this.liveDelay) {
      this.liveDelay.reapply();
    }
  }

  // ---- native Russian audio track (D28) ----

  /** @returns true when start() must end here (native track in use, or the session was superseded) */
  private async tryNativeDub(gen: number): Promise<boolean> {
    const ctl = this.deps.audioTracks;
    if (!ctl || this.settings.preferNativeDub === false || !this.deps.videoKey?.()?.startsWith('yt:')) return false;
    const miss = (reason: string): false => {
      diag.log('native-dub-miss', { reason });
      return false;
    };
    let st: Awaited<ReturnType<AudioTracksController['list']>> = null;
    try {
      st = await ctl.list();
    } catch {
      st = null;
    }
    if (gen !== this.gen) return true;
    if (!st || st.tracks.length === 0) return miss('no-tracks');
    const ru = findRussianDub(st);
    diag.log('native-dub-probe', { tracks: st.tracks.map((t) => t.id), hasRu: !!ru });
    if (!ru) return false;
    let confirmed = st.currentId === ru.id;
    if (!confirmed) {
      let ok = false;
      try {
        ok = await ctl.select(ru.id);
      } catch {
        ok = false;
      }
      if (gen !== this.gen) return true;
      diag.log('native-dub-switch', { ok, from: st.currentId ?? '?', to: ru.id });
      if (!ok) return miss('set-failed');
    }
    this.setState('native-dub');
    this.watchNative(gen, ru.id, confirmed);
    return true;
  }

  /** observe the active track at most every NATIVE_POLL_MS: the user leaving Russian starts the normal translation, never fight the user */
  private watchNative(gen: number, ruId: string, confirmed: boolean): void {
    this.nativeCtrl?.abort();
    const ctrl = (this.nativeCtrl = new AbortController());
    const ctl = this.deps.audioTracks!;
    void (async () => {
      let misses = 0;
      for (;;) {
        try {
          await (this.deps.nativePoll ?? defaultSleep)(NATIVE_POLL_MS, ctrl.signal);
        } catch {
          return;
        }
        if (gen !== this.gen || ctrl.signal.aborted) return;
        if (this.videoChanged()) return;
        // the element reloads its media after setAudioTrack (ours or the user's): the player may report a transient track meanwhile
        const rs = (this.deps.video as { readyState?: number }).readyState;
        if (typeof rs === 'number' && rs < 2) continue;
        let cur: string | undefined;
        try {
          cur = (await ctl.list())?.currentId;
        } catch {
          cur = undefined;
        }
        if (gen !== this.gen || ctrl.signal.aborted) return;
        if (!cur) continue;
        if (cur === ruId) {
          confirmed = true;
          misses = 0;
          continue;
        }
        // right after our own switch the player may still report the old track: allow ~3 polls before giving up on it
        if (!confirmed && ++misses < 3) continue;
        diag.log(confirmed ? 'native-dub-left' : 'native-dub-miss', { reason: confirmed ? 'user-switched' : 'switch-not-applied', to: cur });
        this.nativeCtrl = undefined;
        this.setState('starting');
        try {
          await this.beginTranslation(gen);
        } catch (e) {
          if (gen === this.gen) this.fail(e);
        }
        return;
      }
    })();
  }

  stop(): void {
    if (this._state === 'stopped') return;
    this.teardown();
    this.setState('stopped');
  }

  private hostName(): string {
    return this.deps.host ?? (typeof location !== 'undefined' ? location.hostname : '');
  }

  updateSettings(raw: Settings): void {
    const prev = this.settings;
    this.rawSettings = raw;
    const s = withSiteOverride(raw, this.hostName(), this.liveVideo, this.hasLocalProvider());
    this.settings = s;
    const keysChanged = prev.geminiKeys.join('\n') !== s.geminiKeys.join('\n');
    if (prev.yandexToken !== s.yandexToken || prev.groqApiKey !== s.groqApiKey || keysChanged) this.chain.authSkip.clear();
    if (s.subtitles === 'off') this.cues = [];
    this.applyTierChange(prev, s);
    if (!this.scheduler) return;
    if (prev.originalVolume !== s.originalVolume) {
      this.rebuildScheduler();
    } else if (prev.translationVolume !== s.translationVolume) {
      this.scheduler.setVolume(s.translationVolume);
    }
    if (prev.dubLagSec !== s.dubLagSec) this.scheduler.setDubLagSec?.(this.lagSec());
  }

  // ---- tier switching (owner feedback #3) ----

  private computeUsable(): Set<ProviderId> {
    const out = new Set<ProviderId>();
    for (const p of this.deps.providers) {
      if (this.settings.voiceEnabled[p.id] === false) continue;
      if (this.chain.authSkip.has(p.id)) continue;
      if (!p.isConfigured()) continue;
      out.add(p.id);
    }
    return out;
  }

  private rankOf(id: ProviderId): number {
    const i = this.settings.voiceOrder.indexOf(id);
    return i < 0 ? 99 : i;
  }

  private topUsable(set: Set<ProviderId>): ProviderId | undefined {
    return [...set].sort((a, b) => this.rankOf(a) - this.rankOf(b))[0];
  }

  /**
   * A tier was switched off: cancel its in-flight attempts, drop its segments (the one playing fades out), and put its
   * cells back in the queue so the remaining tiers voice them. A tier that became available/better only affects cells
   * that are not voiced yet, plus the next few already voiced by a worse tier.
   */
  private applyTierChange(prev: Settings, s: Settings): void {
    if (this._state === 'idle' || this._state === 'stopped' || this._state === 'error' || this._state === 'skipped-ru' || this._state === 'native-dub') {
      this.usable = this.computeUsable();
      return;
    }
    const before = this.usable;
    const after = this.computeUsable();
    this.usable = after;
    const disabled = new Set<ProviderId>([...before].filter((id) => !after.has(id)));
    const enabled = [...after].filter((id) => !before.has(id));
    const topBefore = this.topUsable(before);
    const topAfter = this.topUsable(after);
    const orderChanged = prev.voiceOrder.join() !== s.voiceOrder.join();
    if (disabled.size === 0 && enabled.length === 0 && !orderChanged) return;
    diag.log('settings-tiers', {
      disabled: [...disabled],
      enabled,
      order: s.voiceOrder.join('>'),
      top: topAfter,
      inflight: [...this.liveAttempts.keys()],
    });
    for (const id of disabled) this.tierState(id, 'disabled', { reason: 'settings' });
    if (disabled.size > 0) this.dropTiers(disabled);
    if (enabled.length > 0) {
      let switched = 0;
      if (this.tracks.size > 0) {
        const before = this.upgradeCount;
        this.upgradeFromTracks(); // a re-enabled tier whose track exists takes over at once
        switched = this.upgradeCount - before;
      }
      // a Yandex tier that was not usable when the session started was never probed: probe the REAL url now (with the first-reply
      // hold, so no chunk-mode Yandex job starts in parallel to a track that is about to arrive); else the watchers take over
      const fresh = enabled.filter((t) => (t === 'yandex' || t === 'yandex-live') && !this.probedTiers.has(t) && !this.tracks.has(t));
      if (fresh.length > 0 && this.probedTiers.size === 0) this.startFullTrack(this.gen);
      else this.ensureWatchers();
      diag.log('settings-switch', { enabled, probed: fresh.length > 0 ? fresh : [...this.watching.keys()], switched });
    }
    if (topAfter && topAfter !== topBefore) this.revoiceUpcoming(topAfter);
    this.pump();
  }

  private dropTiers(ids: Set<ProviderId>): void {
    const ct = this.deps.video.currentTime;
    for (const [key, a] of [...this.liveAttempts]) {
      if (ids.has(a.id)) {
        diag.log('tier-abort-inflight', { attempt: key, tier: a.id });
        a.abort();
      }
    }
    const isDropped = (seg: DubSegment): boolean => !!seg.providerId && ids.has(seg.providerId);
    const removed = this.scheduler?.removeSegmentsWhere?.(isDropped, { fadeSec: 0.3, reason: 'tier-disabled' }) ?? 0;
    const before = this.segments.length;
    this.segments = this.segments.filter((x) => !isDropped(x));
    let requeued = 0;
    for (const [key, id] of [...this.cellProvider]) {
      if (!ids.has(id)) continue;
      this.cellProvider.delete(key);
      this.pendingSwaps.delete(key);
      const end = this.doneRanges.get(key);
      this.doneRanges.delete(key);
      const chunk = this.kept.get(key);
      if (!chunk || (end ?? key + chunk.durationSec) < ct - STALE_SEC || this.tasks.has(key)) continue;
      this.tasks.set(key, { chunk, status: 'queued', attempts: 0, noTierWaits: 0, ctrl: new AbortController() });
      requeued++;
    }
    diag.log('tier-dropped', { tiers: [...ids], segmentsEngine: before - this.segments.length, segmentsScheduler: removed, requeued, ct });
  }

  /** a better tier is now first: re-voice the next few cells that a worse tier already voiced */
  private revoiceUpcoming(top: ProviderId): void {
    const ct = this.deps.video.currentTime;
    const rank = this.rankOf(top);
    const cands = [...this.cellProvider]
      .filter(([key, id]) => key > ct + 2 && this.rankOf(id) > rank && this.kept.has(key) && !this.tasks.has(key))
      .sort((a, b) => a[0] - b[0])
      .slice(0, REVOICE_CELLS);
    for (const [key] of cands) {
      this.tasks.set(key, { chunk: this.kept.get(key)!, status: 'queued', attempts: 0, noTierWaits: 0, ctrl: new AbortController(), revoice: true });
    }
    if (cands.length > 0) diag.log('tier-revoice', { top, cells: cands.map(([k]) => k) });
  }

  // ---- capture ----

  private chunksFromCapture = 0;

  private async openCapture(gen: number): Promise<Capture | undefined> {
    const all: CaptureKind[] = strategiesForHost(this.hostName());
    const strategies = all.filter((k) => !this.excluded.has(k));
    if (strategies.length === 0) {
      this.fail(new Error('no capture strategy left'));
      return undefined;
    }
    const create = this.deps.createCapture ?? defaultCreateCapture;
    const cap = await create(this.deps.video, {
      chunkSec: this.settings.chunkSec,
      strategies,
      onStatus: (st) => this.onCaptureStatus(st, gen),
    });
    if (gen !== this.gen) return cap;
    this.capture = cap;
    this.chunksFromCapture = 0;
    this.emptyRun = 0;
    this.wd.capOpenedAt = this.nowMs();
    diag.log('capture-open', { kind: cap.kind, strategies });
    // a fallback away from hls on an hls host (offline / token error / no transport): same background probe as every other fallback
    if (cap.kind !== 'hls' && isHlsHost(this.hostName()) && strategies.includes('hls')) {
      this.excluded.add('hls');
      this.armHlsProbe(gen);
    }
    if (cap.kind === 'hls') this.capPrerollForLive(gen);
    // fixed [k*chunkSec, (k+1)*chunkSec) cells: a second viewing produces identical chunk boundaries (result cache)
    const rc = new Rechunker({
      chunkSec: this.cellSec(),
      emit: (c) => this.onChunk(c),
      // an incomplete cell that is still far enough ahead keeps waiting for its missing piece (a partial cell costs a
      // full request for little audio); once it is about to become late, the partial is better than nothing
      // holdCellsToEnd (realtime captures only): keep the cell until playback has passed its end (the rest of its audio is still coming).
      // Meaningless with the 'hls' capture (it has lookahead: cells arrive complete), where it is forced off and has no UI toggle.
      hold: (start) =>
        this.settings.holdCellsToEnd && cap.kind !== 'hls'
          ? start + this.cellSec() + this.lagSec() > this.deps.video.currentTime
          : start + this.lagSec() > this.deps.video.currentTime + this.latencySec() + START_MARGIN_SEC,
    });
    this.rechunker = rc;
    // diagnostics: how far the player has buffered ahead of playback (the lead the capture can deliver in time)
    const v = this.deps.video;
    this.bufTimer = setInterval(() => {
      const b = v.buffered;
      const end = b && b.length > 0 ? b.end(b.length - 1) : v.currentTime;
      diag.log('buf-ahead', { ct: v.currentTime, aheadSec: end - v.currentTime, ranges: b?.length ?? 0, kind: cap.kind });
      if (cap.kind === 'hls' || this.isLive()) this.ensureLiveDelay();
    }, 3000);
    this.offChunk = cap.onChunk((c) => {
      this.chunksFromCapture++;
      this.noteChunk(c);
      if (cap.kind === 'mse') this.noteMseClock(c);
      this.archiveChunk(c, cap.kind);
      rc.push(c);
    });
    return cap;
  }

  /**
   * The real clock alignment replaced a provisional offset: slots of chunks emitted under it moved by `shift` (new - old). Only FUTURE
   * cells use the real offset by themselves. Already scheduled provisional dubs are left alone when the difference is small; above
   * RETIME_MIN_SEC they are re-timed in the scheduler (not dropped), the not yet running provisional cells ahead of the playhead are
   * re-requested from the real mapping, and results of provisional chunks still in flight are shifted when they arrive.
   */
  private onRetime(shift: number): void {
    this.provShift = shift;
    const large = Math.abs(shift) > RETIME_MIN_SEC;
    const ct = this.deps.video.currentTime;
    let moved = 0;
    if (large) {
      moved = this.scheduler?.shiftSegmentsWhere?.((seg) => this.provSegs.has(seg), shift, { reason: 'provisional-offset', maxPlayingMoveSec: RETIME_PLAYING_MAX_MOVE_SEC }) ?? 0;
      this.segments = this.segments.map((x) => (this.provSegs.has(x) ? { ...x, start: x.start + shift, end: x.end + shift } : x));
      for (const [cell, dur] of this.provCells) {
        if (cell + dur <= ct - 1) continue;
        const t = this.tasks.get(cell);
        if (t && t.status !== 'running') {
          t.ctrl.abort();
          this.tasks.delete(cell);
        } else if (t) continue;
        this.doneRanges.delete(cell);
      }
      // the capture re-delivers the audio after the playhead under the real mapping
      this.rechunker?.reset(ct);
      this.capture?.start(ct).catch((e) => this.fail(e));
    }
    this.provCells.clear();
    this.provSegs = new WeakSet();
    diag.log('align-retime', { shiftSec: shift, large, moved, ct, estimate: Math.abs(shift) > 0.5 });
    this.pump();
  }

  /** diag 'ttfd', once per session at the first audible dub: where the time to the first voice went */
  private logTtfd(): void {
    const t = this.ttfd;
    if (t.logged) return;
    t.logged = true;
    const nowMs = (this.deps.now ?? Date.now)();
    const adMs = t.adMs + (t.adSince !== undefined ? nowMs - t.adSince : 0);
    const r1 = (ms: number): number => Math.round(ms / 100) / 10;
    diag.log('ttfd', {
      sinceStartSec: r1(nowMs - this.startedAt),
      adSec: r1(adMs),
      alignSec: t.alignAt !== undefined ? r1(t.alignAt - this.startedAt) : null,
      asrSec: t.asrMs !== undefined ? r1(t.asrMs) : null,
      capture: this.capture?.kind ?? null,
      rewound: this.liveDelay?.appliedSec() ?? 0,
    });
  }

  // ---- watchdog ----

  private nowMs(): number {
    return (this.deps.now ?? Date.now)();
  }

  private mseClock: { lastLogAt: number; lastDelta?: number; gen: number } = { lastLogAt: -Infinity, gen: -1 };

  /**
   * MSE chunks are stamped tfdt + timestampOffset and used as video time as is. delta = (end of the newest decoded segment) - (end of
   * the buffered range holding it): constant while both clocks agree; a jump means the DVR window / live edge moved or the player
   * re-based its timeline, and every cell index (cache cell, slots) after it is off by that much.
   */
  private noteMseClock(c: AudioChunk): void {
    const v = this.deps.video;
    const b = v.buffered;
    if (!b || b.length === 0) return;
    const end = c.startSec + c.durationSec;
    let bufEnd: number | undefined;
    for (let i = 0; i < b.length; i++) if (b.start(i) - 1 <= end && end <= b.end(i) + 1) bufEnd = b.end(i);
    if (bufEnd === undefined) return;
    const m = this.mseClock;
    if (m.gen !== this.gen) {
      m.gen = this.gen;
      m.lastDelta = undefined;
      m.lastLogAt = -Infinity;
    }
    const delta = Math.round((end - bufEnd) * 1000) / 1000;
    const t = this.nowMs();
    if (m.lastDelta !== undefined && Math.abs(delta - m.lastDelta) > 0.5) {
      diag.log('mse-clock-jump', { tfdtStart: c.startSec, ct: v.currentTime, delta, prev: m.lastDelta });
    }
    m.lastDelta = delta;
    if (t - m.lastLogAt >= 30_000) {
      m.lastLogAt = t;
      diag.log('mse-clock', { tfdtStart: c.startSec, ct: v.currentTime, delta });
    }
  }

  private noteChunk(c: AudioChunk): void {
    const t = this.nowMs();
    this.wd.chunksOut++;
    this.wd.lastChunkAt = t;
    this.wd.softRestarts = 0;
    this.wd.gapSince = undefined;
    this.wd.gapLogged = false;
    if (c.pcm.length > 0) {
      let sum = 0;
      const n = Math.min(c.pcm.length, 16000);
      for (let i = 0; i < n; i++) sum += (c.pcm[i]! / 32768) ** 2;
      if (Math.sqrt(sum / Math.max(1, n)) > SPEECH_RMS) this.wd.speechSinceDub ??= t;
    }
    localReasons.clear('restart');
  }

  private noteDub(): void {
    this.wd.dubs++;
    this.wd.lastDubAt = this.nowMs();
    this.wd.speechSinceDub = undefined;
  }

  private startWatchdog(): void {
    this.stopWatchdog();
    const t = this.nowMs();
    this.wd = { ...this.wd, capOpenedAt: t, lastChunkAt: 0, lastDubAt: 0, speechSinceDub: undefined, playSince: this.deps.video.paused ? undefined : t, lastHealthAt: t, lastRestartAt: -Infinity, adsSince: undefined, lateDubs: 0, gapSince: undefined, gapLogged: false, softRestarts: 0 };
    this.wdTimer = setInterval(() => this.watchdogTick(), this.deps.watchdogMs ?? WATCHDOG_TICK_MS);
  }

  private stopWatchdog(): void {
    clearInterval(this.wdTimer);
    this.wdTimer = undefined;
  }

  private alignedFlag(): boolean | null {
    const c = this.capture as unknown as { state?: () => { aligned: boolean } } | undefined;
    return this.capture?.kind === 'hls' ? (c?.state?.().aligned ?? null) : null;
  }

  private stallFlags(): Record<string, unknown> {
    const v = this.deps.video;
    return {
      ads: this.adsActive,
      aligned: this.alignedFlag(),
      capture: this.capture?.kind ?? null,
      asrQueue: [...this.tasks.values()].filter((x) => x.status === 'running').length,
      queued: this.tasks.size,
      state: this._state,
      ct: Math.round(v.currentTime * 10) / 10,
      lastError: this.lastError ?? null,
    };
  }

  /**
   * Long-session self-healing. Called every WATCHDOG_TICK_MS while a session runs (public for tests). Logs a compact 'health' line
   * every 30 s and, when the video plays but nothing comes out, logs 'stall' and restarts the capture (token + playlist + realign),
   * at most once per STALL_RESTART_GAP_MS. The reason surfaces through the local-reason line (no banner).
   */
  watchdogTick(): void {
    if (this._state !== 'starting' && this._state !== 'translating' && this._state !== 'buffering') return;
    const v = this.deps.video;
    const t = this.nowMs();
    const w = this.wd;
    const playing = !v.paused && !v.ended;
    if (!playing) w.playSince = undefined;
    else w.playSince ??= t;
    const ago = (x: number): number | null => (x > 0 ? Math.round((t - x) / 100) / 10 : null);
    if (t - w.lastHealthAt >= HEALTH_EVERY_MS) {
      w.lastHealthAt = t;
      const f = this.stallFlags();
      diag.log('health', { chunksOut: w.chunksOut, dubsScheduled: w.dubs, lastChunkAgoSec: ago(w.lastChunkAt), lastDubAgoSec: ago(w.lastDubAt), asrQueue: f.asrQueue, adsState: this.adsActive, aligned: f.aligned, capture: f.capture, playing, rewinds: this.rewinds, gaps: this.capture?.gapCount?.() ?? 0 });
    }
    if (!playing || !this.capture) return;
    let what: string | undefined;
    let sinceSec = 0;
    if (this.adsActive) {
      if (w.adsSince !== undefined && (t - w.adsSince) / 1000 > ADS_STUCK_SEC) {
        what = 'ads-stuck';
        sinceSec = (t - w.adsSince) / 1000;
      }
    } else {
      const ref = Math.max(w.lastChunkAt, w.capOpenedAt, w.playSince ?? 0);
      // an hls capture that is still calibrating (first alignment takes ~40 s) is not stalled
      const calibrating = this.capture.kind === 'hls' && this.alignedFlag() !== true;
      if ((t - ref) / 1000 > (calibrating ? STALL_CALIBRATING_SEC : STALL_NO_CHUNK_SEC)) {
        what = 'no-chunks';
        sinceSec = (t - ref) / 1000;
      } else if (w.speechSinceDub !== undefined && (t - Math.max(w.speechSinceDub, w.playSince ?? 0)) / 1000 > STALL_NO_DUB_SEC) {
        what = 'no-dubs';
        sinceSec = (t - w.speechSinceDub) / 1000;
      } else if (w.lateDubs >= STALL_LATE_DUBS && this.capture.kind === 'realtime' && isHlsHost(this.hostName())) {
        what = 'late-dubs';
        sinceSec = w.lateDubs;
      }
    }
    if (!what) {
      w.gapSince = undefined;
      w.gapLogged = false;
      return;
    }
    // The anonymous playlist carries stitched-ad segments (a 'gap'): no content audio from OUR stream for up to ~30 s although the capture is
    // healthy and the player shows no ad. Restarting would only create a new anonymous usher session (another preroll ad + a re-alignment).
    if ((what === 'no-chunks' || what === 'no-dubs') && this.capture.inGap?.()) {
      w.gapSince ??= t;
      if ((t - w.gapSince) / 1000 <= GAP_STUCK_SEC) {
        if (!w.gapLogged) {
          w.gapLogged = true;
          diag.log('stall', { what: 'gap', sinceSec: Math.round(sinceSec * 10) / 10, gaps: this.capture.gapCount?.() ?? 0, ...this.stallFlags() });
        }
        return;
      }
    }
    if (t - w.lastRestartAt < STALL_RESTART_GAP_MS) return;
    w.lastRestartAt = t;
    diag.log('stall', { what, sinceSec: Math.round(sinceSec * 10) / 10, ...this.stallFlags() });
    this.restartForStall(what);
  }

  private restartForStall(what: string): void {
    const ct = this.deps.video.currentTime;
    localReasons.set('restart', reasonText.restart());
    this.setAds(false);
    this.lateRun = 0;
    this.wd.lateDubs = 0;
    this.wd.speechSinceDub = undefined;
    // results of cells around the playhead may have been lost with the dead pipeline (or with a reset player): allow re-requests
    for (const [s, e] of [...this.doneRanges]) if (e > ct - 2) this.doneRanges.delete(s);
    if (what === 'late-dubs' || this.excluded.has('hls')) {
      this.excluded.delete('hls');
      this.stopHlsProbe();
    }
    const reset = this.deps.resetLocalAsr;
    if (reset && what !== 'late-dubs') void reset().catch((e) => diag.log('asr-reset-failed', { message: String((e as Error)?.message ?? e).slice(0, 100) }));
    this.rechunker?.reset(ct);
    // hls: restart only the poller (same media URL / token, the aligned clock or the remembered offset stays); a full capture restart
    // creates a new anonymous Twitch session. Only when soft restarts did not bring chunks back is the capture recreated.
    const cap = this.capture;
    if (cap?.kind === 'hls' && cap.softRestart && what !== 'late-dubs' && this.wd.softRestarts < MAX_SOFT_RESTARTS) {
      this.wd.softRestarts++;
      cap.softRestart(what);
      void cap.start(ct).catch((e) => this.fail(e));
      return;
    }
    void this.switchCapture();
  }

  private setAds(active: boolean): void {
    if (this.adsActive === active) return;
    this.adsActive = active;
    const nowMs = (this.deps.now ?? Date.now)();
    if (active) this.ttfd.adSince = nowMs;
    else if (this.ttfd.adSince !== undefined) {
      this.ttfd.adMs += nowMs - this.ttfd.adSince;
      this.ttfd.adSince = undefined;
    }
    this.wd.adsSince = active ? nowMs : undefined;
    diag.log('ads-state', { active });
    if (active) localReasons.set('ads', reasonText.ads());
    else localReasons.clear('ads');
  }

  private onCaptureStatus(st: CaptureStatus, gen: number): void {
    if (gen !== this.gen) return;
    if (st.type === 'ads') return this.setAds(st.active);
    if (st.type === 'aligned' || st.type === 'provisional') this.ttfd.alignAt ??= (this.deps.now ?? Date.now)();
    if (st.type === 'retime') return this.onRetime(st.shiftSec);
    if (st.type !== 'tainted' && st.type !== 'unsupported') return;
    const kind = this.capture?.kind;
    if (st.type === 'tainted') {
      this.deps.events?.onWarning?.({ kind: 'capture-tainted', message: `capture "${kind ?? '?'}" is tainted (cross-origin media)` });
      // a strategy that already delivered audio is demonstrably not tainted: a late report is a false positive
      if (this.chunksFromCapture > 0) return;
    }
    if (kind) this.excluded.add(kind);
    // alignment kept failing outside an ad break: realtime serves meanwhile, hls is probed in the background and taken back
    // EVERY way hls can fail (align-failed, tainted, offline, token/poll errors) keeps the background probe: realtime has no lookahead
    // (every dub is late), so hls is taken back as soon as one probe aligns
    if (kind === 'hls') {
      this.setAds(false);
      if (st.type === 'unsupported') {
        diag.log('hls-lost', { reason: st.reason });
        this.armHlsProbe(gen);
      }
    }
    void this.switchCapture();
  }

  // ---- background hls probe ----

  private armHlsProbe(gen: number): void {
    clearTimeout(this.hlsProbeTimer);
    this.hlsProbeTimer = setTimeout(() => void this.runHlsProbe(), this.deps.hlsProbeEveryMs ?? HLS_PROBE_EVERY_MS);
    void gen;
  }

  private stopHlsProbe(): void {
    clearTimeout(this.hlsProbeTimer);
    this.hlsProbeTimer = undefined;
    const p = this.hlsProbe;
    this.hlsProbe = undefined;
    try {
      p?.stop();
    } catch {
      /* already stopped */
    }
  }

  /** one lightweight alignment attempt with a second HlsCapture that delivers no chunks; success switches the engine back to hls */
  private async runHlsProbe(): Promise<void> {
    this.hlsProbeTimer = undefined;
    const gen = this.gen;
    if (this.capture?.kind === 'hls' || !this.excluded.has('hls') || this.hlsProbe) return;
    if (this._state !== 'translating' && this._state !== 'starting' && this._state !== 'buffering') return;
    let inAds = false;
    let done = false;
    const finish = (switchBack: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(watchdog);
      this.stopHlsProbe();
      if (inAds) this.setAds(false);
      if (gen !== this.gen) return;
      if (switchBack) {
        diag.log('hls-probe', { ok: true });
        this.excluded.delete('hls');
        this.setAds(false);
        void this.switchCapture();
      } else {
        if (!inAds) diag.log('hls-probe', { ok: false });
        this.armHlsProbe(gen);
      }
    };
    const watchdog = setTimeout(() => finish(false), this.deps.hlsProbeRunMs ?? HLS_PROBE_RUN_MS);
    try {
      const create = this.deps.createCapture ?? defaultCreateCapture;
      const cap = await create(this.deps.video, {
        chunkSec: this.settings.chunkSec,
        strategies: ['hls'],
        onStatus: (st) => {
          if (done || gen !== this.gen) return;
          if (st.type === 'aligned') finish(true);
          else if (st.type === 'ads') {
            inAds = st.active;
            this.setAds(st.active);
          } else if (st.type === 'unsupported' || st.type === 'tainted') finish(false);
        },
      });
      if (done || gen !== this.gen || cap.kind !== 'hls') {
        cap.stop();
        if (!done) finish(false);
        return;
      }
      this.hlsProbe = cap;
      await cap.start(this.deps.video.currentTime);
    } catch {
      finish(false);
    }
  }

  private async switchCapture(): Promise<void> {
    const gen = ++this.gen;
    this.offChunk?.();
    this.offChunk = undefined;
    clearInterval(this.bufTimer);
    this.bufTimer = undefined;
    this.rechunker?.dispose();
    this.rechunker = undefined;
    const old = this.capture;
    this.capture = undefined;
    old?.stop();
    this.abortTasks();
    try {
      const cap = await this.openCapture(gen);
      if (gen !== this.gen) {
        cap?.stop();
        return;
      }
      if (!cap) return;
      await cap.start(this.deps.video.currentTime);
      this.ensureLiveDelay();
    } catch (e) {
      if (gen === this.gen) this.fail(e);
    }
  }

  private fail(e: unknown): void {
    this.lastError = e instanceof Error ? e.message : String(e);
    const kind = [...this.excluded].pop();
    this.teardown();
    this.setState('error', { captureKind: kind });
  }

  // ---- queue ----

  /** the page moved on to another video while this session was running (the key read at start no longer matches) */
  private videoChanged(): boolean {
    if (!this.startKey) return false;
    const k = this.deps.videoKey?.();
    return !!k && k !== this.startKey;
  }

  /** @returns true (and logs) when a result/chunk for `cell` cannot belong to the video playing now */
  private staleVideoData(where: string, cell: number): boolean {
    let why: string | undefined;
    const d = this.deps.video.duration;
    if (this.videoChanged()) why = 'video-key';
    else if (Number.isFinite(d) && d > 0 && cell >= d + 1) why = 'beyond-duration';
    if (!why) return false;
    diag.log('stale-drop', { where, why, cell, dur: Number.isFinite(d) ? Math.round(d) : null, vid: this.startKey, nowVid: this.deps.videoKey?.() });
    return true;
  }

  private onChunk(c: AudioChunk): void {
    if (this._state !== 'starting' && this._state !== 'translating' && this._state !== 'buffering') return;
    if (this.staleVideoData('chunk', c.startSec)) return;
    try {
      this.deps.events?.onChunk?.(c);
    } catch {
      /* observers must not break the queue */
    }
    if (this.doneRanges.has(c.startSec) || this.tasks.has(c.startSec)) return;
    if (this.isStale(c)) {
      diag.log('chunk-stale', { cell: c.startSec, dur: c.durationSec, ct: this.deps.video.currentTime });
      return;
    }
    if (c.provisional) this.provCells.set(c.startSec, c.durationSec);
    diag.log('chunk-queued', { cell: c.startSec, dur: c.durationSec, partial: !!c.partial, ct: this.deps.video.currentTime, kind: this.capture?.kind, ...(c.provisional ? { provisional: true } : {}) });
    this.tasks.set(c.startSec, { chunk: c, status: 'queued', attempts: 0, noTierWaits: 0, ctrl: new AbortController() });
    if (!this.dubReady && this._state === 'starting') this.emitPreparing();
    this.pumpSoon();
  }

  /** chunks that arrive in one burst (the MSE tap holds 60+ s ahead) are pumped together, so they can form one super-chunk job */
  private pumpQueued = false;
  private pumpSoon(): void {
    if (this.superCells() < 2 || !this.isYandexTier()) return this.pump();
    if (this.pumpQueued) return;
    this.pumpQueued = true;
    const session = this.session;
    queueMicrotask(() => {
      this.pumpQueued = false;
      if (session === this.session) this.pump();
    });
  }

  private isStale(c: AudioChunk): boolean {
    // a realtime tap can only deliver a cell after it was played, so its dub is always late: keep such cells for rewinds
    let lim = this.capture?.kind === 'realtime' ? 120 : STALE_SEC;
    // rewind-when-ready: a cell the playhead has passed is still worth dubbing while the first rewind can reach its slot (ad-aware back-buffer)
    if (this.rewindWhenReady() && (this.liveDelay?.appliedSec() ?? 0) === 0) lim = Math.max(lim, availableBackSec(this.deps.video, this.deps.video.currentTime, this.capture?.adEndSec?.()).sec - 1);
    return c.startSec + c.durationSec < this.deps.video.currentTime - lim;
  }

  private distance(c: AudioChunk): number {
    const ct = this.deps.video.currentTime;
    if (c.startSec > ct) return c.startSec - ct;
    return Math.max(0, ct - (c.startSec + c.durationSec));
  }

  private pump(): void {
    if (this._state !== 'starting' && this._state !== 'translating' && this._state !== 'buffering') return;
    if (this.probePending) return;
    while (this.inflight.size < this.concurrency()) {
      const best = this.pickNext();
      if (!best) return;
      const plan = this.planTask(best);
      if (plan.blocked) return; // every usable tier is at its cap: the next completion pumps again
      const group = this.formBatch(best, plan.plan);
      if (group) void this.runBatch(group, plan.plan);
      else void this.run(best, plan.plan);
    }
  }

  /**
   * Time-ordered, latency-aware choice (owner diag: 30 s of video went untranslated because cells were requested in
   * arrival order and dropped as late). A dub requested now arrives at `ct + lat`.
   *   group 0: slot START >= arrival + margin  -> a full dub; processed in TIME order, all harvested lookahead
   *   group 1: arrives late but >= LATE_TAIL_SEC of the cell is left -> the scheduler starts it mid-buffer; latest first
   *   group 2: entirely past on arrival -> only useful for rewinds; nearest to the playhead first, never takes the
   *            last free slot, and is dropped (farthest first) only when the queue is saturated
   * Nothing is dropped just for being late: only a cell the playhead has passed (isStale) goes.
   */
  private pickNext(): Task | undefined {
    const ct = this.deps.video.currentTime;
    const realtime = this.capture?.kind === 'realtime';
    const lat = this.deps.video.paused || realtime ? 0 : this.latencySec();
    const arrive = ct + lat;
    const queued: Array<{ t: Task; g: number }> = [];
    for (const [key, t] of this.tasks) {
      if (t.status !== 'queued') continue;
      const c = t.chunk;
      if (this.isStale(c)) {
        diag.log('chunk-drop-stale', { cell: c.startSec, ct });
        t.ctrl.abort();
        this.tasks.delete(key);
        continue;
      }
      const lag = this.lagSec();
      const slot = c.startSec + lag;
      const end = c.startSec + c.durationSec + lag;
      let g: number;
      if (lat > 0) g = slot >= arrive + START_MARGIN_SEC ? 0 : end - arrive >= LATE_TAIL_SEC ? 1 : 2;
      else g = end > ct ? 0 : 2;
      if (t.revoice && g > 0) g = 1;
      queued.push({ t, g });
    }
    if (queued.length > MAX_QUEUED) {
      const doomed = queued
        .filter((q) => q.g === 2 && !q.t.revoice)
        .sort((p, q) => this.distance(q.t.chunk) - this.distance(p.t.chunk))
        .slice(0, queued.length - MAX_QUEUED);
      for (const d of doomed) {
        diag.log('chunk-drop-saturated', { cell: d.t.chunk.startSec, ct, queued: queued.length });
        d.t.ctrl.abort();
        this.tasks.delete(d.t.chunk.startSec);
        queued.splice(queued.indexOf(d), 1);
      }
    }
    let best: { t: Task; g: number } | undefined;
    for (const q of queued) {
      if (!best || q.g < best.g) best = q;
      else if (q.g === best.g) {
        const better =
          q.g === 0
            ? q.t.chunk.startSec < best.t.chunk.startSec
            : q.g === 1
              ? q.t.chunk.startSec > best.t.chunk.startSec
              : this.distance(q.t.chunk) < this.distance(best.t.chunk);
        if (better) best = q;
      }
    }
    if (!best) return undefined;
    // a cell that cannot be heard in time must not occupy the last free slot (a feasible cell may arrive any moment)
    if (best.g === 2 && lat > 0 && this.concurrency() > 1 && this.inflight.size >= this.concurrency() - 1) return undefined;
    return best.t;
  }

  private isYandexTier(): boolean {
    const a = this._active ?? this.topUsable(this.usable);
    return a === 'yandex' || a === 'yandex-live';
  }

  /** expected seconds from request to dub of the FASTEST usable tier (a cell is feasible when any tier can make it); 0 = no tier */
  private latencySec(): number {
    let best = 0;
    for (const id of this.usable) {
      const e = this.model.expectedSec(id);
      if (best === 0 || e < best) best = e;
    }
    return best;
  }

  private yandexUsable(): boolean {
    return this.usable.has('yandex') || this.usable.has('yandex-live');
  }

  /** in-flight cap of ONE Yandex tier: enough parallel jobs to sustain real time at the slowest expected latency */
  private yandexCap(): number {
    // `globalThis.__nvtTest.maxParallelYandex` is a measurement hook for real-browser runs with a request budget (isolated world only)
    const lo = this.deps.maxParallelYandex ?? (globalThis as { __nvtTest?: { maxParallelYandex?: number } }).__nvtTest?.maxParallelYandex;
    if (lo !== undefined) return Math.max(1, lo);
    let worst = 0;
    // the live tier's (ETA-driven) latency must not inflate the cap of the standard tier: live has its own cap of 1 in chunk mode
    for (const id of ['yandex-live', 'yandex'] as const) if (this.usable.has(id) && (id === 'yandex' || !this.usable.has('yandex'))) worst = Math.max(worst, this.model.expectedSec(id));
    const k = this.superCells();
    // bigger jobs (S26): fewer of them are needed in parallel to sustain real time
    return yandexTierCap(worst, this.settings.chunkSec * k, k > 1 ? 3 : 5);
  }

  private tierCap(id: ProviderId): number {
    let cap = id === 'gemini' ? GEMINI_MAX_PARALLEL : id === 'groq' ? GROQ_MAX_PARALLEL : id === 'local' ? LOCAL_MAX_PARALLEL : id === 'yandex-live' ? LIVE_CHUNK_CAP : this.yandexCap();
    if (this.qualityLive() && TranslationEngine.isYandexId(id)) cap = Math.min(cap, LIVE_YANDEX_MAX_INFLIGHT);
    if ((this.deps.now ?? Date.now)() < this.rateUntil) cap = Math.min(cap, this.rateCap);
    return Math.max(1, cap);
  }

  private tierActive(id: ProviderId): number {
    let n = 0;
    for (const a of this.liveAttempts.values()) if (a.id === id) n++;
    return n;
  }

  /** Cells (tasks) in flight: the Yandex cap when Yandex is usable (plus Gemini's own), else Gemini's. Halved after a rate-limit-like answer. */
  private concurrency(): number {
    // quality live mode: a cell's task ends with the local dub (Yandex jobs go on in the background under their own cap)
    if (this.qualityLive()) return LOCAL_MAX_PARALLEL + 1;
    let cap = this.isYandexTier() ? this.yandexCap() : 0;
    if (this.usable.has('gemini')) cap += GEMINI_MAX_PARALLEL;
    if (this.usable.has('groq')) cap += GROQ_MAX_PARALLEL;
    if (this.usable.has('local')) cap += LOCAL_MAX_PARALLEL;
    if (cap === 0) cap = GEMINI_MAX_PARALLEL;
    if ((this.deps.now ?? Date.now)() < this.rateUntil) cap = Math.min(cap, this.rateCap);
    return Math.max(1, cap);
  }

  /** Which tiers to start for this cell right now (deadline-driven, see planner.ts). */
  private planTask(task: Task): { plan: CellPlan; blocked: boolean; tts: number } {
    const now = (this.deps.now ?? Date.now)();
    const c = task.chunk;
    const tts = c.startSec + this.lagSec() - this.deps.video.currentTime;
    const ft = this.trackTierFor(c);
    if (ft && !this.higherTierInTime(ft, tts)) return { plan: { start: [ft], preferred: ft, reason: 'full-track', inTime: [ft], late: false }, blocked: false, tts };
    const all = eligibleProviders(this.deps.providers, this.settings, this.chain, now);
    const free = all.filter((p) => this.tierActive(p.id) < this.tierCap(p.id));
    // 0.3.6 censorship: Yandex voices a bleeped word as silence. Where the captions mark one, Yandex is left out while another tier can voice the cell
    const censoredCell = this.deps.censored?.(c.startSec, c.durationSec) === true;
    const censorSkip: ProviderId[] = censoredCell && free.some((p) => !TranslationEngine.isYandexId(p.id)) ? free.filter((p) => TranslationEngine.isYandexId(p.id)).map((p) => p.id) : [];
    if (censorSkip.length > 0) diag.log('censor-skip-yandex', { cell: c.startSec, tiers: censorSkip });
    if (all.length === 0) return { plan: { start: [], reason: 'no-tier', inTime: [], late: true }, blocked: false, tts }; // the chain reports "no tier"
    if (free.length === 0) return { plan: { start: [], reason: 'no-tier', inTime: [], late: true }, blocked: true, tts };
    if (censorSkip.length > 0) free.splice(0, free.length, ...free.filter((p) => !censorSkip.includes(p.id)));
    if (this.qualityLive() && !task.revoice && all.some((p) => p.id === 'local')) return this.planLiveQuality(task, all, free, tts);
    // a pinned (full-track) tier is fast only for the cells its track covers; this cell is not covered, so it runs at its chunk-mode speed
    // D26 live policy (chunk mode): the live tier starts only for a cell whose slot is at least its expected latency away
    // (the server ETA of a live job is 500-750 s); it never runs as the fall-through of a cell it was gated out of
    const liveGated = free.some((p) => p.id === 'yandex-live') && all.some((p) => p.id !== 'yandex-live') && tts < this.model.expectedSec('yandex-live', c.durationSec);
    const skip: ProviderId[] = [...(liveGated ? ['yandex-live' as ProviderId] : []), ...censorSkip];
    if (liveGated) {
      const rest = free.filter((p) => p.id !== 'yandex-live');
      if (rest.length === 0) {
        // the only free tiers besides live are busy: wait for them
        return { plan: { start: [], reason: 'no-tier', inTime: [], late: true, skip }, blocked: true, tts };
      }
      free.splice(0, free.length, ...rest);
    }
    const tiers = free.map((p) => ({ id: p.id, expectedSec: this.tracks.get(p.id)?.complete ? Math.max(this.model.expectedSec(p.id), this.model.prior(p.id) * 0.5) : this.model.expectedSec(p.id) }));
    let plan = planCell({ timeToSlot: tts, tiers, localFirst: true });
    if (task.revoice) plan = { ...plan, start: [tiers[0]!.id], reason: 'single' };
    if (!liveGated && plan.start.includes('yandex-live') && !this.model.etaKnown('yandex-live')) {
      // scouting live job (its server ETA is not known yet): race it with the best other tier so the cell is not at its mercy
      const other = tiers.find((t) => t.id !== 'yandex-live' && t.id !== 'gemini') ?? tiers.find((t) => t.id !== 'yandex-live');
      if (other && !plan.start.includes(other.id)) plan = { ...plan, start: [...plan.start, other.id] };
    }
    if (skip.length > 0) plan = { ...plan, skip };
    return { plan, blocked: false, tts };
  }

  /**
   * 'quality' live mode: the local tier runs for EVERY cell (the safety net); the Yandex gate adds at most one Yandex tier (sampling for
   * evidence, then only when the latency model says it fits before the slot). A Yandex dub that arrives >= UPGRADE_LEAD_SEC before the
   * slot replaces the local one (onLateWin -> applyUpgrade); a later one is kept for rewinds only.
   */
  private planLiveQuality(task: Task, all: DubProvider[], free: DubProvider[], tts: number): { plan: CellPlan; blocked: boolean; tts: number } {
    const dur = task.chunk.durationSec;
    if (!free.some((p) => p.id === 'local')) return { plan: { start: [], reason: 'no-tier', inTime: [], late: true }, blocked: true, tts };
    const tierOf = (p: DubProvider): { id: ProviderId; expectedSec: number } => ({ id: p.id, expectedSec: this.model.expectedSec(p.id, dur) });
    const yAll = all.filter((p) => TranslationEngine.isYandexId(p.id)).map(tierOf);
    const yBusy = this.tierActive('yandex') + this.tierActive('yandex-live') >= LIVE_YANDEX_MAX_INFLIGHT;
    const yFree = yBusy ? [] : free.filter((p) => TranslationEngine.isYandexId(p.id)).map(tierOf);
    const budget = Math.max(tts, (this.liveDelay?.appliedSec() ?? 0) + this.lagSec());
    const d = yAll.length === 0 ? { send: [] as ProviderId[], reason: 'busy' as const, backoff: undefined } : this.yandexGate.decide({ ttsSec: tts, budgetSec: budget, tiers: yFree, all: yAll });
    const nowMs = this.deps.now ?? Date.now;
    if (d.reason === 'probe' || d.reason === 'in-time') localReasons.clear('quality-slow');
    if (d.backoff) {
      localReasons.set('quality-slow', reasonText.qualitySlow());
      diag.log('yandex-live-skip', { why: 'too-slow', results: d.backoff.results, expS: Math.round(d.backoff.bestExpectedSec * 10) / 10, budgetS: Math.round(d.backoff.budgetSec * 10) / 10, backoffMin: 5 });
    } else if (d.reason === 'late' && this.yandexSkipLogAt + 30_000 <= nowMs()) {
      this.yandexSkipLogAt = nowMs();
      diag.log('yandex-live-skip', { why: 'cell-late', cell: task.chunk.startSec, tts: Math.round(tts * 10) / 10, exp: Object.fromEntries(yAll.map((t) => [t.id, Math.round(t.expectedSec * 10) / 10])) });
    }
    // the user's voice order decides who starts first: a local tier ranked above Yandex starts before it
    const start: ProviderId[] = [...d.send, 'local' as ProviderId].sort((a, b) => this.rankOf(a) - this.rankOf(b));
    const inTime = yAll.filter((t) => d.send.includes(t.id) && t.expectedSec + PLAN_MARGIN_SEC <= tts).map((t) => t.id);
    return { plan: { start, preferred: start[0], reason: 'live-quality', inTime: [...inTime, 'local'], late: false }, blocked: false, tts };
  }

  /** whole-job deadline (ms) of a Yandex tier's attempt, evaluated when the attempt starts */
  private deadlineFor(id: ProviderId, task: Task): number | undefined {
    if (id === 'gemini' || id === 'groq' || id === 'local') return undefined;
    if (this.qualityLive()) return LIVE_YANDEX_JOB_DEADLINE_MS;
    const c = task.chunk;
    const ct = this.deps.video.currentTime;
    return jobTimeoutMs(c.startSec + this.lagSec() - ct, ct >= c.startSec + c.durationSec + this.lagSec(), this.model.expectedSec(id, c.durationSec));
  }

  private onRateSignal(id: ProviderId, status?: number): void {
    this.rateCap = Math.max(1, Math.floor(this.concurrency() / 2));
    this.rateUntil = (this.deps.now ?? Date.now)() + RATE_BACKOFF_MS;
    diag.log('rate-backoff', { tier: id, status, cap: this.rateCap, inflight: this.inflight.size });
  }

  private async run(task: Task, plan: CellPlan): Promise<void> {
    task.status = 'running';
    this.inflight.add(task);
    const key = task.chunk.startSec;
    const { signal } = task.ctrl;
    const now = this.deps.now ?? Date.now;
    const t0 = now();
    if (!this.firstRequestAt) this.firstRequestAt = t0;
    const ct0 = this.deps.video.currentTime;
    const tierIds = this.deps.providers.map((p) => p.id);
    diag.log('cell-plan', {
      cell: key,
      tts: Math.round((key + this.lagSec() - ct0) * 10) / 10,
      exp: this.model.snapshot(tierIds),
      start: plan.start,
      pref: plan.preferred,
      inTime: plan.inTime,
      late: plan.late,
      reason: plan.reason,
      active: Object.fromEntries(tierIds.map((id) => [id, this.tierActive(id)])),
    });
    this.notePrep(task, plan);
    diag.log('chunk-start', {
      cell: key,
      dur: task.chunk.durationSec,
      partial: !!task.chunk.partial,
      ct: this.deps.video.currentTime,
      inflight: this.inflight.size,
      cap: this.concurrency(),
      lat: Math.round(this.latencySec()),
      tiers: plan.start,
    });
    const pref = plan.preferred ?? plan.start[0];
    const hedgeAfterMs =
      this.deps.hedgeAfterMs ??
      (pref && (plan.reason === 'preferred-in-time' || plan.reason === 'single') ? Math.max(HEDGE_MIN_MS, Math.round(this.model.expectedSec(pref) * 1000 * HEDGE_OVERRUN)) : 0);
    const trackTier = plan.reason === 'full-track' ? plan.start[0] : undefined;
    const session = this.session;
    try {
      let out: ChainOutcome | undefined;
      if (trackTier) {
        await Promise.resolve();
        out = this.serveTrack(trackTier, task.chunk);
      }
      out ??= await runChain(
        task.chunk,
        this.deps.providers,
        this.settings,
        {
          signal,
          now,
          sleep: this.deps.sleep ?? defaultSleep,
          warn: (w) => this.deps.events?.onWarning?.(w),
          sourceLang: this.sourceLang,
          getSettings: () => this.settings,
          isLive: () => this.isLive(),
          hedgeAfterMs,
          hedgeTimer: this.deps.hedgeTimer,
          plan: plan.start,
          skip: plan.skip,
          deadlineMs: (id) => this.deadlineFor(id, task),
          onHint: (id, sec) => {
            this.model.hint(id, sec);
            if (id === 'yandex-live') this.model.eta(id, sec);
            diag.log('latency-hint', { tier: id, remainingS: Math.round(sec) });
          },
          onLatency: (id, ms, censored) => this.onLatency(id, ms, censored, task.chunk.durationSec),
          onTierResult: (id, ok, ms) => this.noteYandexResult(task, id, ok, ms),
          onLate: (win) => {
            if (session !== this.session) {
              diag.log('stale-drop', { where: 'late-win', why: 'session', cell: key, tier: win.providerId });
              return;
            }
            this.onLateWin(task, win);
          },
          onRateSignal: (id, status) => this.onRateSignal(id, status),
          onAttempt: (id, abort) => {
            const k = `${key}:${id}`;
            if (abort) {
              task.provider = id;
              this.liveAttempts.set(k, { id, abort });
              this.capLiveYandexAttempt(task, id, k, abort);
            } else {
              this.liveAttempts.delete(k);
              this.capTimers.get(k)?.();
              this.capTimers.delete(k);
              if (task.provider === id) task.provider = undefined;
            }
            if (!abort) this.pump();
          },
        },
        this.chain,
      );
      if (signal.aborted) return;
      if (session !== this.session) {
        diag.log('stale-drop', { where: 'result', why: 'session', cell: key, ok: out.ok });
        return;
      }
      if (this.staleVideoData('result', key)) {
        this.tasks.delete(key);
        return;
      }
      if (!out.ok) {
        this.onChunkFailed(task, out.noTier ? { waitMs: out.waitMs } : undefined);
        return;
      }
      this.completeCell(task, out.providerId, out.result, now() - t0);
    } catch (e) {
      if (signal.aborted) return;
      diag.log('chunk-error', { cell: key, msg: e instanceof Error ? e.message.slice(0, 120) : String(e).slice(0, 120) });
      this.onChunkFailed(task);
    } finally {
      this.inflight.delete(task);
      this.pump();
    }
  }

  /** a tier delivered the cell: book it as done and hand the segments to the scheduler */
  private completeCell(task: Task, providerId: ProviderId, result: CellResult, ms: number): void {
    const key = task.chunk.startSec;
    this.tasks.delete(key);
    this.doneRanges.set(key, key + task.chunk.durationSec);
    this.cellProvider.set(key, providerId);
    this.keep(task.chunk);
    this.onResult(task, providerId, result.segments, result.sourceLang, result.subtitles, result.voice, ms);
    if (this.tracks.size > 0) {
      // a track tier arrived while a worse tier was working on this cell
      const r = this.upgradeCell(key, task.chunk.durationSec);
      if (r) diag.log('tier-switch-now', { from: r.from, to: r.to, vt: this.deps.video.currentTime, cells: 1 });
    }
  }

  // ---- S26: Yandex super-chunk jobs ----

  private superCells(): number {
    return Math.max(1, Math.floor(this.deps.yandexSuperCells ?? YANDEX_SUPER_CELLS));
  }

  /** a Yandex batch has succeeded once: later batches may use the full size */
  private superOk = false;

  private static isYandexId(id: ProviderId): boolean {
    return id === 'yandex' || id === 'yandex-live';
  }

  /** captured audio matches its declared length (cells built from a track or odd test chunks have no real pcm) */
  private static pcmMatches(c: AudioChunk): boolean {
    return c.pcm.length > 0 && c.sampleRate > 0 && Math.abs(c.pcm.length / c.sampleRate - c.durationSec) < 0.05;
  }

  /**
   * The cells that go out as ONE Yandex job with `lead` (>= 2 cells) or undefined (the lead runs alone as before). Only audio that is
   * already captured and queued is merged, nothing waits for more. Not used with a full track, for re-voicing, for rewind-only cells,
   * for cells a failed batch handed back, nor when the plan also starts Gemini (that cell is the bridge and runs on its own).
   */
  private formBatch(lead: Task, plan: CellPlan): Task[] | undefined {
    const max = this.superCells();
    if (max < 2 || lead.revoice || lead.noBatch || this.tracks.size > 0) return undefined;
    if (plan.reason === 'full-track' || plan.start.length === 0 || !plan.start.every((id) => TranslationEngine.isYandexId(id))) return undefined;
    const ct = this.deps.video.currentTime;
    const c0 = lead.chunk;
    if (c0.startSec + c0.durationSec <= ct || !TranslationEngine.pcmMatches(c0)) return undefined;
    const limit = this.superOk ? max : Math.min(max, YANDEX_FIRST_BATCH_CELLS);
    const cells = [lead];
    let end = c0.startSec + c0.durationSec;
    while (cells.length < limit) {
      let next: Task | undefined;
      for (const t of this.tasks.values()) {
        if (t.status === 'queued' && Math.abs(t.chunk.startSec - end) < 0.02) {
          next = t;
          break;
        }
      }
      if (!next || next.revoice || next.noBatch || next.chunk.sampleRate !== c0.sampleRate || !TranslationEngine.pcmMatches(next.chunk) || this.isStale(next.chunk)) break;
      cells.push(next);
      end = next.chunk.startSec + next.chunk.durationSec;
    }
    return cells.length >= 2 ? cells : undefined;
  }

  private async runBatch(cells: Task[], plan: CellPlan): Promise<void> {
    const lead = cells[0]!;
    const key = lead.chunk.startSec;
    const now = this.deps.now ?? Date.now;
    const t0 = now();
    if (!this.firstRequestAt) this.firstRequestAt = t0;
    const session = this.session;
    const lastChunk = cells[cells.length - 1]!.chunk;
    const total = lastChunk.startSec + lastChunk.durationSec - key;
    const pcm = new Int16Array(cells.reduce((n, t) => n + t.chunk.pcm.length, 0));
    let at = 0;
    for (const t of cells) {
      pcm.set(t.chunk.pcm, at);
      at += t.chunk.pcm.length;
    }
    const merged: AudioChunk = { startSec: key, durationSec: total, sampleRate: lead.chunk.sampleRate, pcm, partial: lead.chunk.partial };
    const ids = plan.start;
    const providers = this.deps.providers.filter((p) => TranslationEngine.isYandexId(p.id));
    const expS = Math.max(...ids.map((id) => this.model.expectedSec(id, total)));
    const ct0 = this.deps.video.currentTime;
    diag.log('cell-plan', {
      cell: key,
      tts: Math.round((key + this.lagSec() - ct0) * 10) / 10,
      exp: this.model.snapshot(this.deps.providers.map((p) => p.id)),
      start: ids,
      pref: plan.preferred,
      inTime: plan.inTime,
      late: plan.late,
      reason: plan.reason,
      batch: cells.length,
    });
    diag.log('yandex-batch', { cells: cells.map((t) => t.chunk.startSec), sec: Math.round(total * 10) / 10, expS: Math.round(expS * 10) / 10 });
    this.notePrep(lead, plan);
    for (const t of cells) t.status = 'running';
    this.inflight.add(lead);

    // one controller for the whole job: any member being aborted (seek, stop) cancels it
    const bAc = new AbortController();
    const unlink: Array<() => void> = [];
    for (const t of cells) {
      const f = (): void => bAc.abort();
      if (t.ctrl.signal.aborted) bAc.abort();
      else {
        t.ctrl.signal.addEventListener('abort', f, { once: true });
        unlink.push(() => t.ctrl.signal.removeEventListener('abort', f));
      }
    }
    const sub = (): AbortController => {
      const ac = new AbortController();
      const f = (): void => ac.abort();
      if (bAc.signal.aborted) ac.abort();
      else {
        bAc.signal.addEventListener('abort', f, { once: true });
        unlink.push(() => bAc.signal.removeEventListener('abort', f));
      }
      return ac;
    };
    const deadline = (id: ProviderId): number => {
      const ct = this.deps.video.currentTime;
      return jobTimeoutMs(key + this.lagSec() - ct, ct >= key + total + this.lagSec(), this.model.expectedSec(id, total));
    };
    const attempt = (dup: boolean, ac: AbortController): Promise<ChainOutcome> => {
      const state: ChainState = dup ? createChainState() : this.chain;
      if (dup) {
        // the duplicate keeps none of its own faults (the cooldown counts the primary only) but respects the primary's verdicts
        for (const [id, until] of this.chain.cooldownUntil) state.cooldownUntil.set(id, until);
        for (const id of this.chain.authSkip) state.authSkip.add(id);
      }
      return runChain(
        merged,
        providers,
        this.settings,
        {
          signal: ac.signal,
          now,
          sleep: this.deps.sleep ?? defaultSleep,
          warn: (w) => {
            if (!dup) this.deps.events?.onWarning?.(w);
          },
          sourceLang: this.sourceLang,
          getSettings: () => this.settings,
          isLive: () => this.isLive(),
          hedgeAfterMs: 0,
          plan: ids,
          skip: plan.skip,
          deadlineMs: deadline,
          onHint: (id, sec) => {
            if (!dup) this.model.hint(id, sec);
            if (id === 'yandex-live') this.model.eta(id, sec);
          },
          onLatency: (id, ms, censored) => {
            if (!(dup && censored)) this.onLatency(id, ms, censored, total);
          },
          onRateSignal: (id, status) => this.onRateSignal(id, status),
          onAttempt: (id, abort) => {
            const k = `${key}:${id}${dup ? ':dup' : ''}`;
            if (abort) this.liveAttempts.set(k, { id, abort });
            else {
              this.liveAttempts.delete(k);
              this.pump();
            }
          },
        },
        state,
      ).catch((): ChainOutcome => ({ ok: false }));
    };

    // primary job; after max(2 x expected, 25 s) ONE duplicate job (new fake id, same audio): the first success wins
    const primaryAc = sub();
    const dupAc = sub();
    const timerAc = sub();
    let outcome: (ChainOutcome & { dup?: boolean }) | undefined;
    try {
      outcome = await new Promise<(ChainOutcome & { dup?: boolean }) | undefined>((resolve) => {
        let done = false;
        let running = 1;
        const finish = (o: (ChainOutcome & { dup?: boolean }) | undefined): void => {
          if (done) return;
          done = true;
          timerAc.abort();
          primaryAc.abort();
          dupAc.abort();
          resolve(o);
        };
        const settle = (o: ChainOutcome, dup: boolean): void => {
          if (done) return;
          if (o.ok) return finish({ ...o, dup });
          running--;
          // no duplicate yet and the primary failed: nothing left to wait for (a running duplicate keeps `running` above 0)
          if (running === 0) finish(bAc.signal.aborted ? undefined : o);
        };
        void attempt(false, primaryAc).then((o) => settle(o, false));
        const afterMs = Math.max(YANDEX_DUP_FACTOR * expS * 1000, YANDEX_DUP_MIN_MS);
        (this.deps.dupTimer ?? defaultSleep)(afterMs, timerAc.signal).then(
          () => {
            if (done || bAc.signal.aborted) return;
            running++;
            diag.log('yandex-dup', { j: key, afterS: Math.round((now() - t0) / 100) / 10 });
            void attempt(true, dupAc).then((o) => settle(o, true));
          },
          () => {
            /* timer cancelled: the job ended or was aborted */
          },
        );
        bAc.signal.addEventListener('abort', () => finish(undefined), { once: true });
      });
    } finally {
      unlink.forEach((f) => f());
    }

    try {
      if (bAc.signal.aborted || session !== this.session || !outcome) return;
      if (this.staleVideoData('result', key)) {
        for (const t of cells) this.tasks.delete(t.chunk.startSec);
        return;
      }
      const ms = now() - t0;
      const back = (t: Task, why: string): void => {
        if (this.tasks.get(t.chunk.startSec) !== t || t.ctrl.signal.aborted) return;
        t.noBatch = true;
        t.status = 'queued';
        diag.log('yandex-batch-fallback', { cell: t.chunk.startSec, why });
      };
      const sliced = outcome.ok ? this.sliceBatch(cells, outcome.result) : undefined;
      if (!outcome.ok || !sliced) {
        diag.log('yandex-batch-fail', { cells: cells.map((t) => t.chunk.startSec), ms, noTier: !outcome.ok && !!outcome.noTier });
        for (const t of cells) back(t, 'batch-failed');
        return;
      }
      this.superOk = true;
      diag.log('yandex-batch-ok', { cells: cells.length, ms, dup: !!outcome.dup, tier: outcome.providerId });
      for (let i = 0; i < cells.length; i++) {
        const t = cells[i]!;
        if (session !== this.session || (this._state !== 'starting' && this._state !== 'translating' && this._state !== 'buffering')) return;
        if (this.tasks.get(t.chunk.startSec) !== t || t.ctrl.signal.aborted) continue;
        const r = sliced[i];
        if (!r) back(t, 'slice-missing');
        else this.completeCell(t, outcome.providerId, r, ms);
      }
    } finally {
      this.inflight.delete(lead);
      this.pump();
    }
  }

  /** cuts the mp3 of a batch job back into one result per cell (undefined entry = that cell could not be sliced); undefined = unusable result */
  private sliceBatch(cells: Task[], result: CellResult): Array<CellResult | undefined> | undefined {
    const base = { voice: result.voice, sourceLang: result.sourceLang };
    if (result.segments.length === 0) return cells.map(() => ({ segments: [], ...base })); // no speech anywhere in the job
    const a = result.segments.length === 1 ? result.segments[0]!.audio : undefined;
    if (!a || a.kind !== 'encoded') return undefined;
    const idx = indexMp3(a.data);
    if (!idx) return undefined;
    const t0 = cells[0]!.chunk.startSec;
    return cells.map((t) => {
      const c = t.chunk;
      const sl = sliceMp3(a.data, idx, c.startSec - t0, c.startSec - t0 + c.durationSec);
      if (!sl) return undefined;
      return {
        segments: [{ start: c.startSec, end: c.startSec + c.durationSec, audio: { kind: 'encoded' as const, mime: 'audio/mpeg', data: sl.data, skipSec: sl.skipSec } }],
        ...base,
      };
    });
  }

  private warnThrottled(key: string, w: EngineWarning, everyMs = 60_000): void {
    const t = (this.deps.now ?? Date.now)();
    const last = this.lastWarnAt.get(key);
    if (last !== undefined && t - last < everyMs) return;
    this.lastWarnAt.set(key, t);
    this.deps.events?.onWarning?.(w);
  }

  /**
   * Evidence of the quality live mode: one diag line per finished Yandex request ('yandex-live-lat'), and the gate's result count.
   * `late` = the dub arrived less than UPGRADE_LEAD_SEC before its slot (it would not replace the local dub).
   */
  private noteYandexResult(task: Task, id: ProviderId, ok: boolean, ms: number): void {
    if (!TranslationEngine.isYandexId(id) || !this.qualityLive()) return;
    this.yandexGate.record();
    const c = task.chunk;
    const tts = c.startSec + this.lagSec() - this.deps.video.currentTime;
    diag.log('yandex-live-lat', { tier: id, cells: 1, audioSec: Math.round(c.durationSec * 10) / 10, ms: Math.round(ms), ok, late: tts < UPGRADE_LEAD_SEC, tts: Math.round(tts * 10) / 10 });
  }

  /** a live Yandex job is cut off after LIVE_YANDEX_JOB_DEADLINE_MS (+5 s) whatever its server ETA says: later than any delay target is useless */
  private capLiveYandexAttempt(task: Task, id: ProviderId, key: string, abort: () => void): void {
    if (!TranslationEngine.isYandexId(id) || !this.qualityLive()) return;
    const att = this.liveAttempts.get(key);
    const t0 = (this.deps.now ?? Date.now)();
    const ac = new AbortController();
    const link = (): void => ac.abort();
    task.ctrl.signal.addEventListener('abort', link, { once: true });
    this.capTimers.set(key, () => {
      task.ctrl.signal.removeEventListener('abort', link);
      ac.abort();
    });
    (this.deps.dupTimer ?? defaultSleep)(LIVE_YANDEX_JOB_DEADLINE_MS + 5000, ac.signal).then(
      () => {
        if (this.liveAttempts.get(key) !== att) return;
        const ms = (this.deps.now ?? Date.now)() - t0;
        this.onLatency(id, ms, true, task.chunk.durationSec);
        this.noteYandexResult(task, id, false, ms);
        diag.log('yandex-live-cut', { tier: id, cell: task.chunk.startSec, ms });
        abort();
      },
      () => {},
    );
  }

  private onLatency(id: ProviderId, ms: number, censored: boolean, durSec?: number): void {
    if (!censored && ms < MIN_LATENCY_SAMPLE_MS) return; // cache hit or instant failure, not a latency sample
    const exp = this.model.observe(id, ms, censored, durSec);
    diag.log('latency-ewma', { tier: id, ms: Math.round(ms), censored, durS: durSec === undefined ? undefined : Math.round(durSec), expS: Math.round(exp * 10) / 10 });
  }

  /** remember which tier is expected to deliver the first audible dub (status line "first part in ~N s (source)") */
  private notePrep(task: Task, plan: CellPlan): void {
    if (this.dubReady || plan.start.length === 0) return;
    const c = task.chunk;
    if (c.startSec + c.durationSec <= this.deps.video.currentTime) return;
    if (this.prep && this.prep.cell <= c.startSec) return;
    let id = plan.start[0]!;
    for (const t of plan.start) if (this.model.expectedSec(t) < this.model.expectedSec(id)) id = t;
    this.prep = { id, at: (this.deps.now ?? Date.now)(), expectedSec: this.model.expectedSec(id), cell: c.startSec };
  }

  // ---- upgrade semantics: a better tier arrives after a worse one already voices the cell ----

  private onLateWin(task: Task, win: { providerId: ProviderId; result: { segments: DubSegment[]; voice?: 'lively' | 'standard' }; latencyMs: number }): void {
    if (task.ctrl.signal.aborted || (this._state !== 'starting' && this._state !== 'translating' && this._state !== 'buffering')) return;
    const cell = task.chunk.startSec;
    const dur = task.chunk.durationSec;
    const old = this.cellProvider.get(cell);
    const segs = win.result.segments.map((x) => (x.providerId ? x : { ...x, providerId: win.providerId }));
    if (segs.length === 0 || !old || this.rankOf(win.providerId) >= this.rankOf(old)) {
      diag.log('tier-late-discard', { cell, tier: win.providerId, old, why: segs.length === 0 ? 'empty' : 'not-better' });
      return;
    }
    this.applyUpgrade(cell, dur, old, win.providerId, segs, win.result.voice);
  }

  /** D26: a better tier's dub of a cell that a worse tier already voices (race winner arriving late, or a full track appearing) */
  private applyUpgrade(cell: number, dur: number, old: ProviderId, to: ProviderId, segs: DubSegment[], voice: 'lively' | 'standard' | undefined): void {
    const ct = this.deps.video.currentTime;
    const d = upgradeDecision(cell, cell + dur, ct);
    if (d === 'defer') {
      this.pendingSwaps.set(cell, { from: old, to, dur, segments: segs, voice });
      diag.log('tier-late-discard', { cell, tier: to, old, lead: Math.round((cell - ct) * 10) / 10, why: 'slot-playing', kept: 'for-rewind' });
      return;
    }
    this.swapCell(cell, dur, old, to, segs, voice, d);
  }

  // ---- Yandex full track (S24) ----

  /**
   * A full track of a lower-ranked tier waits while a higher-ranked usable tier is predicted in time for the cell (owner: the user's
   * voice order decides; the higher tier voices the cell itself and the track may still upgrade it later).
   */
  private higherTierInTime(tier: ProviderId, tts: number): boolean {
    return [...this.usable].some((id) => this.rankOf(id) < this.rankOf(tier) && this.model.expectedSec(id) + PLAN_MARGIN_SEC <= tts);
  }

  /** best usable tier whose full track covers the cell (the user's voice order decides) */
  private trackTierFor(c: { startSec: number; durationSec: number }): ProviderId | undefined {
    let best: ProviderId | undefined;
    for (const t of this.tracks.values()) {
      if (!this.usable.has(t.tier) || !trackCovers(t, c.startSec, c.durationSec)) continue;
      if (best === undefined || this.rankOf(t.tier) < this.rankOf(best)) best = t.tier;
    }
    return best;
  }

  private serveTrack(tier: ProviderId, c: { startSec: number; durationSec: number }): ChainOutcome | undefined {
    const t = this.tracks.get(tier);
    const result = t ? serveFromTrack(t, c, this.sourceLang) : undefined;
    if (!result) return undefined;
    const a = result.segments[0]?.audio;
    diag.log('fulltrack-serve', { cell: c.startSec, tier, bytes: a && a.kind === 'encoded' ? a.data.length : 0 });
    return { ok: true, providerId: tier, result, latencyMs: 0 };
  }

  /**
   * Replaces the dub of a done cell by the full-track dub of a better tier (D29: IMMEDIATELY, no D26 lead rule). The cell the
   * playhead is in is cut from the frame holding the playhead, the old voice fades out (~0.15 s) and the new one starts at once.
   */
  private upgradeCell(cell: number, dur: number): { from: ProviderId; to: ProviderId; playing: boolean } | undefined {
    const old = this.cellProvider.get(cell);
    if (!old) return undefined;
    const tier = this.trackTierFor({ startSec: cell, durationSec: dur });
    if (!tier || this.rankOf(tier) >= this.rankOf(old)) return undefined;
    const out = this.serveTrack(tier, { startSec: cell, durationSec: dur });
    if (!out || !out.ok) return undefined;
    const full = out.result.segments.map((x) => ({ ...x, providerId: tier }));
    const ct = this.deps.video.currentTime;
    const playing = ct > cell && ct < cell + dur;
    const past = ct >= cell + dur;
    let sched: DubSegment[] | undefined;
    if (playing) {
      const t = this.tracks.get(tier);
      const tail = t ? serveFromTrack(t, { startSec: cell, durationSec: dur }, this.sourceLang, ct) : undefined;
      sched = tail?.segments.map((x) => ({ ...x, providerId: tier }));
      if (tail && !sched?.length) return undefined;
    }
    this.swapCell(cell, dur, old, tier, full, out.result.voice, past ? 'rewind-now' : 'now', sched);
    this.upgradeCount++;
    return { from: old, to: tier, playing };
  }

  /** every done cell the playhead has not left far behind: swapped to the best full track now (the user's voice order decides) */
  private upgradeFromTracks(): void {
    const ct = this.deps.video.currentTime;
    let n = 0;
    let from: ProviderId | undefined;
    let first: { from: ProviderId; to: ProviderId } | undefined;
    for (const [cell, end] of [...this.doneRanges]) {
      if (end <= ct - UPGRADE_BEHIND_SEC) continue;
      const r = this.upgradeCell(cell, end - cell);
      if (!r) continue;
      n++;
      first ??= r;
      if (r.playing) from = r.from;
    }
    if (n > 0 && first) diag.log('tier-switch-now', { from: from ?? first.from, to: first.to, vt: ct, cells: n });
  }

  private onTrackReady(track: FullTrack): void {
    this.tracks.set(track.tier, track);
    if (track.complete) this.model.pin(track.tier, FULL_TRACK_LATENCY_SEC);
    this.feedFromTrack();
    this.upgradeFromTracks();
    this.pump();
  }

  private dropTracks(): void {
    for (const id of this.tracks.keys()) this.model.unpin(id);
    this.tracks.clear();
    this.probeCtrl.abort();
    this.watching.clear();
    this.probedTiers.clear();
    this.probePending = false;
    this.archive = undefined;
    this.uploaded.clear();
    this.uploadSkipped.clear();
    this.tierStates.clear();
  }

  /**
   * YouTube only: probe the real url for every usable Yandex tier in parallel with the capture opening. Cells are held back
   * for the first probe reply only (at most PROBE_RACE_MS); a track found later still serves every cell not yet voiced and
   * upgrades the already voiced ones. Nothing here may block or break the normal chunk pipeline.
   */
  private startFullTrack(gen: number): void {
    const ft = this.deps.fullTrack;
    const vk = this.deps.videoKey?.();
    const session = this.session;
    if (!ft || !vk?.startsWith('yt:') || this.liveVideo) return; // a live stream has no complete track to fetch
    // the real url is known even when no Yandex tier is usable yet: the complete-audio archive and a later mid-session enable need it
    const url = `https://youtu.be/${vk.slice(3)}`;
    this.probeUrl = url;
    const tiers = (['yandex-live', 'yandex'] as const).filter((t) => this.usable.has(t) && !this.tracks.has(t));
    if (tiers.length === 0) return;
    for (const t of tiers) this.probedTiers.add(t);
    const d = this.deps.video.duration;
    const durationSec = Number.isFinite(d) && d > 0 ? d : FALLBACK_DURATION_SEC;
    this.probeCtrl.abort();
    this.probeCtrl = new AbortController();
    const { signal } = this.probeCtrl;
    this.probePending = true;
    const open = (): void => {
      if (gen !== this.gen || !this.probePending) return;
      this.probePending = false;
      this.pump();
    };
    let left = tiers.length;
    let downloading = 0;
    let raceExpired = false;
    for (const tier of tiers) {
      let seen = false;
      let dl = false;
      const first = (): void => {
        if (seen) return;
        seen = true;
        if (dl) {
          dl = false;
          downloading--;
        }
        if (--left <= 0 || (raceExpired && downloading === 0)) open();
      };
      const onDownload = (): void => {
        if (seen || dl || gen !== this.gen) return;
        dl = true;
        downloading++;
        diag.log('fulltrack-hold', { tier, holdMs: this.deps.probeDownloadHoldMs ?? PROBE_DOWNLOAD_HOLD_MS });
        (this.deps.hintSleep ?? defaultSleep)(this.deps.probeDownloadHoldMs ?? PROBE_DOWNLOAD_HOLD_MS, signal).then(open, () => {});
      };
      let info: ProbeReplyInfo | undefined;
      this.tierState(tier, 'probing');
      ft.probe({ tier, url, durationSec, sourceLang: this.sourceLang, signal, onFirst: first, onDownload, onReply: (i) => (info = i) }).then(
        (track) => {
          if (!track) {
            this.tierStateFromReply(tier, info);
            first();
            this.watchTier(tier, session, signal, info);
            return;
          }
          // the track is registered BEFORE the hold opens, so the first planned cells already see it
          if (!this.acceptTrack(track, session, signal)) {
            this.tierState(tier, 'miss', { reason: 'dropped' });
            first();
            this.watchTier(tier, session, signal, info);
            return;
          }
          first();
        },
        () => {
          this.tierState(tier, 'miss', { reason: 'probe-threw' });
          first();
          this.watchTier(tier, session, signal, undefined);
        },
      );
    }
    (this.deps.hintSleep ?? defaultSleep)(this.deps.probeRaceMs ?? PROBE_RACE_MS, signal).then(
      () => {
        raceExpired = true;
        if (downloading === 0) open();
      },
      () => {},
    );
  }

  /** diag 'fulltrack-state' on every CHANGE of a tier's full-track state (why a tier is not engaging) */
  private tierState(tier: ProviderId, state: 'probing' | 'waiting' | 'ready' | 'miss' | 'auth' | 'cooldown' | 'disabled', info?: { status?: number; remaining?: number; reason?: string }): void {
    const key = `${state}|${info?.status ?? ''}|${info?.reason ?? ''}`;
    if (this.tierStates.get(tier) === key) return;
    this.tierStates.set(tier, key);
    diag.log('fulltrack-state', { tier, state, status: info?.status, remaining: info?.remaining, reason: info?.reason });
  }

  private tierStateFromReply(tier: ProviderId, i: ProbeReplyInfo | undefined): void {
    if (!i) return this.tierState(tier, 'miss', { reason: 'no-reply' });
    if (i.errorKind === 'auth') return this.tierState(tier, 'auth', { status: i.status, reason: i.reason });
    if (i.status === 2 || i.status === 3) return this.tierState(tier, 'waiting', { status: i.status, remaining: i.remainingSec, reason: i.reason });
    this.tierState(tier, 'miss', { status: i.status, remaining: i.remainingSec, reason: i.reason });
  }

  // ---- complete-audio upload under the real id (status 6) ----

  /** keeps the raw captured audio of a short/medium video so that, when Yandex asks for audio, the COMPLETE track can be uploaded */
  private archiveChunk(c: AudioChunk, kind: CaptureKind): void {
    if (!this.probeUrl || !this.deps.fullTrack?.upload || kind === 'realtime' || c.pcm.length === 0 || c.sampleRate <= 0) return;
    const d = this.deps.video.duration;
    if (!Number.isFinite(d) || d <= 0 || d > (this.deps.uploadMaxSec ?? UPLOAD_MAX_SEC)) return;
    let a = this.archive;
    if (!a || Math.abs(a.durSec - d) > 0.5 || a.rate !== c.sampleRate) {
      a = this.archive = { pcm: new Int16Array(Math.ceil(d * c.sampleRate) + 1), rate: c.sampleRate, cov: [], durSec: d, maxEndSec: 0 };
    }
    const from = Math.max(0, Math.round(c.startSec * a.rate));
    const to = from + c.pcm.length;
    a.maxEndSec = Math.max(a.maxEndSec, to / a.rate);
    const n = Math.min(c.pcm.length, a.pcm.length - from);
    if (n <= 0) return;
    a.pcm.set(n === c.pcm.length ? c.pcm : c.pcm.subarray(0, n), from);
    // merge [from, from+n) into the coverage
    const cov = [...a.cov, [from, from + n] as [number, number]].sort((x, y) => x[0] - y[0]);
    const out: Array<[number, number]> = [];
    for (const r of cov) {
      const last = out[out.length - 1];
      if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
      else out.push([r[0], r[1]]);
    }
    a.cov = out;
  }

  /** the archive covers 0..duration without gaps (tiny holes tolerated), and no audio lies beyond the video */
  private archiveVerdict(): 'ok' | 'not-covered' | 'duration-mismatch' {
    const a = this.archive;
    const d = this.deps.video.duration;
    if (!a || !Number.isFinite(d) || d <= 0) return 'not-covered';
    if (a.maxEndSec > d * 1.01 + 1) return 'duration-mismatch';
    const r = a.rate;
    const holeMax = 0.3 * r;
    const holeTotal = 0.01 * d * r;
    let gaps = 0;
    let pos = 0;
    for (const [f, t] of a.cov) {
      const g = f - pos;
      if (g > holeMax) return 'not-covered';
      if (g > 0) gaps += g;
      pos = Math.max(pos, t);
    }
    const end = Math.min(a.pcm.length, Math.ceil(d * r));
    const tail = end - pos;
    if (tail > 0.01 * d * r) return 'not-covered';
    if (tail > 0) gaps += tail;
    return gaps <= holeTotal ? 'ok' : 'not-covered';
  }

  private uploadSkip(tier: ProviderId, reason: 'not-covered' | 'too-long' | 'no-id' | 'duration-mismatch', permanent: boolean): void {
    diag.log('audio-upload-skip', { tier, reason });
    if (permanent) this.uploadSkipped.add(tier);
  }

  /**
   * Status 6 for the REAL url: Yandex has no translation and wants the audio. Uploads the COMPLETE captured audio (never a
   * part: it would be cached as THE translation of this video id for everyone). Waits for the capture to cover the whole video.
   * @returns 'uploaded' | 'skip' (nothing will be uploaded for this tier) | 'later' (not covered yet; ask again on the next status 6)
   */
  private async uploadFor(tier: 'yandex' | 'yandex-live', info: ProbeReplyInfo, session: number, signal: AbortSignal): Promise<'uploaded' | 'skip' | 'later'> {
    const ft = this.deps.fullTrack;
    const url = this.probeUrl;
    if (!ft?.upload) return 'skip';
    if (this.uploaded.has(tier)) return 'uploaded';
    if (this.uploadSkipped.has(tier)) return 'skip';
    if (!url || !info.translationId) {
      this.uploadSkip(tier, 'no-id', true);
      return 'skip';
    }
    const d = this.deps.video.duration;
    if (!Number.isFinite(d) || d <= 0) {
      this.uploadSkip(tier, 'duration-mismatch', false);
      return 'later';
    }
    if (d > (this.deps.uploadMaxSec ?? UPLOAD_MAX_SEC)) {
      this.uploadSkip(tier, 'too-long', true);
      return 'skip';
    }
    const sleep = this.deps.uploadPollSleep ?? defaultSleep;
    const alive = (): boolean => session === this.session && !signal.aborted && !this.videoChanged() && this.usable.has(tier) && !this.chain.authSkip.has(tier);
    let waited = 0;
    let said = false;
    for (;;) {
      if (!alive()) return 'later';
      const v = this.archiveVerdict();
      if (v === 'duration-mismatch') {
        this.uploadSkip(tier, 'duration-mismatch', true);
        return 'skip';
      }
      if (v === 'ok') break;
      if (!said) {
        this.uploadSkip(tier, 'not-covered', false);
        said = true;
      }
      if (waited >= UPLOAD_WAIT_MAX_MS) return 'later';
      await sleep(UPLOAD_CHECK_MS, signal);
      waited += UPLOAD_CHECK_MS;
    }
    const a = this.archive!;
    // one upload at a time (live first in practice: its probe is issued first); the copy keeps the audio stable while it is sent
    const run = this.uploadLock.then(async () => {
      if (!alive() || this.uploaded.has(tier)) return this.uploaded.has(tier);
      const pcm = a.pcm.slice(0, Math.min(a.pcm.length, Math.round(d * a.rate)));
      try {
        await ft.upload!({ tier, url, translationId: info.translationId!, pcm, sampleRate: a.rate, signal, partBytes: this.deps.uploadPartBytes });
        this.uploaded.add(tier);
        return true;
      } catch (e) {
        if (signal.aborted) return false;
        const kind = (e as { kind?: string })?.kind;
        diag.log('audio-upload-fail', { tier, kind, err: String((e as Error)?.message ?? e).slice(0, 100) });
        if (kind === 'auth') this.chain.authSkip.add(tier);
        return false;
      }
    });
    this.uploadLock = run.catch(() => undefined);
    return (await run) ? 'uploaded' : 'later';
  }

  /** a probe delivered a track: registers it unless it belongs to a finished session / another video */
  private acceptTrack(track: FullTrack, session: number, signal: AbortSignal): boolean {
    if (session !== this.session || signal.aborted) {
      diag.log('stale-drop', { where: 'fulltrack', why: 'session', tier: track.tier });
      return false;
    }
    if (this.videoChanged()) {
      diag.log('stale-drop', { where: 'fulltrack', why: 'video-key', tier: track.tier, vid: this.startKey, nowVid: this.deps.videoKey?.() });
      return false;
    }
    this.tierState(track.tier, 'ready');
    this.onTrackReady(track);
    return true;
  }

  /**
   * Background watcher (D29): a Yandex tier that has no full track yet is asked again for as long as the video session lives -
   * Yandex finishes live translations minutes later (remainingTime 600-700 s) or another viewer prepares it. At most one request
   * per tier is in flight (sequential loop); backoff by nextWatchDelayMs; stops when the tier's track arrives (or, for the
   * standard tier, when a live track exists), on an auth error, and with the session. Cooldowns of the chunk mode do not apply.
   */
  private watchTier(tier: 'yandex' | 'yandex-live', session: number, signal: AbortSignal, initial: ProbeReplyInfo | undefined, firstDelayMs?: number): void {
    const ft = this.deps.fullTrack;
    const url = this.probeUrl;
    if (!ft || !url || signal.aborted || session !== this.session || this.watching.has(tier) || this.tracks.has(tier)) return;
    this.watching.set(tier, signal);
    const sleep = this.deps.probeWatchSleep ?? defaultSleep;
    const live = (): boolean => session === this.session && !signal.aborted && !this.videoChanged() && this.watching.get(tier) === signal;
    void (async () => {
      let info = initial;
      let waits = 0;
      let attempt = 0;
      let override = firstDelayMs;
      try {
        let sixes = 0;
        for (;;) {
          // status 6: Yandex has no translation and wants the audio -> upload the COMPLETE captured audio once, then poll
          if (info?.status === 6 && this.deps.fullTrack?.upload) {
            if (this.uploaded.has(tier)) {
              override = ++sixes <= POST_UPLOAD_SIX_TRIES ? WATCH_WAIT_REPEAT_MS : undefined;
            } else if (!this.chain.authSkip.has(tier) && this.usable.has(tier)) {
              const r = await this.uploadFor(tier, info, session, signal);
              if (!live()) return;
              if (r === 'uploaded') {
                info = { status: 2, remainingSec: 20 };
                this.tierState(tier, 'waiting', { status: 2, reason: 'uploaded' });
              }
            }
          }
          const delay = override ?? nextWatchDelayMs(info, waits);
          override = undefined;
          if (info?.status === 2 || info?.status === 3) waits++;
          if (delay === undefined) {
            diag.log('fulltrack-watch-stop', { tier, why: info?.errorKind ?? 'fatal' });
            return;
          }
          await sleep(delay, signal);
          if (!live() || this.tracks.has(tier) || (tier === 'yandex' && this.tracks.has('yandex-live'))) return;
          if (this.chain.authSkip.has(tier)) {
            this.tierState(tier, 'auth', { reason: 'auth-skip' });
            diag.log('fulltrack-watch-stop', { tier, why: 'auth' });
            return;
          }
          if (!this.usable.has(tier) || this._state === 'native-dub' || this._state === 'idle' || this._state === 'stopped') {
            this.tierState(tier, 'disabled', { reason: this.usable.has(tier) ? this._state : 'not-usable' });
            info = { reason: 'unusable' }; // disabled in settings / not translating: ask nothing, look again later
            continue;
          }
          const d = this.deps.video.duration;
          let got: ProbeReplyInfo | undefined;
          attempt++;
          this.tierState(tier, 'probing', { reason: (this.chain.cooldownUntil.get(tier) ?? 0) > (this.deps.now ?? Date.now)() ? 'chunk-cooldown-ignored' : undefined });
          const track = await ft.probe({
            tier,
            url,
            durationSec: Number.isFinite(d) && d > 0 ? d : FALLBACK_DURATION_SEC,
            sourceLang: this.sourceLang,
            signal,
            once: true,
            firstRequest: false,
            onReply: (i) => (got = i),
          });
          if (!live()) return;
          if (!track) this.tierStateFromReply(tier, got);
          if (track) {
            diag.log('fulltrack-watch-hit', { tier, attempt });
            this.acceptTrack(track, session, signal);
            return;
          }
          info = got;
        }
      } catch {
        /* aborted: the session ended */
      } finally {
        if (this.watching.get(tier) === signal) this.watching.delete(tier);
      }
    })();
  }

  /** a tier became usable mid-session (settings): start probing it if it has no track yet */
  private ensureWatchers(): void {
    if (this.probeCtrl.signal.aborted || !this.probeUrl || !this.deps.fullTrack) return;
    for (const tier of ['yandex-live', 'yandex'] as const) {
      if (this.usable.has(tier) && !this.tracks.has(tier)) this.watchTier(tier, this.session, this.probeCtrl.signal, undefined, 0);
    }
  }

  /**
   * Creates the cells of the next TRACK_AHEAD_SEC straight from a full track: they need neither captured audio nor the
   * rechunker, so the first dub does not wait for the MSE buffer to grow. Cells already done / queued are left alone.
   */
  private feedFromTrack(): void {
    if (this.tracks.size === 0 || (this._state !== 'starting' && this._state !== 'translating' && this._state !== 'buffering')) return;
    if (this.videoChanged()) return;
    const cs = this.settings.chunkSec;
    const ct = this.deps.video.currentTime;
    const dur = this.deps.video.duration;
    let added = 0;
    for (let k = Math.floor(ct / cs + 1e-9); k * cs < ct + TRACK_AHEAD_SEC; k++) {
      const startSec = k * cs;
      if (Number.isFinite(dur) && dur > 0 && startSec >= dur) break;
      if (this.doneRanges.has(startSec) || this.tasks.has(startSec)) continue;
      const chunk: AudioChunk = { startSec, durationSec: cs, sampleRate: 0, pcm: new Int16Array(0) };
      if (!this.trackTierFor(chunk)) continue;
      this.tasks.set(startSec, { chunk, status: 'queued', attempts: 0, noTierWaits: 0, ctrl: new AbortController() });
      added++;
    }
    if (added > 0) {
      diag.log('track-feed', { added, ct, ahead: TRACK_AHEAD_SEC });
      if (!this.dubReady && this._state === 'starting') this.emitPreparing();
    }
  }

  /** `schedSegs`: what the scheduler plays when it differs from the engine's record `segs` (the tail of the playing cell) */
  private swapCell(cell: number, dur: number, from: ProviderId, to: ProviderId, segs: DubSegment[], voice: 'lively' | 'standard' | undefined, mode: string, schedSegs?: DubSegment[]): void {
    const inCell = (x: DubSegment): boolean => x.providerId === from && x.start >= cell - 0.01 && x.end <= cell + dur + 0.01;
    const removed = this.scheduler?.removeSegmentsWhere?.(inCell, { fadeSec: mode === 'now' ? 0.15 : 0.3, reason: 'tier-upgrade' }) ?? 0;
    this.segments = this.segments.filter((x) => !inCell(x));
    this.segments.push(...segs);
    this.scheduler?.addSegments(schedSegs ?? segs);
    this.cellProvider.set(cell, to);
    this.pendingSwaps.delete(cell);
    diag.log('tier-upgrade', { cell, from, to, mode, removed, lead: Math.round((cell - this.deps.video.currentTime) * 10) / 10 });
    if (mode === 'upgrade' || mode === 'now') {
      this.deps.events?.onVoice?.({ providerId: to, voice });
      // the status line ("Озвучка: X -> Y позже") follows the tier that voices now: a takeover must refresh it
      this._active = to;
      this.updateReady();
    }
  }

  /** deferred swaps whose slot has passed: the better voice is used from now on (rewinds) */
  private flushSwaps(): void {
    const ct = this.deps.video.currentTime;
    for (const [cell, w] of [...this.pendingSwaps]) {
      if (ct >= cell + w.dur + 0.3 && this.cellProvider.get(cell) === w.from) this.swapCell(cell, w.dur, w.from, w.to, w.segments, w.voice, 'rewind');
    }
  }

  private onChunkFailed(task: Task, noTier?: { waitMs?: number }): void {
    const cell = task.chunk.startSec;
    if (noTier) task.noTierWaits++;
    else task.attempts++;
    if (!task.revoice) this.setState('buffering', { provider: this._active });
    if (task.attempts > MAX_CHUNK_RETRIES || task.noTierWaits > MAX_NOTIER_WAITS || task.revoice) {
      this.tasks.delete(cell);
      diag.log('chunk-gave-up', { cell, attempts: task.attempts, noTierWaits: task.noTierWaits, revoice: !!task.revoice });
      const ctNow = this.deps.video.currentTime;
      if (!task.revoice && ctNow >= cell - 0.5 && ctNow < cell + task.chunk.durationSec) this.releasePreroll('gave-up');
      if (!task.revoice) {
        // the original keeps playing for this cell (adaptive ducking never lowered it), but say so
        this.warnThrottled('chunk-failed', {
          kind: 'chunk-failed',
          message: `no voice tier could translate the part at ${Math.round(cell)} s; the original stays audible there`,
        });
      }
      return;
    }
    task.status = 'waiting';
    const base = (this.deps.retryDelayMs ?? 5000) * Math.max(1, task.attempts);
    const delay = noTier ? Math.min(30_000, Math.max(1000, noTier.waitMs ?? base)) : base;
    diag.log('chunk-retry', { cell, attempts: task.attempts, noTier: !!noTier, delay });
    const sleep = this.deps.sleep ?? defaultSleep;
    sleep(delay, task.ctrl.signal).then(
      () => {
        if (task.ctrl.signal.aborted || this.tasks.get(cell) !== task) return;
        task.status = 'queued';
        this.pump();
      },
      () => {},
    );
  }

  private keep(c: AudioChunk): void {
    if (c.pcm.length === 0) return; // a cell created from a full track has no captured audio to re-voice
    this.kept.set(c.startSec, c);
    if (this.kept.size <= KEEP_CHUNKS) return;
    const ct = this.deps.video.currentTime;
    const keys = [...this.kept.keys()].sort((a, b) => a - b);
    // drop what lies furthest behind the playhead first
    for (const k of keys) {
      if (this.kept.size <= KEEP_CHUNKS) break;
      if (k + c.durationSec < ct - 5) this.kept.delete(k);
    }
    for (const k of keys.reverse()) {
      if (this.kept.size <= KEEP_CHUNKS) break;
      this.kept.delete(k);
    }
  }

  /**
   * Safety rule: a phrase cannot be dubbed before the speech of its chunk begins. Estimated sentence times (Whisper without
   * timestamps, Gemini guesses) can fall into a lead-in of silence / music; such segments are moved (whole, duration kept)
   * to the measured speech onset. The scheduler then adds the dub lag on top. Yandex cell voice-overs trail the speaker by
   * construction and are left alone, as are chunks without captured audio.
   */
  private clampToSpeechOnset(chunk: AudioChunk, segs: DubSegment[], providerId: ProviderId): DubSegment[] {
    if (segs.length === 0 || providerId === 'yandex' || providerId === 'yandex-live' || chunk.pcm.length === 0) return segs;
    let onset = 0;
    try {
      onset = speechOnsetSec(chunk.pcm, chunk.sampleRate);
    } catch {
      return segs;
    }
    if (onset < 0.3) return segs;
    const min = chunk.startSec + onset;
    let moved = 0;
    let maxShift = 0;
    const out = segs.map((x) => {
      if (x.start >= min - 0.05) return x;
      const d = min - x.start;
      moved++;
      if (d > maxShift) maxShift = d;
      return { ...x, start: x.start + d, end: x.end + d };
    });
    if (moved > 0) diag.log('onset-clamp', { cell: chunk.startSec, onset: Math.round(onset * 100) / 100, moved, maxShift: Math.round(maxShift * 100) / 100, tier: providerId });
    return out;
  }

  private onResult(task: Task, providerId: ProviderId, raw: DubSegment[], sourceLang?: string, subs?: SubtitleCue[], voice?: 'lively' | 'standard', ms = 0): void {
    if (sourceLang === 'ru' && this.skipEnabled()) {
      diag.log('lang-gate', { decision: 'skip', lang: 'ru', how: 'provider', tier: providerId });
      this.setLanguage({ lang: 'ru', confidence: 0.99, how: 'provider', unverified: false, skipped: true });
      void this.deps.langStore?.markRussian().catch(() => {});
      this.skipRussian();
      return;
    }
    if (sourceLang && sourceLang !== 'ru' && this.unverified) {
      this.unverified = false;
      diag.log('lang-gate', { decision: 'verified', lang: sourceLang, how: 'provider', tier: providerId });
      this.setLanguage({ lang: sourceLang, confidence: 0.99, how: 'provider', unverified: false });
    }
    let segments = this.clampToSpeechOnset(task.chunk, raw.map((x) => (x.providerId ? x : { ...x, providerId })), providerId);
    if (task.chunk.provisional) {
      // produced under a provisional clock offset: the real one may already be known (shift the slots) or still come (remember them)
      const sh = this.provShift;
      if (sh !== undefined && Math.abs(sh) > RETIME_MIN_SEC) segments = segments.map((x) => ({ ...x, start: x.start + sh, end: x.end + sh }));
      else if (sh === undefined) for (const x of segments) this.provSegs.add(x);
    }
    const cell = task.chunk.startSec;
    const dur = task.chunk.durationSec;
    const ct = this.deps.video.currentTime;
    const dubSec = segments.reduce((n, x) => n + Math.max(0, x.end - x.start), 0);
    // how far the playhead already is into the cell this dub belongs to (> 0.7 of it = the scheduler will skip it)
    const intoCell = ct - cell - this.lagSec();
    diag.log('chunk-voiced', { cell, dur, partial: !!task.chunk.partial, tier: providerId, ms, segments: segments.length, dubSec, ct, intoCell, voice });
    if (segments.length > 0 && !task.revoice) {
      // F: every segment of the chunk was already over when its dub arrived (live: useless) -> status after 3 in a row
      const lastEnd = Math.max(...segments.map((x) => x.end));
      if (lastEnd + this.lagSec() < ct) {
        this.lateRun++;
        if (this.lateRun >= 3) localReasons.set('late', reasonText.late(Math.round(ct - lastEnd)));
        this.wd.lateDubs = this.lateRun;
      } else {
        this.lateRun = 0;
        this.wd.lateDubs = 0;
        localReasons.clear('late');
      }
    }
    if (segments.length === 0) {
      this.emptyRun++;
      diag.log('chunk-no-speech', { cell, tier: providerId, run: this.emptyRun });
      if (this.capture?.kind === 'hls' && this.emptyRun >= PREROLL_EMPTY_RELEASE) this.releasePreroll('no-speech');
    } else this.emptyRun = 0;
    if (segments.length > 0 && intoCell > 0.7 * dur && !task.revoice) {
      this.warnThrottled('dub-late', {
        kind: 'dub-late',
        providerId,
        message: `the dub for ${Math.round(cell)}..${Math.round(cell + dur)} s arrived ${Math.round(ct - (cell + dur))} s after its slot (${ms ? Math.round(ms / 1000) : '?'} s to translate, capture ${this.capture?.kind ?? '?'}); kept for rewinds`,
      });
    }
    try {
      this.deps.events?.onSegments?.(segments, providerId);
    } catch {
      /* observers must not break playback */
    }
    this.deps.events?.onVoice?.({ providerId, voice });
    if (sourceLang) this.sourceLang = sourceLang;
    if (segments.length > 0) {
      this.noteDub();
      this.segments.push(...segments);
      this.scheduler?.addSegments(segments);
      if (!this.schedStarted) {
        this.schedStarted = true;
        this.scheduler?.start();
      }
      if (!task.revoice) this.maybeRewindForDub(segments);
    }
    if (this.ttfd.asrMs === undefined && ms > 0 && segments.length > 0) this.ttfd.asrMs = ms;
    if (this.settings.subtitles === 'on' && subs && subs.length > 0) {
      const seen = new Set(this.cues.map((c) => `${c.start}|${c.text}`));
      for (const c of subs) if (!seen.has(`${c.start}|${c.text}`)) this.cues.push(c);
      this.cues.sort((a, b) => a.start - b.start);
      this.deps.events?.onSubtitles?.([...this.cues]);
    }
    this._active = providerId;
    this.updateReady();
  }

  // ---- start-up: "preparing" status and the optional preroll pause ----

  private etaSec(): number {
    const now = (this.deps.now ?? Date.now)();
    if (this.prep) return Math.max(0, Math.round(this.prep.expectedSec - (now - this.prep.at) / 1000));
    return Math.max(0, Math.round(this.latencySec()));
  }

  private emitPreparing(): void {
    if (this._state !== 'starting') return;
    this.setState('starting', this.preparingDetail());
  }

  private preparingDetail(): EngineStateDetail {
    const top = this.topUsable(this.usable);
    const id = this.prep?.id ?? this.fastestUsable();
    return {
      preparing: true,
      etaSec: this.etaSec(),
      prerollPaused: this.prerollActive && this.pausedByUs,
      provider: this._active,
      slow: this.slowHint(),
      etaProvider: id,
      later: top && id && top !== id ? top : undefined,
    };
  }

  private fastestUsable(): ProviderId | undefined {
    return [...this.usable].sort((a, b) => this.model.expectedSec(a) - this.model.expectedSec(b))[0];
  }

  /** the user's top usable tier is not the one voicing now (and is not cooling down): it takes over later */
  private laterTier(): ProviderId | undefined {
    const now = (this.deps.now ?? Date.now)();
    const cur = this._active;
    const top = [...this.usable].filter((id) => (this.chain.cooldownUntil.get(id) ?? 0) <= now).sort((a, b) => this.rankOf(a) - this.rankOf(b))[0];
    return cur && top && this.rankOf(top) < this.rankOf(cur) ? top : undefined;
  }

  /** Yandex-specific "answers slowly" hint, see SLOW_START_HINT_MS */
  private slowHint(): 'wait' | 'switch' | undefined {
    if (this.dubReady || this._state !== 'starting' || !this.isYandexTier()) return undefined;
    const now = (this.deps.now ?? Date.now)();
    if (now - this.startedAt < (this.deps.slowStartMs ?? SLOW_START_HINT_MS)) return undefined;
    return this.chain.hedges > 0 || [...this.chain.cooldownUntil.values()].some((u) => u > now) ? 'switch' : 'wait';
  }

  /** a finished cell (voiced or without speech) that contains the playhead: the dub has joined (or never will here) */
  private coversPlayhead(): boolean {
    const ct = this.deps.video.currentTime;
    for (const [s, e] of this.doneRanges) if (ct >= s - 0.3 && ct < e - 0.3) return true;
    return false;
  }

  private updateReady(): void {
    if (this._state === 'idle' || this._state === 'stopped' || this._state === 'error' || this._state === 'skipped-ru' || this._state === 'native-dub') return;
    if (!this.dubReady && this.coversPlayhead()) {
      this.dubReady = true;
      localReasons.clear('live');
      diag.log('dub-ready', {
        ms: (this.deps.now ?? Date.now)() - this.startedAt,
        ct: this.deps.video.currentTime,
        paused: this.prerollActive && this.pausedByUs,
      });
      if (this.prerollActive) {
        const gen = this.gen;
        const ctrl = this.prerollCtrl;
        (this.deps.sleep ?? defaultSleep)(PREROLL_RESUME_DELAY_MS, ctrl?.signal ?? new AbortController().signal).then(
          () => {
            if (gen === this.gen) this.releasePreroll('ready');
          },
          () => {},
        );
      }
    }
    if (this.dubReady) this.setState('translating', { provider: this._active, later: this.laterTier() });
    else if (this._state === 'translating' || this._state === 'buffering' || this._state === 'starting') {
      this.setState('starting', this.preparingDetail());
    }
  }

  /** prerollPause = 'on': hold the video paused until the first dub covering the playhead is ready */
  private beginPreroll(gen: number): void {
    const v = this.deps.video;
    if (this.settings.prerollPause !== 'on' || v.paused || v.ended) return;
    // live: pausing destroys the player's buffer on Twitch (ct -> 0) and the delay seek replaces the wait
    if (this.isLive() || isHlsHost(this.hostName())) {
      diag.log('preroll-skip', { reason: 'live', ct: v.currentTime });
      return;
    }
    try {
      v.pause();
    } catch {
      return;
    }
    this.prerollActive = true;
    this.pausedByUs = true;
    const ctrl = new AbortController();
    this.prerollCtrl = ctrl;
    this.prerollAt = (this.deps.now ?? Date.now)();
    diag.log('preroll-pause', { ct: v.currentTime });
    (this.deps.sleep ?? defaultSleep)(PREROLL_MAX_MS, ctrl.signal).then(
      () => {
        if (gen === this.gen) this.releasePreroll('timeout');
      },
      () => {},
    );
    this.emitPreparing();
  }

  /** the capture turned out to be a live HLS one: shorten the preroll wait (a second timer; releasePreroll is idempotent) */
  private capPrerollForLive(gen: number): void {
    if (!this.prerollActive) return;
    const left = Math.max(0, PREROLL_LIVE_MAX_MS - ((this.deps.now ?? Date.now)() - this.prerollAt));
    const ctrl = this.prerollCtrl;
    (this.deps.sleep ?? defaultSleep)(left, ctrl?.signal ?? new AbortController().signal).then(
      () => {
        if (gen === this.gen) this.releasePreroll('timeout-live');
      },
      () => {},
    );
  }

  private endPreroll(): void {
    this.prerollActive = false;
    this.prerollCtrl?.abort();
    this.prerollCtrl = undefined;
  }

  /** resume playback only if WE paused it and nobody touched the video since */
  private releasePreroll(reason: string): void {
    if (!this.prerollActive) return;
    const v = this.deps.video;
    const resume = this.pausedByUs && v.paused && !v.ended;
    this.endPreroll();
    this.pausedByUs = false;
    diag.log('preroll-release', { reason, resume, ct: v.currentTime });
    if (!resume) return;
    this.selfPlay = true;
    let p: unknown;
    try {
      p = v.play();
    } catch {
      /* autoplay policy: the user presses play */
    }
    Promise.resolve(p)
      .catch(() => {})
      .finally(() => {
        this.selfPlay = false;
      });
  }

  // ---- early language gate ----

  private setLanguage(info: LanguageInfo): void {
    this.langInfo = info;
    try {
      this.deps.events?.onLanguage?.(info);
    } catch {
      /* observers must not break the engine */
    }
  }

  /** the Russian skip applies: setting on, nothing forced, no explicit source language */
  private skipEnabled(): boolean {
    return this.settings.skipRussian !== 'off' && !this.forced && (!this.settings.sourceLang || this.settings.sourceLang === 'auto');
  }

  /** @returns false when the video must not be translated (state is then 'skipped-ru') */
  private async languageGate(gen: number): Promise<boolean> {
    const s = this.settings;
    if (s.sourceLang && s.sourceLang !== 'auto') {
      this.sourceLang = s.sourceLang;
      this.setLanguage({ lang: s.sourceLang, confidence: 1, how: 'settings', unverified: false });
      diag.log('lang-gate', { decision: 'explicit', lang: s.sourceLang });
      return true;
    }
    const detect = this.deps.detectLanguage;
    if (!detect) return true;
    const skipOn = this.skipEnabled();
    try {
      if (skipOn && (await this.deps.langStore?.isRussian())) {
        if (gen !== this.gen) return false;
        diag.log('lang-gate', { decision: 'skip', how: 'cache' });
        this.setLanguage({ lang: 'ru', confidence: 0.99, how: 'cache', unverified: false, skipped: true });
        this.skipRussian();
        return false;
      }
    } catch {
      /* a store failure must not block translation */
    }
    let v: LangVerdict | undefined;
    try {
      v = await detect();
    } catch (e) {
      diag.log('lang-gate-error', { msg: e instanceof Error ? e.message.slice(0, 60) : 'err' });
    }
    if (gen !== this.gen) return false;
    const lang = v?.lang;
    const conf = v?.confidence ?? 0;
    const how = v?.how ?? 'none';
    if (lang === 'ru' && conf >= SKIP_CONFIDENCE) {
      if (skipOn) {
        diag.log('lang-gate', { decision: 'skip', lang, conf, how });
        this.setLanguage({ lang, confidence: conf, how, unverified: false, skipped: true });
        void this.deps.langStore?.markRussian().catch(() => {});
        this.skipRussian();
        return false;
      }
      // Russian but the user wants it translated anyway (setting off / forced): the provider detects the source itself
      diag.log('lang-gate', { decision: 'proceed-ru', lang, conf, how, forced: this.forced });
      this.setLanguage({ lang, confidence: conf, how, unverified: false, forced: true });
      return true;
    }
    if (lang && lang !== 'ru' && conf >= PASS_CONFIDENCE) {
      this.sourceLang = lang;
      diag.log('lang-gate', { decision: 'proceed', lang, conf, how });
      this.setLanguage({ lang, confidence: conf, how, unverified: false });
      return true;
    }
    this.unverified = true;
    diag.log('lang-gate', { decision: 'unverified', lang: lang ?? '?', conf, how });
    this.setLanguage({ lang, confidence: conf, how, unverified: true });
    this.deps.events?.onWarning?.({ kind: 'language-unverified', message: 'the language of the video could not be verified; the first result decides' });
    return true;
  }

  private skipRussian(): void {
    this.teardown();
    this.setState('skipped-ru');
    this.deps.events?.onWarning?.({ kind: 'already-russian', message: 'the video is already in Russian' });
  }

  // ---- scheduler ----

  private schedOpts(): DubSchedulerOptions {
    return {
      translationVolume: this.settings.translationVolume,
      originalVolume: this.settings.originalVolume,
      dubLagSec: this.lagSec(),
      onStarve: () => this.pump(),
      onFirstPlay: () => this.logTtfd(),
      // never lead the original: with the hls capture the monitor envelope says whether the original has started speaking (see DubScheduler onsetProbe)
      onsetProbe: (vt) => (this.capture?.kind === 'hls' ? this.capture.onsetProbe?.(vt) : undefined),
      forgetBehindSec: this.isLive() ? 60 : undefined,
      onDecodeError: (info) =>
        this.warnThrottled('dub-decode-failed', {
          kind: 'dub-decode-failed',
          message: `the dub audio at ${Math.round(info.start)} s could not be decoded (${info.mime}, ${info.bytes} bytes): ${info.message}`,
        }),
    };
  }

  private rebuildScheduler(): void {
    const old = this.scheduler;
    if (!old) return;
    old.onStarve = undefined;
    old.dispose();
    const sch = (this.deps.createScheduler ?? defaultScheduler)(this.deps.video, this.deps.audioCtx, this.schedOpts());
    this.scheduler = sch;
    const keepFrom = this.deps.video.currentTime - 30;
    this.segments = this.segments.filter((s) => s.end >= keepFrom);
    if (this.segments.length > 0) sch.addSegments(this.segments);
    if (this.schedStarted) sch.start();
  }

  // ---- lifecycle ----

  private abortTasks(): void {
    for (const t of this.tasks.values()) t.ctrl.abort();
    this.tasks.clear();
    this.inflight.clear();
  }

  private teardown(): void {
    this.gen++;
    this.session++;
    this.dropTracks();
    this.hintCtrl.abort();
    this.nativeCtrl?.abort();
    this.nativeCtrl = undefined;
    this.abortTasks();
    // racers/hedges that outlive their task must not keep working for (or report into) a finished session
    for (const att of [...this.liveAttempts.values()]) {
      try {
        att.abort();
      } catch {
        /* already finished */
      }
    }
    this.liveAttempts.clear();
    this.releasePreroll('stop');
    this.liveDelay?.stop();
    this.liveDelay = undefined;
    this.lateRun = 0;
    localReasons.clear('late');
    localReasons.clear('quality-slow');
    this.stopHlsProbe();
    this.stopWatchdog();
    this.adsActive = false;
    localReasons.clear('ads');
    localReasons.clear('restart');
    if (this.listening) {
      this.deps.video.removeEventListener('seeked', this.onSeeked);
      this.deps.video.removeEventListener('timeupdate', this.onTimeUpdate);
      this.deps.video.removeEventListener('playing', this.onTimeUpdate);
      this.deps.video.removeEventListener('play', this.onPlayEvent);
    }
    this.listening = false;
    this.offChunk?.();
    this.offChunk = undefined;
    clearInterval(this.bufTimer);
    this.bufTimer = undefined;
    this.rechunker?.dispose();
    this.rechunker = undefined;
    try {
      this.capture?.stop();
    } catch {
      /* already stopped */
    }
    this.capture = undefined;
    if (this.scheduler) {
      this.scheduler.onStarve = undefined;
      this.scheduler.dispose();
    }
    this.scheduler = undefined;
    this.schedStarted = false;
  }

  private reset(): void {
    this.dropTracks();
    this.tasks.clear();
    this.doneRanges.clear();
    this.cellProvider.clear();
    this.kept.clear();
    this.pendingSwaps.clear();
    this.liveAttempts.clear();
    this.prep = undefined;
    this.rewindSlot = undefined;
    this.provSegs = new WeakSet();
    this.provCells.clear();
    this.provShift = undefined;
    this.ttfd = { logged: false, adMs: 0 };
    if (this.liveVideo) {
      this.liveVideo = false;
      this.settings = withSiteOverride(this.rawSettings, this.hostName());
    }
    localReasons.clear('live');
    localReasons.clear('quality-slow');
    this.qualityExtraDone = false;
    this.dubReady = false;
    this.firstRequestAt = 0;
    this.rateCap = 0;
    this.rateUntil = 0;
    this.segments = [];
    this.cues = [];
    this.sourceLang = undefined;
    this.unverified = false;
    this.langInfo = undefined;
    this.excluded = new Set();
    this.lastError = undefined;
    this._active = undefined;
    this.lastKey = '';
  }

  private setState(s: EngineState, detail?: EngineStateDetail): void {
    const d = { ...detail, captureKind: detail?.captureKind ?? this.capture?.kind };
    const key = `${s}|${d.provider ?? ''}|${d.captureKind ?? ''}|${d.preparing ? 'p' : ''}${d.prerollPaused ? 'z' : ''}|${d.slow ?? ''}|${d.later ?? ''}|${d.etaProvider ?? ''}`;
    if (s === this._state && key === this.lastKey) return;
    this._state = s;
    this.lastKey = key;
    this.deps.events?.onState?.(s, d);
  }
}
