import { describe, expect, it, vi } from 'vitest';
import { HlsCapture, type PcmMonitor } from '../src/capture/hls/hlsCapture';
import type { AacDecoder } from '../src/capture/hls/aac';
import type { AudioChunk } from '../src/providers/types';
import { audioSegment } from './hlsFixtures';
import { diag } from '../src/diag';

// deterministic speech-like envelope as a function of absolute time (pts)
function amp(t: number): number {
  const k = Math.floor(t * 2.7);
  const x = Math.sin(k * 12.9898) * 43758.5453;
  const r = x - Math.floor(x);
  return r < 0.3 ? 0.01 : 0.05 + 0.5 * r;
}
function signal(t0: number, n: number): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = t0 + i / 16000;
    out[i] = Math.sin(2 * Math.PI * 220 * t) * amp(t);
  }
  return out;
}

const P0 = 970; // pts of segment 0
const NSEG = 30;
const OFFSET = 990.5; // true pts - videoTime

function playlist(first: number, last: number): string {
  let s = `#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:${first}\n`;
  for (let i = first; i <= last; i++) s += `#EXTINF:2.000,live\nseg${i}.ts\n`;
  return s;
}

function setup() {
  let lastSeq = NSEG - 1;
  const fetchFn = vi.fn(async (url: string): Promise<Response> => {
    if (url.endsWith('index.m3u8')) return new Response(playlist(Math.max(0, lastSeq - 15), lastSeq));
    const m = /seg(\d+)\.ts$/.exec(url);
    if (m) return new Response(audioSegment(P0 + Number(m[1]) * 2, 94, 2) as BlobPart);
    return new Response('', { status: 404 });
  });
  // the fake decoder derives the PCM from the frames' pts, like a real decoder would reproduce the stream's audio
  const decoder: AacDecoder = {
    kind: 'decodeAudioData',
    decode: async (frames) => {
      const n = Math.round((frames.length * 1024 * 16000) / 48000);
      const f = signal(frames[0]!.pts, n);
      const out = new Int16Array(n);
      for (let i = 0; i < n; i++) out[i] = Math.round(f[i]! * 32767);
      return out;
    },
    close() {},
  };
  let onPcm: (s: Float32Array, vt: number) => void = () => {};
  const monitor: PcmMonitor = { start: async () => {}, stop() {}, onStatus: () => () => {} };
  const video = { addEventListener() {}, removeEventListener() {} } as unknown as HTMLMediaElement;
  let clock = 0;
  const statuses: Array<{ type: string; reason?: string }> = [];
  const cap = new HlsCapture({
    video,
    channel: 'chan',
    fetchFn,
    mediaUrl: 'https://v.example/audio_only/index.m3u8',
    monitorFactory: (cb) => {
      onPcm = cb;
      return monitor;
    },
    decoderFactory: async () => decoder,
    onStatus: (s) => statuses.push(s as { type: string }),
    now: () => (clock += 5000),
    sleep: (_ms, signal) => new Promise<void>((r) => signal.addEventListener('abort', () => r(), { once: true })),
  });
  const chunks: AudioChunk[] = [];
  cap.onChunk((c) => chunks.push(c));
  const feedVideo = (fromVt: number, toVt: number, off = OFFSET): void => {
    const blk = 1600;
    for (let vt = fromVt; vt < toVt; vt += blk / 16000) onPcm(signal(vt + off, blk), vt + blk / 16000);
  };
  const setLast = (n: number): void => {
    lastSeq = n;
  };
  return { cap, chunks, feedVideo, fetchFn, statuses, setLast };
}

