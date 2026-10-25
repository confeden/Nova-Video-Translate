/**
 * Capture strategy 'hls' (twitch.tv live): downloads Twitch's own audio_only HLS rendition AHEAD of the playhead, demuxes
 * the TS (tsDemux), decodes the AAC (aac.ts) to 16 kHz mono and delivers chunks stamped on the VIDEO timeline, so the
 * engine sees an mse-like capture with real lookahead.
 *
 * The stream PTS clock is not the <video> clock: the offset (pts = videoTime + offset) is found by cross-correlating the
 * 20 Hz RMS envelope of the HLS audio with the envelope of what the element plays (monitor tap), see align.ts. Until the
 * offset is known decoded audio is only buffered; when calibration keeps failing the strategy reports `unsupported` and
 * the engine silently falls back to the realtime tap (diag 'hls-fallback', no UI) and keeps probing hls in the background.
 *
 * Twitch ad breaks: the stitched-ad segments are skipped here, but the <video> PLAYS the ad. While a break lasts (state 'ads')
 * nothing is aligned, verified or emitted and failures are not counted; when it ends the mapping is recalibrated from scratch.
 */
import type { AudioChunk } from '../../providers/types';
import { diag } from '../../diag';
import { int16ToFloat, TARGET_RATE } from '../audio';
import type { Capture, CaptureStatus } from '../index';
import { createAacDecoder, type AacDecoder } from './aac';
import { createDomAdProbe } from './adDom';
import { ALIGN_MIN_CLEAN_SEC, ALIGN_SHORT_WINDOW_SEC, alignAcceptance, correlateEnvelopes, Envelope, ENV_RATE } from './align';
import { adSummary, parseMediaPlaylist, resolveUrl, type HlsSegment, type MediaPlaylist } from './playlist';
import { fetchAudioPlaylistSession, HlsAccessError, logHlsSession, type FetchFn } from './twitchApi';
import { demuxAudio, type AdtsFrame } from './tsDemux';

export interface PcmMonitor {
  start(): Promise<void>;
  stop(): void;
  onStatus(cb: (s: CaptureStatus) => void): () => void;
}
/** builds a monitor tap of the playing element; it calls `onPcm(samples@16k, videoTimeAtBlockEnd)` */
export type PcmMonitorFactory = (onPcm: (samples: Float32Array, videoTime: number) => void) => PcmMonitor;

export interface HlsCaptureOptions {
  video: HTMLMediaElement;
  channel: string;
  fetchFn: FetchFn;
  /** audio_only media playlist URL from the preflight (refreshed by the capture) */
  mediaUrl: string;
  monitorFactory: PcmMonitorFactory;
  onStatus?: (s: CaptureStatus) => void;
  /** AAC decoder factory (tests inject a fake) */
  decoderFactory?: (first: AdtsFrame) => Promise<AacDecoder>;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  pollMs?: number;
  /**
   * "the PLAYER shows an ad now" (DOM evidence, see adDom.ts). Default: the Twitch player's ad UI around `video`. The playlist's ad
   * tags are NOT the visible state: our anonymous stream can carry ads the logged-in player never shows.
   */
  adProbe?: () => boolean;
  /** how often adProbe is polled (default ADS_DOM_POLL_MS) */
  adPollMs?: number;
  /** expiry (epoch ms) of the access token behind `mediaUrl`; undefined = unknown (the URL is then only renewed after an HTTP 401/403/404) */
  mediaExpiresAtMs?: number;
  /** last GOOD pts-videoTime offset of this channel, kept across capture restarts (default: private to this capture) */
  prior?: OffsetPrior;
  /** a new media playlist URL was obtained by the capture itself (renewal): the owner may remember it */
  onSession?: (s: { url: string; expiresAtMs?: number }) => void;
}

/** store for the last good clock offset; the owner (capture/index.ts) keeps one per channel so a restarted capture starts from it */
export interface OffsetPrior {
  get(): number | undefined;
  set(offsetSec: number | undefined): void;
}

/** DOM ad probe period / how long the DOM must stay clean before the break is over */
export const ADS_DOM_POLL_MS = 500;
export const ADS_DOM_CLEAR_MS = 1000;
/** the monitor tap (alignment aid only) is re-created this long after it reported tainted/unsupported */
export const MONITOR_RETRY_MS = 10_000;
/** an UNALIGNED capture whose monitor stays down this long gives up (an aligned one keeps its constant offset) */
export const MONITOR_DOWN_GIVE_UP_MS = 90_000;

/**
 * The token / usher session is NOT refreshed on a timer (every new anonymous usher session may open with a preroll ad: the report of
 * 2026-10-25 showed outages + re-alignment after each 4 min refresh and watchdog restart). It is renewed only this long before the token's
 * own expiry, or after HTTP 401/403/404 of the media playlist.
 */
