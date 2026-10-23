import { describe, expect, it } from 'vitest';
import { diag } from '../src/diag';
import { TranslationEngine, YANDEX_MAX_PARALLEL } from '../src/pipeline';
import { FakeCapture, FakeProvider, FakeScheduler, FakeVideo, chunk, flush, seg, settings } from './helpers/pipelineFakes';
import type { Settings } from '../src/types';

class PVideo extends FakeVideo {
  ended = false;
  pauses = 0;
  plays = 0;
  pause(): void {
    this.paused = true;
    this.pauses++;
    this.dispatchEvent(new Event('pause'));
  }
  play(): Promise<void> {
    this.paused = false;
    this.plays++;
    this.dispatchEvent(new Event('play'));
    return Promise.resolve();
  }
}

/** short waits (the resume delay) resolve at once; long ones (the preroll timeout) stay pending until aborted */
const shortSleep = async (ms: number, signal: AbortSignal): Promise<void> => {
  if (ms < 30_000) return;
  await new Promise<void>((_, rej) => signal.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))));
};

function setup(over: Partial<Settings> = {}, extra: { maxParallelYandex?: number; sleep?: (ms: number, s: AbortSignal) => Promise<void>; hintSleep?: (ms: number, s: AbortSignal) => Promise<void> } = {}) {
  const video = new PVideo();
  const providers = [new FakeProvider('yandex-live'), new FakeProvider('yandex'), new FakeProvider('gemini')];
  const caps: FakeCapture[] = [];
  const scheds: FakeScheduler[] = [];
  const states: Array<[string, any]> = [];
  const clock = { t: 0 };
  const engine = new TranslationEngine({
    video: video as unknown as HTMLVideoElement,
    audioCtx: { state: 'running' } as AudioContext,
    yandexSuperCells: 1,
    providers,
    settings: settings({ voiceOrder: ['yandex', 'yandex-live', 'gemini'], voiceEnabled: { 'yandex-live': false, yandex: true, gemini: false }, ...over }),
    events: { onState: (s, d) => states.push([s, d]) },
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
    sleep: extra.sleep ?? shortSleep,
    retryDelayMs: 10,
    maxParallelYandex: extra.maxParallelYandex,
    latencyPriors: { yandex: 22, 'yandex-live': 22, gemini: 12 },
    hintSleep: extra.hintSleep,
  });
  const yandex = providers.find((p) => p.id === 'yandex')!;
  return { video, engine, yandex, caps, scheds, states, clock };
}

const cells = (e: { yandex: FakeProvider }) => e.yandex.calls.map((c) => c.chunk.startSec);

describe('Yandex throughput', () => {
  it('runs up to 5 chunks in flight from the very first request (not 2)', async () => {
    const e = setup();
    e.yandex.script = Array(10).fill('hang');
    await e.engine.start();
    for (let k = 0; k < 8; k++) e.caps[0]!.emit(chunk(k * 15));
    await flush();
    expect(YANDEX_MAX_PARALLEL).toBe(5);
    expect(e.yandex.calls).toHaveLength(5);
    e.engine.stop();
  });

  it('maxParallelYandex is configurable', async () => {
    const e = setup({}, { maxParallelYandex: 3 });
    e.yandex.script = Array(10).fill('hang');
    await e.engine.start();
    for (let k = 0; k < 8; k++) e.caps[0]!.emit(chunk(k * 15));
    await flush();
    expect(e.yandex.calls).toHaveLength(3);
    e.engine.stop();
  });

  it('fast answers do not shrink the window below the floor of 5 in flight', async () => {
    const e = setup();
    e.yandex.script = [
      async () => {
        e.clock.t += 3000; // measured latency 3 s: the cap floor (5) still applies
        return { segments: [seg(0)], sourceLang: 'en' };
      },
    ];
    await e.engine.start();
    e.caps[0]!.emit(chunk(0));
    await flush();
    e.yandex.script = Array(10).fill('hang');
    for (let k = 1; k < 9; k++) e.caps[0]!.emit(chunk(k * 15));
    await flush();
    expect(e.yandex.calls).toHaveLength(1 + 5);
    e.engine.stop();
  });

  it('backs off after HTTP 429: parallelism is halved, and restored a minute later', async () => {
    const e = setup();
    e.yandex.script = [new Error('translate: HTTP 429'), ...Array(20).fill('hang')];
    await e.engine.start();
    e.caps[0]!.emit(chunk(0));
    await flush();
    const before = e.yandex.calls.length; // the 429 attempt and its retry (hanging)
    expect(before).toBe(2);
    for (let k = 1; k < 8; k++) e.caps[0]!.emit(chunk(k * 15));
    await flush();
    // 5 -> 2: the hanging retry of cell 0 plus one more
    const added = e.yandex.calls.length - before;
    expect(added).toBe(1);
    e.clock.t += 61_000;
    e.caps[0]!.emit(chunk(195));
    await flush();
    expect(e.yandex.calls.length - before).toBeGreaterThan(added);
    e.engine.stop();
  });
});

