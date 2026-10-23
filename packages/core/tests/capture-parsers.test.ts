import { describe, expect, it } from 'vitest';
import { Coalescer, TARGET_RATE, TimelineRing, downmixToMono, floatToInt16, resampleMono, sliceChunks, toMono16k } from '../src/capture/audio';
import { fragmentTiming, parseMp4Init, splitMp4, topLevelTypes } from '../src/capture/mp4';
import { isWebm, parseWebmClusters, parseWebmInit } from '../src/capture/webm';
import type { AudioChunk } from '../src/providers/types';
import { box, concat, mp4Fragment, mp4Init, webmCluster, webmInit } from './helpers/media-fixtures';

describe('mp4', () => {
  it('reads track id, timescale and handler from init (v0 and v1 boxes)', () => {
    const a = parseMp4Init(mp4Init({ trackId: 2, timescale: 48000, handler: 'soun', trexDur: 1024 }));
    expect(a).toEqual([{ id: 2, timescale: 48000, kind: 'audio', defaultSampleDuration: 1024 }]);
    const v = parseMp4Init(mp4Init({ trackId: 1, timescale: 90000, handler: 'vide', v1: true }));
    expect(v[0]).toMatchObject({ id: 1, timescale: 90000, kind: 'video' });
  });

  it('computes start from tfdt and duration from trun sample durations', () => {
    const track = parseMp4Init(mp4Init({ trackId: 1, timescale: 48000, handler: 'soun' }))[0]!;
    const seg = mp4Fragment({ trackId: 1, baseTime: 48000 * 12, durations: Array(235).fill(1024) });
    const t = fragmentTiming(seg, track)!;
    expect(t.startSec).toBeCloseTo(12, 6);
    expect(t.durationSec).toBeCloseTo((235 * 1024) / 48000, 6);
  });

  it('falls back to tfhd default duration, then trex default; supports 64-bit tfdt', () => {
    const track = parseMp4Init(mp4Init({ trackId: 1, timescale: 44100, handler: 'soun', trexDur: 1024 }))[0]!;
    const withTfhd = fragmentTiming(mp4Fragment({ trackId: 1, baseTime: 44100, defaultDur: 2048, count: 10, tfdt64: true }), track)!;
    expect(withTfhd.durationSec).toBeCloseTo(20480 / 44100, 6);
    const withTrex = fragmentTiming(mp4Fragment({ trackId: 1, baseTime: 0, count: 10 }), track)!;
    expect(withTrex.durationSec).toBeCloseTo(10240 / 44100, 6);
  });

  it('sums several moofs, picks the right track, returns null for foreign track', () => {
    const track = parseMp4Init(mp4Init({ trackId: 1, timescale: 1000, handler: 'soun' }))[0]!;
    const seg = concat(
      mp4Fragment({ trackId: 1, baseTime: 5000, durations: [1000, 1000] }),
      mp4Fragment({ trackId: 1, baseTime: 7000, durations: [500] }),
    );
    expect(fragmentTiming(seg, track)).toEqual({ startSec: 5, durationSec: 2.5 });
    expect(fragmentTiming(mp4Fragment({ trackId: 9, baseTime: 0, durations: [1] }), track)).toBeNull();
  });

  it('splits an init+media append', () => {
    const init = mp4Init({ trackId: 1, timescale: 1000, handler: 'soun' });
    const frag = mp4Fragment({ trackId: 1, baseTime: 0, durations: [1000] });
    expect(splitMp4(init)).toEqual({ init });
    expect(splitMp4(frag).media?.length).toBe(frag.length);
    const both = splitMp4(concat(init, frag));
    expect(both.init?.length).toBe(init.length);
    expect(both.media?.length).toBe(frag.length);
    expect(topLevelTypes(concat(init, frag))).toEqual(['ftyp', 'moov', 'moof', 'mdat']);
    expect(splitMp4(box('free', new Uint8Array(4)))).toEqual({});
  });
});

describe('webm', () => {
  it('reads timecode scale, audio track and first cluster offset', () => {
    const init = webmInit({ audioTrack: 2, withVideoTrack: 1, scale: 1_000_000 });
    expect(isWebm(init)).toBe(true);
    const cluster = webmCluster({ timecode: 5000, blocks: [{ track: 2, rel: 0 }] });
    const w = parseWebmInit(concat(init, cluster));
    expect(w).toMatchObject({ timecodeScale: 1_000_000, audioTrack: 2, hasVideo: true });
    expect(w.clusterOffset).toBe(init.length);
    expect(parseWebmInit(init).clusterOffset).toBe(-1);
  });

  it('cluster timing from SimpleBlock timecodes (opus 20 ms frames), filtering by track', () => {
    const blocks = Array.from({ length: 250 }, (_, i) => ({ track: 2, rel: i * 20 }));
    blocks.push({ track: 1, rel: 3 }); // other track must be ignored
    const t = parseWebmClusters(webmCluster({ timecode: 10_000, blocks }), 1_000_000, 2)!;
    expect(t.startSec).toBeCloseTo(10, 6);
    expect(t.durationSec).toBeCloseTo(5, 6);
  });

  it('honours a custom timecode scale and several clusters', () => {
    const c1 = webmCluster({ timecode: 100, blocks: [{ track: 1, rel: 0 }, { track: 1, rel: 10 }] });
    const c2 = webmCluster({ timecode: 200, blocks: [{ track: 1, rel: 0 }, { track: 1, rel: 10 }] });
    const t = parseWebmClusters(concat(c1, c2), 10_000_000, 1)!; // 10 ms ticks
    expect(t.startSec).toBeCloseTo(1, 6);
    expect(t.durationSec).toBeCloseTo(1.1 + 0.1, 6);
    expect(parseWebmClusters(new Uint8Array([1, 2, 3]), 1_000_000)).toBeNull();
  });
});

