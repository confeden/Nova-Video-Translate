import { describe, expect, it } from 'vitest';
import { TranslationEngine, type EngineWarning } from '../src/pipeline';
import { FakeCapture, FakeProvider, FakeScheduler, FakeVideo, chunk, flush, instantSleep, seg, settings, unavailable } from './helpers/pipelineFakes';
import type { AudioChunk, DubSegment } from '../src/providers/types';
import type { Settings } from '../src/types';

function setup(over: Partial<Settings> = {}, extra: { events?: object; clock?: { t: number } } = {}) {
  const video = new FakeVideo();
  const providers = [new FakeProvider('yandex-live'), new FakeProvider('yandex'), new FakeProvider('gemini')];
  const caps: FakeCapture[] = [];
  const scheds: FakeScheduler[] = [];
  const warnings: EngineWarning[] = [];
  const clock = extra.clock ?? { t: 0 };
  const engine = new TranslationEngine({
    video: video as unknown as HTMLVideoElement,
    audioCtx: { state: 'running' } as AudioContext,
    yandexSuperCells: 1,
    providers,
    settings: settings({ voiceOrder: ['gemini', 'yandex', 'yandex-live'], voiceEnabled: { 'yandex-live': false, yandex: true, gemini: true }, ...over }),
    events: { onWarning: (w) => warnings.push(w), ...extra.events },
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
    now: () => clock.t,
    sleep: instantSleep(),
    retryDelayMs: 10,
  });
  const by = (id: string) => providers.find((p) => p.id === id)!;
  return { video, engine, providers, by, caps, scheds, warnings, clock };
}

const onlyYandex = { 'yandex-live': false, yandex: true, gemini: false };

describe('tier switching (owner feedback #3)', () => {
  it('disabling a tier cancels its in-flight attempt and the chunk falls through to the next tier at once', async () => {
    const e = setup();
    e.by('gemini').script = ['hang'];
    await e.engine.start();
    e.caps[0]!.emit(chunk(0));
    await flush();
    expect(e.by('gemini').calls).toHaveLength(1);
    expect(e.by('yandex').calls).toHaveLength(0);
    e.engine.updateSettings(settings({ voiceOrder: ['gemini', 'yandex'], voiceEnabled: onlyYandex }));
    await flush();
    expect(e.by('yandex').calls.map((c) => c.chunk.startSec)).toEqual([0]);
    expect(e.engine.activeProvider).toBe('yandex');
    expect(e.scheds[0]!.added.map((s) => s.providerId)).toEqual(['yandex']);
  });

  it('drops segments of the disabled tier (playing one fades <= 0.3 s) and re-queues the cells through the new order', async () => {
    const e = setup();
    await e.engine.start();
    e.video.currentTime = 2;
    e.caps[0]!.emit(chunk(0));
    await flush();
    e.caps[0]!.emit(chunk(15));
    e.caps[0]!.emit(chunk(30));
    await flush();
    expect(e.by('gemini').calls.map((c) => c.chunk.startSec)).toEqual([0, 15, 30]);
    expect(e.scheds[0]!.added.map((s) => s.providerId)).toEqual(['gemini', 'gemini', 'gemini']);
    e.engine.updateSettings(settings({ voiceOrder: ['gemini', 'yandex'], voiceEnabled: onlyYandex }));
    await flush();
    const rm = e.scheds[0]!.removed;
    expect(rm).toHaveLength(1);
    expect(rm[0]!.n).toBe(3);
    expect(rm[0]!.opts?.fadeSec).toBeLessThanOrEqual(0.3);
    expect(e.by('yandex').calls.map((c) => c.chunk.startSec).sort((a, b) => a - b)).toEqual([0, 15, 30]);
    expect(e.scheds[0]!.added.map((s) => s.providerId)).toEqual(['yandex', 'yandex', 'yandex']);
  });

  it('a cell already behind the playhead is not re-queued', async () => {
    const e = setup();
    await e.engine.start();
    e.caps[0]!.emit(chunk(0));
    await flush();
    e.video.currentTime = 100;
    e.engine.updateSettings(settings({ voiceOrder: ['gemini', 'yandex'], voiceEnabled: onlyYandex }));
    await flush();
    expect(e.by('yandex').calls).toHaveLength(0);
    expect(e.scheds[0]!.removed[0]!.n).toBe(1);
  });

  it('enabling a higher-priority tier re-voices the next upcoming cells voiced by a worse tier', async () => {
    const e = setup({ voiceOrder: ['yandex', 'gemini'], voiceEnabled: { 'yandex-live': false, yandex: false, gemini: true } });
    await e.engine.start();
    for (const s of [0, 15, 30, 45, 60, 75, 90]) e.caps[0]!.emit(chunk(s));
    await flush(30);
    expect(e.by('gemini').calls).toHaveLength(7);
    e.video.currentTime = 10;
    e.engine.updateSettings(settings({ voiceOrder: ['yandex', 'gemini'], voiceEnabled: { 'yandex-live': false, yandex: true, gemini: true } }));
    await flush(30);
    expect(e.by('yandex').calls.map((c) => c.chunk.startSec).sort((a, b) => a - b)).toEqual([15, 30, 45, 60]);
  });

  it('a failed re-voice leaves the old audio in place and stays silent about it', async () => {
    const e = setup({ voiceOrder: ['yandex', 'gemini'], voiceEnabled: { 'yandex-live': false, yandex: false, gemini: true } });
    await e.engine.start();
    e.caps[0]!.emit(chunk(30));
    await flush();
    e.by('yandex').fallback = unavailable('yandex', 'network');
    e.engine.updateSettings(settings({ voiceOrder: ['yandex', 'gemini'], voiceEnabled: { 'yandex-live': false, yandex: true, gemini: true } }));
    await flush(30);
    expect(e.scheds[0]!.removed).toHaveLength(0);
    expect(e.warnings.some((w) => w.kind === 'chunk-failed')).toBe(false);
  });

  it('removing the Yandex token (isConfigured false) disables yandex-live like voiceEnabled=false', async () => {
    const live = { 'yandex-live': true, yandex: true, gemini: false };
    const e = setup({ voiceOrder: ['yandex-live', 'yandex'], voiceEnabled: live });
    await e.engine.start();
    e.caps[0]!.emit(chunk(120)); // far enough ahead for the live prior (90 s + 5 s margin)
    await flush();
    expect(e.scheds[0]!.added[0]!.providerId).toBe('yandex-live');
    e.by('yandex-live').configured = false;
    e.engine.updateSettings(settings({ voiceOrder: ['yandex-live', 'yandex'], voiceEnabled: live }));
    await flush();
    expect(e.scheds[0]!.added.map((s) => s.providerId)).toEqual(['yandex']);
  });
});

