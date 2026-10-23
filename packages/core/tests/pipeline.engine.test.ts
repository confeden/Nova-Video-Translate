import { beforeEach, describe, expect, it } from 'vitest';
import { TranslationEngine, type EngineWarning } from '../src/pipeline';
import { FakeCapture, FakeProvider, FakeScheduler, FakeVideo, chunk, flush, instantSleep, seg, settings, unavailable } from './helpers/pipelineFakes';
import type { CaptureOptions, CaptureStatus } from '../src/capture';
import type { Settings } from '../src/types';

function setup(over: Partial<Settings> = {}) {
  const video = new FakeVideo();
  const providers = [new FakeProvider('yandex-live'), new FakeProvider('yandex'), new FakeProvider('gemini')];
  const caps: FakeCapture[] = [];
  const capOpts: CaptureOptions[] = [];
  const scheds: FakeScheduler[] = [];
  const states: Array<[string, any]> = [];
  const warnings: EngineWarning[] = [];
  const cues: unknown[][] = [];
  const engine = new TranslationEngine({
    video: video as unknown as HTMLVideoElement,
    audioCtx: {} as AudioContext,
    providers,
    settings: settings({ voiceOrder: ['gemini', 'yandex', 'yandex-live'], ...over }),
    events: { onState: (s, d) => states.push([s, d]), onWarning: (w) => warnings.push(w), onSubtitles: (c) => cues.push(c) },
    createCapture: (async (_v: unknown, o: CaptureOptions = {}) => {
      const c = new FakeCapture();
      caps.push(c);
      capOpts.push(o);
      return c;
    }) as never,
    createScheduler: ((_v: unknown, _c: unknown, o: any) => {
      const s = new FakeScheduler(o);
      s.onStarve = o.onStarve;
      scheds.push(s);
      return s;
    }) as never,
    now: () => 0,
    sleep: instantSleep(),
    retryDelayMs: 10,
  });
  const by = (id: string) => providers.find((p) => p.id === id)!;
  return { video, engine, providers, by, caps, capOpts, scheds, states, warnings, cues };
}

