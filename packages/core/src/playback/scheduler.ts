import { devAudio, diag } from '../diag';
import { Ducker } from '../ducking';
import type { DubSegment } from '../providers/types';
import { timeStretch, STRETCH_MAX } from '../audio/timeStretch';
import { decodeDubAudio } from './decode';

/** A segment may carry a TTS speed hint; DubSegment itself does not declare it. */
/** a dub shorter than this share of its slot is reported as sped up (defect diagnostics) */
const FAST_RATIO = 0.85;
/** decoded dub peaks are scaled down to this level (below full scale, leaves headroom for the output stage) */
const PEAK_CEIL = 0.95;
/** noise gate for encoded dubs: when the quiet-part floor is above GATE_FLOOR_DB (dBFS), frames below floor + GATE_ABOVE_FLOOR_DB are cut */
const GATE_FLOOR_DB = -48;
/** encoded dubs whose high-frequency share exceeds this are low-passed (hiss) */
const HISS_HF_RATIO = 0.2;
/** devlog: how many noisy dubs were handed to the audio dump in this page */
let devDumps = 0;
const HISS_CUTOFF_HZ = 7000;
const GATE_ABOVE_FLOOR_DB = 8;
const GATE_MIN_DB = -40;
const GATE_MAX_DB = -28;

export type SchedSegment = DubSegment & { rate?: number };

export interface DubSchedulerOptions {
  /** gain of the dub voice (separate GainNode, independent of video.volume). Default 1. */
  translationVolume?: number;
  /** volume the original track is ducked to while running (D4). Default 0.3. */
  originalVolume?: number;
  /** max delay of a dub segment behind its slot when the previous one overruns. Default 1.5 s. */
  maxLagSec?: number;
  /** how far ahead (video seconds) segments are put on the AudioContext clock. Default 2. */
  lookaheadSec?: number;
  tickMs?: number;
  /** fire onStarve when covered time ends within this many video seconds. Default 6. */
  starveSec?: number;
  onStarve?: (atVideoTime: number) => void;
  /** a dub payload could not be decoded (the segment is skipped; surfaced so the UI can tell the user) */
  onDecodeError?: (info: { start: number; end: number; bytes: number; mime: string; message: string }) => void;
  /** adaptive ducking (D22). Default true. false = duck for the whole run like before. */
  adaptiveDuck?: boolean;
  /** duck only when dub starts within this many video seconds. Default 0.3. */
  duckLeadSec?: number;
  /** release the original when the next dub is further away than this. Default 2.5. */
  duckGapSec?: number;
  duckAttackMs?: number;
  duckReleaseMs?: number;
  /**
   * Continuous dubs (Yandex cell audio) and a resume after a seek / pause start mid-buffer; they are skipped only when at least 70% of
   * the dub is gone AND less than this many seconds of it remain. Default 3 s. Per-phrase dubs never start mid-buffer (see maxSlipSec).
   */
  lateTailSec?: number;
  /**
   * Per-phrase dubs (local / groq / gemini segments) NEVER lose the beginning of a phrase: a dub that is late starts NOW from offset 0
   * ("slip"), later ones follow it (glue) and are sped up to 1.25x to close the gap. A phrase that would start more than this many
   * seconds behind its slot is skipped whole ('seg-skip' reason 'late-over-slip'). Default 4 s.
   */
  maxSlipSec?: number;
  /** dub output RMS sampling period for diag ('dub-rms'). Default 250 ms; 0 = off. */
  meterMs?: number;
  /** decoded buffers of segments that ended more than this many seconds behind the playhead are released (re-decoded on a rewind). Default 20; 0 = never. */
  releaseBehindSec?: number;
  /** segments that ended more than this many seconds behind the playhead are forgotten entirely (live streams: a rewind that far is impossible). Default: never. */
  forgetBehindSec?: number;
  /**
   * Constant lag of every dub slot behind the original phrase: the segment i is heard at seg.start + dubLagSec (the whole
   * timeline is shifted, rates / overlap handling / ducking are unchanged). Gives the pipeline that much extra time and
   * reads better than a dub that starts before the phrase. 0 = off. Applied to all segments, also to Yandex cell dubs
   * (their audio is one continuous voice-over per cell that already trails the speaker). Default 0 here; the engine passes the setting.
   */
  dubLagSec?: number;
  /** fired once, when the first dub voice is put on the audio clock (time-to-first-dub diagnostics) */
  onFirstPlay?: (info: { vt: number; start: number }) => void;
  /**
   * Onset gate (never lead the original): what the ORIGINAL audio does around video time `vt` (hls: the monitor envelope of the audio the player
   * plays). `silentForSec` = how long it has been quiet up to `vt` (0 while `speaking`). undefined = no information (gate off).
   * A dub is started at its slot only if the original has produced speech energy since slot - ONSET_BACK_SEC; otherwise the start waits in
   * ONSET_STEP_MS steps until it does, at most ONSET_MAX_WAIT_SEC. Not applied to Yandex voices, to a slot that is already late, or without a probe.
   */
  onsetProbe?: (vt: number) => { speaking: boolean; silentForSec: number } | undefined;
}

/** onset gate: speech since slot - this counts as "the original has started"; poll period while a start waits; longest extra wait */
export const ONSET_BACK_SEC = 0.3;
export const ONSET_STEP_MS = 100;
export const ONSET_MAX_WAIT_SEC = 2.5;

export interface BufferedRange {
  start: number;
  end: number;
}

interface Entry {
  seg: SchedSegment;
  rate: number;
  buffer?: AudioBuffer;
  decoding?: boolean;
  failed?: boolean;
  /** decoded but (practically) silent: 'no speech', must not duck */
  silent?: boolean;
  peak?: number;
  /** samples at or above 0.999 (full scale): a clipped decode */
  clipped?: number;
  /** the decoded voice was scaled down to PEAK_CEIL */
  scaled?: boolean;
  /** the dub went through the 7 kHz low-pass (hiss) */
  lowPassed?: boolean;
  /** quietest 20% of 20 ms frames, dBFS, and their high-frequency share (encoded dubs) */
  floorDb?: number;
  hfRatio?: number;
  gated?: boolean;
  /** voiced ranges inside the buffer, buffer seconds (gaps shorter than the duck gap are bridged) */
  voiced?: Array<[number, number]>;
  logged?: Set<string>;
  /** its slot has played out and the item was retired: never re-evaluated or logged again (until a seek/replan) */
  played?: boolean;
  /** onset gate: seconds the start was postponed behind the slot (decided once per entry) */
  shift?: number;
  gateDone?: boolean;
  /** onset gate: video time at which the wait began */
  gateSince?: number;
  /** the phrase has been put on the clock (or the playhead jumped into it): a resume / seek may start mid-buffer */
  midOk?: boolean;
  /** slip: video time at which buffer position 0 was anchored (kept so a re-plan does not restart the phrase earlier) */
  slipV?: number;
  /** pitch-preserving time-stretched copies of the buffer, keyed by factor (null = stretching failed, use playbackRate) */
  stretched?: Map<number, AudioBuffer | null>;
}