describe('engine hooks and failure reporting', () => {
  it('onChunk sees every rechunked chunk (partial too) before the chain; onSegments sees provider results', async () => {
    const chunks: AudioChunk[] = [];
    const segs: Array<[DubSegment[], string]> = [];
    const order: string[] = [];
    const e = setup(
      {},
      {
        events: {
          onChunk: (c: AudioChunk) => {
            chunks.push(c);
            order.push('chunk');
          },
          onSegments: (s: DubSegment[], id: string) => {
            segs.push([s, id]);
            order.push('segments');
          },
        },
      },
    );
    e.by('gemini').script = [
      async () => {
        order.push('provider');
        return { segments: [seg(0)], sourceLang: 'en' };
      },
    ];
    await e.engine.start();
    e.caps[0]!.emit(chunk(0));
    await flush();
    expect(chunks).toHaveLength(1);
    expect(segs).toHaveLength(1);
    expect(segs[0]![1]).toBe('gemini');
    expect(order).toEqual(['chunk', 'provider', 'segments']);
  });

  it('a cell no tier can voice ends in a chunk-failed warning (never a silent hole)', async () => {
    const e = setup();
    for (const p of e.providers) p.fallback = unavailable(p.id, 'network');
    await e.engine.start();
    e.caps[0]!.emit(chunk(0));
    await flush(80);
    expect(e.warnings.some((w) => w.kind === 'chunk-failed')).toBe(true);
  });

  it('zero segments (no speech) is a finished cell: no scheduler call, no refetch', async () => {
    const e = setup();
    e.by('gemini').fallback = { segments: [], sourceLang: 'en' };
    await e.engine.start();
    e.caps[0]!.emit(chunk(0));
    await flush();
    e.caps[0]!.emit(chunk(0));
    await flush();
    expect(e.scheds[0]!.added).toHaveLength(0);
    expect(e.scheds[0]!.started).toBe(0);
    expect(e.by('gemini').calls).toHaveLength(1);
  });

  it('warns once when a dub arrives after its slot (late dub is kept for rewinds)', async () => {
    const e = setup();
    await e.engine.start();
    e.video.currentTime = 40;
    e.caps[0]!.emit(chunk(30)); // ends at 45: not stale; playhead is at 67% .. use 44 to be past 70%
    e.video.currentTime = 44;
    await flush();
    expect(e.scheds[0]!.added).toHaveLength(1);
    expect(e.warnings.filter((w) => w.kind === 'dub-late').length).toBeLessThanOrEqual(1);
  });
});

describe('latency-aware queue', () => {
  it('asks first for cells whose slot is still ahead when the answer arrives; a cell that would be entirely past waits (not dropped)', async () => {
    const clock = { t: 0 };
    const e = setup({}, { clock });
    e.by('gemini').script = [
      async () => {
        clock.t += 40_000;
        return { segments: [seg(0)], sourceLang: 'en' };
      },
    ];
    await e.engine.start();
    e.video.currentTime = 10;
    e.caps[0]!.emit(chunk(0));
    await flush();
    expect(e.by('gemini').calls).toHaveLength(1);
    e.by('gemini').script = ['hang', 'hang'];
    e.caps[0]!.emit(chunk(75));
    e.caps[0]!.emit(chunk(60));
    e.caps[0]!.emit(chunk(30)); // 10 + 40 > 45 => would arrive after its slot: requested last, only on a spare slot
    await flush();
    expect(e.by('gemini').calls.slice(1).map((c) => c.chunk.startSec).sort((a, b) => a - b)).toEqual([60, 75]);
    e.engine.stop();
  });
});
