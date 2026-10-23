import { describe, expect, it } from 'vitest';
import { diag } from '../src/diag';
import { TranslationEngine } from '../src/pipeline';
import type { Transport } from '../src/providers/types';
import {
  YandexClient,
  concat,
  createFullTrackProber,
  decode,
  fStr,
  fVar,
  indexMp3,
  type FullTrack,
  type FullTrackProber,
  type ProbeOptions,
  type ProbeReplyInfo,
  type UploadOptions,
} from '../src/providers/yandex';
import { FakeCapture, FakeProvider, FakeScheduler, FakeVideo, flush, instantSleep, settings } from './helpers/pipelineFakes';

// ---------- client: chunked upload wire ----------

describe('YandexClient.uploadAudioParts (VOT partialAudioInfo)', () => {
  it('splits into parts of the minimum size, the last carries audioPartsLength and the remainder', async () => {
    const puts: Uint8Array[] = [];
    const transport: Transport = async (req) => {
      const u = new URL(req.url);
      if (u.pathname === '/session/create') return { status: 200, headers: {}, body: concat(fStr(1, 'SECRET'), fVar(2, 3600)) };
      if (u.pathname === '/video-translation/audio') {
        puts.push(req.body!);
        return { status: 200, headers: {}, body: fVar(1, 1) };
      }
      return { status: 404, headers: {}, body: new Uint8Array() };
    };
    const c = new YandexClient(transport, { sleep: async () => {}, random: () => 0.5 });
    const wav = new Uint8Array(250).map((_, i) => i % 251);
    const r = await c.uploadAudioParts('TID', 'https://youtu.be/abc', wav, undefined, 100);
    expect(r.parts).toBe(3);
    const parsed = puts.map((b) => {
      const m = decode(b);
      const part = decode(m[4]![0] as Uint8Array);
      const buf = decode(part[1]![0] as Uint8Array);
      return { tid: new TextDecoder().decode(m[1]![0] as Uint8Array), url: new TextDecoder().decode(m[2]![0] as Uint8Array), len: (buf[2]![0] as Uint8Array).length, chunkId: buf[1]?.[0], total: part[2]?.[0], version: part[4]?.[0] };
    });
    expect(parsed.map((p) => p.len)).toEqual([100, 100, 50]);
    expect(parsed.map((p) => p.tid)).toEqual(['TID', 'TID', 'TID']);
    expect(parsed.every((p) => p.url === 'https://youtu.be/abc')).toBe(true);
    expect(parsed.map((p) => p.total)).toEqual([undefined, undefined, 3]);
    expect(parsed.map((p) => p.chunkId)).toEqual([undefined, 1, 2]);
  });
});

// ---------- engine ----------

const FRAME_SEC = 1152 / 44100;
function synthMp3(frames: number): Uint8Array {
  const parts: number[][] = [];
  for (let i = 0; i < frames; i++) {
    const len = Math.floor(((i + 1) * 144 * 128000) / 44100) - Math.floor((i * 144 * 128000) / 44100);
    const f = new Array<number>(len).fill((i % 200) + 1);
    f[0] = 0xff;
    f[1] = 0xfb;
    f[2] = (9 << 4) | ((len - 417) << 1);
    f[3] = 0;
    parts.push(f);
  }
  return Uint8Array.from(parts.flat());
}
function track(tier: 'yandex' | 'yandex-live', sec: number): FullTrack {
  const bytes = synthMp3(Math.ceil(sec / FRAME_SEC));
  const index = indexMp3(bytes)!;
  return { tier, bytes, index, durationSec: index.durationSec, bitrate: index.bitrateKbps, complete: true };
}

class FakeProber implements FullTrackProber {
  calls: ProbeOptions[] = [];
  uploads: UploadOptions[] = [];
  private resolvers = new Map<string, (t: FullTrack | undefined) => void>();
  probe(o: ProbeOptions): Promise<FullTrack | undefined> {
    this.calls.push(o);
    return new Promise((res) => this.resolvers.set(o.tier, res));
  }
  async upload(o: UploadOptions): Promise<{ bytes: number; parts: number }> {
    this.uploads.push(o);
    return { bytes: o.pcm.length * 2, parts: 1 };
  }
  miss(tier: string, info: ProbeReplyInfo): void {
    const c = this.calls.findLast((x) => x.tier === tier)!;
    c.onFirst?.(info.status);
    c.onReply?.(info);
    this.resolvers.get(tier)!(undefined);
  }
  finish(tier: string, t: FullTrack | undefined): void {
    this.resolvers.get(tier)!(t);
  }
  watched(tier: string): ProbeOptions[] {
    return this.calls.filter((c) => c.tier === tier && c.once);
  }
}