export const HLS_TOKEN_EXPIRY_MARGIN_MS = 90_000;
/** a failed renewal is retried this long later */
export const HLS_REFRESH_RETRY_MS = 20_000;
/** a playlist gap (stitched ad segments skipped) is considered running this long after the last skipped ad segment */
export const GAP_HOLD_MS = 10_000;
/** with a prior offset: the narrow check accepts a candidate within +-PRIOR_RANGE_SEC when the peak reaches PRIOR_MIN_PEAK, after this much clean audio */
export const PRIOR_RANGE_SEC = 0.5;
export const PRIOR_MIN_PEAK = 0.6;
export const PRIOR_MIN_CLEAN_SEC = 4;
export const PRIOR_ERR_BOUND_SEC = 0.5;
/** onset probe: how far back the silence is measured, and the speech-energy threshold relative to the recent loud level */
export const ONSET_LOOKBACK_SEC = 4;
export const ONSET_REL_THRESHOLD = 0.3;
export const ONSET_ABS_MIN_RMS = 0.003;
export const HLS_HISTORY_SEC = 100;
export const ALIGN_RANGE_SEC = 40;
export const ALIGN_WINDOW_SEC = 20;
/** the initial alignment uses all video envelope available up to this long (music-heavy streams need more to be distinctive) */
export const ALIGN_WINDOW_MAX_SEC = 30;
/** relaxed acceptance of the initial alignment: peak >= 0.4 that stands out of the runner-up by 1.4x */
export const ALIGN_RELAXED_PEAK = 0.4;
export const ALIGN_MIN_RATIO = 1.4;
/** failed alignment tries (outside ads / settling) before the strategy reports 'align-failed' */
export const ALIGN_GIVE_UP_FAILS = 10;
/**
 * consecutive polls (that brought new segments) whose NEWEST segments are ads before the break is declared / consecutive polls
 * whose newest segments are clean before it ends. An ad flag anywhere else in the window (finished break, stale DATERANGE) counts for nothing.
 */
export const ADS_ENTER_POLLS = 3;
export const ADS_EXIT_POLLS = 2;
/** how long after our own live-delay seek the next backwards jump of the video clock is taken for that seek */
export const OWN_SEEK_WINDOW_MS = 6_000;
/** after an ad break the player may still be playing its tail (it trails the live edge by its buffer): failures are not counted for this long */
export const ADS_SETTLE_MS = 45_000;
export const ALIGN_MIN_VIDEO_SEC = 12;
export const ALIGN_GIVE_UP_VIDEO_SEC = 60;
export const VERIFY_EVERY_MS = 60_000;
/** incremental search: one correlation try per poll once ALIGN_MIN_CLEAN_SEC of clean overlap exist */
export const ALIGN_TRY_EVERY_MS = 900;
/** clean (ad-free, post-seek) monitor audio needed before a PROVISIONAL offset lets chunks flow */
export const PROVISIONAL_AFTER_CLEAN_SEC = 8;
/** the player trails the newest playlist segment by about one segment */
export const PROVISIONAL_PLAYER_LAG_SEC = 2;
export const PROVISIONAL_ERR_BOUND_SEC = 3;
/** monitor audio this close after an ad break's end still counts as ad (splice crossfade) */
export const AD_TAIL_MARGIN_SEC = 0.5;
/** a real alignment moving the slots of provisional dubs by more than this re-times them */
export const RETIME_MIN_SEC = 1.5;
const MAX_POLL_ERRORS = 8;

interface Seg {
  pts: number;
  pcm: Int16Array;
  seq: number;
}

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });

export class HlsCapture implements Capture {
  readonly kind = 'hls' as const;
  private readonly cbs = new Set<(c: AudioChunk) => void>();
  private readonly hlsEnv = new Envelope(ENV_RATE * 240);
  private videoEnv = new Envelope(ENV_RATE * 240);
  private history: Seg[] = [];
  private monitor?: PcmMonitor;
  private decoder?: AacDecoder;
  private ctrl?: AbortController;
  private running = false;
  private failed = false;
  private mediaUrl: string;
  private tokenAt: number;
  private expiresAtMs: number | undefined;
  private refreshRetryAt = 0;
  private readonly priorStore: OffsetPrior;
  private lastPriorTry = 0;
  /** the provisional offset in use comes from the prior (not from the buffer formula) */
  private provisionalFromPrior = false;
  private gapEpisodes = 0;
  private lastGapAt = -Infinity;
  private lastSeq = -1;
  private nextPts: number | undefined;
  private newestPtsEnd = 0;
  private fromSec = 0;
  private offsetSec: number | undefined;
  private aligned = false;
  private lastAlignTry = 0;
  private lastVerify = 0;
  private verifyFails = 0;
  private videoMax = -Infinity;
  private seekPending = false;
  /** a seek moved the playhead back inside the buffer: the mapping is expected to hold but is checked on the first fresh audio */
  private suspect = false;
  /** a larger (= EARLIER slots) offset seen once by a re-verification, waiting for a second agreeing one */
  private pendingOffset: number | undefined;
  private pollErrors = 0;
  /** our own live-delay seek was announced at this time (noteOwnSeek): the next backwards clock jump is it */
  private ownSeekAt = -Infinity;
  /** the PLAYER shows an ad (DOM evidence); drives status and suspension */
  private inAds = false;
  /** the playlist's newest segments are ads (informational: only a 'gap' unless the DOM agrees) */
  private playlistAd = false;
  private domClearSince: number | undefined;
  private adTimer?: ReturnType<typeof setInterval>;
  private readonly adProbe: () => boolean;
  private monitorDownAt: number | undefined;
  private monitorTimer?: ReturnType<typeof setTimeout>;
  private adStreak = 0;
  private cleanStreak = 0;
  /** first sequence number seen in the clean polls that ended the break (segments before it are ad-era history) */
  private firstCleanSeq = -1;
  private settleUntil = 0;
  private alignFails = 0;
  /** video-time ranges occupied by finished ad breaks (the monitor tap's samples inside them are never recorded) */
  private adRegions: Array<[number, number]> = [];
  /** video time at which the current / candidate ad break began (the newest video sample when the playlist first showed ads) */
  private adStartVt: number | undefined;
  /** the first clean segment's pts after the latest break (refines the break's video end once the clock is aligned) */
  private cleanPts: number | undefined;
  /** chunks flow under a provisional offset (offsetSec set, aligned false) */
  private provisional = false;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;