describe('time-ordered scheduling with latency', () => {
  it('feasible cells (slot start >= now + latency + margin) go in time order, then partly-late, then entirely-late; nothing dropped', async () => {
    const e = setup({}, { maxParallelYandex: 1 });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    e.yandex.script = [async () => (await gate, { segments: [seg(300)], sourceLang: 'en' })];
    await e.engine.start();
    e.video.currentTime = 0;
    e.caps[0]!.emit(chunk(300)); // occupies the only slot
    await flush();
    // initial latency guess 22 s => a dub requested now arrives at 22 s; feasible slot starts are >= 25
    for (const s of [60, 0, 45, 15, 30]) e.caps[0]!.emit(chunk(s));
    await flush();
    release();
    await flush(40);
    expect(cells(e)).toEqual([300, 30, 45, 60, 15, 0]);
    e.engine.stop();
  });

  it('a late cell is kept (not dropped) while the playhead has not passed its end, and requested on a spare slot', async () => {
    const e = setup({}, { maxParallelYandex: 2 });
    e.yandex.script = ['hang', 'hang'];
    await e.engine.start();
    e.video.currentTime = 100;
    e.caps[0]!.emit(chunk(300));
    e.caps[0]!.emit(chunk(90)); // ends 105 > ct, but a dub arrives at 122: late, entirely past => lowest priority
    await flush();
    // 2 slots: the feasible cell takes one, the late cell must not take the last free slot
    expect(cells(e)).toEqual([300]);
    e.yandex.script = ['hang'];
    e.caps[0]!.emit(chunk(315));
    await flush();
    expect(cells(e)).toEqual([300, 315]);
    e.engine.stop();
  });

  it('saturated queue: entirely-late cells are dropped, feasible ones all survive', async () => {
    const e = setup({}, { maxParallelYandex: 1 });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    e.yandex.script = [async () => (await gate, { segments: [seg(900)], sourceLang: 'en' })];
    await e.engine.start();
    e.video.currentTime = 100;
    e.caps[0]!.emit(chunk(900));
    await flush();
    for (const late of [90, 105]) e.caps[0]!.emit(chunk(late)); // entirely late on arrival (ct + 22 = 122)
    for (let k = 0; k < 10; k++) e.caps[0]!.emit(chunk(135 + k * 15)); // feasible (>= 125)
    await flush();
    release();
    await flush(80);
    const started = cells(e).filter((s) => s !== 900);
    expect(started.filter((s) => s >= 125)).toEqual([...Array(10)].map((_, k) => 135 + k * 15));
    expect(started.filter((s) => s < 125)).toEqual([]); // 12 queued > 10: the two late ones were dropped
    e.engine.stop();
  });
});

