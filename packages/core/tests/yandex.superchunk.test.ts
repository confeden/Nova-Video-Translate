import { describe, expect, it } from 'vitest';
import { TranslationEngine } from '../src/pipeline';
import { LatencyModel, YANDEX_JOB_PER_SEC, YANDEX_SUPER_CELLS, yandexJobSec, yandexTierCap } from '../src/pipeline/planner';
import { indexMp3 } from '../src/providers/yandex';
import type { AudioChunk, ChunkResult, DubProvider, ProviderContext, ProviderId } from '../src/providers/types';
import { ProviderUnavailableError } from '../src/providers/types';
import { FakeCapture, FakeScheduler, FakeVideo, flush, instantSleep, settings } from './helpers/pipelineFakes';

// ---------- synthetic CBR mp3 (MPEG1 L3, 128 kbps, 44.1 kHz, alternating padding) ----------
const FRAME_SEC = 1152 / 44100;
function synthMp3(frames: number): Uint8Array {
  const parts: number[][] = [];
  for (let i = 0; i < frames; i++) {
    const len = Math.floor(((i + 1) * 144 * 128000) / 44100) - Math.floor((i * 144 * 128000) / 44100);
    const pad = len - 417;
    const f = new Array<number>(len).fill((i % 200) + 1);
    f[0] = 0xff;
    f[1] = 0xfb;
    f[2] = (9 << 4) | (pad << 1);
    f[3] = 0x00;
    parts.push(f);
  }
  return Uint8Array.from(parts.flat());
}

/** captured cell with real-length pcm (1 kHz so the arrays stay small) */
function cell(startSec: number, durationSec = 15, partial = false): AudioChunk {
  return { startSec, durationSec, sampleRate: 1000, pcm: new Int16Array(Math.round(durationSec * 1000)).fill(1), partial };
}

type Behaviour = (c: AudioChunk, ctx: ProviderContext, n: number) => Promise<ChunkResult>;
const mp3Result = (c: AudioChunk): ChunkResult => ({
  segments: [{ start: c.startSec, end: c.startSec + c.durationSec, audio: { kind: 'encoded', mime: 'audio/mpeg', data: synthMp3(Math.ceil(c.durationSec / FRAME_SEC)) } }],
  voice: 'standard',
  sourceLang: 'en',
});
const hang: Behaviour = (_c, ctx) => new Promise((_, rej) => ctx.signal.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))));

class YandexFake implements DubProvider {
  readonly label: string;
  calls: Array<{ chunk: AudioChunk; ctx: ProviderContext }> = [];
  behaviour: Behaviour = (c) => Promise.resolve(mp3Result(c));
  constructor(readonly id: ProviderId = 'yandex') {
    this.label = id;
  }
  isConfigured(): boolean {
    return true;
  }
  translateChunk(c: AudioChunk, ctx: ProviderContext): Promise<ChunkResult> {
    this.calls.push({ chunk: c, ctx });
    return this.behaviour(c, ctx, this.calls.length - 1);
  }
}

function setup(over: { superCells?: number; dupTimer?: (ms: number, s: AbortSignal) => Promise<void>; ct?: number } = {}) {
  const video = new FakeVideo();
  video.currentTime = over.ct ?? 0;
  const prov = new YandexFake();
  const caps: FakeCapture[] = [];
  const scheds: FakeScheduler[] = [];
  const engine = new TranslationEngine({
    video: video as unknown as HTMLVideoElement,
    audioCtx: {} as AudioContext,
    providers: [prov],
    settings: settings({ voiceOrder: ['yandex'], voiceEnabled: { 'yandex-live': false, yandex: true, gemini: false } }),
    createCapture: (async () => {
      const c = new FakeCapture();
      caps.push(c);
      return c;
    }) as never,
    createScheduler: ((_v: unknown, _c: unknown, o: any) => {
      const s = new FakeScheduler(o);
      scheds.push(s);
      return s;
    }) as never,
    now: () => 0,
    sleep: instantSleep(),
    retryDelayMs: 10,
    latencyPriors: { yandex: 2, 'yandex-live': 2 },
    yandexSuperCells: over.superCells,
    dupTimer: over.dupTimer ?? (() => new Promise(() => {})),
    hedgeAfterMs: 0,
  });
  const durs = (): Array<[number, number]> => prov.calls.map((c) => [c.chunk.startSec, c.chunk.durationSec]);
  return { video, prov, engine, caps, scheds, durs };
}