  constructor(private readonly o: HlsCaptureOptions) {
    this.mediaUrl = o.mediaUrl;
    this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? defaultSleep;
    this.tokenAt = this.now();
    this.expiresAtMs = o.mediaExpiresAtMs;
    let own: number | undefined;
    this.priorStore = o.prior ?? { get: () => own, set: (v) => void (own = v) };
    this.adProbe = o.adProbe ?? createDomAdProbe(o.video);
  }

  /** current calibration (tests / diagnostics) */
  state(): { aligned: boolean; offsetSec: number | undefined; historySec: number; newestPtsEnd: number; inAds: boolean; provisional: boolean } {
    return { provisional: this.provisional, inAds: this.inAds, aligned: this.aligned, offsetSec: this.offsetSec, historySec: this.history.reduce((a, s) => a + s.pcm.length / TARGET_RATE, 0), newestPtsEnd: this.newestPtsEnd };
  }

  /** a playlist gap runs now (the anonymous playlist carries stitched-ad segments): no content audio from our stream, but the capture is healthy */
  inGap(): boolean {
    return this.playlistAd || this.now() - this.lastGapAt < GAP_HOLD_MS;
  }

  /** number of playlist gap episodes seen (diag 'health') */
  gapCount(): number {
    return this.gapEpisodes;
  }

  /**
   * Restart the poller WITHOUT a new token / usher session: the media playlist URL (and the clock offset when aligned) stay, the
   * playlist window is re-read from scratch. Used by the watchdog instead of a full capture restart.
   */
  softRestart(why: string): void {
    if (!this.running || this.failed) return;
    diag.log('hls-soft-restart', { why, aligned: this.aligned, offsetSec: this.offsetSec });
    this.ctrl?.abort();
    this.ctrl = new AbortController();
    this.lastSeq = -1;
    this.nextPts = undefined;
    this.pollErrors = 0;
    void this.loop(this.ctrl.signal);
  }

  /**
   * What the original audio did around video time `vt` (from the monitor tap = the audio the player actually plays): `speaking` = speech
   * energy at `vt`; `silentForSec` = how long it has been quiet up to `vt` (0 while speaking, capped at ONSET_LOOKBACK_SEC). undefined
   * when the monitor has no fresh data (down, ad, stale). Speech energy = RMS above ONSET_REL_THRESHOLD of the recent loud level.
   */
  onsetProbe(vt: number): { speaking: boolean; silentForSec: number } | undefined {
    if (!this.running || this.monitorDownAt !== undefined || this.inAds) return undefined;
    const env = this.videoEnv;
    const span = env.span();
    if (!span) return undefined;
    const b0 = Math.floor(vt * ENV_RATE);
    if (span[1] < b0 - ENV_RATE * 0.6 || span[0] > b0) return undefined;
    // recent loud level: 80th percentile of the last 20 s
    const lvl: number[] = [];
    for (let b = b0 - ENV_RATE * 20; b <= b0; b++) {
      const x = env.at(b);
      if (!Number.isNaN(x)) lvl.push(x);
    }
    if (lvl.length < ENV_RATE * 2) return undefined;
    lvl.sort((a, b) => a - b);
    const thr = Math.max(ONSET_ABS_MIN_RMS, ONSET_REL_THRESHOLD * lvl[Math.floor(lvl.length * 0.8)]!);
    let missing = 0;
    for (let k = 0; k <= ENV_RATE * ONSET_LOOKBACK_SEC; k++) {
      const x = env.at(b0 - k);
      if (Number.isNaN(x)) {
        if (k < ENV_RATE) missing++;
        continue;
      }
      if (x >= thr) return { speaking: k <= 4, silentForSec: k / ENV_RATE };
    }
    if (missing > ENV_RATE * 0.5) return undefined;
    return { speaking: false, silentForSec: ONSET_LOOKBACK_SEC };
  }

  onChunk(cb: (c: AudioChunk) => void): () => void {
    this.cbs.add(cb);
    return () => this.cbs.delete(cb);
  }

  async start(fromSec: number): Promise<void> {
    this.fromSec = fromSec;
    if (this.running) {
      // a restart inside a running capture (own live-delay seek): re-deliver what is already decoded
      this.replayHistory();
      return;
    }
    this.running = true;
    this.ctrl = new AbortController();
    this.startMonitor();
    const v = this.o.video;
    const onSeeking = (): void => {
      this.seekPending = true;
    };
    v.addEventListener('seeking', onSeeking);
    this.cleanup.push(() => v.removeEventListener('seeking', onSeeking));
    this.adTimer = setInterval(() => this.tickAdProbe(), this.o.adPollMs ?? ADS_DOM_POLL_MS);
    void this.loop(this.ctrl.signal);
  }

  /**
   * The monitor tap is ONLY an alignment aid. When it reports tainted / unsupported (silence while the element is waiting or seeking
   * is a known false positive) the capture does NOT give up: the last offset is constant and keeps working, verification pauses and the
   * tap is re-created after MONITOR_RETRY_MS. An unaligned capture gives up only after MONITOR_DOWN_GIVE_UP_MS without a monitor.
   */
  private startMonitor(): void {
    if (!this.running || this.failed) return;
    const mon: PcmMonitor = this.o.monitorFactory((s, vt) => {
      if (this.monitorDownAt !== undefined && mon === this.monitor) {
        diag.log('hls-monitor-up', { downSec: Math.round((this.now() - this.monitorDownAt) / 100) / 10 });
        this.monitorDownAt = undefined;
      }
      this.onVideoPcm(s, vt);
    });
    this.monitor = mon;
    mon.onStatus((st) => {
      if (mon !== this.monitor) return;
      if (st.type === 'tainted') this.monitorDown('tainted');
      else if (st.type === 'unsupported') this.monitorDown('unsupported: ' + st.reason);
    });
    void mon.start().catch((e) => {
      if (mon === this.monitor) this.monitorDown('start: ' + String(e));
    });
  }

