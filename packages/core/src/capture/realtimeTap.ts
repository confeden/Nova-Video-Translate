/**
 * S3 (fallback): real-time capture of what the <video> element plays, via video.captureStream() -> AudioContext@16 kHz
 * -> AudioWorklet (ScriptProcessor if worklets are blocked by the page CSP). Chunks are stamped with the video clock.
 * It can never run ahead of playback, never touches `muted`/`currentTime`, and does not reroute the element's output
 * (createMediaElementSource is deliberately NOT used: it would silence the page's own audio path).
 * Cross-origin media without CORS makes captureStream() throw SecurityError (reported as 'tainted'); a muted or otherwise
 * silent stream is detected only while playback really advances: 3 s of zeros on a muted element => 'muted', >= 8 s on an audible one => 'tainted'.
 */
import type { AudioChunk } from '../providers/types';
import { TARGET_RATE } from './audio';

export type RealtimeStatus =
  | { type: 'running' }
  | { type: 'tainted' }
  | { type: 'muted' }
  | { type: 'discarded'; reason: 'pause' | 'seek' | 'rate' | 'waiting'; droppedSec: number }
  | { type: 'unsupported'; reason: string };

/** Cuts a continuous 16 kHz stream into fixed-length chunks stamped on the video timeline. */
export class RealtimeChunker {
  private buf: Float32Array;
  private n = 0;
  private startSec = 0;
  private open = false;
  constructor(
    private readonly chunkSec: number,
    private readonly emit: (c: AudioChunk) => void,
    private readonly sampleRate = TARGET_RATE,
  ) {
    this.buf = new Float32Array(Math.round(chunkSec * sampleRate));
  }

  /** (Re)start at a video time; whatever was partial is dropped by `discard()` first. */
  begin(videoSec: number): void {
    this.n = 0;
    this.startSec = videoSec;
    this.open = true;
  }

  get active(): boolean {
    return this.open;
  }
  get bufferedSec(): number {
    return this.n / this.sampleRate;
  }

  push(samples: Float32Array): void {
    if (!this.open) return;
    let i = 0;
    while (i < samples.length) {
      const take = Math.min(this.buf.length - this.n, samples.length - i);
      this.buf.set(samples.subarray(i, i + take), this.n);
      this.n += take;
      i += take;
      if (this.n === this.buf.length) {
        const pcm = new Int16Array(this.n);
        for (let k = 0; k < this.n; k++) {
          const s = Math.max(-1, Math.min(1, this.buf[k]!));
          pcm[k] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
        }
        this.emit({ startSec: this.startSec, durationSec: this.n / this.sampleRate, sampleRate: this.sampleRate, pcm });
        this.startSec += this.n / this.sampleRate;
        this.n = 0;
      }
    }
  }

  /** drop the partial chunk; returns seconds dropped. Stops accepting samples until `begin()`. */
  discard(): number {
    const d = this.n / this.sampleRate;
    this.n = 0;
    this.open = false;
    return d;
  }
}

/** Reports when the stream has been digital silence for > `limitSec` of playing time. */
export class SilenceDetector {
  private zeroSec = 0;
  private fired = false;
  constructor(
    private readonly limitSec = 3,
    private readonly sampleRate = TARGET_RATE,
  ) {}
  /** @returns true exactly once, when the limit is crossed */
  feed(samples: Float32Array): boolean {
    let nonZero = false;
    for (let i = 0; i < samples.length; i++) {
      if (samples[i] !== 0) {
        nonZero = true;
        break;
      }
    }
    if (nonZero) {
      this.zeroSec = 0;
      this.fired = false;
      return false;
    }
    this.zeroSec += samples.length / this.sampleRate;
    if (!this.fired && this.zeroSec > this.limitSec) {
      this.fired = true;
      return true;
    }
    return false;
  }
  reset(): void {
    this.zeroSec = 0;
    this.fired = false;
  }
}

export interface RealtimeOptions {
  chunkSec?: number;
  /** digital silence (while playback advances) after which a muted element is reported 'muted' */
  silenceLimitSec?: number;
  /** advancing, audible-element digital silence after which the stream is reported 'tainted' */
  taintLimitSec?: number;
  /**
   * Raw 16 kHz blocks while the media clock advances, with video.currentTime at the block's arrival (HLS clock alignment).
   * Monitor use: the chunks are simply never consumed.
   */
  onPcm?: (samples: Float32Array, videoTime: number) => void;
}

export interface RealtimeTap {
  /** `fromSec` is advisory: real-time capture can only deliver from the current playhead onward */
  start(fromSec?: number): Promise<void>;
  stop(): void;
  onChunk(cb: (c: AudioChunk) => void): () => void;
  onStatus(cb: (s: RealtimeStatus) => void): () => void;
}

const WORKLET_SRC = `
class NvtTap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor('nvt-tap', NvtTap);
`;

