import { describe, expect, it } from 'vitest';
import { TranslationEngine } from '../src/pipeline';
import type { ChunkResult, SubtitleCue } from '../src/providers/types';
import { FakeCapture, FakeProvider, FakeScheduler, FakeVideo, chunk, flush, seg, settings } from './helpers/pipelineFakes';

class Video extends FakeVideo {
  duration = 1000;
  ended = false;
  plays = 0;
  pauses = 0;
  pause(): void { this.paused = true; this.pauses++; this.dispatchEvent(new Event('pause')); }
  play(): Promise<void> { this.paused = false; this.plays++; this.dispatchEvent(new Event('play')); return Promise.resolve(); }
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> => ms < 1000 ? Promise.resolve() :
  new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }));

function setup(localEnabled = false, wait = true, video = new Video()) {
  const cloud = new FakeProvider('gemini');
  const local = new FakeProvider('local');
  const capture = new FakeCapture();
  const scheduler = new FakeScheduler();
  const schedulerRef = { current: scheduler };
  const subtitles: SubtitleCue[][] = [];
  const s = settings({ prerollPause: wait ? 'on' : 'off', voiceOrder: ['gemini', 'local'],
    voiceEnabled: { gemini: true, local: localEnabled, groq: false, yandex: false, 'yandex-live': false } });
  const engine = new TranslationEngine({ video: video as unknown as HTMLVideoElement, audioCtx: {} as AudioContext,
    providers: [cloud, local], settings: s, events: { onSubtitles: (cues) => subtitles.push(cues) }, createCapture: (async () => capture) as never,
    createScheduler: (() => schedulerRef.current) as never, now: () => 0, sleep });
  return { video, cloud, local, capture, scheduler, schedulerRef, engine, s, subtitles };
}