  private monitorDown(why: string): void {
    if (!this.running || this.failed) return;
    this.monitorDownAt ??= this.now();
    diag.log('hls-monitor-down', { why: why.slice(0, 80), aligned: this.aligned, offsetSec: this.offsetSec });
    try {
      this.monitor?.stop();
    } catch {
      /* already stopped */
    }
    this.monitor = undefined;
    clearTimeout(this.monitorTimer);
    this.monitorTimer = setTimeout(() => this.startMonitor(), MONITOR_RETRY_MS);
  }

  private cleanup: Array<() => void> = [];

  stop(): void {
    this.running = false;
    clearInterval(this.adTimer);
    this.adTimer = undefined;
    clearTimeout(this.monitorTimer);
    this.monitorTimer = undefined;
    this.ctrl?.abort();
    this.monitor?.stop();
    this.monitor = undefined;
    this.cleanup.forEach((f) => f());
    this.cleanup = [];
    this.decoder?.close();
    this.decoder = undefined;
    this.history = [];
    this.hlsEnv.clear();
    this.videoEnv.clear();
  }

  private fail(reason: string, detail?: string): void {
    if (this.failed || !this.running) return;
    this.failed = true;
    diag.log('hls-fallback', { reason, detail: detail?.slice(0, 100) });
    this.o.onStatus?.({ type: 'unsupported', reason });
  }

  // ---- video side ----

  private onVideoPcm(samples: Float32Array, vt: number): void {
    // the element's clock jumped back without a seek we saw (Twitch pause/resume rebuilds the buffer at 0): old mapping is void
    const backJump = vt < this.videoMax - 1.5 || (vt < 3 && this.videoMax > 30);
    // Twitch rebuilds its buffer at ~0 (a new MSE timeline: the old mapping is void even though a 'seeking' event may have fired)
    const rebuilt = backJump && vt < 1 && this.videoMax > 10;
    const own = backJump && !rebuilt && this.now() - this.ownSeekAt < OWN_SEEK_WINDOW_MS;
    const blockStart = vt - samples.length / TARGET_RATE;
    if (own) {
      // OUR live-delay seek back by N: the media timeline of an MSE player does not change when the playhead moves inside the
      // buffer, so pts = videoTime + offset still holds EXACTLY (offset unchanged; only currentTime dropped by N). Nothing is
      // cleared or re-measured: the envelope is keyed by video time and still describes the same content, and the chunks already
      // delivered stay valid. A background verification follows after ~20 s (not blocking anything).
      this.ownSeekAt = -Infinity;
      // the monitor samples recorded before the seek instant that cover the replayed range are dropped: the replay is recorded afresh
      // (clean, and without the ad / pre-seek audio that used to pollute the correlation window)
      this.videoEnv.clearFrom(blockStart);
      this.lastVerify = this.now() - VERIFY_EVERY_MS + 20_000;
      diag.log('hls-own-seek', { aligned: this.aligned, offsetSec: this.offsetSec, jumpSec: Math.round((this.videoMax - vt) * 10) / 10 });
    } else if (backJump && (!this.seekPending || rebuilt)) this.recalibrate('player-reset');
    else if (backJump) {
      // a seek back inside the buffer (own live-delay seek, user): the media timeline is unchanged, so the mapping should hold;
      // the old envelope is dropped and the mapping is re-checked on the first fresh audio (alignStep, `suspect`)
      this.videoEnv.clear();
      this.suspect = true;
    }
    this.seekPending = false;
    if (backJump) this.videoMax = -Infinity;
    // ad audio (the <video> plays the ad, the HLS audio rendition does not contain it) is never recorded: it can only pollute the match
    if (!this.inAds && !this.inAdRegion(blockStart, vt)) this.videoEnv.add(samples, TARGET_RATE, blockStart);
    if (vt > this.videoMax) this.videoMax = vt;
  }

  private inAdRegion(a: number, b: number): boolean {
    for (const [s, e] of this.adRegions) if (a < e && b > s) return true;
    return false;
  }

  /** video time where the latest ad break ended (Infinity while one runs), undefined when none was seen on this timeline */
  adEndSec(): number | undefined {
    if (this.inAds) return Infinity;
    let end: number | undefined;
    for (const [, e] of this.adRegions) if (end === undefined || e > end) end = e;
    return end;
  }

  private recalibrate(why: string): void {
    if (this.aligned) diag.log('hls-align', { ok: false, why, offsetSec: this.offsetSec });
    this.aligned = false;
    this.offsetSec = undefined;
    this.verifyFails = 0;
    this.suspect = false;
    this.pendingOffset = undefined;
    this.provisional = false;
    this.provisionalFromPrior = false;
    this.videoEnv.clear();
    this.videoMax = -Infinity;
    this.lastAlignTry = 0;
    // the remembered offset describes one video timeline without ad splices: a player reset, an ad break or a failed re-verification voids it
    if (why === 'player-reset' || why === 'engine-reset' || why === 'ads-end' || why === 'verify-failed' || why === 'seek-verify-failed') this.priorStore.set(undefined);
    // a new video timeline: ad ranges recorded on the old one mean nothing (an ad-end recalibration keeps them)
    if (why === 'player-reset' || why === 'engine-reset') {
      this.adRegions = [];
      this.adStartVt = undefined;
    }
  }