interface Item {
  entry: Entry;
  skipped: boolean;
  source?: AudioBufferSourceNode;
  gain?: GainNode;
  ctxStart: number;
  /** video time at which buffer position == offset0 */
  anchorV: number;
  offset0: number;
  /** planned video-time end of this voice (including lag) */
  endV: number;
  /** the 'dub-lead' check ran for this item */
  leadChecked?: boolean;
}

const FADE_SEC = 0.03;
/** a source is never started closer to 'now' than this (output latency + the 128-sample render quantum would swallow the first samples) */
export const START_AHEAD_SEC = 0.03;
/** a dub that is already late and finds the original not ducked yet waits this long so the duck ramp is under way before the first syllable */
export const LATE_DUCK_LEAD_SEC = 0.1;
/** equal-power fade-in at the very start of a source (the TTS buffer carries >= 40 ms of silence first, so no speech is faded) */
export const FADE_IN_SEC = 0.008;
const FADE_IN_CURVE = Float32Array.from({ length: 16 }, (_, i) => Math.sin((i / 15) * (Math.PI / 2)));
/** compression above this rate is done by a pitch-preserving stretch of the buffer instead of playbackRate (which would raise the pitch) */
const STRETCH_MIN_RATE = 1.02;
/** stretch factors are rounded to this step so a re-plan reuses the cached buffer */
const STRETCH_STEP = 0.02;
/** the original stays ducked this long after the last voiced frame of the dub */
const DUCK_TAIL_SEC = 0.3;
const MAX_SPEEDUP = 1.1;
const MID_START_MAX = 0.7;
export const MAX_SLIP_SEC = 4;
/** rate cap while a slipped phrase is compressed to close the gap to the next one (D10) */
const SLIP_MAX_RATE = 1.25;
const DRIFT_SEC = 0.35;
const MERGE_GAP_SEC = 1.5;
const SILENT_PEAK = 0.002;
const VOICE_FRAME_SEC = 0.05;
const METER_SAMPLE_MS = 250;
const VIDEO_EVENTS = ['play', 'playing', 'pause', 'waiting', 'seeking', 'seeked', 'ratechange', 'ended'] as const;

/**
 * Plays dub segments on the AudioContext clock, driven by video.currentTime (invariant I3), not by
 * event order. Only reads the video (never writes currentTime/muted; D14); ducks via Ducker.
 */
export class DubScheduler {
  onStarve?: (atVideoTime: number) => void;

  private readonly video: HTMLVideoElement;
  private readonly ctx: AudioContext;
  private readonly master: GainNode;
  private readonly ducker: Ducker;
  private readonly maxLag: number;
  private readonly lookahead: number;
  private readonly tickMs: number;
  private readonly starveSec: number;
  private readonly originalVolume: number;
  private readonly lateTail: number;
  private readonly maxSlip: number;
  private readonly releaseBehind: number;
  private readonly forgetBehind: number;
  /** seconds every slot is shifted by (see DubSchedulerOptions.dubLagSec) */
  private lag = 0;

  private entries: Entry[] = [];
  private firstPlayed = false;
  private readonly onFirstPlay?: DubSchedulerOptions['onFirstPlay'];
  private items = new Map<Entry, Item>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private fadeTimers = new Set<ReturnType<typeof setTimeout>>();
  private running = false;
  private disposed = false;
  private stalled = false;
  private starveKey: string | null = null;
  private readonly adaptive: boolean;
  private readonly duckLead: number;
  private readonly duckGap: number;
  private readonly attackMs: number;
  private readonly releaseMs: number;
  private readonly meterMs: number;
  private readonly onDecodeError?: DubSchedulerOptions['onDecodeError'];
  private readonly onsetProbe?: DubSchedulerOptions['onsetProbe'];
  private gateTimer: ReturnType<typeof setInterval> | null = null;
  /** plan() stopped at an entry waiting for the onset gate: the fast timer re-plans */
  private gateWatch = false;
  /** we lowered the original and the user has not overridden it since */
  private duckedByUs = false;
  /** video time at which we ducked (diag: lead of the duck before the dub's speech) */
  private duckOnVt = 0;
  private duckTimer: ReturnType<typeof setTimeout> | null = null;
  private userOverride = false;
  private analyser?: AnalyserNode;
  private meterBuf?: Float32Array<ArrayBuffer>;
  private meterTimer: ReturnType<typeof setInterval> | null = null;
  private meterWindow = 0;
  private meterLastLog = 0;
  private meterLastBeat = 0;
  private lastCtxState = '';
  /** loudest dub output RMS seen since construction (verification) */
  maxRms = 0;

  private readonly onVideoEvent = (ev: Event): void => {
    if (!this.running) return;
    switch (ev.type) {
      case 'waiting':
      case 'seeking':
        this.stalled = true;
        this.stopAll();
        break;
      case 'pause':
      case 'ended':
        this.stopAll();
        break;
      case 'playing':
        this.stalled = false;
        this.replan();
        break;
      case 'seeked':
        this.stalled = false;
        this.replan(true);
        break;
      default: // play, ratechange
        this.replan();
    }
  };

  constructor(video: HTMLVideoElement, audioCtx: AudioContext, opts: DubSchedulerOptions = {}) {
    this.video = video;
    this.ctx = audioCtx;
    this.maxLag = opts.maxLagSec ?? 1.5;
    this.lookahead = opts.lookaheadSec ?? 2;
    this.tickMs = opts.tickMs ?? 250;
    this.starveSec = opts.starveSec ?? 6;
    this.originalVolume = opts.originalVolume ?? 0.3;
    this.lateTail = opts.lateTailSec ?? 3;
    this.maxSlip = opts.maxSlipSec ?? MAX_SLIP_SEC;
    this.releaseBehind = opts.releaseBehindSec ?? 20;
    this.forgetBehind = opts.forgetBehindSec && opts.forgetBehindSec > 0 ? opts.forgetBehindSec : Infinity;
    this.lag = Math.max(0, opts.dubLagSec ?? 0);
    this.onStarve = opts.onStarve;
    this.master = audioCtx.createGain();
    this.master.gain.value = opts.translationVolume ?? 1;
    // 0.3.2: a limiter before the speakers. Full-track Yandex audio decodes at peaks up to ~1.03 (diag 0.3.1: most segments >= 0.95),
    // and the output stage clips those samples into audible crackle; chunk voices sit near 0.7-0.8 and are not touched.
    if (typeof audioCtx.createDynamicsCompressor === 'function') {
      const limiter = audioCtx.createDynamicsCompressor();
      limiter.threshold.value = -1;
      limiter.knee.value = 0;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.1;
      this.master.connect(limiter);
      limiter.connect(audioCtx.destination);
    } else this.master.connect(audioCtx.destination);
    this.ducker = new Ducker(video);
    this.adaptive = opts.adaptiveDuck ?? true;
    this.duckLead = opts.duckLeadSec ?? 0.25;
    this.duckGap = opts.duckGapSec ?? 2.5;
    this.attackMs = opts.duckAttackMs ?? 150;
    this.releaseMs = opts.duckReleaseMs ?? 250;
    this.meterMs = opts.meterMs ?? 250;
    this.onDecodeError = opts.onDecodeError;
    this.onFirstPlay = opts.onFirstPlay;
    this.onsetProbe = opts.onsetProbe;
    if (this.meterMs > 0 && typeof audioCtx.createAnalyser === 'function') {
      try {
        this.analyser = audioCtx.createAnalyser();
        this.analyser.fftSize = 512; // diagnostics only (RMS of the dub output): a short window is plenty and cheap
        this.meterBuf = new Float32Array(new ArrayBuffer(this.analyser.fftSize * 4));
        this.master.connect(this.analyser);
      } catch {
        this.analyser = undefined;
      }
    }
    try {
      audioCtx.addEventListener?.('statechange', this.onCtxState);
    } catch {
      /* optional */
    }
  }

