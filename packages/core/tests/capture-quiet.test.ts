import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCapture, type Capture } from '../src/capture';
import type { MseBridgeClient } from '../src/capture/mseBridge';
import type { AudioChunk } from '../src/providers/types';

const opened: Capture[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const capture of opened.splice(0)) capture.stop();
  vi.useRealTimers();
});

async function setup() {
  const listeners = new Set<(chunk: AudioChunk) => void>();
  const bridge: MseBridgeClient = {
    ping: async () => ({ audioBuffers: 1, segments: 3, bufferedSec: 10, minStartSec: 13440, maxEndSec: 13450, decoded: 0, failed: 0, queued: 0, active: false, source: 1 }),
    start: vi.fn(), stop: vi.fn(), dispose: vi.fn(),
    onChunk: (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
  };
  const video = { currentTime: 13440, duration: 36000, paused: true } as HTMLMediaElement;
  const capture = await createCapture(video, { bridge, strategies: ['mse'], chunkSec: 15 });
  opened.push(capture);
  const chunks: AudioChunk[] = [];
  capture.onChunk((chunk) => chunks.push(chunk));
  await capture.start(video.currentTime);
  const push = (startSec: number, durationSec: number) => {
    const chunk: AudioChunk = { startSec, durationSec, sampleRate: 10, pcm: new Int16Array(durationSec * 10).fill(1) };
    for (const listener of listeners) listener(chunk);
  };
  return { capture, chunks, push, bridge };
}

describe('MSE capture quiet tails', () => {
  it('delivers a short buffered tail after a quiet append burst while playback stays paused', async () => {
    const e = await setup();
    e.push(13440, 2);
    await vi.advanceTimersByTimeAsync(250);
    e.push(13442, 2);
    await vi.advanceTimersByTimeAsync(499);
    expect(e.chunks).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(e.chunks).toHaveLength(1);
    expect(e.chunks[0]).toMatchObject({ startSec: 13440, durationSec: 4 });
  });

  it('still batches a full window immediately without a duplicate quiet flush', async () => {
    const e = await setup();
    e.push(13440, 5);
    e.push(13445, 5);
    e.push(13450, 5);
    expect(e.chunks).toHaveLength(1);
    expect(e.chunks[0]!.durationSec).toBe(15);
    await vi.advanceTimersByTimeAsync(1000);
    expect(e.chunks).toHaveLength(1);
  });

  it('clears the timer on stop, flushes the final tail once and ignores later bridge data', async () => {
    const e = await setup();
    e.push(13440, 2);
    expect(vi.getTimerCount()).toBe(1);
    e.capture.stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(e.chunks).toHaveLength(1);
    e.push(13442, 2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(e.chunks).toHaveLength(1);
  });

  it('drops the previous pending tail when capture restarts after a seek', async () => {
    const e = await setup();
    e.push(13440, 2);
    await e.capture.start(100);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(e.chunks).toHaveLength(0);
    e.push(100, 2);
    await vi.advanceTimersByTimeAsync(500);
    expect(e.chunks.map((chunk) => chunk.startSec)).toEqual([100]);
  });
});
