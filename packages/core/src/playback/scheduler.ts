import { diag } from '../diag';
import { Ducker } from '../ducking';
import type { DubSegment } from '../providers/types';
import { decodeDubAudio } from './decode';

/** A segment may carry a TTS speed hint; DubSegment itself does not declare it. */
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
   * A dub that arrives late starts mid-buffer. It is skipped only when at least 70% of it is gone AND less than this
   * many seconds of it remain (a late 15 s dub still covers the rest of its cell). Default 3 s.
   */
  lateTailSec?: number;
  /** dub output RMS sampling period for diag ('dub-rms'). Default 250 ms; 0 = off. */
  meterMs?: number;
}

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
  /** voiced ranges inside the buffer, buffer seconds (gaps shorter than the duck gap are bridged) */
  voiced?: Array<[number, number]>;
  logged?: Set<string>;
  /** its slot has played out and the item was retired: never re-evaluated or logged again (until a seek/replan) */
  played?: boolean;
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
}

const FADE_SEC = 0.03;
const MAX_SPEEDUP = 1.1;
const MID_START_MAX = 0.7;
const DRIFT_SEC = 0.35;
const MERGE_GAP_SEC = 1.5;
const SILENT_PEAK = 0.002;
const VOICE_FRAME_SEC = 0.05;
const METER_SAMPLE_MS = 100;
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

  private entries: Entry[] = [];
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
  /** we lowered the original and the user has not overridden it since */
  private duckedByUs = false;
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
      case 'seeked':
        this.stalled = false;
        this.replan();
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
    this.tickMs = opts.tickMs ?? 200;
    this.starveSec = opts.starveSec ?? 6;
    this.originalVolume = opts.originalVolume ?? 0.3;
    this.lateTail = opts.lateTailSec ?? 3;
    this.onStarve = opts.onStarve;
    this.master = audioCtx.createGain();
    this.master.gain.value = opts.translationVolume ?? 1;
    this.master.connect(audioCtx.destination);
    this.ducker = new Ducker(video);
    this.adaptive = opts.adaptiveDuck ?? true;
    this.duckLead = opts.duckLeadSec ?? 0.3;
    this.duckGap = opts.duckGapSec ?? 2.5;
    this.attackMs = opts.duckAttackMs ?? 80;
    this.releaseMs = opts.duckReleaseMs ?? 250;
    this.meterMs = opts.meterMs ?? 250;
    this.onDecodeError = opts.onDecodeError;
    if (this.meterMs > 0 && typeof audioCtx.createAnalyser === 'function') {
      try {
        this.analyser = audioCtx.createAnalyser();
        this.analyser.fftSize = 2048;
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

  start(): void {
    if (this.disposed || this.running) return;
    this.running = true;
    this.stalled = false;
    if (!this.adaptive) this.ducker.duck(this.originalVolume);
    for (const ev of VIDEO_EVENTS) this.video.addEventListener(ev, this.onVideoEvent);
    this.timer = setInterval(() => this.tick(), this.tickMs);
    if (this.analyser) this.meterTimer = setInterval(() => this.sampleMeter(), METER_SAMPLE_MS);
    this.lastCtxState = this.ctx.state;
    diag.log('sched-start', { ctx: this.ctx.state, vt: this.video.currentTime, paused: this.video.paused, entries: this.entries.length, adaptive: this.adaptive });
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
    this.stopAll('stop');
    this.releaseDuck('stop', 0);
  }

  setVolume(v: number): void {
    this.master.gain.value = Math.max(0, v);
  }

  /** Merged video-time ranges covered by dub segments (gaps up to 1.5 s are bridged). */
  getBuffered(): BufferedRange[] {
    const out: BufferedRange[] = [];
    for (const { seg } of this.entries) {
      const last = out[out.length - 1];
      if (last && seg.start <= last.end + MERGE_GAP_SEC) last.end = Math.max(last.end, seg.end);
      else out.push({ start: seg.start, end: seg.end });
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

  private replan(): void {
    this.stopAll('replan');
    const vt = this.video.currentTime;
    for (const e of this.entries) if (e.played && vt <= e.seg.end + this.maxLag + 2) e.played = false; // rewound into it
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
    this.updateDuck();
    this.checkStarve(vt);
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
    for (const entry of this.entries) {
      if (entry.failed || entry.silent) continue;
      const item = this.items.get(entry);
      if (item?.skipped) continue;
      // not scheduled yet although its slot is already here (undecoded late arrival, suspended context, order wait):
      // nothing is audible from it, so it must not lower the original (it may still be skipped as too late)
      if (!item && entry.seg.start - this.duckLead <= this.video.currentTime) continue;
      const dur = entry.buffer?.duration;
      let anchor = entry.seg.start;
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
        out.push([anchor, entry.seg.end]); // not decoded yet: assume the slot
      }
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
    for (const [s, e] of ivs) {
      if (s - this.duckLead <= vt && e + 0.15 >= vt) audible = true;
      else if (s > vt && s < nextStart) nextStart = s;
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
        this.ducker.duck(this.originalVolume, this.attackMs);
        diag.log('duck', { on: true, vt, user: this.ducker.userVolume, to: this.originalVolume });
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
    a.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i]! * buf[i]!;
    const rms = Math.sqrt(sum / buf.length);
    if (rms > this.meterWindow) this.meterWindow = rms;
    if (rms > this.maxRms) this.maxRms = rms;
    const t = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (t - this.meterLastLog < this.meterMs) return;
    this.meterLastLog = t;
    const vt = this.video.currentTime;
    let expect = false;
    for (const item of this.items.values()) if (!item.skipped && item.source && vt >= item.anchorV && vt <= item.endV) expect = true;
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

  private plan(): void {
    if (!this.isActive()) return;
    const vt = this.video.currentTime;
    const decodeUntil = vt + this.lookahead * 3;
    const running = this.ctx.state === 'running';
    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i]!;
      if (entry.seg.start > decodeUntil) break;
      if (this.items.has(entry)) continue;
      if (entry.played && vt > entry.seg.end + this.maxLag + 2) continue; // retired, still in the past: nothing to decide
      if (!entry.buffer && !entry.failed) {
        if (entry.seg.end + this.maxLag + 0.5 < vt) {
          if (this.mark(entry, 'past')) diag.log('seg-skip', { start: entry.seg.start, end: entry.seg.end, vt, reason: 'slot-in-the-past-undecoded', late: vt - entry.seg.end });
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
      if (entry.seg.start > vt + this.lookahead) break;
      if (!running) {
        this.ensureRunning();
        break;
      }
      this.schedule(i, entry, entry.buffer, vt);
    }
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
          start: entry.seg.start,
          end: entry.seg.end,
          dur: buffer.duration,
          peak: entry.peak,
          silent: !!entry.silent,
          voiced: entry.voiced?.map(([a, b]) => [Math.round(a * 10) / 10, Math.round(b * 10) / 10]),
          ms: typeof performance !== 'undefined' ? Math.round(performance.now() - t0) : undefined,
        });
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
    const rmsList: number[] = [];
    let peak = 0;
    for (let i = 0; i < data.length; i += frame) {
      let sum = 0;
      const end = Math.min(data.length, i + frame);
      for (let j = i; j < end; j++) {
        const v = data[j]!;
        sum += v * v;
        const av = v < 0 ? -v : v;
        if (av > peak) peak = av;
      }
      rmsList.push(Math.sqrt(sum / (end - i)));
    }
    entry.peak = peak;
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

  private schedule(index: number, entry: Entry, buffer: AudioBuffer, vt: number): void {
    const now = this.ctx.currentTime;
    const pbr = this.rate();
    const segRate = entry.rate;
    const dur = buffer.duration;
    const prev = index > 0 ? this.items.get(this.entries[index - 1]!) : undefined;
    const prevEnd = prev && !prev.skipped ? prev.endV : -Infinity;
    const startV = Math.max(entry.seg.start, prevEnd);

    let anchorV = startV;
    let offset0 = 0;
    if (startV < vt - 0.02) {
      offset0 = (vt - startV) * segRate;
      if (offset0 >= MID_START_MAX * dur && dur - offset0 < this.lateTail) {
        if (!entry.played && this.mark(entry, 'late')) diag.log('seg-skip', { start: entry.seg.start, end: entry.seg.end, vt, reason: 'late-over-70pct', late: vt - startV, dur });
        this.items.set(entry, this.skipItem(entry));
        return;
      }
      anchorV = vt;
    }
    const remaining = dur - offset0;

    // Overrun: if we would run past the next slot by more than maxLag, speed up slightly (max +10%).
    let extra = 1;
    const next = this.entries[index + 1];
    if (next) {
      const remVideo = remaining / segRate;
      const lagNext = anchorV + remVideo - next.seg.start;
      if (lagNext > this.maxLag) {
        const reduction = Math.min(lagNext - this.maxLag, remVideo * (1 - 1 / MAX_SPEEDUP));
        extra = remVideo / (remVideo - reduction);
      }
    }
    const endV = anchorV + remaining / (segRate * extra);

    const ctxStart = Math.max(now, now + (anchorV - vt) / pbr);
    const source = this.ctx.createBufferSource();
    const gain = this.ctx.createGain();
    source.buffer = buffer;
    source.playbackRate.value = pbr * segRate * extra;
    gain.gain.value = 1;
    source.connect(gain);
    gain.connect(this.master);
    source.start(ctxStart, offset0);
    this.items.set(entry, { entry, skipped: false, source, gain, ctxStart, anchorV, offset0, endV });
    diag.log('seg-play', { start: entry.seg.start, end: entry.seg.end, vt, in: ctxStart - now, offset: offset0, dur, rate: source.playbackRate.value, endV, ctx: this.ctx.state });
  }
}