describe('preroll pause and the preparing status', () => {
  const run = async (prerollPause: 'on' | 'off', ct = 1000) => {
    const e = setup({ prerollPause });
    e.video.currentTime = ct;
    e.video.paused = false;
    await e.engine.start();
    return e;
  };

  it('off: the video is not touched; status stays starting (preparing, with ETA) until a dub covers the playhead', async () => {
    const e = await run('off');
    expect(e.video.pauses).toBe(0);
    e.caps[0]!.emit(chunk(1050));
    await flush();
    const last = e.states.at(-1)!;
    expect(last[0]).toBe('starting');
    expect(last[1]).toMatchObject({ preparing: true, prerollPaused: false });
    expect(last[1].etaSec).toBeGreaterThanOrEqual(0);
    // a result for a FUTURE cell does not end the preparing status
    expect(e.engine.state).toBe('starting');
    // the playhead reaches that cell: it is now covered
    e.video.currentTime = 1051;
    e.video.dispatchEvent(new Event('timeupdate'));
    expect(e.engine.state).toBe('translating');
    e.engine.stop();
  });

  it('on: pauses at start, resumes once the dub covering the playhead is ready', async () => {
    const e = await run('on');
    expect(e.video.pauses).toBe(1);
    expect(e.video.paused).toBe(true);
    expect(e.states.some(([s, d]) => s === 'starting' && d?.prerollPaused)).toBe(true);
    e.caps[0]!.emit(chunk(990));
    await flush();
    expect(e.engine.state).toBe('translating');
    expect(e.video.plays).toBe(1);
    expect(e.video.paused).toBe(false);
    e.engine.stop();
  });

  it('on: does not pause a video that is already paused, and never resumes it', async () => {
    const e = setup({ prerollPause: 'on' });
    e.video.paused = true;
    await e.engine.start();
    expect(e.video.pauses).toBe(0);
    e.caps[0]!.emit(chunk(0));
    await flush();
    expect(e.video.plays).toBe(0);
    e.engine.stop();
  });

  it('on: the user pressing play cancels the preroll; pausing again by hand is never undone', async () => {
    const e = await run('on');
    void e.video.play(); // user
    expect(e.video.plays).toBe(1);
    e.video.pause(); // user pauses manually
    e.caps[0]!.emit(chunk(990));
    await flush();
    expect(e.video.plays).toBe(1);
    expect(e.video.paused).toBe(true);
    e.engine.stop();
    expect(e.video.plays).toBe(1);
  });

  it('on: stop() during the preroll resumes the video we paused (the user did not touch it)', async () => {
    const e = await run('on');
    e.engine.stop();
    await flush();
    expect(e.video.plays).toBe(1);
    expect(e.video.paused).toBe(false);
  });

  it('on: gives up after the timeout and resumes', async () => {
    let fire!: () => void;
    const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
      ms >= 30_000
        ? new Promise<void>((res, rej) => {
            fire = res;
            signal.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
          })
        : Promise.resolve();
    const e = setup({ prerollPause: 'on' }, { sleep });
    e.video.paused = false;
    await e.engine.start();
    expect(e.video.paused).toBe(true);
    fire();
    await flush();
    expect(e.video.plays).toBe(1);
    e.engine.stop();
  });
});

describe('slow-start hint', () => {
  it('after 40 s of starting on Yandex the preparing detail says slow; ready clears it', async () => {
    let fire!: () => void;
    const hintSleep = (_ms: number, signal: AbortSignal): Promise<void> =>
      new Promise<void>((res, rej) => {
        fire = res;
        signal.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
      });
    const e = setup({}, { hintSleep });
    e.yandex.script = ['hang'];
    await e.engine.start();
    e.caps[0]!.emit(chunk(0));
    await flush();
    expect(e.states.at(-1)![1].slow).toBeUndefined();
    e.clock.t = 41_000;
    fire();
    await flush();
    expect(e.states.at(-1)![0]).toBe('starting');
    expect(e.states.at(-1)![1]).toMatchObject({ preparing: true, slow: 'wait' });
    e.engine.stop();
  });
});