describe('planner: Yandex job latency law (S26)', () => {
  it('yandexJobSec = 10 s + 0.045 s per audio second', () => {
    expect(yandexJobSec(15)).toBeCloseTo(10.675, 3);
    expect(yandexJobSec(60)).toBeCloseTo(12.7, 3);
    expect(yandexJobSec(604)).toBeCloseTo(37.18, 2);
  });

  it('expectedSec scales with the job duration around the reference (live prior stays 90 s at 15 s)', () => {
    const m = new LatencyModel(() => 0);
    expect(m.expectedSec('yandex-live')).toBe(90);
    expect(m.expectedSec('yandex-live', 15)).toBe(90);
    expect(m.expectedSec('yandex-live', 60)).toBeCloseTo(90 + YANDEX_JOB_PER_SEC * 45, 6);
    expect(m.expectedSec('gemini', 60)).toBe(20); // Gemini does not scale
  });

  it('a sample of a long job is normalised to the reference duration before it enters the EWMA', () => {
    const a = new LatencyModel(() => 0);
    const b = new LatencyModel(() => 0);
    a.observe('yandex', 30_000, false, 60); // 30 s for 60 s of audio = 27.97 s at 15 s
    b.observe('yandex', 30_000, false);
    expect(a.expectedSec('yandex')).toBeLessThan(b.expectedSec('yandex'));
    // a repeat of the same job predicts that job back
    for (let i = 0; i < 12; i++) a.observe('yandex', 30_000, false, 60);
    expect(a.expectedSec('yandex', 60)).toBeCloseTo(30, 0);
    expect(a.expectedSec('yandex', 15)).toBeCloseTo(30 - YANDEX_JOB_PER_SEC * 45, 0);
  });

  it('cap floor can be lowered for bigger jobs (>= 3)', () => {
    expect(yandexTierCap(50, 60, 3)).toBe(4);
    expect(yandexTierCap(5, 60, 3)).toBe(4);
    expect(yandexTierCap(5, 15)).toBe(5);
  });
});