describe('TranslationEngine', () => {
  let e: ReturnType<typeof setup>;
  beforeEach(() => {
    e = setup();
  });

  it('start: state, capture chunkSec, start from currentTime, scheduler volumes', async () => {
    e.video.currentTime = 42;
    await e.engine.start();
    expect(e.engine.state).toBe('starting');
    expect(e.caps[0]!.starts).toEqual([42]);
    expect(e.capOpts[0]!.chunkSec).toBe(15);
    expect(e.scheds[0]!.opts).toMatchObject({ translationVolume: 1, originalVolume: 0.3 });
  });

  it('translates a chunk: tier order, segments to scheduler, activeProvider in state detail', async () => {
    await e.engine.start();
    e.caps[0]!.emit(chunk(0));
    await flush();
    expect(e.by('gemini').calls).toHaveLength(1);
    expect(e.by('yandex').calls).toHaveLength(0);
    expect(e.scheds[0]!.added).toHaveLength(1);
    expect(e.scheds[0]!.started).toBe(1);
    expect(e.engine.state).toBe('translating');
    expect(e.engine.activeProvider).toBe('gemini');
    expect(e.states.at(-1)).toEqual(['translating', { provider: 'gemini', captureKind: 'mse' }]);
  });

  it('falls through to the next tier and reports the active one', async () => {
    e.by('gemini').fallback = unavailable('gemini', 'quota');
    await e.engine.start();
    e.caps[0]!.emit(chunk(0));
    await flush();
    expect(e.engine.activeProvider).toBe('yandex');
    expect(e.warnings.map((w) => w.kind)).toEqual(['quota-exhausted']);
  });

  it('subtitles are not requested by default and not forwarded', async () => {
    e.by('gemini').fallback = { segments: [seg(0)], sourceLang: 'en', subtitles: [{ start: 0, end: 1, text: 'x' }] };
    await e.engine.start();
    e.caps[0]!.emit(chunk(0));
    await flush();
    expect(e.by('gemini').calls[0]!.ctx.wantSubtitles).toBe(false);
    expect(e.cues).toHaveLength(0);
  });

  it('subtitles on: requested and forwarded', async () => {
    const s = setup({ subtitles: 'on' });
    s.by('gemini').fallback = { segments: [seg(0)], sourceLang: 'en', subtitles: [{ start: 0, end: 1, text: 'x' }] };
    await s.engine.start();
    s.caps[0]!.emit(chunk(0));
    await flush();
    expect(s.by('gemini').calls[0]!.ctx.wantSubtitles).toBe(true);
    expect(s.cues).toHaveLength(1);
    expect(s.cues[0]).toHaveLength(1);
  });

  it('never re-translates a chunk already done or pending', async () => {
    await e.engine.start();
    e.caps[0]!.emit(chunk(0));
    e.caps[0]!.emit(chunk(0));
    await flush();
    e.caps[0]!.emit(chunk(0));
    await flush();
    expect(e.by('gemini').calls).toHaveLength(1);
  });

  it('queue: concurrency 2, nearest-to-playhead first, stale chunks dropped', async () => {
    e.video.currentTime = 105;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    e.by('gemini').script = [async () => (await gate, { segments: [seg(105)], sourceLang: 'en' }), 'hang'];
    await e.engine.start();
    const cap = e.caps[0]!;
    cap.emit(chunk(105));
    cap.emit(chunk(120));
    cap.emit(chunk(60)); // ends at 75 < 104 => stale, never queued
    cap.emit(chunk(165));
    cap.emit(chunk(135));
    cap.emit(chunk(150));
    await flush();
    expect(e.by('gemini').calls.map((c) => c.chunk.startSec)).toEqual([105, 120]);
    e.by('gemini').script = ['hang', 'hang'];
    release();
    await flush();
    expect(e.by('gemini').calls.map((c) => c.chunk.startSec)).toEqual([105, 120, 135]);
    e.engine.stop();
  });

  it('chunks that went stale while queued are dropped when a slot frees up', async () => {
    e.video.currentTime = 0;
    e.by('gemini').script = [{ segments: [seg(0)], sourceLang: 'en' }, 'hang'];
    await e.engine.start();
    const cap = e.caps[0]!;
    cap.emit(chunk(0));
    cap.emit(chunk(15));
    cap.emit(chunk(30));
    cap.emit(chunk(45));
    e.video.currentTime = 100; // 30 and 45 become stale before a slot frees
    await flush();
    const started = e.by('gemini').calls.map((c) => c.chunk.startSec);
    expect(started).toEqual([0, 15]);
    e.engine.stop();
  });

  it('retries a chunk that no tier could translate (max 3 retries), staying in buffering', async () => {
    for (const p of e.providers) p.fallback = unavailable(p.id, 'network');
    await e.engine.start();
    e.caps[0]!.emit(chunk(0));
    await flush(40);
    expect(e.engine.state).toBe('buffering');
    expect(e.warnings.some((w) => w.kind === 'no-provider')).toBe(true);
    const total = e.providers.reduce((n, p) => n + p.calls.length, 0);
    expect(total).toBeLessThanOrEqual(12);
    await flush(40);
    expect(e.providers.reduce((n, p) => n + p.calls.length, 0)).toBe(total);
  });

  it('recovers from buffering when a tier comes back', async () => {
    e.by('gemini').script = [unavailable('gemini', 'network'), unavailable('gemini', 'network')];
    for (const id of ['yandex', 'yandex-live']) e.by(id).configured = false;
    await e.engine.start();
    e.caps[0]!.emit(chunk(0));
    await flush(30);
    expect(e.engine.state).toBe('translating');
    expect(e.states.map((s) => s[0])).toContain('buffering');
    expect(e.scheds[0]!.added).toHaveLength(1);
  });

  it('already-russian: stops everything, disposes scheduler (restores volume), keeps capture off', async () => {
    e.by('gemini').fallback = { segments: [], sourceLang: 'ru' };
    await e.engine.start();
    e.caps[0]!.emit(chunk(0));
    await flush();
    expect(e.engine.state).toBe('skipped-ru');
    expect(e.warnings.map((w) => w.kind)).toEqual(['already-russian']);
    expect(e.caps[0]!.stopped).toBe(true);
    expect(e.scheds[0]!.disposed).toBe(1);
    expect(e.scheds[0]!.started).toBe(0);
    e.caps[0]!.emit(chunk(15));
    await flush();
    expect(e.by('gemini').calls).toHaveLength(1);
  });

  it('seek far outside the covered range restarts capture and clears the queue', async () => {
    e.by('gemini').script = ['hang', 'hang'];
    await e.engine.start();
    const cap = e.caps[0]!;
    cap.emit(chunk(0));
    cap.emit(chunk(15));
    cap.emit(chunk(30));
    await flush();
    e.video.currentTime = 500;
    e.video.dispatchEvent(new Event('seeked'));
    await flush();
    expect(cap.starts).toEqual([0, 500]);
    cap.emit(chunk(495));
    await flush();
    expect(e.by('gemini').calls.map((c) => c.chunk.startSec)).toEqual([0, 15, 495]);
    expect(e.engine.state).toBe('translating');
  });

  it('short seek inside the covered range does not restart capture', async () => {
    await e.engine.start();
    e.caps[0]!.emit(chunk(0));
    await flush();
    e.video.currentTime = 20;
    e.video.dispatchEvent(new Event('seeked'));
    await flush();
    expect(e.caps[0]!.starts).toEqual([0]);
  });

  it('stop is idempotent and tears everything down', async () => {
    await e.engine.start();
    e.engine.stop();
    e.engine.stop();
    expect(e.engine.state).toBe('stopped');
    expect(e.caps[0]!.stopped).toBe(true);
    expect(e.scheds[0]!.disposed).toBe(1);
    expect(e.states.filter((s) => s[0] === 'stopped')).toHaveLength(1);
    e.caps[0]!.emit(chunk(0));
    await flush();
    expect(e.by('gemini').calls).toHaveLength(0);
  });

  it('stop aborts in-flight requests', async () => {
    e.by('gemini').script = ['hang'];
    await e.engine.start();
    e.caps[0]!.emit(chunk(0));
    await flush();
    e.engine.stop();
    await flush();
    expect(e.engine.state).toBe('stopped');
    expect(e.scheds[0]!.added).toHaveLength(0);
  });

  it('updateSettings: live volume, next-chunk tier order, token change resets auth skip', async () => {
    e.by('gemini').script = [unavailable('gemini', 'auth')];
    await e.engine.start();
    e.caps[0]!.emit(chunk(0));
    await flush();
    expect(e.warnings.map((w) => w.kind)).toEqual(['auth-required']);
    e.caps[0]!.emit(chunk(15));
    await flush();
    expect(e.by('gemini').calls).toHaveLength(1); // skipped for the session
    e.engine.updateSettings(settings({ voiceOrder: ['gemini', 'yandex', 'yandex-live'], translationVolume: 0.5, yandexToken: 'new' }));
    expect(e.scheds[0]!.volume).toBe(0.5);
    e.caps[0]!.emit(chunk(30));
    await flush();
    expect(e.by('gemini').calls).toHaveLength(2);
    e.engine.updateSettings(settings({ voiceOrder: ['yandex', 'gemini', 'yandex-live'], yandexToken: 'new' }));
    e.caps[0]!.emit(chunk(45));
    await flush();
    expect(e.by('yandex').calls.at(-1)!.chunk.startSec).toBe(45);
  });

  it('updateSettings: original volume change rebuilds the scheduler with the same segments', async () => {
    await e.engine.start();
    e.caps[0]!.emit(chunk(0));
    await flush();
    e.engine.updateSettings(settings({ voiceOrder: ['gemini', 'yandex', 'yandex-live'], originalVolume: 0.1 }));
    expect(e.scheds[0]!.disposed).toBe(1);
    expect(e.scheds[1]!.opts.originalVolume).toBe(0.1);
    expect(e.scheds[1]!.added).toHaveLength(1);
    expect(e.scheds[1]!.started).toBe(1);
  });

  it('scheduler starve nudges the queue', async () => {
    e.by('gemini').script = ['hang', 'hang'];
    await e.engine.start();
    e.caps[0]!.emit(chunk(0));
    e.caps[0]!.emit(chunk(15));
    await flush();
    e.scheds[0]!.onStarve?.(0);
    expect(e.by('gemini').calls).toHaveLength(2);
    e.engine.stop();
  });

  it('capture tainted: warns and tries the next strategy; none left => error', async () => {
    const statusCbs: Array<(s: CaptureStatus) => void> = [];
    const kinds: string[][] = [];
    const caps: FakeCapture[] = [];
    const warnings: EngineWarning[] = [];
    const states: string[] = [];
    const engine = new TranslationEngine({
      video: new FakeVideo() as unknown as HTMLVideoElement,
      audioCtx: {} as AudioContext,
      providers: [new FakeProvider('gemini')],
      settings: settings(),
      events: { onState: (s) => states.push(s), onWarning: (w) => warnings.push(w) },
      createCapture: (async (_v: unknown, o: CaptureOptions = {}) => {
        kinds.push(o.strategies ?? []);
        statusCbs.push(o.onStatus!);
        const c = new FakeCapture();
        c.kind = (o.strategies ?? [])[0] ?? 'realtime';
        caps.push(c);
        return c;
      }) as never,
      createScheduler: (() => new FakeScheduler()) as never,
      sleep: instantSleep(),
    });
    await engine.start();
    statusCbs[0]!({ type: 'tainted' });
    await flush();
    expect(warnings.map((w) => w.kind)).toEqual(['capture-tainted']);
    expect(kinds[1]).toEqual(['direct', 'realtime']);
    expect(caps[0]!.stopped).toBe(true);
    statusCbs[1]!({ type: 'tainted' }); // direct tainted
    await flush();
    expect(kinds[2]).toEqual(['realtime']);
    statusCbs[2]!({ type: 'tainted' }); // realtime tainted => nothing left
    await flush();
    expect(engine.state).toBe('error');
    expect(warnings.filter((w) => w.kind === 'capture-tainted')).toHaveLength(3);
  });

  it('capture creation failure => error state', async () => {
    const engine = new TranslationEngine({
      video: new FakeVideo() as unknown as HTMLVideoElement,
      audioCtx: {} as AudioContext,
      providers: [],
      settings: settings(),
      createCapture: (async () => {
        throw new Error('no capture strategy available');
      }) as never,
      createScheduler: (() => new FakeScheduler()) as never,
    });
    await engine.start();
    expect(engine.state).toBe('error');
    expect(engine.lastError).toContain('no capture');
  });

  it('grid: windows from a mid-cell start are re-cut into fixed cells; a second session sees identical boundaries', async () => {
    const win = (start: number, dur: number) => ({ startSec: start, durationSec: dur, sampleRate: 16000, pcm: new Int16Array(8) });
    const starts = async (from: number) => {
      const x = setup();
      x.video.currentTime = from;
      await x.engine.start();
      for (let t = from; t < 70; t += 10) x.caps[0]!.emit(win(t, 10));
      await flush();
      x.engine.stop();
      return x.by('gemini').calls.map((c) => [c.chunk.startSec, c.chunk.durationSec, !!c.chunk.partial]);
    };
    const a = await starts(3.5);
    const b = await starts(31.2);
    expect(a[0]).toEqual([3.5, 11.5, true]);
    const full = (l: unknown[][]) => l.filter((c) => !c[2]).map((c) => c[0]);
    expect(full(a)).toEqual([15, 30, 45]);
    expect(full(b)).toEqual([45]);
    for (const k of full(b)) expect(full(a)).toContain(k);
    expect(full(a).every((k) => (k as number) % 15 === 0)).toBe(true);
  });
});