  /** the live-delay controller is about to move the playhead back itself (called BEFORE the seek, see onVideoPcm) */
  noteOwnSeek(): void {
    if (this.running) this.ownSeekAt = this.now();
  }

  /** the engine saw the player rebuild its timeline (ct jumped to ~0): every video-time mapping is void until re-aligned */
  invalidateClock(why: string): void {
    if (!this.running) return;
    this.recalibrate(why);
  }

  // ---- hls side ----

  private async loop(signal: AbortSignal): Promise<void> {
    try {
      await this.pollOnce(signal);
    } catch {
      /* counted inside */
    }
    while (this.running && !signal.aborted && !this.failed) {
      await this.sleep(this.o.pollMs ?? 1000, signal);
      if (!this.running || signal.aborted || this.failed) break;
      try {
        await this.pollOnce(signal);
      } catch {
        /* counted inside */
      }
    }
  }

  /** one playlist poll + download/decode of new segments + alignment step. Exposed for tests. */
  async pollOnce(signal: AbortSignal = this.ctrl?.signal ?? new AbortController().signal): Promise<number> {
    let n = 0;
    try {
      if (this.expiresAtMs !== undefined && this.now() >= this.expiresAtMs - HLS_TOKEN_EXPIRY_MARGIN_MS && this.now() >= this.refreshRetryAt) await this.refreshUrl(signal, 'expiry');
      const res = await this.o.fetchFn(this.mediaUrl, { signal, credentials: 'omit' });
      if (res.status === 401 || res.status === 403 || res.status === 404) {
        await this.refreshUrl(signal, `http-${res.status}`);
        throw new Error(`playlist ${res.status}`);
      }
      if (!res.ok) throw new Error(`playlist ${res.status}`);
      const pl = parseMediaPlaylist(await res.text());
      const fresh = pl.segments.filter((s) => s.seq > this.lastSeq);
      if (fresh.length > 0) this.lastSeq = fresh[fresh.length - 1]!.seq;
      const usable = fresh.filter((s) => !s.ad);
      if (fresh.length > usable.length) {
        // ad segments of OUR stream are never decoded. If the player shows no ad this is only a 'gap' (the content clock is
        // continuous, the offset unchanged): expect a PTS jump to the next content segment without treating it as a re-base.
        const skipped = fresh.filter((s) => s.ad);
        if (!this.inAds) {
          const t = this.now();
          if (t - this.lastGapAt > GAP_HOLD_MS) this.gapEpisodes++;
          this.lastGapAt = t;
          diag.log('hls-gap', { segments: skipped.length, sec: Math.round(skipped.reduce((a, s) => a + s.duration, 0) * 10) / 10 });
          this.nextPts = undefined;
        } else diag.log('hls-ads', { skipped: skipped.length });
      }
      if (fresh.length > 0) this.trackAds(pl);
      n = await this.ingest(usable, signal);
      this.pollErrors = 0;
    } catch (e) {
      if (signal.aborted) return n;
      if (++this.pollErrors >= MAX_POLL_ERRORS) {
        const reason = e instanceof HlsAccessError ? e.reason : 'poll';
        this.fail(reason, (e as Error)?.message);
      }
    }
    this.alignStep();
    return n;
  }

  /**
   * Playlist evidence (informational only): the newest segments are ads in OUR anonymous stream. It never drives the visible state;
   * the player's own DOM does (tickAdProbe). Logged on every change together with the DOM evidence.
   */
  private trackAds(pl: MediaPlaylist): void {
    const a = adSummary(pl);
    const was = this.playlistAd;
    this.playlistAd = a.newestIsAd;
    const first = pl.segments[0]?.seq ?? 0;
    if (!a.newestIsAd && this.cleanStreak === 0) this.firstCleanSeq = a.lastAdSeq >= 0 ? a.lastAdSeq + 1 : first;
    if (!a.newestIsAd) this.cleanStreak++;
    else this.cleanStreak = 0;
    if (was !== a.newestIsAd) this.logAdState('playlist-changed', { adSegs: a.adSegs, dateRange: pl.adRanges.join(' ; ').slice(0, 160), window: pl.segments.length });
  }

  private logAdState(why: string, extra: Record<string, unknown> = {}): void {
    diag.log('hls-ad-state', { domAd: this.inAds, playlistAd: this.playlistAd, why, ...extra });
  }

  /** the player shows an ad right now (DOM). Public for tests; polled every ADS_DOM_POLL_MS. */
  tickAdProbe(): void {
    if (!this.running || this.failed) return;
    let dom = false;
    try {
      dom = this.adProbe();
    } catch {
      dom = false;
    }
    const t = this.now();
    if (dom) {
      this.domClearSince = undefined;
      if (!this.inAds) this.enterAds();
    } else if (this.inAds) {
      this.domClearSince ??= t;
      if (t - this.domClearSince >= ADS_DOM_CLEAR_MS) this.exitAds();
    }
  }

  private enterAds(): void {
    this.inAds = true;
    this.cleanStreak = 0;
    this.adStartVt = Number.isFinite(this.videoMax) ? this.videoMax - 1 : undefined;
    // what the monitor recorded in the last second may already be ad audio
    if (this.adStartVt !== undefined) this.videoEnv.clearFrom(this.adStartVt);
    this.logAdState('player-shows-ad');
    this.o.onStatus?.({ type: 'ads', active: true });
  }

