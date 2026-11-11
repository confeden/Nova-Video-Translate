import { describe, expect, it } from 'vitest';
import { createChainState, runChain, TranslationEngine } from '../src/pipeline';
import { needsGapFill, uncoveredSpeech } from '../src/pipeline/gaps';
import type { ChunkResult } from '../src/providers/types';
import { FakeCapture, FakeProvider, FakeScheduler, FakeVideo, chunk, flush, instantSleep, seg, settings } from './helpers/pipelineFakes';

function setup() {
  const cloud = new FakeProvider('gemini');
  const local = new FakeProvider('local');
  const controller = new AbortController();
  const fills: ChunkResult[] = [];
  const s = settings({ voiceOrder: ['gemini', 'local'], voiceEnabled: { gemini: true, local: true, groq: false, yandex: false, 'yandex-live': false } });
  const ctx = { signal: controller.signal, now: () => 0, sleep: instantSleep(), warn: () => {}, onGapFill: (r: ChunkResult) => { fills.push(r); } };
  return { cloud, local, controller, fills, s, ctx, run: (plan?: Array<'gemini' | 'local'>) => runChain(chunk(0), [cloud, local], s, { ...ctx, plan }, createChainState()) };
}

describe('local speech repair', () => {
  it('checks empty/partial results, but never repairs confirmed Russian or a fully covered cell', () => {
    expect(needsGapFill(chunk(0), { segments: [] })).toBe(true);
    expect(needsGapFill(chunk(0), { segments: [seg(0, 15)] })).toBe(false);
    expect(needsGapFill(chunk(0), { segments: [], sourceLang: 'ru' })).toBe(false);
    expect(needsGapFill(chunk(0), { segments: [seg(0, 15)], failedSegments: [{ start: 5, end: 6 }] })).toBe(true);
  });

  it('keeps whole missing sentences, rejects overlap and duplicates, and allows touching boundaries', () => {
    const found = uncoveredSpeech([seg(0, 3)], [seg(0, 2), seg(2, 4), seg(3, 5), seg(3, 5), seg(8, 8)]);
    expect(found.map((s) => [s.start, s.end])).toEqual([[3, 5]]);
  });

  it('delivers cloud immediately and keeps its slower local racer for the missing speech', async () => {
    const e = setup();
    let finish!: (r: ChunkResult) => void;
    e.local.script = [() => new Promise((r) => { finish = r; })];
    const out = await e.run(['gemini', 'local']);
    expect(out).toMatchObject({ ok: true, providerId: 'gemini' });
    expect(e.local.calls[0]!.ctx.signal.aborted).toBe(false);
    finish({ segments: [seg(5, 7)] });
    await flush();
    expect(e.fills).toHaveLength(1);
  });

  it('starts an enabled local repair when only cloud was planned, bypassing caption/cache omissions', async () => {
    const e = setup();
    e.cloud.fallback = { segments: [], sourceLang: 'en' };
    const out = await e.run(['gemini']);
    expect(out).toMatchObject({ ok: true, providerId: 'gemini', result: { segments: [] } });
    await flush();
    expect(e.local.calls).toHaveLength(1);
    expect(e.local.calls[0]!.ctx.repairGaps).toBe(true);
    expect(e.fills).toHaveLength(1);
  });

  it.each(['disabled', 'russian', 'covered'] as const)('does not start a local repair for %s', async (why) => {
    const e = setup();
    if (why === 'disabled') e.s.voiceEnabled.local = false;
    if (why === 'russian') e.cloud.fallback = { segments: [], sourceLang: 'ru' };
    if (why === 'covered') e.cloud.script = [async () => ({ segments: [seg(0, 15)] })];
    await e.run(['gemini']);
    await flush();
    expect(e.local.calls).toHaveLength(0);
  });

  it('session cancellation stops a still-running local repair', async () => {
    const e = setup();
    e.local.script = ['hang'];
    await e.run(['gemini', 'local']);
    e.controller.abort();
    await flush();
    expect(e.local.calls[0]!.ctx.signal.aborted).toBe(true);
    expect(e.fills).toEqual([]);
  });

  it('schedules only the uncovered local sentence alongside the existing cloud audio', async () => {
    const e = setup();
    let finish!: (r: ChunkResult) => void;
    e.local.script = [() => new Promise((r) => { finish = r; })];
    const capture = new FakeCapture();
    const scheduler = new FakeScheduler();
    const engine = new TranslationEngine({
      video: new FakeVideo() as unknown as HTMLVideoElement,
      audioCtx: {} as AudioContext,
      providers: [e.cloud, e.local], settings: e.s,
      createCapture: (async () => capture) as never,
      createScheduler: (() => scheduler) as never,
      now: () => 0, sleep: instantSleep(),
    });
    await engine.start();
    capture.emit(chunk(0));
    await flush();
    expect(scheduler.added.map((s) => s.providerId)).toEqual(['gemini']);
    capture.emit(chunk(15));
    await flush();
    expect(e.local.calls).toHaveLength(1); // the next repair waits for the normal local concurrency slot
    finish({ segments: [seg(0, 1), seg(5, 7)], subtitles: [{ start: 5, end: 7, text: 'Missing sentence' }] });
    await flush();
    expect(e.local.calls).toHaveLength(2);
    expect(scheduler.added.map((s) => [s.start, s.end, s.providerId])).toEqual([[0, 1, 'gemini'], [15, 16, 'gemini'], [5, 7, 'local']]);
    engine.stop();
  });

  it('retains missing local sentences when a better, incomplete cloud result upgrades a future cell', async () => {
    const e = setup();
    let finish!: (r: ChunkResult) => void;
    e.cloud.script = [() => new Promise((r) => { finish = r; })];
    e.local.script = [async () => ({ segments: [seg(30, 31), seg(35, 37)] })];
    const capture = new FakeCapture();
    const scheduler = new FakeScheduler();
    const engine = new TranslationEngine({
      video: new FakeVideo() as unknown as HTMLVideoElement,
      audioCtx: {} as AudioContext,
      providers: [e.cloud, e.local], settings: e.s,
      createCapture: (async () => capture) as never,
      createScheduler: (() => scheduler) as never,
      now: () => 0, sleep: instantSleep(),
    });
    await engine.start();
    capture.emit(chunk(30));
    await flush();
    finish({ segments: [seg(30, 31)] });
    await flush();
    expect(scheduler.added.map((s) => [s.start, s.end, s.providerId])).toEqual([[30, 31, 'gemini'], [35, 37, 'local']]);
    engine.stop();
  });
});