class Timers {
  list: Array<{ ms: number; fire: () => void; signal: AbortSignal; done: boolean }> = [];
  sleep = (ms: number, signal: AbortSignal): Promise<void> =>
    new Promise((res, rej) => {
      const t = { ms, signal, done: false, fire: () => ((t.done = true), res()) };
      this.list.push(t);
      signal.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')), { once: true });
    });
  pending(): number[] {
    return this.list.filter((t) => !t.done && !t.signal.aborted).map((t) => t.ms);
  }
  next(): number {
    const t = this.list.find((x) => !x.done && !x.signal.aborted)!;
    t.fire();
    return t.ms;
  }
}

function setup(over: { duration?: number; off?: Array<'yandex-live' | 'yandex'> } = {}) {
  const video = new FakeVideo() as FakeVideo & { duration?: number };
  video.duration = over.duration ?? 60;
  const providers = [new FakeProvider('yandex-live'), new FakeProvider('yandex'), new FakeProvider('gemini')];
  const caps: FakeCapture[] = [];
  const scheds: FakeScheduler[] = [];
  const voices: Array<[string, string | undefined]> = [];
  const prober = new FakeProber();
  const watch = new Timers();
  const poll = new Timers();
  const base = settings({ voiceOrder: ['yandex-live', 'yandex', 'gemini'] });
  for (const id of over.off ?? []) base.voiceEnabled[id] = false;
  const engine = new TranslationEngine({
    video: video as unknown as HTMLVideoElement,
    audioCtx: {} as AudioContext,
    providers,
    settings: base,
    events: { onVoice: (v) => voices.push([v.providerId, v.voice]) },
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
    now: () => 0,
    sleep: instantSleep(),
    hintSleep: () => new Promise(() => {}),
    retryDelayMs: 10,
    fullTrack: prober,
    videoKey: () => 'yt:dQw4w9WgXcQ',
    probeRaceMs: 1500,
    probeWatchSleep: watch.sleep,
    uploadPollSleep: poll.sleep,
  });
  return { video, engine, caps, scheds, voices, prober, watch, poll };
}

const full = (start: number, sec: number, fill = 5) => ({ startSec: start, durationSec: sec, sampleRate: 16000, pcm: new Int16Array(sec * 16000).fill(fill) });
const SIX = (tid: string): ProbeReplyInfo => ({ status: 6, reason: 'audio-requested', translationId: tid });

describe('engine: complete-audio upload under the real id', () => {
  it('complete coverage: one upload per tier (live first), then the re-probe finds the track and live takes over', async () => {
    const e = setup();
    await e.engine.start();
    for (const s of [0, 15, 30, 45]) e.caps[0]!.emit(full(s, 15));
    e.prober.miss('yandex-live', SIX('T-live'));
    e.prober.miss('yandex', SIX('T-std'));
    await flush();
    expect(e.prober.uploads.map((u) => [u.tier, u.translationId, u.url, u.sampleRate, u.pcm.length])).toEqual([
      ['yandex-live', 'T-live', 'https://youtu.be/dQw4w9WgXcQ', 16000, 60 * 16000],
      ['yandex', 'T-std', 'https://youtu.be/dQw4w9WgXcQ', 16000, 60 * 16000],
    ]);
    // uploaded: the watchers re-probe soon (not after the usual 90 s)
    expect(e.watch.pending()).toEqual([20_000, 20_000]);
    e.watch.next();
    await flush();
    expect(e.prober.watched('yandex-live')).toHaveLength(1);
    expect(e.prober.watched('yandex-live')[0]).toMatchObject({ once: true, firstRequest: false });
    e.prober.finish('yandex-live', track('yandex-live', 60));
    await flush();
    expect(diag.entries().some((x) => x.ev === 'tier-switch-now' && (x.data as any).to === 'yandex-live') || e.voices.some((v) => v[0] === 'yandex-live')).toBe(true);
    // a later status 6 never uploads twice
    expect(e.prober.uploads).toHaveLength(2);
    e.engine.stop();
  });

  it('partial coverage: nothing is uploaded; it waits and uploads once the capture covers the whole video', async () => {
    const e = setup();
    await e.engine.start();
    e.caps[0]!.emit(full(0, 15));
    e.caps[0]!.emit(full(30, 15)); // hole 15..30
    e.prober.miss('yandex-live', SIX('T1'));
    await flush();
    expect(e.prober.uploads).toHaveLength(0);
    expect(diag.entries().some((x) => x.ev === 'audio-upload-skip' && (x.data as any).reason === 'not-covered')).toBe(true);
    expect(e.poll.pending()).toEqual([5000]);
    e.caps[0]!.emit(full(15, 15));
    e.poll.next();
    await flush();
    expect(e.prober.uploads).toHaveLength(0); // 45..60 still missing
    e.caps[0]!.emit(full(45, 15));
    e.poll.next();
    await flush();
    expect(e.prober.uploads).toHaveLength(1);
    e.engine.stop();
  });

  it('a video longer than the buffer limit is never uploaded', async () => {
    const e = setup({ duration: 2000 });
    await e.engine.start();
    e.caps[0]!.emit(full(0, 15));
    e.prober.miss('yandex-live', SIX('T1'));
    e.prober.miss('yandex', SIX('T2'));
    await flush();
    expect(e.prober.uploads).toHaveLength(0);
    expect(diag.entries().filter((x) => x.ev === 'audio-upload-skip' && (x.data as any).reason === 'too-long')).toHaveLength(2);
    e.engine.stop();
  });

  it('audio running past the video end is a duration mismatch: no upload', async () => {
    const e = setup();
    await e.engine.start();
    for (const s of [0, 15, 30, 45]) e.caps[0]!.emit(full(s, 15));
    e.caps[0]!.emit(full(59, 30)); // 59..89 on a 60 s video
    e.prober.miss('yandex-live', SIX('T1'));
    await flush();
    expect(e.prober.uploads).toHaveLength(0);
    expect(diag.entries().some((x) => x.ev === 'audio-upload-skip' && (x.data as any).reason === 'duration-mismatch')).toBe(true);
    e.engine.stop();
  });

  it('writes fulltrack-state events on every state change', async () => {
    diag.clear();
    const e = setup();
    await e.engine.start();
    e.prober.miss('yandex-live', { status: 2, remainingSec: 35, reason: 'waiting' });
    await flush();
    const st = diag.entries().filter((x) => x.ev === 'fulltrack-state' && (x.data as any).tier === 'yandex-live').map((x) => (x.data as any).state);
    expect(st).toEqual(['probing', 'waiting']);
    e.engine.stop();
  });
});