  private exitAds(): void {
    this.inAds = false;
    this.domClearSince = undefined;
    // everything decoded before the break belongs to the old mapping: keep only the post-break segments if the playlist saw ads too
    if (this.firstCleanSeq >= 0) this.history = this.history.filter((x) => x.seq >= this.firstCleanSeq);
    const endVt = this.videoMax;
    this.recalibrate('ads-end');
    const start = this.adStartVt ?? endVt;
    if (Number.isFinite(start) && Number.isFinite(endVt)) {
      this.adRegions.push([start, endVt + AD_TAIL_MARGIN_SEC]);
      if (this.adRegions.length > 8) this.adRegions.shift();
    }
    this.adStartVt = undefined;
    this.cleanPts = this.history[0]?.pts;
    this.alignFails = 0;
    this.settleUntil = this.now() + ADS_SETTLE_MS;
    this.logAdState('player-ad-over', { keptSegs: this.history.length });
    this.o.onStatus?.({ type: 'ads', active: false });
  }

  private async refreshUrl(signal: AbortSignal, reason: string): Promise<void> {
    try {
      const age = (this.now() - this.tokenAt) / 1000;
      const sess = await fetchAudioPlaylistSession(this.o.channel, this.o.fetchFn, signal);
      this.mediaUrl = sess.url;
      this.expiresAtMs = sess.expiresAtMs;
      this.tokenAt = this.now();
      logHlsSession(reason, age, sess.expiresAtMs, this.now());
      this.o.onSession?.({ url: sess.url, expiresAtMs: sess.expiresAtMs });
    } catch (e) {
      this.refreshRetryAt = this.now() + HLS_REFRESH_RETRY_MS;
      if (e instanceof HlsAccessError && (e.reason === 'offline' || e.reason === 'forbidden') && this.pollErrors >= 2) this.fail(e.reason, e.message);
    }
  }

  private async ingest(list: HlsSegment[], signal: AbortSignal): Promise<number> {
    let done = 0;
    for (let i = 0; i < list.length; i += 3) {
      const batch = list.slice(i, i + 3);
      const bytes = await Promise.all(
        batch.map(async (s) => {
          const r = await this.o.fetchFn(resolveUrl(this.mediaUrl, s.uri), { signal, credentials: 'omit' });
          if (!r.ok) throw new Error(`segment ${r.status}`);
          return new Uint8Array(await r.arrayBuffer());
        }),
      );
      for (let k = 0; k < batch.length; k++) {
        if (signal.aborted) return done;
        if (await this.processSegment(batch[k]!, bytes[k]!)) done++;
      }
    }
    return done;
  }

  private async processSegment(seg: HlsSegment, ts: Uint8Array): Promise<boolean> {
    const d = demuxAudio(ts);
    if (d.frames.length === 0) {
      diag.log('hls-empty-seg', { seq: seg.seq, packets: d.packets, bad: d.badPackets });
      return false;
    }
    const first = d.frames[0]!;
    this.decoder ??= await (this.o.decoderFactory ?? createAacDecoder)(first);
    const pcm = await this.decoder.decode(d.frames);
    if (pcm.length === 0) return false;
    const dur = pcm.length / TARGET_RATE;
    // PTS jump between consecutive segments: the timeline was re-based (ad splice, restart) -> the offset is void
    if (this.nextPts !== undefined && Math.abs(first.pts - this.nextPts) > 1.5) {
      diag.log('hls-discont', { expected: this.nextPts, got: first.pts });
      this.priorStore.set(undefined);
      this.aligned = false;
      this.provisional = false;
      this.provisionalFromPrior = false;
      this.offsetSec = undefined;
      this.history = [];
      this.lastAlignTry = 0;
    }
    this.nextPts = first.pts + dur;
    this.newestPtsEnd = first.pts + dur;
    this.hlsEnv.add(int16ToFloat(pcm), TARGET_RATE, first.pts);
    const s: Seg = { pts: first.pts, pcm, seq: seg.seq };
    this.history.push(s);
    this.trimHistory();
    if ((this.aligned || this.provisional) && this.offsetSec !== undefined && !this.inAds) this.emit(s);
    return true;
  }

  private trimHistory(): void {
    let total = 0;
    for (let i = this.history.length - 1; i >= 0; i--) {
      total += this.history[i]!.pcm.length / TARGET_RATE;
      if (total > HLS_HISTORY_SEC) {
        this.history.splice(0, i);
        break;
      }
    }
  }

  private emit(s: Seg): void {
    if (this.offsetSec === undefined) return;
    const startSec = s.pts - this.offsetSec;
    const durationSec = s.pcm.length / TARGET_RATE;
    if (startSec + durationSec <= this.fromSec) return;
    const chunk: AudioChunk = { startSec, durationSec, sampleRate: TARGET_RATE, pcm: s.pcm, ...(this.provisional && !this.aligned ? { provisional: true } : {}) };
    this.cbs.forEach((f) => f(chunk));
  }

  private replayHistory(): void {
    if ((!this.aligned && !this.provisional) || this.inAds) return;
    for (const s of this.history) this.emit(s);
  }

  // ---- alignment ----

  private videoSeconds(): number {
    return this.videoEnv.size / ENV_RATE;
  }

