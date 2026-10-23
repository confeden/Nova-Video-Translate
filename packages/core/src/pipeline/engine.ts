/** TranslationEngine: capture -> prioritised chunk queue -> provider chain -> scheduler. */
import { Rechunker } from '../capture/rechunk';
import { diag } from '../diag';
import { createCapture as defaultCreateCapture, type Capture, type CaptureKind, type CaptureStatus } from '../capture';
import { DubScheduler, type BufferedRange, type DubSchedulerOptions } from '../playback/scheduler';
import type { AudioChunk, DubProvider, DubSegment, ProviderId, SubtitleCue } from '../providers/types';
import type { Settings } from '../types';
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
  LIVE_CHUNK_CAP,
  upgradeDecision,
  yandexTierCap,
  type CellPlan,
} from './planner';

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
  getBuffered?(): BufferedRange[];
  /** drop matching segments (a playing one fades out); used when a tier is switched off */
  removeSegmentsWhere?(pred: (seg: DubSegment) => boolean, opts?: { fadeSec?: number; reason?: string }): number;
}

export interface EngineDeps {
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
  /** last error of start()/capture switching, for the UI */
  lastError?: string;

  private readonly onSeeked = (): void => {
    if (this._state !== 'starting' && this._state !== 'translating' && this._state !== 'buffering') return;
    const ct = this.deps.video.currentTime;
    const cs = this.settings.chunkSec;
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

  constructor(private readonly deps: EngineDeps) {
    this.settings = deps.settings;
    this.model = new LatencyModel(() => (deps.now ?? Date.now)(), { ...TIER_PRIOR_SEC, ...deps.latencyPriors });
  }

  get state(): EngineState {
    return this._state;
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

  /** the translation proper: providers, probes, capture (everything after the language gate and the native-dub check) */
  private async beginTranslation(gen: number): Promise<void> {
    await Promise.all(this.deps.providers.map((p) => (p.probe ? p.probe().catch(() => undefined) : undefined)));
    if (gen !== this.gen) return;
    this.usable = this.computeUsable();
    diag.log('engine-start', {
      t: this.deps.video.currentTime,
      chunkSec: this.settings.chunkSec,
      order: this.settings.voiceOrder.join('>'),
      usable: [...this.usable],
      authSkip: [...this.chain.authSkip],
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
    } catch (e) {
      if (gen === this.gen) this.fail(e);
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

  updateSettings(s: Settings): void {
    const prev = this.settings;
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
    const all: CaptureKind[] = ['mse', 'direct', 'realtime'];
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
    diag.log('capture-open', { kind: cap.kind, strategies });
    // fixed [k*chunkSec, (k+1)*chunkSec) cells: a second viewing produces identical chunk boundaries (result cache)
    const rc = new Rechunker({
      chunkSec: this.settings.chunkSec,
      emit: (c) => this.onChunk(c),
      // an incomplete cell that is still far enough ahead keeps waiting for its missing piece (a partial cell costs a
      // full request for little audio); once it is about to become late, the partial is better than nothing
      // holdCellsToEnd: keep the cell until playback has passed its end (the rest of its audio is still coming)
      hold: (start) =>
        this.settings.holdCellsToEnd
          ? start + this.settings.chunkSec > this.deps.video.currentTime
          : start > this.deps.video.currentTime + this.latencySec() + START_MARGIN_SEC,
    });
    this.rechunker = rc;
    // diagnostics: how far the player has buffered ahead of playback (the lead the capture can deliver in time)
    const v = this.deps.video;
    this.bufTimer = setInterval(() => {
      const b = v.buffered;
      const end = b && b.length > 0 ? b.end(b.length - 1) : v.currentTime;
      diag.log('buf-ahead', { ct: v.currentTime, aheadSec: end - v.currentTime, ranges: b.length, kind: cap.kind });
    }, 3000);
    this.offChunk = cap.onChunk((c) => {
      this.chunksFromCapture++;
      this.archiveChunk(c, cap.kind);
      rc.push(c);
    });
    return cap;
  }

  private onCaptureStatus(st: CaptureStatus, gen: number): void {
    if (gen !== this.gen) return;
    if (st.type !== 'tainted' && st.type !== 'unsupported') return;
    const kind = this.capture?.kind;
    if (st.type === 'tainted') {
      this.deps.events?.onWarning?.({ kind: 'capture-tainted', message: `capture "${kind ?? '?'}" is tainted (cross-origin media)` });
      // a strategy that already delivered audio is demonstrably not tainted: a late report is a false positive
      if (this.chunksFromCapture > 0) return;
    }
    if (kind) this.excluded.add(kind);
    void this.switchCapture();
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
    diag.log('chunk-queued', { cell: c.startSec, dur: c.durationSec, partial: !!c.partial, ct: this.deps.video.currentTime, kind: this.capture?.kind });
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
    const lim = this.capture?.kind === 'realtime' ? 120 : STALE_SEC;
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
      const end = c.startSec + c.durationSec;
      let g: number;
      if (lat > 0) g = c.startSec >= arrive + START_MARGIN_SEC ? 0 : end - arrive >= LATE_TAIL_SEC ? 1 : 2;
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
    const tts = c.startSec - this.deps.video.currentTime;
    const ft = this.trackTierFor(c);
    if (ft) return { plan: { start: [ft], preferred: ft, reason: 'full-track', inTime: [ft], late: false }, blocked: false, tts };
    const all = eligibleProviders(this.deps.providers, this.settings, this.chain, now);
    const free = all.filter((p) => this.tierActive(p.id) < this.tierCap(p.id));
    if (all.length === 0) return { plan: { start: [], reason: 'no-tier', inTime: [], late: true }, blocked: false, tts }; // the chain reports "no tier"
    if (free.length === 0) return { plan: { start: [], reason: 'no-tier', inTime: [], late: true }, blocked: true, tts };
    // a pinned (full-track) tier is fast only for the cells its track covers; this cell is not covered, so it runs at its chunk-mode speed
    // D26 live policy (chunk mode): the live tier starts only for a cell whose slot is at least its expected latency away
    // (the server ETA of a live job is 500-750 s); it never runs as the fall-through of a cell it was gated out of
    const liveGated = free.some((p) => p.id === 'yandex-live') && all.some((p) => p.id !== 'yandex-live') && tts < this.model.expectedSec('yandex-live', c.durationSec);
    const skip: ProviderId[] = liveGated ? ['yandex-live'] : [];
    if (liveGated) {
      const rest = free.filter((p) => p.id !== 'yandex-live');
      if (rest.length === 0) {
        // the only free tiers besides live are busy: wait for them
        return { plan: { start: [], reason: 'no-tier', inTime: [], late: true, skip }, blocked: true, tts };
      }
      free.splice(0, free.length, ...rest);
    }
    const tiers = free.map((p) => ({ id: p.id, expectedSec: this.tracks.get(p.id)?.complete ? Math.max(this.model.expectedSec(p.id), this.model.prior(p.id) * 0.5) : this.model.expectedSec(p.id) }));
    let plan = planCell({ timeToSlot: tts, tiers });
    if (task.revoice) plan = { ...plan, start: [tiers[0]!.id], reason: 'single' };
    if (!liveGated && plan.start.includes('yandex-live') && !this.model.etaKnown('yandex-live')) {
      // scouting live job (its server ETA is not known yet): race it with the best other tier so the cell is not at its mercy
      const other = tiers.find((t) => t.id !== 'yandex-live' && t.id !== 'gemini') ?? tiers.find((t) => t.id !== 'yandex-live');
      if (other && !plan.start.includes(other.id)) plan = { ...plan, start: [...plan.start, other.id] };
    }
    if (skip.length > 0) plan = { ...plan, skip };
    return { plan, blocked: false, tts };
  }

  /** whole-job deadline (ms) of a Yandex tier's attempt, evaluated when the attempt starts */
  private deadlineFor(id: ProviderId, task: Task): number | undefined {
    if (id === 'gemini' || id === 'groq' || id === 'local') return undefined;
    const c = task.chunk;
    const ct = this.deps.video.currentTime;
    return jobTimeoutMs(c.startSec - ct, ct >= c.startSec + c.durationSec, this.model.expectedSec(id, c.durationSec));
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
      tts: Math.round((key - ct0) * 10) / 10,
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
            } else {
              this.liveAttempts.delete(k);
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
      tts: Math.round((key - ct0) * 10) / 10,
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
      return jobTimeoutMs(key - ct, ct >= key + total, this.model.expectedSec(id, total));
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
   * Voice preference for track decisions (D29 quality ladder): live > standard > Gemini regardless of the user's order and of
   * which track arrived first (a tier the user disabled is never in `usable`, so it never takes part).
   */
  private prefRank(id: ProviderId): number {
    return id === 'gemini' ? 100 : id === 'yandex-live' ? 0 : id === 'yandex' ? 1 : this.rankOf(id) + 2;
  }

  /** best usable tier whose full track covers the cell */
  private trackTierFor(c: { startSec: number; durationSec: number }): ProviderId | undefined {
    let best: ProviderId | undefined;
    for (const t of this.tracks.values()) {
      if (!this.usable.has(t.tier) || !trackCovers(t, c.startSec, c.durationSec)) continue;
      if (best === undefined || this.prefRank(t.tier) < this.prefRank(best)) best = t.tier;
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
    if (!tier || this.prefRank(tier) >= this.prefRank(old)) return undefined;
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

  /** every done cell the playhead has not left far behind: swapped to the best full track now (live outranks standard outranks Gemini) */
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
    if (!ft || !vk?.startsWith('yt:')) return;
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
    const segments = raw.map((x) => (x.providerId ? x : { ...x, providerId }));
    const cell = task.chunk.startSec;
    const dur = task.chunk.durationSec;
    const ct = this.deps.video.currentTime;
    const dubSec = segments.reduce((n, x) => n + Math.max(0, x.end - x.start), 0);
    // how far the playhead already is into the cell this dub belongs to (> 0.7 of it = the scheduler will skip it)
    const intoCell = ct - cell;
    diag.log('chunk-voiced', { cell, dur, partial: !!task.chunk.partial, tier: providerId, ms, segments: segments.length, dubSec, ct, intoCell, voice });
    if (segments.length === 0) diag.log('chunk-no-speech', { cell, tier: providerId });
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
      this.segments.push(...segments);
      this.scheduler?.addSegments(segments);
      if (!this.schedStarted) {
        this.schedStarted = true;
        this.scheduler?.start();
      }
    }
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
    try {
      v.pause();
    } catch {
      return;
    }
    this.prerollActive = true;
    this.pausedByUs = true;
    const ctrl = new AbortController();
    this.prerollCtrl = ctrl;
    diag.log('preroll-pause', { ct: v.currentTime });
    (this.deps.sleep ?? defaultSleep)(PREROLL_MAX_MS, ctrl.signal).then(
      () => {
        if (gen === this.gen) this.releasePreroll('timeout');
      },
      () => {},
    );
    this.emitPreparing();
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
      onStarve: () => this.pump(),
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