describe('audio helpers', () => {
  const sine = (hz: number, rate: number, sec: number): Float32Array => Float32Array.from({ length: Math.round(rate * sec) }, (_, i) => Math.sin((2 * Math.PI * hz * i) / rate) * 0.5);

  it('downmixes and converts to int16', () => {
    expect(Array.from(downmixToMono([Float32Array.of(1, 0), Float32Array.of(0, 1)]))).toEqual([0.5, 0.5]);
    expect(Array.from(floatToInt16(Float32Array.of(0, 1, -1, 2)))).toEqual([0, 32767, -32768, 32767]);
  });

  it('resamples 48k -> 16k with correct length and preserves a 440 Hz tone', () => {
    const out = resampleMono(sine(440, 48000, 1), 48000, 16000);
    expect(out.length).toBe(16000);
    const ref = sine(440, 16000, 1);
    let err = 0;
    for (let i = 100; i < 15900; i++) err = Math.max(err, Math.abs(out[i]! - ref[i]!));
    expect(err).toBeLessThan(0.05);
  });

  it('44.1k -> 16k keeps length and the RMS of the tone; upsampling works', () => {
    const out = resampleMono(sine(1000, 44100, 2), 44100, 16000);
    expect(out.length).toBe(32000);
    const rms = Math.sqrt(out.reduce((s, x) => s + x * x, 0) / out.length);
    expect(rms).toBeCloseTo(0.5 / Math.SQRT2, 1);
    expect(resampleMono(Float32Array.of(0, 1), 8000, 16000).length).toBe(4);
    expect(toMono16k([sine(440, 16000, 0.5)], 16000).length).toBe(8000);
  });

  it('sliceChunks starts at fromSec and stamps the video timeline', () => {
    const pcm = new Int16Array(TARGET_RATE * 10);
    const cs = sliceChunks(pcm, 100, 4, 102);
    expect(cs.map((c) => [c.startSec, c.durationSec])).toEqual([[102, 4], [106, 4]]);
  });
});

const chunk = (start: number, dur: number, v = 1): AudioChunk => ({ startSec: start, durationSec: dur, sampleRate: TARGET_RATE, pcm: new Int16Array(dur * TARGET_RATE).fill(v) });

describe('TimelineRing (dedupe + cap)', () => {
  it('drops a re-appended segment (quality switch with slightly shifted bounds)', () => {
    const r = new TimelineRing<{ startSec: number; durationSec: number }>(600);
    expect(r.add({ startSec: 10, durationSec: 5 })).toBe(true);
    expect(r.add({ startSec: 10.02, durationSec: 4.98 })).toBe(false);
    expect(r.add({ startSec: 15, durationSec: 5 })).toBe(true);
    expect(r.add({ startSec: 12, durationSec: 5 })).toBe(false); // 3 s of 5 s overlaps an existing one
    expect(r.size).toBe(2);
  });

  it('evicts oldest-inserted beyond the cap', () => {
    const r = new TimelineRing<{ startSec: number; durationSec: number }>(20);
    for (let i = 0; i < 6; i++) r.add({ startSec: i * 5, durationSec: 5 });
    expect(r.totalSec).toBeLessThanOrEqual(20);
    expect(r.sorted()[0]!.startSec).toBe(10);
  });
});

describe('Coalescer', () => {
  it('merges contiguous segments to the target length', () => {
    const out: AudioChunk[] = [];
    const c = new Coalescer(10, (x) => out.push(x));
    c.push(chunk(0, 5, 1));
    expect(out).toHaveLength(0);
    c.push(chunk(5, 5, 2));
    expect(out).toHaveLength(1);
    expect(out[0]!.durationSec).toBe(10);
    expect(out[0]!.pcm[0]).toBe(1);
    expect(out[0]!.pcm[7.5 * TARGET_RATE]).toBe(2);
  });

  it('flushes the partial window on a discontinuity (seek) and on flush()', () => {
    const out: AudioChunk[] = [];
    const c = new Coalescer(10, (x) => out.push(x));
    c.push(chunk(0, 5));
    c.push(chunk(100, 5));
    expect(out.map((x) => x.startSec)).toEqual([0]);
    c.flush();
    expect(out.map((x) => x.startSec)).toEqual([0, 100]);
  });
});
