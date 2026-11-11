import { describe, expect, it } from 'vitest';
import { createChainState, runChain } from '../src/pipeline';
import type { ChunkResult, ProviderId, SubtitleCue } from '../src/providers/types';
import { FakeProvider, chunk, flush, seg, settings } from './helpers/pipelineFakes';

function setup() {
  const cloud = new FakeProvider('gemini');
  const local = new FakeProvider('local');
  const controller = new AbortController();
  const queued: Array<() => Promise<void>> = [];
  const late: ProviderId[] = [];
  const fills: ChunkResult[] = [];
  const s = settings({ voiceOrder: ['gemini', 'local'], voiceEnabled: { gemini: true, local: true, yandex: false, 'yandex-live': false, groq: false } });
  const ctx = {
    signal: controller.signal, now: () => 0, sleep: async () => {}, warn: () => {},
    plan: ['gemini', 'local'] as ProviderId[],
    scheduleRepair: (run: () => Promise<void>) => { queued.push(run); },
    onLate: (win: { providerId: ProviderId }) => { late.push(win.providerId); },
    onGapFill: (result: ChunkResult) => { fills.push(result); },
  };
  return { cloud, local, controller, queued, late, fills, s, ctx, run: () => runChain(chunk(0), [cloud, local], s, ctx, createChainState()) };
}

describe('queued local safety net', () => {
  it('reserves local work before cloud answers, without starting it before capacity is available', async () => {
    const e = setup();
    let finish!: (result: ChunkResult) => void;
    e.cloud.script = [() => new Promise((resolve) => { finish = resolve; })];
    const pending = e.run();
    expect(e.queued).toHaveLength(1);
    expect(e.local.calls).toHaveLength(0);
    await e.queued.shift()!();
    const out = await pending;
    expect(out).toMatchObject({ ok: true, providerId: 'local' });
    expect(e.cloud.calls[0]!.ctx.signal.aborted).toBe(false);
    finish({ segments: [seg(0, 2)] });
    await flush();
    expect(e.late).toEqual(['gemini']);
  });

  it('cancels a queued local racer when the cloud result covers the whole cell', async () => {
    const e = setup();
    e.cloud.script = [async () => ({ segments: [seg(0, 15)] })];
    expect(await e.run()).toMatchObject({ ok: true, providerId: 'gemini' });
    await e.queued.shift()!();
    expect(e.local.calls).toHaveLength(0);
    expect(e.fills).toEqual([]);
  });

  it('settles session cancellation while local work is still queued', async () => {
    const e = setup();
    e.cloud.script = ['hang'];
    const pending = e.run();
    e.controller.abort();
    await expect(pending).rejects.toThrow();
    await e.queued.shift()!();
    expect(e.local.calls).toHaveLength(0);
  });

  it('an empty higher cloud result preserves the pending local voice', async () => {
    const e = setup();
    e.cloud.script = [async () => ({ segments: [] })];
    expect(await e.run()).toMatchObject({ ok: true, providerId: 'gemini' });
    await e.queued.shift()!();
    await flush();
    expect(e.fills).toHaveLength(1);
    expect(e.local.calls[0]!.ctx.signal.aborted).toBe(false);
  });

  it('an empty late cloud result cannot replace a completed local voice', async () => {
    const e = setup();
    let finish!: (result: ChunkResult) => void;
    e.cloud.script = [() => new Promise((resolve) => { finish = resolve; })];
    const pending = e.run();
    await e.queued.shift()!();
    expect(await pending).toMatchObject({ ok: true, providerId: 'local' });
    finish({ segments: [] });
    await flush();
    expect(e.late).toEqual([]);
  });
});

describe('early subtitle delivery', () => {
  it('publishes translated text before the dub finishes, respecting opt-in and cancellation', async () => {
    const e = setup();
    const emitted: Array<[ProviderId, SubtitleCue[]]> = [];
    e.cloud.script = ['hang'];
    e.s.subtitles = 'on';
    const pending = runChain(chunk(0), [e.cloud], e.s, { ...e.ctx, plan: ['gemini'], onSubtitles: (id, cues) => { emitted.push([id, cues]); } }, createChainState());
    const cues = [{ start: 0, end: 2, text: 'Early text' }];
    e.cloud.calls[0]!.ctx.onSubtitles?.(cues);
    expect(emitted).toEqual([['gemini', cues]]);
    e.controller.abort();
    await expect(pending).rejects.toThrow();
    e.cloud.calls[0]!.ctx.onSubtitles?.(cues);
    expect(emitted).toHaveLength(1);

    const off = setup();
    const result = await runChain(chunk(0), [off.cloud], off.s, { ...off.ctx, plan: ['gemini'], onSubtitles: (id, next) => { emitted.push([id, next]); } }, createChainState());
    expect(result.ok).toBe(true);
    expect(off.cloud.calls[0]!.ctx.onSubtitles).toBeUndefined();
  });
});