describe('wait for voice throughout playback', () => {
  it('resumes a ten-hour video from the local buffer at the saved pause position while clouds and later cells are pending', async () => {
    class ZeroOnPauseVideo extends Video {
      held = 0;
      pause(): void { this.held = this.currentTime; super.pause(); this.currentTime = 0; }
      play(): Promise<void> { this.currentTime = this.held; return super.play(); }
    }
    const video = new ZeroOnPauseVideo();
    video.duration = 36_000;
    video.currentTime = 13_452;
    Object.assign(video, { readyState: 4, buffered: { length: 1, start: () => 13_430, end: () => 13_470 } });
    const e = setup(true, true, video);
    e.cloud.script = ['hang', 'hang'];
    e.local.script = [async () => ({ segments: [seg(13_452, 13_455)] }), 'hang'];
    await e.engine.start();
    expect(video.currentTime).toBe(0);
    expect(e.capture.starts).toEqual([13_452]);
    e.capture.emit(chunk(13_450, 5));
    e.capture.emit(chunk(13_455));
    await flush();
    expect(video.plays).toBe(1);
    expect(video.paused).toBe(false);
    expect(video.currentTime).toBe(13_452);
    expect(e.cloud.calls[0]!.ctx.signal.aborted).toBe(false);
    expect(e.local.calls).toHaveLength(2);
    expect(e.local.calls[1]!.ctx.signal.aborted).toBe(false);
    e.engine.stop();
  });

  it('does not pause a zero position before YouTube has restored loaded media', async () => {
    const video = new Video();
    Object.assign(video, { readyState: 0, buffered: { length: 0, start: () => 0, end: () => 0 } });
    const e = setup(true, true, video);
    e.cloud.script = ['hang'];
    e.local.script = [async () => ({ segments: [seg(300, 303)] })];
    await e.engine.start();
    expect(video.pauses).toBe(0);
    video.currentTime = 300;
    Object.assign(video, { readyState: 4, buffered: { length: 1, start: () => 300, end: () => 330 } });
    video.dispatchEvent(new Event('loadeddata'));
    expect(video.paused).toBe(true);
    e.capture.emit(chunk(300));
    await flush();
    expect(video.plays).toBe(1);
    e.engine.stop();
  });

  it('resumes on a ready dub tail extending past the source cell boundary', async () => {
    const e = setup(true);
    e.video.currentTime = 1005.021;
    e.cloud.script = ['hang'];
    e.local.script = [async () => ({ segments: [seg(1004, 1008)] })];
    await e.engine.start();
    e.capture.emit(chunk(990));
    await flush();
    expect(e.video.paused).toBe(false);
    expect(e.video.plays).toBe(1);
    e.engine.stop();
  });

  it('actively decodes the nearest local dub while paused before resuming', async () => {
    const e = setup(true);
    let decoded!: (ready: boolean) => void;
    const positions: number[] = [];
    Object.assign(e.scheduler, { prepareUpgrade: (_s: unknown, at: number) => {
      positions.push(at);
      return new Promise<boolean>((r) => { decoded = r; });
    } });
    e.cloud.script = ['hang'];
    e.local.script = [async () => ({ segments: [seg(0, 3)] })];
    await e.engine.start();
    e.capture.emit(chunk(0));
    await flush();
    expect(positions).toEqual([0]);
    expect(e.video.paused).toBe(true);
    decoded(true);
    await flush();
    expect(e.video.plays).toBe(1);
    e.engine.stop();
  });

  it('honors an actual seek to zero during its own pause', async () => {
    const e = setup(true);
    e.video.currentTime = 300;
    e.cloud.script = ['hang'];
    e.local.script = [async () => ({ segments: [seg(0, 3)] })];
    await e.engine.start();
    e.video.currentTime = 0;
    e.video.dispatchEvent(new Event('seeked'));
    e.capture.emit(chunk(0));
    await flush();
    expect(e.video.currentTime).toBe(0);
    expect(e.video.plays).toBe(1);
    e.engine.stop();
  });

  it('restarts paused preparation when changing original volume rebuilds the scheduler', async () => {
    const e = setup(true);
    let oldDecoded!: (ready: boolean) => void;
    Object.assign(e.scheduler, { prepareUpgrade: () => new Promise<boolean>((r) => { oldDecoded = r; }) });
    e.cloud.script = ['hang'];
    e.local.script = [async () => ({ segments: [seg(0, 3)] })];
    await e.engine.start();
    e.capture.emit(chunk(0));
    await flush();
    expect(e.video.paused).toBe(true);
    e.schedulerRef.current = new FakeScheduler();
    Object.assign(e.schedulerRef.current, { prepareUpgrade: async () => true });
    e.engine.updateSettings({ ...e.s, originalVolume: 0.7 });
    await flush();
    expect(e.video.plays).toBe(1);
    oldDecoded(false);
    await flush();
    expect(e.video.plays).toBe(1);
    expect(e.video.paused).toBe(false);
    e.engine.stop();
  });

  it('ignores a decoding result for the previous seek position', async () => {
    const e = setup(true);
    let oldDecoded!: (ready: boolean) => void;
    Object.assign(e.scheduler, { prepareUpgrade: () => new Promise<boolean>((r) => { oldDecoded = r; }) });
    e.cloud.script = ['hang'];
    e.local.script = [async () => ({ segments: [seg(0, 3)] })];
    await e.engine.start();
    e.capture.emit(chunk(0));
    await flush();
    e.video.currentTime = 300;
    e.video.dispatchEvent(new Event('seeked'));
    oldDecoded(true);
    await flush();
    expect(e.video.paused).toBe(true);
    expect(e.video.plays).toBe(0);
    e.engine.stop();
  });

  it('pauses again at the next unprepared cell and resumes when that cell finishes', async () => {
    const e = setup();
    await e.engine.start();
    e.capture.emit(chunk(0));
    await flush();
    expect(e.video.paused).toBe(false);
    e.video.currentTime = 15;
    e.video.dispatchEvent(new Event('timeupdate'));
    expect(e.video.paused).toBe(true);
    expect(e.video.pauses).toBe(2);
    e.capture.emit(chunk(15));
    await flush();
    expect(e.video.paused).toBe(false);
    expect(e.video.plays).toBe(2);
    e.engine.stop();
  });

  it('respects manual play for this cell, then arms waiting for the next cell', async () => {
    const e = setup();
    await e.engine.start();
    await e.video.play();
    e.video.currentTime = 2;
    e.video.dispatchEvent(new Event('timeupdate'));
    expect(e.video.paused).toBe(false);
    e.video.currentTime = 15;
    e.video.dispatchEvent(new Event('timeupdate'));
    expect(e.video.paused).toBe(true);
    e.engine.stop();
  });

  it('does not resume a video the user paused by hand', async () => {
    const e = setup();
    await e.engine.start();
    e.capture.emit(chunk(0));
    await flush();
    e.video.pause();
    e.video.currentTime = 15;
    e.video.dispatchEvent(new Event('timeupdate'));
    e.capture.emit(chunk(15));
    await flush();
    expect(e.video.plays).toBe(1);
    expect(e.video.paused).toBe(true);
    e.engine.stop();
  });

  it('re-arms waiting after seeking backwards from a manually bypassed cell', async () => {
    const e = setup();
    e.video.currentTime = 300;
    await e.engine.start();
    await e.video.play();
    e.video.currentTime = 30;
    e.video.dispatchEvent(new Event('seeked'));
    expect(e.video.paused).toBe(true);
    expect(e.video.pauses).toBe(2);
    e.engine.stop();
  });

  it('keeps waiting in a cloud omission until queued local recognition checks it', async () => {
    const e = setup(true);
    let finish!: (r: ChunkResult) => void;
    e.cloud.fallback = { segments: [], sourceLang: 'en' };
    e.local.script = [() => new Promise((r) => { finish = r; })];
    await e.engine.start();
    e.capture.emit(chunk(0));
    await flush();
    expect(e.video.paused).toBe(true);
    finish({ segments: [], sourceLang: 'en' }); // confirmed silence/music needs no voice
    await flush();
    expect(e.video.paused).toBe(false);
    e.engine.stop();
  });

  it('reserves the next local job while cloud is still pending and upgrades a playing local bridge', async () => {
    const e = setup(true, false);
    let finishLocal!: (r: ChunkResult) => void;
    let finishCloud!: (r: ChunkResult) => void;
    e.local.script = [() => new Promise((r) => { finishLocal = r; }), async () => ({ segments: [seg(15, 18)] })];
    e.cloud.script = ['hang', () => new Promise((r) => { finishCloud = r; })];
    await e.engine.start();
    e.capture.emit(chunk(0));
    await flush();
    e.capture.emit(chunk(15));
    await flush();
    expect(e.local.calls).toHaveLength(1);
    finishLocal({ segments: [seg(0, 3)] });
    await flush();
    expect(e.local.calls).toHaveLength(2); // started before the second cloud answer
    e.video.currentTime = 16;
    finishCloud({ segments: [seg(15, 18)] });
    await flush();
    expect(e.scheduler.added.filter((s) => s.start === 15).map((s) => s.providerId)).toEqual(['gemini']);
    e.engine.stop();
  });

  it('publishes text before audio and replaces overlapping local text by cloud priority without double subtitles', async () => {
    const e = setup(true, false);
    e.s.subtitles = 'on';
    e.engine.updateSettings(e.s);
    e.cloud.script = ['hang'];
    e.local.script = ['hang'];
    await e.engine.start();
    e.capture.emit(chunk(0));
    await flush();
    e.local.calls[0]!.ctx.onSubtitles?.([{ start: 0, end: 2, text: 'Local text' }]);
    expect(e.subtitles.at(-1)?.map((c) => c.text)).toEqual(['Local text']);
    expect(e.scheduler.added).toHaveLength(0);
    e.cloud.calls[0]!.ctx.onSubtitles?.([{ start: 0, end: 2, text: 'Cloud text' }]);
    expect(e.subtitles.at(-1)?.map((c) => c.text)).toEqual(['Cloud text']);
    e.engine.stop();
    const count = e.subtitles.length;
    e.cloud.calls[0]!.ctx.onSubtitles?.([{ start: 3, end: 4, text: 'Stale text' }]);
    expect(e.subtitles).toHaveLength(count);
  });

  it.each([true, false])('retains local audio until cloud decode confirms a playable replacement: %s', async (playable) => {
    const e = setup(true, false);
    let finishCloud!: (r: ChunkResult) => void;
    let prepared!: (ready: boolean) => void;
    Object.assign(e.scheduler, { prepareUpgrade: () => new Promise<boolean>((r) => { prepared = r; }) });
    e.cloud.script = [() => new Promise((r) => { finishCloud = r; })];
    e.local.script = [async () => ({ segments: [seg(0, 4)] })];
    await e.engine.start();
    e.capture.emit(chunk(0));
    await flush();
    e.video.currentTime = 1;
    finishCloud({ segments: [seg(0, 4)] });
    await flush();
    expect(e.scheduler.added.map((s) => s.providerId)).toEqual(['local']);
    prepared(playable);
    await flush();
    expect(e.scheduler.added.map((s) => s.providerId)).toEqual([playable ? 'gemini' : 'local']);
    e.engine.stop();
  });

  it('does not activate a cloud tier disabled during replacement decoding', async () => {
    const e = setup(true, false);
    let finishCloud!: (r: ChunkResult) => void;
    let prepared!: (ready: boolean) => void;
    Object.assign(e.scheduler, { prepareUpgrade: () => new Promise<boolean>((r) => { prepared = r; }) });
    e.cloud.script = [() => new Promise((r) => { finishCloud = r; })];
    e.local.script = [async () => ({ segments: [seg(0, 4)] })];
    await e.engine.start();
    e.capture.emit(chunk(0));
    await flush();
    finishCloud({ segments: [seg(0, 4)] });
    await flush();
    e.engine.updateSettings({ ...e.s, voiceEnabled: { ...e.s.voiceEnabled, gemini: false } });
    prepared(true);
    await flush();
    expect(e.scheduler.added.map((s) => s.providerId)).toEqual(['local']);
    e.engine.stop();
  });
});
