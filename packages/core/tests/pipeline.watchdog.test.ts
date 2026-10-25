import { afterEach, describe, expect, it, vi } from 'vitest';
import { diag } from '../src/diag';
import { TranslationEngine, STALL_RESTART_GAP_MS, STALL_NO_CHUNK_SEC, HEALTH_EVERY_MS } from '../src/pipeline';
import { localReasons, reasonText } from '../src/localasr';
import type { CaptureOptions, CaptureStatus } from '../src/capture';
import { FakeCapture, FakeProvider, FakeScheduler, FakeVideo, flush, instantSleep, settings } from './helpers/pipelineFakes';

function setup(host = 'example.com', firstKind: 'hls' | 'mse' | 'realtime' = 'mse') {
  const video = new FakeVideo();
  let clock = 1_000_000;
  const caps: Array<FakeCapture & { opts: CaptureOptions }> = [];
  const engine = new TranslationEngine({
    video: video as unknown as HTMLVideoElement,
    audioCtx: {} as AudioContext,
    providers: [new FakeProvider('gemini')],
    settings: settings({ voiceOrder: ['gemini'] }),
    host,
    createCapture: (async (_v: unknown, o: CaptureOptions = {}) => {
      const c = Object.assign(new FakeCapture(), { opts: o });
      const only = o.strategies?.length === 1 ? o.strategies[0] : undefined;
      c.kind = only ?? (caps.length === 0 ? firstKind : 'realtime');
      caps.push(c);
      return c;
    }) as never,
    createScheduler: ((_v: unknown, _c: unknown, o: any) => {
      const s = new FakeScheduler(o);
      s.onStarve = o.onStarve;
      return s;
    }) as never,
    now: () => clock,
    sleep: instantSleep(),
    retryDelayMs: 10,
    hlsProbeEveryMs: 20,
    hlsProbeRunMs: 60_000,
    watchdogMs: 3_600_000, // the tests call watchdogTick() themselves
  });
  return { engine, caps, video, advance: (ms: number) => (clock += ms) };
}
const status = (c: { opts: CaptureOptions }, s: CaptureStatus): void => c.opts.onStatus!(s);

afterEach(() => localReasons.clearAll());

describe('hls fallbacks all go through the background probe', () => {
  for (const reason of ['tainted', 'poll', 'offline', 'forbidden', 'align-failed']) {
    it(`'${reason}' -> realtime meanwhile -> probe -> back to hls`, async () => {
      const { engine, caps } = setup('example.com', 'hls');
      await engine.start();
      expect(caps[0]!.kind).toBe('hls');
      status(caps[0]!, { type: 'unsupported', reason });
      await vi.waitFor(() => expect(caps.length).toBeGreaterThanOrEqual(2));
      expect(caps[1]!.kind).toBe('realtime');
      await vi.waitFor(() => expect(caps.length).toBeGreaterThanOrEqual(3));
      expect(caps[2]!.opts.strategies).toEqual(['hls']);
      status(caps[2]!, { type: 'aligned' });
      await vi.waitFor(() => expect(caps.length).toBeGreaterThanOrEqual(4));
      expect(caps[1]!.stopped).toBe(true);
      engine.stop();
    });
  }

  it('createCapture falling to realtime on a twitch page (hls transport/token error) also arms the probe', async () => {
    const { engine, caps } = setup('www.twitch.tv', 'realtime');
    await engine.start();
    expect(caps[0]!.kind).toBe('realtime');
    await vi.waitFor(() => expect(caps.some((c) => c.opts.strategies?.length === 1 && c.opts.strategies[0] === 'hls')).toBe(true));
    engine.stop();
  });
});