  private readonly onCtxState = (): void => {
    const st = this.ctx.state;
    if (st === this.lastCtxState) return;
    this.lastCtxState = st;
    diag.log('ctx-state', { state: st });
    if (this.running && st === 'running') this.replan();
  };

  /** Add segments (decoded lazily). Existing segments they overlap (re-requested chunks) are replaced. */
  addSegments(segments: DubSegment[]): void {
    if (this.disposed) return;
    for (const seg of segments) {
      const entry: Entry = { seg, rate: Math.max(0.25, (seg as SchedSegment).rate ?? 1) };
      this.entries = this.entries.filter((old) => {
        const overlap = Math.min(old.seg.end, seg.end) - Math.max(old.seg.start, seg.start);
        const shorter = Math.min(old.seg.end - old.seg.start, seg.end - seg.start);
        const dup = overlap > 0 && overlap >= 0.5 * Math.max(shorter, 1e-6);
        if (dup) {
          const item = this.items.get(old);
          if (item) {
            this.killItem(item);
            this.items.delete(old);
          }
        }
        return !dup;
      });
      this.entries.push(entry);
    }
    this.entries.sort((a, b) => a.seg.start - b.seg.start);
    diag.log('sched-add', { n: segments.length, first: segments[0]?.start, last: segments.at(-1)?.end, vt: this.video.currentTime, total: this.entries.length });
    this.plan();
  }

  /**
   * Remove every segment matching `pred` (tier switch). A voice that is playing right now is faded out over
   * `fadeSec` (default 0.3 s) instead of being cut. Returns how many segments were removed.
   */
  removeSegmentsWhere(pred: (seg: DubSegment) => boolean, opts: { fadeSec?: number; reason?: string } = {}): number {
    if (this.disposed) return 0;
    const fade = opts.fadeSec ?? 0.3;
    let n = 0;
    this.entries = this.entries.filter((e) => {
      if (!pred(e.seg)) return true;
      n++;
      const item = this.items.get(e);
      if (item) {
        this.killItem(item, opts.reason ?? 'removed', fade);
        this.items.delete(e);
      }
      return false;
    });
    if (n > 0) {
      diag.log('sched-remove', { n, reason: opts.reason, vt: this.video.currentTime, left: this.entries.length });
      this.updateDuck();
    }
    return n;
  }

  /**
   * Re-time the matching segments by `deltaSec` (slot on the video timeline += delta) without dropping them: a voice that plays
   * right now is faded out, everything else is re-planned at the new slot. Returns how many were moved.
   */
  shiftSegmentsWhere(pred: (seg: DubSegment) => boolean, deltaSec: number, opts: { reason?: string; maxPlayingMoveSec?: number } = {}): number {
    if (this.disposed || !Number.isFinite(deltaSec) || deltaSec === 0) return 0;
    let n = 0;
    const vt = this.video.currentTime;
    for (const e of this.entries) {
      if (!pred(e.seg)) continue;
      const item = this.items.get(e);
      // a voice that is audible right now is not yanked by a large estimate correction: it finishes where it is
      if (item && !item.skipped && item.source && opts.maxPlayingMoveSec !== undefined && Math.abs(deltaSec) > opts.maxPlayingMoveSec && vt >= item.anchorV - 0.05 && vt <= item.endV) continue;
      if (item) {
        this.killItem(item, opts.reason ?? 'retime', 0.2);
        this.items.delete(e);
      }
      e.seg = { ...e.seg, start: e.seg.start + deltaSec, end: e.seg.end + deltaSec };
      e.played = false;
      e.gateDone = false;
      e.shift = undefined;
      e.gateSince = undefined;
      e.logged = undefined;
      n++;
    }
    if (n > 0) {
      this.entries.sort((a, b) => a.seg.start - b.seg.start);
      diag.log('sched-retime', { n, deltaSec, reason: opts.reason, vt: this.video.currentTime });
      this.plan();
    }
    return n;
  }