  /** calibration / re-verification, called after every poll. Exposed through pollOnce. */
  alignStep(): void {
    if (!this.running || this.failed || this.inAds) return;
    const t = this.now();
    if (this.monitorDownAt !== undefined) {
      // no monitor audio: an aligned capture keeps its constant offset (verification waits), an unaligned one cannot calibrate
      if (!this.aligned && !this.provisional && t - this.monitorDownAt > MONITOR_DOWN_GIVE_UP_MS) this.fail('tainted', 'monitor tap down');
      return;
    }
    if (!this.aligned) {
      const vmax = this.videoMax;
      // incremental search: only CLEAN monitor audio (no ads, nothing from before an own seek) lives in videoEnv, so a short window is enough
      const from = vmax - ALIGN_WINDOW_MAX_SEC;
      const cleanSec = this.videoEnv.count(from, vmax) / ENV_RATE;
      const prior = this.priorStore.get();
      // a remembered good offset (capture restart on the same timeline): chunks flow under it at once, no buffer-formula guess
      if (prior !== undefined && !this.provisional && this.newestPtsEnd > 0 && this.hlsEnv.size >= ENV_RATE * 4) this.provisionalFromPriorStart(prior, cleanSec);
      if (prior !== undefined && cleanSec >= PRIOR_MIN_CLEAN_SEC && this.hlsEnv.size >= ENV_RATE * 8 && t - this.lastPriorTry >= ALIGN_TRY_EVERY_MS) {
        this.lastPriorTry = t;
        const pr = correlateEnvelopes(this.videoEnv, this.hlsEnv, {
          fromSec: from,
          toSec: vmax,
          centerSec: prior,
          rangeSec: PRIOR_RANGE_SEC,
          minOverlapSec: PRIOR_MIN_CLEAN_SEC * 0.85,
          minPeak: PRIOR_MIN_PEAK,
          minMargin: 0,
        });
        diag.log('hls-align', { offsetSec: Math.round(pr.offsetSec * 100) / 100, peak: Math.round(pr.peak * 100) / 100, ok: pr.ok, prior: Math.round(prior * 100) / 100, cleanSec: Math.round(cleanSec * 10) / 10 });
        if (pr.ok) return this.acceptAlignment(pr, 'prior');
        // 12 s of clean audio and still no agreement within +-0.5 s: the remembered offset is stale, the wide search decides alone
        if (cleanSec >= ALIGN_SHORT_WINDOW_SEC) this.priorStore.set(undefined);
      }
      if (cleanSec < ALIGN_MIN_CLEAN_SEC || this.hlsEnv.size < ENV_RATE * 8) return;
      if (t - this.lastAlignTry < ALIGN_TRY_EVERY_MS) return this.maybeProvisional(cleanSec);
      this.lastAlignTry = t;
      const res = correlateEnvelopes(this.videoEnv, this.hlsEnv, {
        fromSec: from,
        toSec: vmax,
        centerSec: this.newestPtsEnd - vmax - 15,
        rangeSec: ALIGN_RANGE_SEC,
        minOverlapSec: ALIGN_MIN_CLEAN_SEC * 0.9,
        ...alignAcceptance(cleanSec),
      });
      const settling = t < this.settleUntil;
      diag.log('hls-align', {
        offsetSec: Math.round(res.offsetSec * 100) / 100,
        peak: Math.round(res.peak * 100) / 100,
        second: Math.round(res.second * 100) / 100,
        ratio: Math.round(Math.min(res.ratio, 99) * 100) / 100,
        ok: res.ok,
        bins: res.overlapBins,
        cleanSec: Math.round(cleanSec * 10) / 10,
        ...(settling ? { settling: true } : {}),
      });
      if (res.ok) this.acceptAlignment(res, 'search');
      else {
        // the correlation did not (yet) find the clock: let chunks flow under a provisional offset meanwhile
        this.maybeProvisional(cleanSec);
      }
      if (!res.ok && !settling) {
        this.alignFails++;
        if (this.alignFails >= ALIGN_GIVE_UP_FAILS && this.videoSeconds() >= ALIGN_GIVE_UP_VIDEO_SEC) this.fail('align-failed', `peak ${res.peak.toFixed(2)} second ${res.second.toFixed(2)}`);
      }
      return;
    }
    if (this.suspect) {
      if (this.videoSeconds() < ALIGN_MIN_VIDEO_SEC) return;
      this.lastVerify = t;
      this.verify(5, true);
      return;
    }
    if (t - this.lastVerify < VERIFY_EVERY_MS) return;
    this.lastVerify = t;
    this.verify(3, false);
  }

  /** a correlation was accepted (`via`: wide search or the narrow check around the prior): the offset becomes real */
  private acceptAlignment(res: { offsetSec: number; peak: number }, via: 'search' | 'prior'): void {
    const t = this.now();
    const wasProv = this.provisional;
    const wasFromPrior = this.provisionalFromPrior;
    const provOffset = this.offsetSec;
    this.offsetSec = res.offsetSec;
    this.aligned = true;
    this.provisional = false;
    this.provisionalFromPrior = false;
    this.alignFails = 0;
    this.lastVerify = t;
    this.verifyFails = 0;
    this.priorStore.set(res.offsetSec);
    this.refineAdEnd();
    if (wasProv && provOffset !== undefined) {
      // chunks already went out under the provisional offset: only FUTURE audio uses the real one; the engine re-times what was scheduled
      const shift = Math.round((provOffset - res.offsetSec) * 100) / 100;
      diag.log('hls-align-provisional', { resolved: true, via, provisionalSec: Math.round(provOffset * 100) / 100, realSec: Math.round(res.offsetSec * 100) / 100, shiftSec: shift, ...(wasFromPrior ? { prior: true } : { estimate: true }) });
      this.o.onStatus?.({ type: 'retime', shiftSec: shift });
    } else this.replayHistory();
    this.o.onStatus?.({ type: 'aligned' });
  }