describe('engine: Yandex super-chunk jobs', () => {
  it('ramp: the first jobs carry <= 2 cells, after one success jobs carry up to YANDEX_SUPER_CELLS; slicing keeps the grid timing', async () => {
    const e = setup();
    await e.engine.start();
    const cap = e.caps[0]!;
    for (const s of [15, 30, 45, 60, 75, 90, 105]) cap.emit(cell(s));
    await flush();
    expect(e.durs()).toEqual([
      [15, 30],
      [45, 30],
      [75, 30],
      [105, 15],
    ]);
    // every cell was voiced as before: one segment per grid cell, mp3 slice with the cell's own timing
    const added = e.scheds[0]!.added;
    expect(added.map((s) => [s.start, s.end]).sort((a, b) => a[0]! - b[0]!)).toEqual([15, 30, 45, 60, 75, 90, 105].map((s) => [s, s + 15]));
    expect(added.every((s) => s.providerId === 'yandex' && s.audio.kind === 'encoded')).toBe(true);
    const seg30 = added.find((s) => s.start === 30)!;
    const a30 = seg30.audio as { data: Uint8Array; skipSec?: number };
    const idx = indexMp3(a30.data)!;
    expect(idx.durationSec).toBeGreaterThan(15 - 0.1); // the cell's 15 s plus the lead-in frames
    expect(idx.durationSec).toBeLessThan(15 + 0.2);
    expect(a30.skipSec).toBeGreaterThan(0);
    // second wave: 4 contiguous cells go as ONE 60 s job
    const cap2 = e.caps[0]!;
    for (const s of [120, 135, 150, 165]) cap2.emit(cell(s));
    await flush();
    expect(e.durs().slice(4)).toEqual([[120, 60]]);
    expect(YANDEX_SUPER_CELLS).toBe(4);
    const seg2 = e.scheds[0]!.added.filter((s) => s.start >= 120).map((s) => [s.start, s.end]);
    expect(seg2).toEqual([120, 135, 150, 165].map((s) => [s, s + 15]));
    e.engine.stop();
  });

  it('only contiguous captured cells are merged (nothing waits for more audio)', async () => {
    const e = setup();
    await e.engine.start();
    e.caps[0]!.emit(cell(15));
    e.caps[0]!.emit(cell(45)); // gap at 30
    await flush();
    expect(e.durs()).toEqual([
      [15, 15],
      [45, 15],
    ]);
    e.engine.stop();
  });

  it('a partial first cell works: the job starts at the partial cell and each cell is cut at its own boundaries', async () => {
    const e = setup();
    await e.engine.start();
    e.caps[0]!.emit(cell(7, 8, true));
    e.caps[0]!.emit(cell(15));
    await flush();
    expect(e.durs()).toEqual([[7, 23]]);
    expect(e.scheds[0]!.added.map((s) => [s.start, s.end]).sort((a, b) => a[0]! - b[0]!)).toEqual([
      [7, 15],
      [15, 30],
    ]);
    e.engine.stop();
  });

  it('urgent cell first: the job containing the cell nearest the playhead starts first', async () => {
    const e = setup({ ct: 100 });
    await e.engine.start();
    for (const s of [150, 135, 120, 105]) e.caps[0]!.emit(cell(s));
    await flush();
    expect(e.durs()[0]).toEqual([105, 30]);
    expect(e.durs()[1]).toEqual([135, 30]);
    e.engine.stop();
  });

  it('a failed batch job sends its cells back one by one (they are not batched again)', async () => {
    const e = setup();
    e.prov.behaviour = (c) => (c.durationSec > 15 ? Promise.reject(new ProviderUnavailableError('boom', 'yandex', 'failed')) : Promise.resolve(mp3Result(c)));
    await e.engine.start();
    e.caps[0]!.emit(cell(15));
    e.caps[0]!.emit(cell(30));
    await flush(30);
    const d = e.durs();
    expect(d.filter(([, dur]) => dur === 30).length).toBe(2); // the chain's own two attempts at the batch
    expect(d.filter(([, dur]) => dur === 15).map(([s]) => s).sort((a, b) => a - b)).toEqual([15, 30]);
    expect(e.scheds[0]!.added.map((s) => s.start).sort((a, b) => a - b)).toEqual([15, 30]);
    e.engine.stop();
  });

  it('an unusable batch result (not an mp3) falls back to per-cell jobs', async () => {
    const e = setup();
    e.prov.behaviour = (c) =>
      Promise.resolve(c.durationSec > 15 ? { segments: [{ start: c.startSec, end: c.startSec + 1, audio: { kind: 'encoded', mime: 'audio/mpeg', data: new Uint8Array(100) } }] } : mp3Result(c));
    await e.engine.start();
    e.caps[0]!.emit(cell(15));
    e.caps[0]!.emit(cell(30));
    await flush(30);
    expect(e.durs().filter(([, d]) => d === 15).map(([s]) => s).sort((a, b) => a - b)).toEqual([15, 30]);
    expect(e.scheds[0]!.added).toHaveLength(2);
    e.engine.stop();
  });

  it('straggler: after the dup delay ONE duplicate job (same audio) starts; the first success wins and the loser is aborted', async () => {
    let fire!: () => void;
    const e = setup({
      dupTimer: (_ms, signal) =>
        new Promise<void>((res, rej) => {
          fire = res;
          signal.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')), { once: true });
        }),
    });
    e.prov.behaviour = (c, ctx, n) => (n === 0 ? hang(c, ctx, n) : Promise.resolve(mp3Result(c)));
    await e.engine.start();
    e.caps[0]!.emit(cell(15));
    e.caps[0]!.emit(cell(30));
    await flush();
    expect(e.prov.calls).toHaveLength(1);
    expect(e.scheds[0]!.added).toHaveLength(0);
    fire();
    await flush();
    expect(e.prov.calls).toHaveLength(2); // exactly one duplicate
    expect(e.prov.calls[1]!.chunk.startSec).toBe(15);
    expect(e.prov.calls[1]!.chunk.durationSec).toBe(30);
    expect(e.prov.calls[0]!.ctx.signal.aborted).toBe(true);
    expect(e.scheds[0]!.added.map((s) => s.start).sort((a, b) => a - b)).toEqual([15, 30]);
    e.engine.stop();
  });

  it('no duplicate when the job finishes before the delay (timer cancelled)', async () => {
    let timerAborted = false;
    const e = setup({
      dupTimer: (_ms, signal) =>
        new Promise<void>((_, rej) => signal.addEventListener('abort', () => {
          timerAborted = true;
          rej(new DOMException('aborted', 'AbortError'));
        })),
    });
    await e.engine.start();
    e.caps[0]!.emit(cell(15));
    e.caps[0]!.emit(cell(30));
    await flush();
    expect(e.prov.calls).toHaveLength(1);
    expect(timerAborted).toBe(true);
    expect(e.scheds[0]!.added).toHaveLength(2);
    e.engine.stop();
  });

  it('the duplicate delay is max(2 x expected, 25 s)', async () => {
    const delays: number[] = [];
    const e = setup({
      dupTimer: (ms) => {
        delays.push(ms);
        return new Promise(() => {});
      },
    });
    await e.engine.start();
    e.caps[0]!.emit(cell(15));
    e.caps[0]!.emit(cell(30));
    await flush();
    expect(delays).toEqual([25_000]); // expected ~2 + 0.045 * 15 s: well under the 25 s floor
    e.engine.stop();
  });

  it('yandexSuperCells = 1 switches batching off', async () => {
    const e = setup({ superCells: 1 });
    await e.engine.start();
    e.caps[0]!.emit(cell(15));
    e.caps[0]!.emit(cell(30));
    await flush();
    expect(e.durs()).toEqual([
      [15, 15],
      [30, 15],
    ]);
    e.engine.stop();
  });
});
