import { describe, expect, it, vi } from 'vitest';
import { HlsCapture, type OffsetPrior, type PcmMonitor } from '../src/capture/hls/hlsCapture';
import type { AacDecoder } from '../src/capture/hls/aac';
import { Envelope, alignAcceptance, correlateEnvelopes } from '../src/capture/hls/align';
import { parseTokenExpiry } from '../src/capture/hls/twitchApi';
import { diag } from '../src/diag';
import type { AudioChunk } from '../src/providers/types';
import { audioSegment } from './hlsFixtures';

// ---- synthetic stream (same construction as hls.alignment.test.ts) ----
function amp(t: number): number {
  const k = Math.floor(t * 9);
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
const P0 = 970;
const OFFSET = 990.5;
const T0 = 1_800_000_000_000; // a realistic epoch ms: token expiries are parsed as epoch seconds
const MASTER = `#EXTM3U
#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="audio_only",NAME="audio_only",AUTOSELECT=NO,DEFAULT=NO
#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=160000,CODECS="mp4a.40.2",VIDEO="audio_only"
https://v.example/audio_only/renewed.m3u8
`;

interface HOpts {
  prior?: OffsetPrior;
  expiresAtMs?: number;
  playlistStatus?: () => number;
}

function harness(ho: HOpts = {}) {
  let first = 14;
  let last = 29;
  const ads = new Set<number>();
  const calls = { gql: 0, usher: 0 };
  const playlist = (): string => {
    let s = `#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:${first}\n`;
    for (let i = first; i <= last; i++) s += ads.has(i) ? `#EXTINF:2.000,Amazon|123\nad${i}.ts\n` : `#EXTINF:2.000,live\nseg${i}.ts\n`;
    return s;
  };
  let clock = T0;
  const fetchFn = vi.fn(async (url: string): Promise<Response> => {
    if (url.includes('gql.twitch.tv')) {
      calls.gql++;
      return new Response(JSON.stringify({ data: { streamPlaybackAccessToken: { value: JSON.stringify({ expires: Math.floor((clock + 600_000) / 1000) }), signature: 'sig' } } }));
    }
    if (url.includes('usher.ttvnw.net')) {
      calls.usher++;
      return new Response(MASTER);
    }
    if (url.endsWith('.m3u8')) {
      const st = ho.playlistStatus?.() ?? 200;
      return st === 200 ? new Response(playlist()) : new Response('', { status: st });
    }
    const m = /seg(\d+)\.ts$/.exec(url);
    if (m) return new Response(audioSegment(P0 + Number(m[1]) * 2, 94, 2) as BlobPart);
    return new Response('', { status: 404 });
  });
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
  const statuses: Array<{ type: string; shiftSec?: number; errBoundSec?: number; offsetSec?: number }> = [];
  const sessions: Array<{ url: string }> = [];
  const cap = new HlsCapture({
    video: { addEventListener() {}, removeEventListener() {} } as unknown as HTMLMediaElement,
    channel: 'chan',
    fetchFn,
    mediaUrl: 'https://v.example/audio_only/index.m3u8',
    mediaExpiresAtMs: ho.expiresAtMs,
    prior: ho.prior,
    onSession: (s) => sessions.push(s),
    monitorFactory: (cb) => {
      onPcm = cb;
      return monitor;
    },
    decoderFactory: async () => decoder,
    onStatus: (s) => statuses.push(s as never),
    adProbe: () => false,
    adPollMs: 3_600_000,
    now: () => clock,
    sleep: (_ms, signal) => new Promise<void>((r) => signal.addEventListener('abort', () => r(), { once: true })),
  });
  const chunks: AudioChunk[] = [];
  cap.onChunk((c) => chunks.push(c));
  const feedVideo = (fromVt: number, toVt: number, off = OFFSET, gain = 1): void => {
    const blk = 1600;
    for (let vt = fromVt; vt < toVt; vt += blk / 16000) {
      const s = signal(vt + off, blk);
      if (gain !== 1) for (let i = 0; i < s.length; i++) s[i]! *= gain;
      onPcm(s, vt + blk / 16000);
    }
  };
  const advance = async (ad: boolean): Promise<void> => {
    last++;
    first = Math.max(0, last - 15);
    if (ad) ads.add(last);
    clock += 1300;
    await cap.pollOnce();
  };
  return { cap, chunks, feedVideo, statuses, advance, tick: (ms: number) => (clock += ms), now: () => clock, calls, fetchFn, sessions };
}

const memPrior = (v?: number): OffsetPrior & { v: number | undefined } => {
  const o = { v, get: () => o.v, set: (x: number | undefined) => void (o.v = x) };
  return o;
};
const R = 20;
function fillEnv(env: Envelope, from: number, to: number, shift: number): void {
  for (let t = from; t < to; t += 1 / R) env.add(new Float32Array(800).fill(amp(t + shift)), 16000, t);
}

describe('B: alignment acceptance and side-lobes', () => {
  it('a near-perfect peak is accepted with ratio >= 1.4 on a short window (report: peak .99, second .66, ratio 1.5)', () => {
    const a = alignAcceptance(8);
    expect(a.strongPeak).toBe(0.9);
    expect(a.strongRatio).toBe(1.4);
    expect(alignAcceptance(15).strongPeak).toBe(0.9);
    const hls = new Envelope(R * 240);
    fillEnv(hls, 1000, 1090, 0);
    const video = new Envelope();
    fillEnv(video, 0, 7, 1012.5);
    const base = { fromSec: 0, toSec: 7, centerSec: 1010, rangeSec: 40, minOverlapSec: 4.5, minPeak: 2, relaxedPeak: 0.6, minRatio: 99 };
    // ratio far below the old short-window requirement: only the strong path accepts
    const noStrong = correlateEnvelopes(video, hls, base);
    expect(noStrong.peak).toBeGreaterThan(0.9);
    expect(noStrong.ok).toBe(false);
    const strong = correlateEnvelopes(video, hls, { ...base, strongPeak: 0.9, strongRatio: 1.4 });
    expect(strong.ok).toBe(true);
    expect(strong.offsetSec).toBeCloseTo(1012.5, 1);
  });

  it('the runner-up is an independent candidate: the main peak lobe is not counted as a second', () => {
    // slowly modulated envelope: the correlation decays slowly around the true offset (a wide lobe)
    const slow = (t: number): number => 0.2 + 0.15 * Math.sin((2 * Math.PI * t) / 7) + 0.05 * Math.sin((2 * Math.PI * t) / 2.3);
    const hls = new Envelope(R * 240);
    const video = new Envelope();
    for (let t = 1000; t < 1090; t += 1 / R) hls.add(new Float32Array(800).fill(slow(t)), 16000, t);
    for (let t = 0; t < 12; t += 1 / R) video.add(new Float32Array(800).fill(slow(t + 1030)), 16000, t);
    const r = correlateEnvelopes(video, hls, { fromSec: 0, toSec: 12, centerSec: 1030, rangeSec: 12, minOverlapSec: 6 });
    expect(r.offsetSec).toBeCloseTo(1030, 1);
    // the +-1.5 s neighbourhood alone would leave a second of ~0.9 here (the lobe's shoulder); the lobe is excluded as a whole
    let naive = -1;
    const lobeFree = r.second;
    for (let off = 1018; off <= 1042; off += 0.05) {
      if (Math.abs(off - r.offsetSec) <= 1.5) continue;
      const one = correlateEnvelopes(video, hls, { fromSec: 0, toSec: 12, centerSec: off, rangeSec: 0, minOverlapSec: 6 });
      if (one.peak > naive) naive = one.peak;
    }
    expect(lobeFree).toBeLessThanOrEqual(naive + 1e-9);
  });
});

describe('B: offset prior across capture restarts', () => {
  it('a restarted capture starts from the last good offset: no buffer formula, accepted by the narrow check, shift ~0', async () => {
    const prior = memPrior();
    const a = harness({ prior });
    await a.cap.start(0);
    await vi.waitFor(() => expect(a.cap.state().historySec).toBeGreaterThan(30));
    a.feedVideo(12, 26, OFFSET);
    a.tick(2000);
    await a.cap.pollOnce();
    expect(a.cap.state().aligned).toBe(true);
    expect(prior.v).toBeCloseTo(OFFSET, 1);
    a.cap.stop();

    // the watchdog restarted the capture: a new instance, nothing aligned yet
    const b = harness({ prior });
    diag.clear?.();
    await b.cap.start(0);
    await vi.waitFor(() => expect(b.cap.state().historySec).toBeGreaterThan(30));
    await b.cap.pollOnce();
    const st = b.cap.state();
    expect(st.aligned).toBe(false);
    expect(st.provisional).toBe(true);
    expect(st.offsetSec).toBeCloseTo(OFFSET, 1); // the prior, not newestPtsEnd - videoMax - 2
    const ps = b.statuses.find((s) => s.type === 'provisional');
    expect(ps?.errBoundSec).toBe(0.5);
    expect(b.chunks.length).toBeGreaterThan(5);
    const provLog = diag.entries().filter((e) => e.ev === 'hls-align-provisional').pop();
    expect(provLog?.data).toMatchObject({ prior: true });
    expect((provLog?.data as Record<string, unknown>).estimate).toBeUndefined();
    // 5 s of clean monitor audio: the narrow check (+-0.5 s, peak >= 0.6) accepts at once
    b.feedVideo(12, 17.5, OFFSET);
    b.tick(1300);
    await b.cap.pollOnce();
    expect(b.cap.state().aligned).toBe(true);
    const rt = b.statuses.find((s) => s.type === 'retime');
    expect(Math.abs(rt?.shiftSec ?? 99)).toBeLessThan(0.5);
    b.cap.stop();
  });

  it('a prior is voided by a clock invalidation (player reset / ad end) and without a prior the provisional offset is an estimate', async () => {
    const prior = memPrior(OFFSET);
    const a = harness({ prior });
    await a.cap.start(0);
    await vi.waitFor(() => expect(a.cap.state().historySec).toBeGreaterThan(30));
    a.cap.invalidateClock('engine-reset');
    expect(prior.v).toBeUndefined();
    a.feedVideo(8, 17.5, 9000); // cannot be placed
    a.tick(2000);
    await a.cap.pollOnce();
    expect(a.cap.state().provisional).toBe(true);
    const e = diag.entries().filter((x) => x.ev === 'hls-align-provisional').pop();
    expect(e?.data).toMatchObject({ estimate: true });
    a.cap.stop();
  });
});

describe('C: token/usher session policy', () => {
  it('parses the token expiry (expires / expires_at / exp, seconds or ms)', () => {
    expect(parseTokenExpiry('{"expires":1792900000}')).toBe(1792900000000);
    expect(parseTokenExpiry('{"expires_at":1792900000000}')).toBe(1792900000000);
    expect(parseTokenExpiry('{"exp":"1792900000"}')).toBe(1792900000000);
    expect(parseTokenExpiry('not json')).toBeUndefined();
    expect(parseTokenExpiry('{"a":1}')).toBeUndefined();
  });

  it('no timer refresh: 20 minutes later the token / usher are untouched', async () => {
    const h = harness();
    await h.cap.start(0);
    await vi.waitFor(() => expect(h.cap.state().historySec).toBeGreaterThan(30));
    h.tick(20 * 60_000);
    await h.cap.pollOnce();
    await h.cap.pollOnce();
    expect(h.calls).toEqual({ gql: 0, usher: 0 });
    h.cap.stop();
  });

  it('refreshes 90 s before the token expiry and logs hls-session {reason, ageSec, expiresInSec}', async () => {
    const h = harness({ expiresAtMs: T0 + 300_000 });
    await h.cap.start(0);
    await vi.waitFor(() => expect(h.cap.state().historySec).toBeGreaterThan(30));
    h.tick(100_000); // 200 s left: nothing yet
    await h.cap.pollOnce();
    expect(h.calls.gql).toBe(0);
    h.tick(120_000); // 80 s left: inside the margin
    await h.cap.pollOnce();
    expect(h.calls).toEqual({ gql: 1, usher: 1 });
    const e = diag.entries().filter((x) => x.ev === 'hls-session').pop();
    expect(e?.data).toMatchObject({ reason: 'expiry' });
    expect((e?.data as { ageSec: number }).ageSec).toBe(220);
    expect((e?.data as { expiresInSec: number }).expiresInSec).toBe(600);
    expect(h.sessions.at(-1)?.url).toBe('https://v.example/audio_only/renewed.m3u8');
    h.cap.stop();
  });

  it('refreshes after an HTTP 403 of the media playlist', async () => {
    let st = 200;
    const h = harness({ playlistStatus: () => st });
    await h.cap.start(0);
    await vi.waitFor(() => expect(h.cap.state().historySec).toBeGreaterThan(30));
    st = 403;
    await h.cap.pollOnce();
    expect(h.calls).toEqual({ gql: 1, usher: 1 });
    expect(diag.entries().filter((x) => x.ev === 'hls-session').pop()?.data).toMatchObject({ reason: 'http-403' });
    h.cap.stop();
  });

  it('softRestart re-reads the playlist with the SAME media URL and no new session; the aligned clock stays', async () => {
    const h = harness();
    await h.cap.start(0);
    await vi.waitFor(() => expect(h.cap.state().historySec).toBeGreaterThan(30));
    h.feedVideo(12, 26, OFFSET);
    h.tick(2000);
    await h.cap.pollOnce();
    expect(h.cap.state().aligned).toBe(true);
    h.cap.softRestart('no-chunks');
    await vi.waitFor(() => expect(diag.entries().some((x) => x.ev === 'hls-soft-restart')).toBe(true));
    await h.cap.pollOnce();
    expect(h.calls).toEqual({ gql: 0, usher: 0 });
    expect(h.cap.state().aligned).toBe(true);
    expect(h.cap.state().offsetSec).toBeCloseTo(OFFSET, 1);
    h.cap.stop();
  });
});

describe('C: playlist gaps are reported, not treated as a stall', () => {
  it('inGap() is true while stitched-ad segments are skipped and for 10 s after; one episode counts once', async () => {
    const h = harness();
    await h.cap.start(0);
    await vi.waitFor(() => expect(h.cap.state().historySec).toBeGreaterThan(30));
    expect(h.cap.inGap()).toBe(false);
    expect(h.cap.gapCount()).toBe(0);
    await h.advance(true);
    await h.advance(true);
    await h.advance(true);
    expect(h.cap.inGap()).toBe(true);
    expect(h.cap.gapCount()).toBe(1);
    h.tick(30_000);
    await h.advance(false);
    await h.advance(false);
    await h.advance(false);
    h.tick(11_000);
    expect(h.cap.inGap()).toBe(false);
    await h.advance(true); // a second break
    expect(h.cap.gapCount()).toBe(2);
    h.cap.stop();
  });
});

describe('E: onsetProbe from the monitor envelope', () => {
  it('reports speaking / silentForSec of the played audio, undefined without data', async () => {
    const h = harness();
    expect(h.cap.onsetProbe(10)).toBeUndefined(); // not running
    await h.cap.start(0);
    expect(h.cap.onsetProbe(10)).toBeUndefined(); // nothing recorded
    // 6 s of speech-like audio, then 3 s of near silence, then speech again
    h.feedVideo(0, 6, OFFSET);
    h.feedVideo(6, 9, OFFSET, 0.001);
    const quiet = h.cap.onsetProbe(8.9);
    expect(quiet).toBeDefined();
    expect(quiet!.speaking).toBe(false);
    expect(quiet!.silentForSec).toBeGreaterThan(2);
    h.feedVideo(9, 10, OFFSET);
    const talking = h.cap.onsetProbe(9.95);
    expect(talking?.speaking).toBe(true);
    expect(talking!.silentForSec).toBeLessThan(0.5);
    expect(h.cap.onsetProbe(30)).toBeUndefined(); // far beyond the recorded audio: stale
    h.cap.stop();
  });
});