  start(): void {
    if (this.disposed || this.running) return;
    this.running = true;
    this.stalled = false;
    if (!this.adaptive) this.ducker.duck(this.originalVolume);
    for (const ev of VIDEO_EVENTS) this.video.addEventListener(ev, this.onVideoEvent);
    this.timer = setInterval(() => this.tick(), this.tickMs);
    if (this.onsetProbe) this.gateTimer = setInterval(() => (this.gateWatch ? this.plan() : undefined), ONSET_STEP_MS);
    if (this.analyser) this.meterTimer = setInterval(() => this.sampleMeter(), METER_SAMPLE_MS);
    this.lastCtxState = this.ctx.state;
    diag.log('sched-start', { ctx: this.ctx.state, vt: this.video.currentTime, paused: this.video.paused, entries: this.entries.length, adaptive: this.adaptive, lag: this.lag });
    try {
      if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => {});
    } catch {
      /* resume is best effort */
    }
    this.replan();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    for (const ev of VIDEO_EVENTS) this.video.removeEventListener(ev, this.onVideoEvent);
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    if (this.meterTimer !== null) clearInterval(this.meterTimer);
    this.meterTimer = null;
    if (this.gateTimer !== null) clearInterval(this.gateTimer);
    this.gateTimer = null;
    this.gateWatch = false;
    this.stopAll('stop');
    this.releaseDuck('stop', 0);
  }

  setVolume(v: number): void {
    this.master.gain.value = Math.max(0, v);
  }

  /** slot start / end on the video timeline (segment time + the dub lag) */
  private ss(e: Entry): number {
    return e.seg.start + this.lag;
  }

  private se(e: Entry): number {
    return e.seg.end + this.lag;
  }

  /** the planned start: the slot plus the onset-gate postponement */
  private startOf(e: Entry): number {
    return this.ss(e) + (e.shift ?? 0);
  }

  /** Change the lag at runtime (settings panel): the timeline is re-planned from the playhead. */
  setDubLagSec(v: number): void {
    const lag = Math.max(0, Number.isFinite(v) ? v : 0);
    if (lag === this.lag) return;
    this.lag = lag;
    diag.log('sched-lag', { lag });
    if (this.running) this.replan();
  }

  /** Merged video-time ranges covered by dub segments (gaps up to 1.5 s are bridged). */
  getBuffered(): BufferedRange[] {
    const out: BufferedRange[] = [];
    for (const e of this.entries) {
      const start = this.ss(e);
      const end = this.se(e);
      const last = out[out.length - 1];
      if (last && start <= last.end + MERGE_GAP_SEC) last.end = Math.max(last.end, end);
      else out.push({ start, end });
    }
    return out;
  }

  dispose(): void {
    if (this.disposed) return;
    this.stop();
    this.disposed = true;
    for (const t of this.fadeTimers) clearTimeout(t);
    this.fadeTimers.clear();
    this.entries = [];
    this.items.clear();
    try {
      this.master.disconnect();
    } catch {
      /* already disconnected */
    }
    try {
      this.analyser?.disconnect();
      this.ctx.removeEventListener?.('statechange', this.onCtxState);
    } catch {
      /* ignore */
    }
    if (this.duckTimer !== null) clearTimeout(this.duckTimer);
    this.duckTimer = null;
    this.ducker.dispose();
    this.onStarve = undefined;
  }

  // ---- internals ----

  private isActive(): boolean {
    return this.running && !this.stalled && !this.video.paused && !this.video.ended;
  }

  private rate(): number {
    const r = this.video.playbackRate;
    return r > 0 ? r : 1;
  }

  private replan(seeked = false): void {
    this.stopAll('replan');
    const vt = this.video.currentTime;
    for (const e of this.entries) {
      // the playhead jumped into a phrase: the original is mid-phrase, so the dub joins mid-buffer (not a late arrival)
      if (seeked && !e.midOk && this.startOf(e) <= vt && vt < this.se(e) + (e.shift ?? 0)) e.midOk = true;
      if (e.slipV !== undefined && vt < this.startOf(e) - 0.02) e.slipV = undefined; // rewound before the slot: replayed fresh
      if (e.played && vt <= this.se(e) + this.maxLag + 2) e.played = false; // rewound into it
      if (e.gateDone && this.ss(e) > vt) {
        // the playhead is before its slot again (a seek back): the original is replayed, so the start is judged afresh
        e.gateDone = false;
        e.shift = undefined;
        e.gateSince = undefined;
      }
    }
    this.starveKey = null;
    this.plan();
    this.updateDuck();
  }

  private stopAll(reason = 'stop'): void {
    for (const item of this.items.values()) this.killItem(item, reason);
    this.items.clear();
  }

  private killItem(item: Item, reason = 'kill', fadeSec = FADE_SEC): void {
    const { source, gain } = item;
    if (!source || !gain) return;
    item.source = undefined;
    const now = this.ctx.currentTime;
    diag.log('seg-stop', { start: item.entry.seg.start, reason, vt: this.video.currentTime, fade: fadeSec });
    try {
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(gain.gain.value, now);
      gain.gain.linearRampToValueAtTime(0, now + fadeSec);
    } catch {
      /* param automation is best effort */
    }
    try {
      source.stop(now + fadeSec);
    } catch {
      /* never started / already stopped */
    }
    const t = setTimeout(() => {
      this.fadeTimers.delete(t);
      try {
        source.disconnect();
        gain.disconnect();
      } catch {
        /* ignore */
      }
    }, fadeSec * 1000 + 20);
    this.fadeTimers.add(t);
  }

  private tick(): void {
    if (!this.running) return;
    if (this.ctx.state !== 'running') this.ensureRunning();
    if (!this.isActive()) {
      if (this.items.size > 0) this.stopAll('inactive');
      return;
    }
    const vt = this.video.currentTime;
    const now = this.ctx.currentTime;
    const pbr = this.rate();
    let drifted = false;
    for (const [entry, item] of this.items) {
      if (item.skipped) continue;
      if (!item.leadChecked && item.source && now >= item.ctxStart) this.checkLead(entry, item, vt, now, pbr);
      if (vt > item.endV + 2) {
        // retire: the slot has played out. Mark it so plan() does not re-evaluate (and re-log) it at a vt past its end.
        entry.played = true;
        this.items.delete(entry);
        continue;
      }
      const ctxEnd = item.ctxStart + (item.endV - item.anchorV) / pbr;
      if (now > ctxEnd) continue;
      const drift = (now - item.ctxStart) * pbr - (vt - item.anchorV);
      if (Math.abs(drift) > DRIFT_SEC) drifted = true;
    }
    if (drifted) {
      diag.log('seg-drift', { vt });
      this.replan();
    } else this.plan();
    this.releaseOld(vt);
    this.updateDuck();
    this.checkStarve(vt);
  }

  /**
   * Diagnostic: the dub just became audible; the video time at that instant (estimated from the audio clock) must not be
   * before its slot start (>= 0.15 s of slack for the currentTime granularity). It never should be: a line here means the
   * playhead clock and the AudioContext clock disagree (stall without a 'waiting' event, currentTime jump).
   */
  private checkLead(entry: Entry, item: Item, vt: number, now: number, pbr: number): void {
    item.leadChecked = true;
    if (item.offset0 > 0) return; // started mid-buffer at the playhead: by construction not before its slot
    const vtAtStart = vt - (now - item.ctxStart) * pbr;
    const slot = this.startOf(entry);
    if (vtAtStart < slot - 0.15) {
      diag.log('dub-lead', { segStart: entry.seg.start, slot, ct: vt, ahead: Math.round((slot - vtAtStart) * 100) / 100 });
    }
  }

  /** memory: drop decoded buffers (and, when asked, whole entries) that are far behind the playhead */
  private releaseOld(vt: number): void {
    if (this.releaseBehind <= 0 && this.forgetBehind === Infinity) return;
    let forget = false;
    for (const e of this.entries) {
      const behind = vt - this.se(e);
      if (behind > this.forgetBehind) forget = true;
      if (this.releaseBehind > 0 && behind > this.releaseBehind && e.buffer && !e.decoding) {
        const item = this.items.get(e);
        if (item && !item.skipped && item.source) continue; // still sounding
        e.buffer = undefined;
        e.stretched = undefined;
        e.played = true; // plan() leaves it alone until a rewind (replan clears the flag)
      }
    }
    if (!forget) return;
    this.entries = this.entries.filter((e) => {
      if (vt - this.se(e) <= this.forgetBehind) return true;
      const item = this.items.get(e);
      if (item && !item.skipped && item.source) return true;
      this.items.delete(e);
      return false;
    });
  }

  private ensureRunning(): void {
    const st = this.ctx.state;
    if (st !== this.lastCtxState) {
      this.lastCtxState = st;
      diag.log('ctx-state', { state: st, note: 'dub waits for a running AudioContext' });
    }
    try {
      void this.ctx.resume().catch(() => {});
    } catch {
      /* resume is best effort */
    }
  }

  // ---- adaptive ducking (D22) ----

  /** Video-time intervals in which dub speech is (or will be) audible; silent / failed / skipped entries excluded. */
  private audibleIntervals(): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    let prevEnd = -Infinity; // end of the previous scheduled voice: a not-yet-scheduled phrase starts after it (glue)
    for (const entry of this.entries) {
      if (entry.failed || entry.silent) continue;
      const item = this.items.get(entry);
      if (item?.skipped) {
        prevEnd = -Infinity;
        continue;
      }
      const planned = Math.max(this.startOf(entry), entry.slipV ?? -Infinity, this.isPerPhrase(entry) ? prevEnd : -Infinity);
      // not scheduled yet although its slot is already here (undecoded late arrival, suspended context, order wait):
      // nothing is audible from it, so it must not lower the original (it may still be skipped as too late)
      if (!item && this.startOf(entry) - this.duckLead <= this.video.currentTime) continue;
      const dur = entry.buffer?.duration;
      let anchor = planned;
      let off = 0;
      let speed = entry.rate;
      if (item && !item.skipped && dur !== undefined && item.endV > item.anchorV) {
        anchor = item.anchorV;
        off = item.offset0;
        speed = (dur - off) / (item.endV - item.anchorV);
      }
      if (dur !== undefined && entry.voiced) {
        for (const [a, b] of entry.voiced) {
          if (b <= off) continue;
          out.push([anchor + (Math.max(a, off) - off) / speed, anchor + (b - off) / speed]);
        }
      } else if (dur !== undefined) {
        out.push([anchor, anchor + (dur - off) / speed]);
      } else {
        out.push([anchor, Math.max(anchor, this.se(entry) + (entry.shift ?? 0))]); // not decoded yet: assume the slot
      }
      prevEnd = item && !item.skipped ? item.endV : -Infinity;
    }
    return out;
  }

  private updateDuck(): void {
    if (!this.adaptive || !this.running || this.disposed) return;
    if (this.stalled || this.video.paused || this.video.ended) return; // nothing audible changes while stopped
    const vt = this.video.currentTime;
    const ivs = this.audibleIntervals();
    let audible = false;
    let nextStart = Infinity;
    let trigger = Infinity;
    for (const [s, e] of ivs) {
      if (s - this.duckLead <= vt && e + DUCK_TAIL_SEC >= vt) {
        audible = true;
        if (s < trigger) trigger = s;
      } else if (s > vt && s < nextStart) nextStart = s;
    }
    // the tick is coarse (250 ms): a precise timer begins the ramp exactly duckLead before the next dub's speech
    if (this.duckTimer !== null) clearTimeout(this.duckTimer);
    this.duckTimer = null;
    if (!audible && nextStart !== Infinity && !this.userOverride) {
      const wait = Math.max(0, (nextStart - this.duckLead - vt) / this.rate()) * 1000;
      if (wait < this.tickMs + 50) {
        this.duckTimer = setTimeout(() => {
          this.duckTimer = null;
          this.updateDuck();
        }, wait + 2);
      }
    }
    if (this.duckedByUs && !this.ducker.active) {
      // the user (or the site) moved the volume while we were ducking: leave it alone until the next quiet gap
      this.duckedByUs = false;
      this.userOverride = true;
      diag.log('duck', { on: false, reason: 'user-volume-change', vt });
    }
    if (audible) {
      if (!this.duckedByUs && !this.userOverride) {
        this.duckedByUs = true;
        this.duckOnVt = vt;
        this.ducker.duck(this.originalVolume, this.attackMs);
        diag.log('duck', { on: true, vt, user: this.ducker.userVolume, to: this.originalVolume, leadMs: trigger === Infinity ? undefined : Math.round((trigger - vt) * 1000), rampMs: this.attackMs });
      }
    } else if (nextStart - vt > this.duckGap) {
      this.userOverride = false;
      if (this.duckedByUs) this.releaseDuck(nextStart === Infinity ? 'no-dub-ahead' : 'gap', this.releaseMs, nextStart - vt);
    }
  }

  private releaseDuck(reason: string, rampMs: number, gap?: number): void {
    if (!this.duckedByUs && !this.ducker.active) return;
    const user = this.ducker.userVolume;
    this.duckedByUs = false;
    this.ducker.restore(rampMs);
    diag.log('duck', { on: false, reason, vt: this.video.currentTime, gap, user });
  }

  // ---- output meter (D23): RMS of the dub gain output ----

  private sampleMeter(): void {
    const a = this.analyser;
    const buf = this.meterBuf;
    if (!a || !buf) return;
    const vt = this.video.currentTime;
    let expect = false;
    let playing = false;
    for (const item of this.items.values()) {
      if (item.skipped || !item.source) continue;
      playing = true;
      if (vt >= item.anchorV && vt <= item.endV) expect = true;
    }
    // hidden tab and nothing scheduled: nobody can see the number, so skip the FFT read
    if (!playing && typeof document !== 'undefined' && document.hidden) return;
    a.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i]! * buf[i]!;
    const rms = Math.sqrt(sum / buf.length);
    if (rms > this.meterWindow) this.meterWindow = rms;
    if (rms > this.maxRms) this.maxRms = rms;
    const t = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (t - this.meterLastLog < this.meterMs) return;
    this.meterLastLog = t;
    const w = this.meterWindow;
    this.meterWindow = 0;
    const beat = t - this.meterLastBeat > 5000;
    if (w > 0.0005 || expect || beat) {
      this.meterLastBeat = t;
      diag.log('dub-rms', { rms: w, expect, vt, ctx: this.ctx.state, vol: this.video.volume, master: this.master.gain.value });
    }
  }

  private mark(entry: Entry, key: string): boolean {
    entry.logged ??= new Set();
    if (entry.logged.has(key)) return false;
    entry.logged.add(key);
    return true;
  }

  private checkStarve(vt: number): void {
    if (!this.onStarve) return;
    const range = this.getBuffered().find((r) => r.end >= vt && r.start - MERGE_GAP_SEC <= vt);
    const covered = range ? range.end : vt;
    if (covered - vt >= this.starveSec) return;
    const key = range ? `e${range.end}` : 'none';
    if (key === this.starveKey) return;
    this.starveKey = key;
    this.onStarve(covered);
  }

  /**
   * Onset gate (see DubSchedulerOptions.onsetProbe). true = hold this entry for now. Decided once per entry: it is released at its slot when
   * the original has already spoken since slot - ONSET_BACK_SEC, else when speech appears or after ONSET_MAX_WAIT_SEC (the postponement is
   * recorded in entry.shift so the voice, the ducking and the next entries' overlap handling follow the shifted start).
   */
  private gateWaits(entry: Entry, vt: number): boolean {
    if (!this.onsetProbe || entry.gateDone) return false;
    const done = (shift: number, why: string): false => {
      entry.gateDone = true;
      entry.shift = shift > 0 ? shift : undefined;
      if (shift > 0) diag.log('onset-gate', { slot: this.ss(entry), waitedSec: Math.round(shift * 100) / 100, why });
      return false;
    };
    const providerId = (entry.seg as { providerId?: string }).providerId;
    if (providerId?.startsWith('yandex')) return done(0, 'yandex');
    const slot = this.ss(entry);
    if (vt > slot + 0.1 && entry.gateSince === undefined) return done(0, 'late'); // the slot is already gone: nothing to wait for
    if (vt < slot - 0.1) return true; // not at the slot yet (the audio clock cannot be delayed once scheduled)
    let p: { speaking: boolean; silentForSec: number } | undefined;
    try {
      p = this.onsetProbe(vt);
    } catch {
      p = undefined;
    }
    if (!p) return done(entry.gateSince !== undefined ? Math.max(0, vt - slot) : 0, 'no-probe');
    const lastSpeech = p.speaking ? vt : vt - p.silentForSec;
    if (lastSpeech >= slot - ONSET_BACK_SEC) return done(entry.gateSince === undefined ? 0 : Math.max(0, vt - slot), 'speech');
    entry.gateSince ??= Math.max(vt, slot);
    const waited = Math.max(0, vt - slot);
    if (waited >= ONSET_MAX_WAIT_SEC) return done(waited, 'timeout');
    return true;
  }

  private plan(): void {
    this.gateWatch = false;
    if (!this.isActive()) return;
    const vt = this.video.currentTime;
    const decodeUntil = vt + this.lookahead * 3;
    const running = this.ctx.state === 'running';
    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i]!;
      if (this.ss(entry) > decodeUntil) break;
      if (this.items.has(entry)) continue;
      if (entry.played && vt > this.se(entry) + this.maxLag + 2) continue; // retired, still in the past: nothing to decide
      if (!entry.buffer && !entry.failed) {
        if (this.se(entry) + this.maxLag + 0.5 < vt) {
          if (this.mark(entry, 'past')) diag.log('seg-skip', { start: entry.seg.start, end: entry.seg.end, vt, reason: 'slot-in-the-past-undecoded', late: vt - this.se(entry) });
          this.items.set(entry, this.skipItem(entry));
          continue;
        }
        this.decode(entry);
      }
      if (entry.failed) {
        this.items.set(entry, this.skipItem(entry));
        continue;
      }
      if (!entry.buffer) break; // keep order: wait for this one
      if (entry.silent) {
        if (this.mark(entry, 'silent')) diag.log('seg-skip', { start: entry.seg.start, end: entry.seg.end, vt, reason: 'silent-no-speech' });
        this.items.set(entry, this.skipItem(entry));
        continue;
      }
      if (this.ss(entry) > vt + this.lookahead) break;
      if (!running) {
        this.ensureRunning();
        break;
      }
      if (this.gateWaits(entry, vt)) {
        this.gateWatch = true;
        break; // keep order: nothing starts before this one
      }
      this.schedule(i, entry, entry.buffer, vt);
    }
  }

  /** continuous Yandex cell audio is cut by cells, not by phrases: it keeps the mid-buffer start; everything else is a phrase */
  private isPerPhrase(entry: Entry): boolean {
    const id = (entry.seg as { providerId?: string }).providerId;
    return !id?.startsWith('yandex');
  }

  private skipItem(entry: Entry): Item {
    return { entry, skipped: true, ctxStart: 0, anchorV: 0, offset0: 0, endV: 0 };
  }

  private decode(entry: Entry): void {
    if (entry.decoding) return;
    entry.decoding = true;
    const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
    decodeDubAudio(this.ctx, entry.seg.audio).then(
      (buffer) => {
        entry.decoding = false;
        entry.buffer = buffer;
        this.analyze(entry, buffer);
        diag.log('dub-decoded', {
          floorDb: entry.floorDb === undefined ? undefined : Math.round(entry.floorDb * 10) / 10,
          hfRatio: entry.hfRatio === undefined ? undefined : Math.round(entry.hfRatio * 1000) / 1000,
          gated: entry.gated ? 1 : 0,
          lowPassed: entry.lowPassed ? 1 : 0,
          start: entry.seg.start,
          end: entry.seg.end,
          dur: buffer.duration,
          peak: entry.peak,
          clipped: entry.clipped,
          silent: !!entry.silent,
          voiced: entry.voiced?.map(([a, b]) => [Math.round(a * 10) / 10, Math.round(b * 10) / 10]),
          ms: typeof performance !== 'undefined' ? Math.round(performance.now() - t0) : undefined,
        });
        // defect markers for a segment (diagnostics only, the playback is unchanged): 'fast' = the voice ran shorter than its slot
        // (sped up by the provider), 'clip' = full-scale samples (the decoded audio overshoots). Owner 0.3.4: Yandex live artefacts.
        {
          const slotSec = entry.seg.end - entry.seg.start;
          const ratio = slotSec > 0 ? buffer.duration / slotSec : 1;
          const why = [ratio < FAST_RATIO ? 'fast' : '', (entry.clipped ?? 0) > 0 ? 'clip' : ''].filter(Boolean);
          if (why.length > 0) diag.log('dub-defect', { start: entry.seg.start, ratio: Math.round(ratio * 100) / 100, why: why.join(','), clipped: entry.clipped ?? 0, peak: entry.peak });
        }
        if (!this.disposed) {
          this.plan();
          this.updateDuck();
        }
      },
      (err: unknown) => {
        entry.decoding = false;
        entry.failed = true;
        const a = entry.seg.audio;
        const info = {
          start: entry.seg.start,
          end: entry.seg.end,
          bytes: a.kind === 'encoded' ? a.data.byteLength : a.samples.length * 2,
          mime: a.kind === 'encoded' ? a.mime : 'pcm',
          message: err instanceof Error ? err.message : String(err),
        };
        diag.log('dub-decode-fail', info);
        try {
          this.onDecodeError?.(info);
        } catch {
          /* observer errors never break playback */
        }
        if (!this.disposed) this.plan();
      },
    );
  }

  /** peak / silence / voiced ranges of a decoded buffer (skipped when the buffer exposes no samples) */
  private analyze(entry: Entry, buffer: AudioBuffer): void {
    let data: Float32Array;
    try {
      data = buffer.getChannelData(0);
    } catch {
      return;
    }
    if (!data || data.length === 0) return;
    const frame = Math.max(1, Math.round(buffer.sampleRate * VOICE_FRAME_SEC));
    if (entry.seg.audio?.kind === 'encoded') {
      // 0.3.6: quiet-part noise (owner: long fading hiss in Yandex live dubs). Measured first, then the gate runs on it.
      const n = noiseFloor(data, frame);
      entry.floorDb = n.floorDb;
      entry.hfRatio = n.hfRatio;
      if (devAudio.dump && devDumps < 12 && (n.hfRatio > HISS_HF_RATIO || n.floorDb > -40)) {
        devDumps++;
        devAudio.dump(`dub-${entry.seg.start}-${Math.round(n.floorDb)}`, data.slice(), buffer.sampleRate);
      }
      // 0.3.7: broadband hiss under the speech (diag 0.3.7: hfRatio 0.23-0.26 on the noisy dubs, 0.16 on clean Yandex audio):
      // a 7 kHz low-pass removes most of it; speech stays intelligible
      if (n.hfRatio > HISS_HF_RATIO) {
        lowPass(data, buffer.sampleRate, HISS_CUTOFF_HZ);
        entry.lowPassed = true;
      }
      if (n.floorDb > GATE_FLOOR_DB) {
        // 0.3.6 adaptive: the gate sits GATE_ABOVE_FLOOR_DB above the measured floor, clamped to a sane range
        // (diag 0.3.6: the 2:30 dub had floorDb -34.7 = hiss inside the Yandex audio; a fixed -55 dB gate missed it)
        const thr = Math.min(GATE_MAX_DB, Math.max(GATE_MIN_DB, n.floorDb + GATE_ABOVE_FLOOR_DB));
        applyGate(data, frame, 10 ** (thr / 20), buffer.sampleRate);
        entry.gated = true;
      }
    }
    const rmsList: number[] = [];
    let peak = 0;
    let clipped = 0;
    for (let i = 0; i < data.length; i += frame) {
      let sum = 0;
      const end = Math.min(data.length, i + frame);
      for (let j = i; j < end; j++) {
        const v = data[j]!;
        sum += v * v;
        const av = v < 0 ? -v : v;
        if (av > peak) peak = av;
        if (av >= 0.999) clipped++;
      }
      rmsList.push(Math.sqrt(sum / (end - i)));
    }
    entry.peak = peak;
    entry.clipped = clipped;
    // 0.3.5: a decoded voice that overshoots full scale (Yandex full track peaks 1.00-1.02, diag 0.3.4 'clip') is scaled to
    // PEAK_CEIL in place: the output stage would otherwise clip it into crackle. Quieter voices are not touched.
    if (peak > PEAK_CEIL) {
      const k = PEAK_CEIL / peak;
      for (let c = 0; c < buffer.numberOfChannels; c++) {
        const ch = buffer.getChannelData(c);
        for (let i = 0; i < ch.length; i++) ch[i] = ch[i]! * k;
      }
      entry.scaled = true; // diagnostics keep the raw peak / clipped count
    }
    if (peak < SILENT_PEAK) {
      entry.silent = true;
      return;
    }
    const thr = Math.max(0.002, peak * 0.03);
    const frameSec = frame / buffer.sampleRate;
    const ranges: Array<[number, number]> = [];
    for (let k = 0; k < rmsList.length; k++) {
      if (rmsList[k]! < thr) continue;
      const a = k * frameSec;
      const b = (k + 1) * frameSec;
      const last = ranges[ranges.length - 1];
      if (last && a - last[1] <= this.duckGap) last[1] = b;
      else ranges.push([a, b]);
    }
    entry.voiced = ranges;
  }

  /** stretched copy of `buffer` (cached per entry and factor), or undefined when it cannot be made */
  private stretchedBuffer(entry: Entry, buffer: AudioBuffer, factor: number): AudioBuffer | undefined {
    const key = Math.round(factor * 100);
    const cache = (entry.stretched ??= new Map());
    const hit = cache.get(key);
    if (hit !== undefined) return hit ?? undefined;
    try {
      const ch = buffer.numberOfChannels;
      const sr = buffer.sampleRate;
      if (!(ch >= 1) || !(sr > 0)) throw new Error('buffer has no channel layout');
      const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
      const outs: Float32Array[] = [];
      for (let c = 0; c < ch; c++) outs.push(timeStretch(buffer.getChannelData(c), sr, factor));
      const out = this.ctx.createBuffer(ch, Math.max(1, outs[0]!.length), sr);
      for (let c = 0; c < ch; c++) out.copyToChannel(outs[c] as Float32Array<ArrayBuffer>, c);
      cache.set(key, out);
      diag.log('dub-stretch', { start: entry.seg.start, factor, ms: typeof performance !== 'undefined' ? Math.round(performance.now() - t0) : undefined });
      return out;
    } catch (err) {
      cache.set(key, null);
      diag.log('dub-stretch-fail', { start: entry.seg.start, factor, message: err instanceof Error ? err.message : String(err) });
      return undefined;
    }
  }

  private schedule(index: number, entry: Entry, buffer: AudioBuffer, vt: number): void {
    const now = this.ctx.currentTime;
    const pbr = this.rate();
    const segRate = entry.rate;
    const dur = buffer.duration;
    const prev = index > 0 ? this.items.get(this.entries[index - 1]!) : undefined;
    const prevEnd = prev && !prev.skipped ? prev.endV : -Infinity;
    const slot = this.startOf(entry);
    const perPhrase = this.isPerPhrase(entry) && !entry.midOk;
    // per-phrase dubs also keep the position of an earlier slip (a re-plan must not restart the phrase before it)
    const startV = Math.max(slot, prevEnd, this.isPerPhrase(entry) ? (entry.slipV ?? -Infinity) : -Infinity);

    let anchorV = startV;
    let offset0 = 0;
    let slip = 0;
    if (startV < vt - 0.02) {
      if (perPhrase) {
        // never cut the beginning of a phrase: start it now from offset 0, unless it is too far behind its slot
        anchorV = vt;
      } else {
        offset0 = (vt - startV) * segRate;
        if (offset0 >= MID_START_MAX * dur && dur - offset0 < this.lateTail) {
          if (!entry.played && this.mark(entry, 'late')) diag.log('seg-skip', { start: entry.seg.start, end: entry.seg.end, vt, reason: 'late-over-70pct', late: vt - startV, dur });
          this.items.set(entry, this.skipItem(entry));
          return;
        }
        anchorV = vt;
      }
    }
    if (perPhrase) {
      slip = Math.max(0, anchorV - slot);
      if (slip > this.maxSlip + 1e-6) {
        if (!entry.played && this.mark(entry, 'late')) diag.log('seg-skip', { start: entry.seg.start, end: entry.seg.end, vt, reason: 'late-over-slip', late: slip, dur });
        this.items.set(entry, this.skipItem(entry));
        return;
      }
    }
    // never start closer to 'now' than START_AHEAD_SEC; a late dub that finds the original not ducked yet waits a little longer so the
    // duck ramp is already running at its first syllable. The anchor moves with the start (no drift), a mid-buffer start moves its offset.
    const wantAhead = slip <= 0.05 || offset0 > 0 || !this.adaptive || this.duckedByUs || this.userOverride ? START_AHEAD_SEC : LATE_DUCK_LEAD_SEC;
    let ctxStart = Math.max(now, now + (anchorV - vt) / pbr);
    if (ctxStart - now < wantAhead) {
      const d = wantAhead - (ctxStart - now);
      ctxStart = now + wantAhead;
      anchorV += d * pbr;
      if (offset0 > 0) offset0 = Math.min(offset0 + d * pbr * segRate, Math.max(0, dur - 0.01));
    }
    const remaining = dur - offset0;
    const slipped = slip > 0.05;

    // Overrun: if we would run past the next slot by more than maxLag, speed up slightly (max +10%). A slipped phrase closes the gap to
    // the next one completely, up to 1.25x (D10); what does not fit is absorbed by the next phrase (glue + its own compression / skip).
    let extra = 1;
    const next = this.entries[index + 1];
    if (next) {
      const remVideo = remaining / segRate;
      const lagNext = anchorV + remVideo - this.startOf(next);
      const tol = slipped ? 0 : this.maxLag;
      const cap = slipped ? Math.max(1, SLIP_MAX_RATE / segRate) : MAX_SPEEDUP;
      if (lagNext > tol) {
        const reduction = Math.min(lagNext - tol, remVideo * (1 - 1 / cap));
        extra = remVideo / (remVideo - reduction);
      }
    }
    // Compression: a pitch-preserving stretch of the buffer (playbackRate would shift the pitch up and make male voices childlike);
    // the video's own rate pbr still goes through playbackRate (unchanged). Any failure falls back to the old playbackRate path.
    let stretch = 1;
    let playBuf = buffer;
    if (segRate * extra > STRETCH_MIN_RATE) {
      const f = Math.min(STRETCH_MAX, Math.round((segRate * extra) / STRETCH_STEP) * STRETCH_STEP);
      const sb = this.stretchedBuffer(entry, buffer, f);
      if (sb) {
        playBuf = sb;
        stretch = f;
      }
    }
    const endV = anchorV + remaining / (stretch > 1 ? stretch : segRate * extra);

    const source = this.ctx.createBufferSource();
    const gain = this.ctx.createGain();
    source.buffer = playBuf;
    source.playbackRate.value = stretch > 1 ? pbr : pbr * segRate * extra;
    let fadeMs = FADE_IN_SEC * 1000;
    try {
      gain.gain.value = 0;
      gain.gain.setValueCurveAtTime(FADE_IN_CURVE, ctxStart, FADE_IN_SEC);
    } catch {
      gain.gain.value = 1;
      fadeMs = 0;
    }
    source.connect(gain);
    gain.connect(this.master);
    source.start(ctxStart, stretch > 1 ? offset0 / stretch : offset0); // offset0 is in original-buffer seconds
    this.items.set(entry, { entry, skipped: false, source, gain, ctxStart, anchorV, offset0, endV });
    entry.midOk = true; // from now on a resume (pause, stall, drift re-plan, rewind) may join mid-buffer
    entry.slipV = slipped ? anchorV : undefined;
    if (slipped) diag.log('seg-slip', { start: entry.seg.start, slot, slipSec: Math.round(slip * 100) / 100, rate: Math.round(segRate * extra * 1000) / 1000 });
    if (!this.firstPlayed) {
      this.firstPlayed = true;
      try {
        this.onFirstPlay?.({ vt, start: entry.seg.start });
      } catch {
        /* observers must not break playback */
      }
    }
    this.updateDuck();
    if (this.mark(entry, 'start')) {
      const v0 = entry.voiced?.[0]?.[0];
      const preRollMs = v0 === undefined ? undefined : Math.round((v0 - offset0) * 1000);
      const speed = (dur - offset0) / Math.max(1e-6, endV - anchorV);
      const onsetV = anchorV + Math.max(0, (v0 ?? 0) - offset0) / speed;
      diag.log('seg-start', {
        slot: Math.round(this.ss(entry) * 1000) / 1000,
        scheduledAhead: Math.round((ctxStart - now) * 1000),
        fadeMs,
        duckLeadMs: v0 === undefined || this.userOverride || !this.adaptive ? undefined : Math.round((onsetV - (this.duckedByUs ? this.duckOnVt : onsetV - this.duckLead)) * 1000),
        preRollMs,
        ...(offset0 > 0 ? { mid: 1 } : {}),
      });
    }
    diag.log('seg-play', { start: entry.seg.start, end: entry.seg.end, slot: this.ss(entry), ...(entry.shift ? { gated: entry.shift } : {}), vt, in: ctxStart - now, offset: offset0, dur, rate: source.playbackRate.value, ...(stretch > 1 ? { stretch } : {}), endV, ctx: this.ctx.state });
  }
}

