import { describe, expect, it } from 'vitest';
import { TranslationEngine } from '../src/pipeline';
import type { AudioChunk } from '../src/providers/types';
import { FakeCapture, FakeProvider, FakeScheduler, FakeVideo, flush, instantSleep, settings } from './helpers/pipelineFakes';

class HlsFakeCapture extends FakeCapture {
  kind = 'hls' as const;
  invalidated: string[] = [];
  invalidateClock(why: string): void {
    this.invalidated.push(why);
  }
}

function setup() {
  const video = new FakeVideo();
  const gemini = new FakeProvider('gemini');
  const caps: HlsFakeCapture[] = [];
  const scheds: FakeScheduler[] = [];
  const engine = new TranslationEngine({
    video: video as unknown as HTMLVideoElement,
    audioCtx: {} as AudioContext,
    providers: [gemini],
    settings: settings({ voiceOrder: ['gemini'], dubLagSec: 2 }),
    createCapture: (async () => {
      const c = new HlsFakeCapture();
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
  });
  return { video, gemini, caps, scheds, engine };
}

/** an 8 s cell: `lead` seconds of near-silence, then noise bursts (speech stand-in) */
function cell(startSec: number, lead: number): AudioChunk {
  const sr = 16000;
  const n = 8 * sr;
  const pcm = new Int16Array(n);
  let seed = 7;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const r = seed / 4294967296 - 0.5;
    pcm[i] = Math.round(r * (i / sr < lead ? 0.002 : 0.4) * 32767);
  }
  return { startSec, durationSec: 8, sampleRate: sr, pcm };
}

describe('engine: a dub never precedes the speech of its chunk', () => {
  it('moves a segment estimated inside a 4 s lead-in to the measured speech onset (duration kept)', async () => {
    const { engine, caps, scheds } = setup();
    await engine.start();
    caps[0]!.emit(cell(0, 4));
    await flush();
    const added = scheds[0]!.added;
    expect(added).toHaveLength(1);
    expect(added[0]!.start).toBeGreaterThan(3.8); // the provider guessed 0
    expect(added[0]!.end - added[0]!.start).toBeCloseTo(1, 5);
  });

  it('leaves segments alone when the chunk starts with speech', async () => {
    const { engine, caps, scheds } = setup();
    await engine.start();
    caps[0]!.emit(cell(0, 0));
    await flush();
    expect(scheds[0]!.added[0]!.start).toBe(0);
  });
});

describe('engine: Twitch player rebuild (currentTime jumps to ~0)', () => {
  it('drops every cell / dub of the old clock, invalidates the capture clock and accepts the same cell keys again', async () => {
    const { engine, caps, scheds, video, gemini } = setup();
    video.currentTime = 100;
    await engine.start();
    video.dispatchEvent(new Event('timeupdate')); // lastCt = 100
    caps[0]!.emit(cell(104, 0));
    await flush();
    expect(scheds[0]!.added).toHaveLength(1);
    expect(gemini.calls).toHaveLength(1);

    video.currentTime = 0.3;
    video.dispatchEvent(new Event('timeupdate'));
    await flush();
    expect(caps[0]!.invalidated).toEqual(['engine-reset']);
    expect(caps[0]!.starts.at(-1)).toBeCloseTo(0.3, 5);
    expect(scheds[0]!.removed.some((r) => r.opts?.reason === 'timeline-reset')).toBe(true);
    expect(scheds[0]!.added).toHaveLength(0);

    // the new clock produces a cell with the same key (104) later: it must not be shadowed by the old 'done' one
    video.currentTime = 96;
    caps[0]!.emit(cell(104, 0));
    await flush();
    expect(gemini.calls).toHaveLength(2);
  });

  it('an ordinary seek back inside the same clock is not a reset', async () => {
    const { engine, caps, scheds, video } = setup();
    video.currentTime = 100;
    await engine.start();
    video.dispatchEvent(new Event('timeupdate'));
    caps[0]!.emit(cell(104, 0));
    await flush();
    video.currentTime = 70;
    video.dispatchEvent(new Event('timeupdate'));
    await flush();
    expect(caps[0]!.invalidated).toEqual([]);
    expect(scheds[0]!.added).toHaveLength(1);
  });
});