export function createRealtimeTap(video: HTMLMediaElement, opts: RealtimeOptions = {}): RealtimeTap {
  const chunkCbs = new Set<(c: AudioChunk) => void>();
  const statusCbs = new Set<(s: RealtimeStatus) => void>();
  const status = (s: RealtimeStatus): void => statusCbs.forEach((f) => f(s));
  const chunker = new RealtimeChunker(opts.chunkSec ?? 15, (c) => chunkCbs.forEach((f) => f(c)));
  const silence = new SilenceDetector(opts.silenceLimitSec ?? 3);
  const taint = new SilenceDetector(Math.max(opts.taintLimitSec ?? 8, opts.silenceLimitSec ?? 3));
  let lastCT = -1;
  let stalledSec = 0;
  let ctx: AudioContext | null = null;
  let cleanup: Array<() => void> = [];
  let lastRate = 1;
  let running = false;

  const playing = (): boolean => !video.paused && !video.ended && !video.seeking && video.readyState >= 3;
  const resetSilence = (): void => {
    silence.reset();
    taint.reset();
    lastCT = -1;
    stalledSec = 0;
  };
  /** true while the media clock is really moving (not paused/seeking/buffering/ended/stalled) */
  const advancing = (sec: number): boolean => {
    if (!playing()) return false;
    if (video.currentTime !== lastCT) {
      lastCT = video.currentTime;
      stalledSec = 0;
      return true;
    }
    stalledSec += sec;
    return stalledSec < 1;
  };
  const resume = (): void => {
    if (!running || chunker.active || !playing()) return;
    lastRate = video.playbackRate;
    chunker.begin(video.currentTime);
    resetSilence();
    status({ type: 'running' });
  };
  const drop = (reason: 'pause' | 'seek' | 'rate' | 'waiting'): void => {
    if (!running) return;
    resetSilence();
    const droppedSec = chunker.discard();
    status({ type: 'discarded', reason, droppedSec });
  };

  const onSamples = (s: Float32Array): void => {
    if (!chunker.active) return;
    if (opts.onPcm && playing() && video.playbackRate === lastRate) opts.onPcm(s, video.currentTime);
    if (video.playbackRate !== lastRate) {
      drop('rate');
      return resume();
    }
    const adv = advancing(s.length / TARGET_RATE);
    const quiet = video.muted || video.volume === 0 || ctx?.state === 'suspended';
    if (!adv) {
      silence.reset();
      taint.reset();
    } else if (quiet) {
      taint.reset(); // a muted / volume-0 element is silent by design, never 'tainted'
      if (silence.feed(s)) status({ type: 'muted' });
    } else {
      silence.reset();
      if (taint.feed(s)) status({ type: 'tainted' });
    }
    chunker.push(s);
  };

  const listen = (type: string, fn: () => void): void => {
    video.addEventListener(type, fn);
    cleanup.push(() => video.removeEventListener(type, fn));
  };

  return {
    async start() {
      if (running) return;
      const capture = (video as unknown as { captureStream?: () => MediaStream; mozCaptureStream?: () => MediaStream }).captureStream
        ?? (video as unknown as { mozCaptureStream?: () => MediaStream }).mozCaptureStream;
      if (!capture) return status({ type: 'unsupported', reason: 'captureStream missing' });
      let stream: MediaStream;
      try {
        stream = capture.call(video);
      } catch (e) {
        // Chromium throws SecurityError for cross-origin (CORS-tainted) media instead of delivering silence
        return status(e instanceof DOMException && e.name === 'SecurityError' ? { type: 'tainted' } : { type: 'unsupported', reason: String(e) });
      }
      const tracks = stream.getAudioTracks();
      if (tracks.length === 0) return status({ type: 'unsupported', reason: 'no audio track on captureStream' });
      ctx = new AudioContext({ sampleRate: TARGET_RATE, latencyHint: 'playback' });
      if (ctx.state === 'suspended') await ctx.resume().catch(() => undefined);
      const src = ctx.createMediaStreamSource(new MediaStream(tracks));
      const sink = ctx.createGain();
      sink.gain.value = 0; // keeps the graph pulled without any audible output
      sink.connect(ctx.destination);
      let node: AudioNode;
      try {
        const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'text/javascript' }));
        try {
          await ctx.audioWorklet.addModule(url);
        } finally {
          URL.revokeObjectURL(url);
        }
        const w = new AudioWorkletNode(ctx, 'nvt-tap', { numberOfOutputs: 1, outputChannelCount: [1] });
        w.port.onmessage = (e: MessageEvent<Float32Array>) => onSamples(e.data);
        node = w;
      } catch {
        // CSP blocked the worklet module. Largest legal buffer: fewer main-thread callbacks (each one copies a chunk)
        const sp = ctx.createScriptProcessor(16384, 1, 1);
        sp.onaudioprocess = (e) => onSamples(e.inputBuffer.getChannelData(0).slice(0));
        node = sp;
      }
      src.connect(node);
      node.connect(sink);
      cleanup.push(() => {
        try {
          src.disconnect();
          node.disconnect();
        } catch {
          /* already gone */
        }
      });
      running = true;
      listen('pause', () => drop('pause'));
      listen('waiting', () => drop('waiting'));
      listen('seeking', () => drop('seek'));
      listen('ratechange', () => drop('rate'));
      listen('ended', () => drop('pause'));
      listen('emptied', () => drop('pause'));
      for (const ev of ['playing', 'seeked', 'canplay']) listen(ev, resume);
      resume();
    },
    stop() {
      running = false;
      chunker.discard();
      cleanup.forEach((f) => f());
      cleanup = [];
      void ctx?.close().catch(() => undefined);
      ctx = null;
    },
    onChunk(cb) {
      chunkCbs.add(cb);
      return () => chunkCbs.delete(cb);
    },
    onStatus(cb) {
      statusCbs.add(cb);
      return () => statusCbs.delete(cb);
    },
  };
}
