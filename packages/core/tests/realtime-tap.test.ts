import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRealtimeTap, type RealtimeStatus } from '../src/capture/realtimeTap';

class FakeVideo {
  paused = false;
  ended = false;
  seeking = false;
  readyState = 4;
  muted = false;
  volume = 1;
  playbackRate = 1;
  currentTime = 0;
  private l = new Map<string, Set<() => void>>();
  addEventListener(t: string, f: () => void) {
    (this.l.get(t) ?? this.l.set(t, new Set()).get(t)!).add(f);
  }
  removeEventListener(t: string, f: () => void) {
    this.l.get(t)?.delete(f);
  }
  emit(t: string) {
    this.l.get(t)?.forEach((f) => f());
  }
  captureStream() {
    return { getAudioTracks: () => [{}] };
  }
}

let proc: ((e: { inputBuffer: { getChannelData: () => Float32Array } }) => void) | null;
let ctxState = 'running';

beforeEach(() => {
  proc = null;
  ctxState = 'running';
  const node = { connect() {}, disconnect() {} };
  class FakeCtx {
    get state() {
      return ctxState;
    }
    destination = {};
    audioWorklet = { addModule: () => Promise.reject(new Error('csp')) };
    resume = async () => undefined;
    close = async () => undefined;
    createMediaStreamSource = () => node;
    createGain = () => ({ ...node, gain: { value: 1 } });
    createScriptProcessor = () => {
      const sp = { ...node, set onaudioprocess(f: typeof proc) { proc = f; } } as unknown;
      return sp;
    };
  }
  vi.stubGlobal('AudioContext', FakeCtx);
  vi.stubGlobal('MediaStream', class { constructor(public t?: unknown) {} });
});
afterEach(() => vi.unstubAllGlobals());

async function setup() {
  const v = new FakeVideo();
  const tap = createRealtimeTap(v as unknown as HTMLMediaElement, { chunkSec: 1 });
  const st: RealtimeStatus[] = [];
  tap.onStatus((s) => st.push(s));
  await tap.start();
  /** feed `sec` seconds of samples in 0.1 s blocks; `advance` moves currentTime like real playback */
  const feed = (sec: number, o: { zeros?: boolean; advance?: boolean } = {}) => {
    for (let i = 0; i < Math.round(sec * 10); i++) {
      if (o.advance !== false) v.currentTime += 0.1;
      const b = new Float32Array(1600);
      if (!o.zeros) b.fill(0.1);
      proc!({ inputBuffer: { getChannelData: () => b } });
    }
  };
  const bad = () => st.filter((s) => s.type === 'tainted' || s.type === 'muted');
  return { v, st, feed, bad, tap };
}

describe('realtimeTap silence detection (S17)', () => {
  it('pause then 5 s of zeros never reports tainted', async () => {
    const { v, feed, bad } = await setup();
    feed(1);
    v.paused = true;
    v.emit('pause');
    feed(5, { zeros: true, advance: false });
    expect(bad()).toEqual([]);
  });

  it('zeros while buffering/seeking (not advancing) do not count', async () => {
    const { v, feed, bad } = await setup();
    v.readyState = 2;
    feed(10, { zeros: true });
    v.readyState = 4;
    v.seeking = true;
    v.emit('seeking');
    feed(10, { zeros: true });
    expect(bad()).toEqual([]);
  });

  it('replay after ended: silence before end does not carry over', async () => {
    const { v, feed, bad } = await setup();
    feed(7, { zeros: true });
    expect(bad()).toEqual([]);
    v.ended = true;
    v.paused = true;
    v.emit('ended');
    feed(5, { zeros: true, advance: false });
    v.ended = false;
    v.paused = false;
    v.currentTime = 0;
    v.emit('playing');
    feed(7, { zeros: true });
    expect(bad()).toEqual([]);
  });

  it('muted and volume-0 elements are never tainted (muted reported)', async () => {
    const { v, feed, bad } = await setup();
    v.muted = true;
    feed(12, { zeros: true });
    expect(bad()).toEqual([{ type: 'muted' }]);
    v.muted = false;
    v.volume = 0;
    feed(12, { zeros: true });
    expect(bad().some((s) => s.type === 'tainted')).toBe(false);
  });

  it('suspended AudioContext is never tainted', async () => {
    const { feed, bad } = await setup();
    ctxState = 'suspended';
    feed(12, { zeros: true });
    expect(bad().some((s) => s.type === 'tainted')).toBe(false);
  });

  it('true taint after >= 8 s of advancing audible zeros (not before)', async () => {
    const { feed, bad } = await setup();
    feed(7.5, { zeros: true });
    expect(bad()).toEqual([]);
    feed(1, { zeros: true });
    expect(bad()).toEqual([{ type: 'tainted' }]);
  });

  it('seek resets the counter', async () => {
    const { v, feed, bad } = await setup();
    feed(6, { zeros: true });
    v.emit('seeking');
    v.emit('seeked');
    feed(6, { zeros: true });
    expect(bad()).toEqual([]);
    feed(3, { zeros: true });
    expect(bad()).toEqual([{ type: 'tainted' }]);
  });

  it('SecurityError from captureStream is tainted immediately', async () => {
    const v = new FakeVideo();
    v.captureStream = () => {
      throw new DOMException('x', 'SecurityError');
    };
    const tap = createRealtimeTap(v as unknown as HTMLMediaElement);
    const st: RealtimeStatus[] = [];
    tap.onStatus((s) => st.push(s));
    await tap.start();
    expect(st).toEqual([{ type: 'tainted' }]);
  });
});