/** 20 ms RMS frames: the quietest 20% define the floor (dBFS); hfRatio = high-frequency share (first difference) of those frames */
export function noiseFloor(data: Float32Array, frame: number): { floorDb: number; hfRatio: number } {
  const rms: number[] = [];
  const hf: number[] = [];
  for (let i = 0; i + frame <= data.length; i += frame) {
    let e = 0;
    let d = 0;
    for (let j = i; j < i + frame; j++) {
      e += data[j]! * data[j]!;
      if (j > i) d += (data[j]! - data[j - 1]!) ** 2;
    }
    rms.push(Math.sqrt(e / frame));
    hf.push(Math.sqrt(d / frame));
  }
  if (rms.length === 0) return { floorDb: -120, hfRatio: 0 };
  const order = rms.map((_, i) => i).sort((a, b) => rms[a]! - rms[b]!);
  const k = Math.max(1, Math.floor(order.length * 0.2));
  let sum = 0;
  let hfSum = 0;
  let rmsSum = 0;
  for (let q = 0; q < k; q++) {
    const i = order[q]!;
    sum += rms[i]!;
    hfSum += hf[i]!;
    rmsSum += rms[i]!;
  }
  const floor = sum / k;
  return { floorDb: 20 * Math.log10(floor + 1e-9), hfRatio: rmsSum > 0 ? hfSum / rmsSum : 0 };
}

/** gate: frames whose RMS is below `level` are scaled down to silence, with a 5 ms smoothed gain (no clicks) */
export function applyGate(data: Float32Array, frame: number, level: number, sampleRate: number): void {
  const a = Math.exp(-1 / Math.max(1, 0.005 * sampleRate));
  let g = 1;
  for (let i = 0; i < data.length; i += frame) {
    const end = Math.min(data.length, i + frame);
    let e = 0;
    for (let j = i; j < end; j++) e += data[j]! * data[j]!;
    const target = Math.sqrt(e / (end - i)) < level ? 0 : 1;
    for (let j = i; j < end; j++) {
      g = a * g + (1 - a) * target;
      data[j] = data[j]! * g;
    }
  }
}

/** four-pole low-pass (four cascaded one-pole filters, about 24 dB per octave), in place */
export function lowPass(data: Float32Array, sampleRate: number, cutoffHz: number): void {
  const al = 1 - Math.exp((-2 * Math.PI * cutoffHz) / sampleRate);
  for (let pass = 0; pass < 4; pass++) {
    let z = 0;
    for (let i = 0; i < data.length; i++) {
      z += al * (data[i]! - z);
      data[i] = z;
    }
  }
}
