import type { Capture } from '../../src/capture';
import type { AudioChunk, ChunkResult, DubProvider, DubSegment, ProviderContext, ProviderId } from '../../src/providers/types';
import { ProviderUnavailableError } from '../../src/providers/types';
import { DEFAULT_SETTINGS, type Settings } from '../../src/types';
import type { SchedulerLike } from '../../src/pipeline';

export class FakeVideo extends EventTarget {
  currentTime = 0;
  volume = 1;
  paused = false;
}

export function chunk(startSec: number, durationSec = 15): AudioChunk {
  return { startSec, durationSec, sampleRate: 16000, pcm: new Int16Array(8) };
}

export function seg(start: number, end = start + 1): DubSegment {
  return { start, end, audio: { kind: 'pcm', sampleRate: 16000, samples: new Int16Array(4) } };
}

export function settings(over: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, voiceEnabled: { ...DEFAULT_SETTINGS.voiceEnabled, gemini: true }, ...over };
}

export type Script = Array<ChunkResult | Error | 'hang' | (() => Promise<ChunkResult>)>;

/** Provider whose answers are scripted; after the script ends it repeats `fallback`. */
export class FakeProvider implements DubProvider {
  readonly label: string;
  configured = true;
  calls: Array<{ chunk: AudioChunk; ctx: ProviderContext }> = [];
  script: Script = [];
  fallback: ChunkResult | Error = { segments: [seg(0)], sourceLang: 'en' };
  constructor(readonly id: ProviderId) {
    this.label = id;
  }
  isConfigured(): boolean {
    return this.configured;
  }
  translateChunk(c: AudioChunk, ctx: ProviderContext): Promise<ChunkResult> {
    this.calls.push({ chunk: c, ctx });
    const next = this.script.length > 0 ? this.script.shift()! : this.fallback;
    if (typeof next === 'function') return next();
    if (next === 'hang') {
      return new Promise((_, rej) => ctx.signal.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))));
    }
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve({ ...next, segments: next.segments.map((s) => ({ ...s, start: c.startSec, end: c.startSec + 1 })) });
  }
}

export function unavailable(id: ProviderId, kind: ProviderUnavailableError['kind']): ProviderUnavailableError {
  return new ProviderUnavailableError(`${id} ${kind}`, id, kind);
}

export class FakeCapture implements Capture {
  kind: Capture['kind'] = 'mse';
  starts: number[] = [];
  stopped = false;
  private cbs = new Set<(c: AudioChunk) => void>();
  async start(fromSec: number): Promise<void> {
    this.starts.push(fromSec);
  }
  onChunk(cb: (c: AudioChunk) => void): () => void {
    this.cbs.add(cb);
    return () => this.cbs.delete(cb);
  }
  stop(): void {
    this.stopped = true;
  }
  emit(c: AudioChunk): void {
    this.cbs.forEach((f) => f(c));
  }
}

export class FakeScheduler implements SchedulerLike {
  onStarve?: (t: number) => void;
  added: DubSegment[] = [];
  started = 0;
  disposed = 0;
  volume = 1;
  constructor(readonly opts: { translationVolume?: number; originalVolume?: number } = {}) {
    this.volume = opts.translationVolume ?? 1;
  }
  addSegments(s: DubSegment[]): void {
    this.added.push(...s);
  }
  start(): void {
    this.started++;
  }
  dispose(): void {
    this.disposed++;
  }
  setVolume(v: number): void {
    this.volume = v;
  }
  removed: Array<{ n: number; opts?: { fadeSec?: number; reason?: string } }> = [];
  removeSegmentsWhere(pred: (s: DubSegment) => boolean, opts?: { fadeSec?: number; reason?: string }): number {
    const n = this.added.filter(pred).length;
    this.added = this.added.filter((s) => !pred(s));
    this.removed.push({ n, opts });
    return n;
  }
}

export async function flush(n = 10): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
}

export const instantSleep =
  (log?: number[]) =>
  async (ms: number): Promise<void> => {
    log?.push(ms);
  };