  /** capture restart on the same timeline: the last good offset is the provisional offset (error bound PRIOR_ERR_BOUND_SEC) */
  private provisionalFromPriorStart(prior: number, cleanSec: number): void {
    this.offsetSec = prior;
    this.provisional = true;
    this.provisionalFromPrior = true;
    diag.log('hls-align-provisional', { offsetSec: Math.round(prior * 100) / 100, errBoundSec: PRIOR_ERR_BOUND_SEC, cleanSec: Math.round(cleanSec * 10) / 10, prior: true });
    this.o.onStatus?.({ type: 'provisional', offsetSec: prior, errBoundSec: PRIOR_ERR_BOUND_SEC });
    this.replayHistory();
  }

  /**
   * No alignment yet but >= PROVISIONAL_AFTER_CLEAN_SEC of clean audio: let chunks flow under a provisional offset = newest playlist
   * pts minus the buffered end of the video, minus the typical player lag (one segment). Chunks are flagged `provisional`; the engine
   * re-times its dubs when the real offset arrives (status 'retime').
   */
  private maybeProvisional(cleanSec: number): void {
    if (this.provisional || this.priorStore.get() !== undefined || cleanSec < PROVISIONAL_AFTER_CLEAN_SEC || !(this.newestPtsEnd > 0)) return;
    const v = this.o.video;
    const b = v.buffered;
    const ct = v.currentTime;
    let end = NaN;
    for (let i = 0; b && i < b.length; i++) if (b.start(i) <= ct + 0.05 && ct <= b.end(i) + 0.05) end = b.end(i);
    if (!Number.isFinite(end) && Number.isFinite(this.videoMax)) end = this.videoMax;
    if (!Number.isFinite(end)) return;
    const off = this.newestPtsEnd - end - PROVISIONAL_PLAYER_LAG_SEC;
    this.offsetSec = off;
    this.provisional = true;
    diag.log('hls-align-provisional', { offsetSec: Math.round(off * 100) / 100, errBoundSec: PROVISIONAL_ERR_BOUND_SEC, cleanSec: Math.round(cleanSec * 10) / 10, estimate: true });
    this.o.onStatus?.({ type: 'provisional', offsetSec: off, errBoundSec: PROVISIONAL_ERR_BOUND_SEC });
    this.replayHistory();
  }

  /** the first clean segment's pts gives the exact video time the latest ad break ended at (the recorded end is the detection time) */
  private refineAdEnd(): void {
    const r = this.adRegions[this.adRegions.length - 1];
    if (!r || this.cleanPts === undefined || this.offsetSec === undefined) return;
    const end = this.cleanPts - this.offsetSec;
    if (Number.isFinite(end) && end < r[1] && end > r[0]) {
      diag.log('hls-ad-end-refined', { from: Math.round(r[1] * 10) / 10, to: Math.round(end * 10) / 10 });
      r[1] = end;
    }
    this.cleanPts = undefined;
  }

  /**
   * Re-checks the video<->pts mapping against the last 20 s. A SMALLER offset moves future slots LATER (harmless) and is
   * taken at once; a LARGER one moves them EARLIER (the dub could lead the phrase) and must be seen twice (or follow a seek,
   * `force`) before it is applied. Only chunks emitted after the change use the new offset; scheduled ones keep theirs.
   */
  private verify(rangeSec: number, force: boolean): void {
    const vmax = this.videoMax;
    const prev = this.offsetSec!;
    const res = correlateEnvelopes(this.videoEnv, this.hlsEnv, {
      fromSec: vmax - ALIGN_WINDOW_SEC,
      toSec: vmax,
      centerSec: prev,
      rangeSec,
      minPeak: force ? 0.55 : 0.45,
      minMargin: force ? 0.15 : 0.1,
    });
    if (res.peak === 0) return; // flat window: inconclusive
    diag.log('hls-align', { offsetSec: Math.round(res.offsetSec * 100) / 100, peak: Math.round(res.peak * 100) / 100, ok: res.ok, reverify: true, ...(force ? { afterSeek: true } : {}) });
    if (!res.ok) {
      if (force || ++this.verifyFails >= 3) this.recalibrate(force ? 'seek-verify-failed' : 'verify-failed');
      return;
    }
    this.verifyFails = 0;
    this.suspect = false;
    const delta = res.offsetSec - prev;
    let applied = false;
    let pending = false;
    if (Math.abs(delta) > 0.25) {
      const confirmed = this.pendingOffset !== undefined && Math.abs(res.offsetSec - this.pendingOffset) <= 0.25;
      if (delta < 0 || confirmed || (force && res.peak >= 0.7)) {
        this.offsetSec = res.offsetSec;
        this.priorStore.set(res.offsetSec);
        this.pendingOffset = undefined;
        applied = true;
      } else {
        this.pendingOffset = res.offsetSec;
        pending = true;
        this.lastVerify = this.now() - VERIFY_EVERY_MS + 15_000; // look again in 15 s
      }
    } else this.pendingOffset = undefined;
    if (Math.abs(delta) > 0.3) {
      diag.log('align-drift', {
        offsetSec: Math.round(res.offsetSec * 100) / 100,
        prevOffsetSec: Math.round(prev * 100) / 100,
        deltaSec: Math.round(delta * 100) / 100,
        ct: Math.round(this.o.video.currentTime * 100) / 100,
        applied,
        ...(pending ? { pending: true } : {}),
      });
    }
  }
}