describe('prober.upload', () => {
  it('sends the complete audio as a wav through the client, with the diag event', async () => {
    const got: Array<{ tid: string; url: string; len: number }> = [];
    const client = {
      requestTranslation: async () => ({ status: 6 }),
      fetchAudio: async () => new Uint8Array(),
      uploadAudioParts: async (tid: string, url: string, wav: Uint8Array) => {
        got.push({ tid, url, len: wav.length });
        return { parts: 2 };
      },
    };
    const p = createFullTrackProber(client as never);
    const r = await p.upload!({ tier: 'yandex-live', url: 'https://youtu.be/x', translationId: 'T', pcm: new Int16Array(1600), sampleRate: 16000 });
    expect(r).toEqual({ bytes: 44 + 3200, parts: 2 });
    expect(got).toEqual([{ tid: 'T', url: 'https://youtu.be/x', len: 44 + 3200 }]);
    expect(diag.entries().some((x) => x.ev === 'audio-upload' && (x.data as any).tier === 'yandex-live' && (x.data as any).parts === 2)).toBe(true);
  });
});

describe('diag: pinned session start', () => {
  it('report keeps the first events after the ring overflows', () => {
    diag.clear();
    diag.log('first-event');
    for (let i = 0; i < 2500; i++) diag.log('x', { i });
    const rep = diag.report();
    expect(rep).toContain('first-event');
    expect(rep).toContain('were dropped');
    expect(rep).toContain('"i":2499');
    diag.clear();
  });
});

describe('status line after a tier takeover', () => {
  it('live track arrives after the standard one: the last state names live as the active tier and no "later"', async () => {
    const states: Array<{ s: string; d?: any }> = [];
    const e = setup();
    (e.engine as any).deps.events.onState = (s: string, d?: any) => states.push({ s, d });
    await e.engine.start();
    e.prober.finish('yandex', track('yandex', 60));
    await flush();
    e.caps[0]!.emit(full(0, 15));
    e.video.currentTime = 1;
    await flush();
    e.prober.finish('yandex-live', track('yandex-live', 60));
    await flush();
    const last = states.filter((x) => x.s === 'translating').at(-1);
    expect(last?.d?.provider).toBe('yandex-live');
    expect(last?.d?.later).toBeUndefined();
    e.engine.stop();
  });

  it('live is WAITING first, then ready: ends on live without "later"', async () => {
    const states: Array<{ s: string; d?: any }> = [];
    const e = setup();
    (e.engine as any).deps.events.onState = (s: string, d?: any) => states.push({ s, d });
    await e.engine.start();
    e.prober.miss('yandex-live', { status: 2, remainingSec: 20, reason: 'wait-timeout' });
    e.prober.finish('yandex', track('yandex', 60));
    await flush();
    e.caps[0]!.emit(full(0, 15));
    await flush();
    expect(states.filter((x) => x.s === 'translating').at(-1)?.d?.later).toBe('yandex-live');
    e.watch.next();
    await flush();
    e.prober.finish('yandex-live', track('yandex-live', 60));
    await flush();
    const last = states.filter((x) => x.s === 'translating').at(-1);
    expect(last?.d?.provider).toBe('yandex-live');
    expect(last?.d?.later).toBeUndefined();
    e.engine.stop();
  });
});