describe('watchdog', () => {
  it('no chunk for 25 s while playing: diag stall, capture restarted, reason shown; at most one restart per 30 s', async () => {
    diag.clear();
    const { engine, caps, advance } = setup();
    await engine.start();
    await flush();
    const n0 = caps.length;
    advance((STALL_NO_CHUNK_SEC - 5) * 1000);
    engine.watchdogTick();
    expect(caps.length).toBe(n0);
    advance(6_000);
    engine.watchdogTick();
    await flush();
    const st = diag.entries().filter((e) => e.ev === 'stall');
    expect(st).toHaveLength(1);
    expect(st[0]!.data).toMatchObject({ what: 'no-chunks', capture: 'mse', state: expect.any(String) });
    expect(caps.length).toBe(n0 + 1);
    expect(caps[n0 - 1]!.stopped).toBe(true);
    expect(localReasons.first()?.text).toBe(reasonText.restart());
    advance(10_000);
    engine.watchdogTick();
    await flush();
    expect(caps.length).toBe(n0 + 1); // rate limited
    advance(STALL_RESTART_GAP_MS);
    engine.watchdogTick();
    await flush();
    expect(caps.length).toBe(n0 + 2);
    // the first chunk of the new capture clears the reason
    caps[n0 + 1]!.emit({ startSec: 0, durationSec: 15, sampleRate: 16000, pcm: new Int16Array(16) });
    expect(localReasons.first()).toBeUndefined();
    engine.stop();
  });

  it('a paused video never counts as a stall', async () => {
    diag.clear();
    const { engine, video, advance } = setup();
    await engine.start();
    video.paused = true;
    advance(120_000);
    engine.watchdogTick();
    expect(diag.entries().some((e) => e.ev === 'stall')).toBe(false);
    engine.stop();
  });

  it('chunks with speech but no dub for 60 s: stall no-dubs; the local ASR reset hook is called', async () => {
    diag.clear();
    const reset = vi.fn(async () => {});
    const video = new FakeVideo();
    let clock = 5_000_000;
    const caps: Array<FakeCapture & { opts: CaptureOptions }> = [];
    const prov = new FakeProvider('gemini');
    prov.fallback = new Error('boom');
    const engine = new TranslationEngine({
      video: video as unknown as HTMLVideoElement,
      audioCtx: {} as AudioContext,
      providers: [prov],
      settings: settings({ voiceOrder: ['gemini'] }),
      host: 'example.com',
      createCapture: (async (_v: unknown, o: CaptureOptions = {}) => {
        const c = Object.assign(new FakeCapture(), { opts: o });
        caps.push(c);
        return c;
      }) as never,
      createScheduler: ((_v: unknown, _c: unknown, o: any) => new FakeScheduler(o)) as never,
      now: () => clock,
      sleep: instantSleep(),
      retryDelayMs: 10,
      watchdogMs: 3_600_000,
      resetLocalAsr: reset,
    });
    await engine.start();
    const loud = new Int16Array(1600).fill(8000);
    const emit = (): void => caps[caps.length - 1]!.emit({ startSec: 0, durationSec: 15, sampleRate: 16000, pcm: loud });
    emit();
    for (let i = 0; i < 4; i++) {
      clock += 20_000;
      emit();
      engine.watchdogTick();
    }
    await flush();
    const st = diag.entries().filter((e) => e.ev === 'stall');
    expect(st.map((e) => (e.data as { what: string }).what)).toContain('no-dubs');
    expect(reset).toHaveBeenCalled();
    engine.stop();
  });

  it('health line every 30 s with counters', async () => {
    diag.clear();
    const { engine, caps, advance } = setup();
    await engine.start();
    caps[0]!.emit({ startSec: 0, durationSec: 15, sampleRate: 16000, pcm: new Int16Array(16) });
    advance(HEALTH_EVERY_MS + 1);
    engine.watchdogTick();
    const h = diag.entries().filter((e) => e.ev === 'health');
    expect(h).toHaveLength(1);
    expect(h[0]!.data).toMatchObject({ chunksOut: 1, dubsScheduled: 0, adsState: false, capture: 'mse', playing: true });
    expect(Object.keys(h[0]!.data as object)).toEqual(expect.arrayContaining(['lastChunkAgoSec', 'lastDubAgoSec', 'asrQueue', 'aligned']));
    engine.stop();
  });

  it('realtime capture on a live twitch page with >=3 late dubs: stall late-dubs and hls is restored (excluded cleared)', async () => {
    diag.clear();
    const { engine, caps, advance } = setup('www.twitch.tv', 'realtime');
    await engine.start();
    await flush();
    (engine as any).wd.lateDubs = 3;
    advance(1000);
    caps[0]!.emit({ startSec: 0, durationSec: 15, sampleRate: 16000, pcm: new Int16Array(16) });
    engine.watchdogTick();
    await flush();
    const st = diag.entries().filter((e) => e.ev === 'stall');
    expect(st.some((e) => (e.data as { what: string }).what === 'late-dubs')).toBe(true);
    const open = diag.entries().filter((e) => e.ev === 'capture-open').pop()!;
    expect((open.data as { strategies: string[] }).strategies).toContain('hls');
    engine.stop();
  });

  it('ads state held for > 5 min is treated as stuck and cleared by the restart', async () => {
    diag.clear();
    const { engine, caps, advance } = setup('example.com', 'hls');
    await engine.start();
    status(caps[0]!, { type: 'ads', active: true });
    expect(localReasons.first()?.key).toBe('ads');
    advance(310_000);
    engine.watchdogTick();
    await flush();
    expect(diag.entries().some((e) => e.ev === 'stall' && (e.data as { what: string }).what === 'ads-stuck')).toBe(true);
    expect(localReasons.first()?.key).not.toBe('ads');
    engine.stop();
  });
});