describe('HlsCapture', () => {
  it('buffers until aligned, then delivers chunks on the video timeline (and later segments live)', async () => {
    const { cap, chunks, feedVideo, setLast } = setup();
    await cap.start(10);
    await vi.waitFor(() => expect(cap.state().historySec).toBeGreaterThan(30));
    expect(chunks.length).toBe(0); // nothing delivered before the clock is known
    feedVideo(8, 30); // video plays 22 s
    await cap.pollOnce();
    const st = cap.state();
    expect(st.aligned).toBe(true);
    expect(st.offsetSec).toBeCloseTo(OFFSET, 1);
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) {
      expect(c.sampleRate).toBe(16000);
      expect(c.durationSec).toBeGreaterThan(1.9);
      expect(c.startSec + c.durationSec).toBeGreaterThan(10); // nothing from before the capture start
    }
    // chunk positions: video time = pts - offset
    const first = chunks[0]!;
    expect((first.startSec + OFFSET - P0) / 2).toBeCloseTo(Math.round((first.startSec + OFFSET - P0) / 2), 1);
    // a new segment later arrives straight away, one segment ahead of the previous chunk
    const before = chunks.length;
    setLast(NSEG);
    await cap.pollOnce();
    expect(chunks.length).toBe(before + 1);
    const last = chunks[chunks.length - 1]!;
    expect(last.startSec).toBeCloseTo(P0 + NSEG * 2 - OFFSET, 1);
    cap.stop();
  });

  it('a restart (own live-delay seek) replays the decoded history after the new position', async () => {
    const { cap, chunks, feedVideo } = setup();
    await cap.start(10);
    await vi.waitFor(() => expect(cap.state().historySec).toBeGreaterThan(30));
    feedVideo(8, 30);
    await cap.pollOnce();
    expect(cap.state().aligned).toBe(true);
    chunks.length = 0;
    await cap.start(60); // later than most of the audio (video time of the newest segment is ~39.5)
    expect(chunks.length).toBe(0);
    await cap.start(30);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks[0]!.startSec + chunks[0]!.durationSec).toBeGreaterThan(30);
    cap.stop();
  });

  it('reports unsupported (hls-fallback) when the audio never correlates', async () => {
    const { cap, feedVideo, statuses } = setup();
    await cap.start(0);
    await vi.waitFor(() => expect(cap.state().historySec).toBeGreaterThan(30));
    // unrelated audio for 70 s of playback
    for (let vt = 0; vt < 70; vt += 5) {
      feedVideo(vt, vt + 5, 9000);
      await cap.pollOnce();
    }
    expect(statuses.some((s) => s.type === 'unsupported')).toBe(true);
    expect(cap.state().aligned).toBe(false);
    cap.stop();
  });

  it('skips stitched-ad segments', async () => {
    const fetchFn = vi.fn(async (url: string): Promise<Response> => {
      if (url.endsWith('index.m3u8')) {
        return new Response(
          '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:2.000,live\nseg0.ts\n#EXTINF:2.000,Amazon\nad1.ts\n#EXTINF:2.000,live\nseg2.ts\n#EXT-X-TWITCH-PREFETCH:https://v/seg3.ts\n',
        );
      }
      return new Response(audioSegment(P0, 94, 2) as BlobPart);
    });
    const cap = new HlsCapture({
      video: { addEventListener() {}, removeEventListener() {} } as unknown as HTMLMediaElement,
      channel: 'c',
      fetchFn,
      mediaUrl: 'https://v.example/audio_only/index.m3u8',
      monitorFactory: () => ({ start: async () => {}, stop() {}, onStatus: () => () => {} }),
      decoderFactory: async () => ({ kind: 'decodeAudioData', decode: async () => new Int16Array(32000), close() {} }),
      sleep: (_ms, signal) => new Promise<void>((r) => signal.addEventListener('abort', () => r(), { once: true })),
    });
    await cap.start(0);
    await vi.waitFor(() => expect(fetchFn.mock.calls.length).toBeGreaterThanOrEqual(3));
    const urls = fetchFn.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.endsWith('seg0.ts'))).toBe(true);
    expect(urls.some((u) => u.endsWith('seg2.ts'))).toBe(true);
    expect(urls.some((u) => u.endsWith('ad1.ts'))).toBe(false);
    expect(urls.some((u) => u.endsWith('seg3.ts'))).toBe(false);
    cap.stop();
  });
});

describe('HlsCapture re-verification (a dub must never be moved EARLIER on one noisy reading)', () => {
  type Internals = { videoEnv: { clear(): void }; videoMax: number; lastVerify: number };
  async function aligned() {
    const h = setup();
    await h.cap.start(10);
    await vi.waitFor(() => expect(h.cap.state().historySec).toBeGreaterThan(30));
    h.feedVideo(8, 30);
    await h.cap.pollOnce();
    expect(h.cap.state().aligned).toBe(true);
    // fresh video envelope (as after a long playback) that plays the same stream with a shifted clock
    const internals = h.cap as unknown as Internals;
    const replay = async (off: number): Promise<void> => {
      internals.videoEnv.clear();
      internals.videoMax = -Infinity;
      h.feedVideo(10, 38, off);
      internals.lastVerify = -1e9;
      await h.cap.pollOnce();
    };
    return { ...h, replay };
  }

  it('a LARGER offset (earlier slots) is applied only after a second agreeing verification; align-drift is logged', async () => {
    const log = vi.spyOn(diag, 'log');
    const { cap, replay } = await aligned();
    await replay(OFFSET + 1);
    expect(cap.state().offsetSec).toBeCloseTo(OFFSET, 1); // not yet
    let drift = log.mock.calls.filter((c) => c[0] === 'align-drift');
    expect(drift).toHaveLength(1);
    expect(drift[0]![1]).toMatchObject({ applied: false, pending: true });
    expect((drift[0]![1] as { deltaSec: number }).deltaSec).toBeCloseTo(1, 1);
    expect((drift[0]![1] as { prevOffsetSec: number }).prevOffsetSec).toBeCloseTo(OFFSET, 1);
    await replay(OFFSET + 1);
    expect(cap.state().offsetSec).toBeCloseTo(OFFSET + 1, 1);
    drift = log.mock.calls.filter((c) => c[0] === 'align-drift');
    expect(drift[1]![1]).toMatchObject({ applied: true });
    cap.stop();
    log.mockRestore();
  });

  it('a SMALLER offset (later slots, harmless) is applied at once', async () => {
    const log = vi.spyOn(diag, 'log');
    const { cap, replay } = await aligned();
    await replay(OFFSET - 1);
    expect(cap.state().offsetSec).toBeCloseTo(OFFSET - 1, 1);
    const drift = log.mock.calls.filter((c) => c[0] === 'align-drift');
    expect(drift[0]![1]).toMatchObject({ applied: true });
    cap.stop();
    log.mockRestore();
  });

  it('no align-drift line for a stable mapping', async () => {
    const log = vi.spyOn(diag, 'log');
    const { cap, replay } = await aligned();
    await replay(OFFSET);
    expect(log.mock.calls.some((c) => c[0] === 'align-drift')).toBe(false);
    expect(cap.state().offsetSec).toBeCloseTo(OFFSET, 1);
    cap.stop();
    log.mockRestore();
  });

  it('invalidateClock voids the mapping (the engine saw the player rebuild its timeline)', async () => {
    const { cap } = await aligned();
    cap.invalidateClock('engine-reset');
    expect(cap.state().aligned).toBe(false);
    expect(cap.state().offsetSec).toBeUndefined();
    cap.stop();
  });
});
