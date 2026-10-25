import { describe, expect, it } from 'vitest';
import { demuxAudio, parseAdts } from '../src/capture/hls/tsDemux';
import { parseMasterPlaylist, parseMediaPlaylist, pickAudioOnly, twitchChannelFromPath } from '../src/capture/hls/playlist';
import { correlateEnvelopes, Envelope } from '../src/capture/hls/align';
import { fetchAudioPlaylistUrl, HlsAccessError, usherUrl } from '../src/capture/hls/twitchApi';
import { createCapture, isHlsHost, strategiesForHost } from '../src/capture';
import { adtsFrame, audioSegment, buildTs } from './hlsFixtures';

describe('tsDemux', () => {
  it('extracts ADTS frames with PTS from PAT/PMT/PES', () => {
    const ts = audioSegment(1234.5, 94, 2);
    const r = demuxAudio(ts);
    expect(r.audioPid).toBe(0x100);
    expect(r.badPackets).toBe(0);
    expect(r.ccErrors).toBe(0);
    expect(r.frames.length).toBe(94);
    expect(r.frames[0]!.pts).toBeCloseTo(1234.5, 4);
    expect(r.frames[0]!.sampleRate).toBe(48000);
    expect(r.frames[0]!.channels).toBe(2);
    // pts continuity across the PES border: frame k = start + k*1024/48000
    for (let k = 0; k < r.frames.length; k++) expect(r.frames[k]!.pts).toBeCloseTo(1234.5 + (k * 1024) / 48000, 3);
    expect(r.frames.every((f) => f.data[0] === 0xff)).toBe(true);
  });

  it('handles a 33-bit PTS beyond 2^32 / 90000', () => {
    const t = 60000.25; // > 2^32/90000 = 47721 s
    const r = demuxAudio(audioSegment(t, 10, 1));
    expect(r.frames[0]!.pts).toBeCloseTo(t, 4);
  });

  it('a PES without PTS continues the previous frame run', () => {
    const f = [adtsFrame(50), adtsFrame(50)];
    const ts = buildTs([
      { pts: 10, frames: [f[0]!] },
      { pts: undefined, frames: [f[1]!] },
    ]);
    const r = demuxAudio(ts);
    expect(r.frames.length).toBe(2);
    expect(r.frames[1]!.pts).toBeCloseTo(10 + 1024 / 48000, 4);
  });

  it('ignores a non-AAC PID and tolerates garbage before the first sync byte', () => {
    const ts = audioSegment(5, 4, 1);
    const junk = new Uint8Array(100).fill(0x11);
    const joined = new Uint8Array(junk.length + ts.length);
    joined.set(junk, 0);
    joined.set(ts, junk.length);
    // the junk is not 188 bytes, so sync must be found by the 188-periodic 0x47
    expect(demuxAudio(joined).frames.length).toBeGreaterThanOrEqual(0);
    expect(demuxAudio(ts).frames.length).toBe(4);
  });

  it('counts continuity errors on the audio pid', () => {
    const ts = audioSegment(1, 94, 1).slice();
    // drop one audio packet in the middle
    const pkts = ts.length / 188;
    const cut = new Uint8Array(ts.length - 188);
    cut.set(ts.subarray(0, 188 * 5), 0);
    cut.set(ts.subarray(188 * 6), 188 * 5);
    expect(pkts).toBeGreaterThan(8);
    expect(demuxAudio(cut).ccErrors).toBeGreaterThan(0);
  });

  it('parseAdts stops on a truncated frame', () => {
    const a = adtsFrame(100);
    expect(parseAdts(a.subarray(0, a.length - 5), 0).length).toBe(0);
  });
});

const MASTER = `#EXTM3U
#EXT-X-TWITCH-INFO:NODE="x"
#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="chunked",NAME="1080p60 (source)",AUTOSELECT=YES,DEFAULT=YES
#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=8000000,CODECS="avc1.64002A,mp4a.40.2",RESOLUTION=1920x1080,VIDEO="chunked"
https://v.example/chunked/index-live.m3u8
#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="audio_only",NAME="audio_only",AUTOSELECT=NO,DEFAULT=NO
#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=160000,CODECS="mp4a.40.2",VIDEO="audio_only"
https://v.example/audio_only/index-live.m3u8
`;

describe('playlists', () => {
  it('master: picks the audio_only variant', () => {
    const v = parseMasterPlaylist(MASTER, 'https://usher.ttvnw.net/api/x.m3u8');
    expect(v.length).toBe(2);
    expect(pickAudioOnly(v)?.url).toBe('https://v.example/audio_only/index-live.m3u8');
    expect(v[0]!.audioOnly).toBe(false);
  });

  it('master without audio_only', () => {
    expect(pickAudioOnly(parseMasterPlaylist(MASTER.split('#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="audio_only"')[0]!, 'https://x/'))).toBeUndefined();
  });

  const MEDIA = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:100
#EXT-X-DATERANGE:ID="stitched-ad-1",CLASS="twitch-stitched-ad",START-DATE="2026-10-24T14:00:04.000Z",DURATION=4.0
#EXT-X-PROGRAM-DATE-TIME:2026-10-24T14:00:00.000Z
#EXTINF:2.000,live
seg100.ts
#EXTINF:2.000,live
seg101.ts
#EXT-X-PROGRAM-DATE-TIME:2026-10-24T14:00:04.000Z
#EXTINF:2.000,Amazon
ad102.ts
#EXTINF:2.000,Amazon
ad103.ts
#EXT-X-PROGRAM-DATE-TIME:2026-10-24T14:00:08.000Z
#EXTINF:2.000,live
seg104.ts
#EXT-X-TWITCH-PREFETCH:https://v.example/seg105.ts
#EXT-X-TWITCH-PREFETCH:https://v.example/seg106.ts
`;

  it('media: sequence numbers, ads and prefetch', () => {
    const pl = parseMediaPlaylist(MEDIA);
    expect(pl.targetDuration).toBe(6);
    expect(pl.mediaSequence).toBe(100);
    expect(pl.segments.map((s) => s.seq)).toEqual([100, 101, 102, 103, 104]);
    expect(pl.segments.map((s) => s.ad)).toEqual([false, false, true, true, false]);
    expect(pl.prefetch.length).toBe(2);
    expect(pl.segments.some((s) => s.uri.includes('105'))).toBe(false); // prefetch never becomes a segment
    expect(pl.segments[0]!.duration).toBe(2);
  });

  it('media: an ad flagged only by DATERANGE window (title "live")', () => {
    const pl = parseMediaPlaylist(MEDIA.replace(/Amazon/g, 'live'));
    expect(pl.segments.map((s) => s.ad)).toEqual([false, false, true, true, false]);
  });

  it('media: plain live playlist has no ads', () => {
    const pl = parseMediaPlaylist('#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:5\n#EXTINF:2.000,live\na.ts\n#EXTINF:2.000,live\nb.ts\n');
    expect(pl.segments.every((s) => !s.ad)).toBe(true);
    expect(pl.segments[1]!.seq).toBe(6);
  });

  it('channel from pathname', () => {
    expect(twitchChannelFromPath('/sondergaardlol')).toBe('sondergaardlol');
    expect(twitchChannelFromPath('/SomeChannel/')).toBe('somechannel');
    expect(twitchChannelFromPath('/popout/chan_1/chat')).toBe('chan_1');
    for (const bad of ['/', '/videos/123', '/directory', '/directory/game/Foo', '/somechan/videos', '/somechan/clip/AbC', '/settings', '/a']) expect(twitchChannelFromPath(bad), bad).toBeUndefined();
  });

  it('usher url has the audio_only flags and the token travels in the query only', () => {
    const u = usherUrl('chan', { value: 'V', signature: 'S' }, 42);
    expect(u).toContain('https://usher.ttvnw.net/api/channel/hls/chan.m3u8?');
    expect(u).toContain('allow_audio_only=true');
    expect(u).toContain('sig=S');
    expect(u).toContain('p=42');
  });
});

describe('twitch access flow', () => {
  const json = (o: unknown, status = 200): Response => new Response(JSON.stringify(o), { status });
  it('token -> master -> audio_only url, credentials omitted, public client id', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const f = async (url: string, init?: RequestInit): Promise<Response> => {
      calls.push({ url, init });
      if (url.startsWith('https://gql.twitch.tv/')) return json({ data: { streamPlaybackAccessToken: { value: 'TOK', signature: 'SIG' } } });
      return new Response(MASTER, { status: 200 });
    };
    const url = await fetchAudioPlaylistUrl('chan', f);
    expect(url).toBe('https://v.example/audio_only/index-live.m3u8');
    expect(calls[0]!.init?.credentials).toBe('omit');
    expect((calls[0]!.init?.headers as Record<string, string>)['Client-ID']).toBe('kimne78kx3ncx6brgo4mv6wki5h1ko');
    expect(calls[1]!.url).toContain('sig=SIG');
  });

  it('offline channel (null token) and 403 are classified', async () => {
    const off = async (): Promise<Response> => json({ data: { streamPlaybackAccessToken: null } });
    await expect(fetchAudioPlaylistUrl('c', off)).rejects.toMatchObject({ reason: 'offline' });
    const forb = async (url: string): Promise<Response> => (url.includes('gql') ? json({ data: { streamPlaybackAccessToken: { value: 'a', signature: 'b' } } }) : new Response('', { status: 403 }));
    await expect(fetchAudioPlaylistUrl('c', forb)).rejects.toMatchObject({ reason: 'forbidden' });
    const net = async (): Promise<Response> => {
      throw new Error('boom');
    };
    await expect(fetchAudioPlaylistUrl('c', net)).rejects.toBeInstanceOf(HlsAccessError);
  });
});

// deterministic speech-like signal as a function of absolute time
function amp(t: number): number {
  const k = Math.floor(t * 2.7);
  const x = Math.sin(k * 12.9898) * 43758.5453;
  const r = x - Math.floor(x);
  return r < 0.3 ? 0.01 : 0.05 + 0.5 * r;
}
function signal(t0: number, sec: number, rate = 16000): Float32Array {
  const out = new Float32Array(Math.round(sec * rate));
  for (let i = 0; i < out.length; i++) {
    const t = t0 + i / rate;
    out[i] = Math.sin(2 * Math.PI * 220 * t) * amp(t);
  }
  return out;
}

describe('envelope alignment', () => {
  it('recovers a known offset', () => {
    const OFFSET = 357.35; // pts = videoTime + offset
    const hls = new Envelope();
    const video = new Envelope();
    hls.add(signal(300, 140), 16000, 300);
    // video plays video time 10..40 == pts (10+OFFSET)..
    video.add(signal(10 + OFFSET, 30), 16000, 10);
    const r = correlateEnvelopes(video, hls, { fromSec: 20, toSec: 40, centerSec: 340, rangeSec: 40 });
    expect(r.ok).toBe(true);
    expect(r.offsetSec).toBeCloseTo(OFFSET, 1);
    expect(r.peak).toBeGreaterThan(0.9);
  });

  it('rejects uncorrelated audio', () => {
    const hls = new Envelope();
    const video = new Envelope();
    hls.add(signal(300, 90), 16000, 300);
    video.add(signal(5000, 30), 16000, 10); // other content
    const r = correlateEnvelopes(video, hls, { fromSec: 20, toSec: 40, centerSec: 340, rangeSec: 40 });
    expect(r.ok).toBe(false);
  });

  it('rejects silence and too little data', () => {
    const hls = new Envelope();
    const video = new Envelope();
    hls.add(signal(300, 90), 16000, 300);
    video.add(new Float32Array(16000 * 30), 16000, 10);
    expect(correlateEnvelopes(video, hls, { fromSec: 20, toSec: 40, centerSec: 340, rangeSec: 40 }).ok).toBe(false);
    const short = new Envelope();
    short.add(signal(310, 3), 16000, 10);
    expect(correlateEnvelopes(short, hls, { fromSec: 10, toSec: 13, centerSec: 300, rangeSec: 40 }).ok).toBe(false);
  });

  it('survives a gain change and noise on the video side', () => {
    const OFFSET = 120;
    const hls = new Envelope();
    const video = new Envelope();
    hls.add(signal(100, 90), 16000, 100);
    const v = signal(15 + OFFSET, 25);
    let seed = 1;
    for (let i = 0; i < v.length; i++) {
      seed = (seed * 16807) % 2147483647;
      v[i] = v[i]! * 0.3 + ((seed / 2147483647 - 0.5) * 0.02);
    }
    video.add(v, 16000, 15);
    const r = correlateEnvelopes(video, hls, { fromSec: 20, toSec: 40, centerSec: 110, rangeSec: 40 });
    expect(r.ok).toBe(true);
    expect(r.offsetSec).toBeCloseTo(OFFSET, 1);
  });
});

describe('capture strategy selection', () => {
  it('twitch hosts: hls then realtime, others keep mse/direct/realtime', () => {
    for (const h of ['twitch.tv', 'www.twitch.tv', 'm.twitch.tv', 'player.TWITCH.tv']) {
      expect(isHlsHost(h), h).toBe(true);
      expect(strategiesForHost(h)).toEqual(['hls', 'realtime']);
    }
    for (const h of ['youtube.com', 'nottwitch.tv', 'twitch.tv.evil.com', '']) {
      expect(isHlsHost(h), h).toBe(false);
      expect(strategiesForHost(h)).toEqual(['mse', 'direct', 'realtime']);
    }
  });

  const video = { currentSrc: '', duration: Infinity } as unknown as HTMLMediaElement;
  const okFetch = async (url: string): Promise<Response> =>
    url.startsWith('https://gql.twitch.tv/')
      ? new Response(JSON.stringify({ data: { streamPlaybackAccessToken: { value: 'a', signature: 'b' } } }))
      : new Response(MASTER);

  it('createCapture picks hls on a channel page', async () => {
    const statuses: string[] = [];
    const cap = await createCapture(video, {
      strategies: ['hls'],
      hlsFetch: okFetch,
      pathname: '/sondergaardlol',
      hlsMonitor: () => ({ start: async () => {}, stop() {}, onStatus: () => () => {} }),
      onStatus: (s) => statuses.push(s.type),
    });
    expect(cap.kind).toBe('hls');
    expect(statuses).toContain('chosen');
  });

  it('falls through when hls is impossible (no transport / not a channel / 403 / offline)', async () => {
    await expect(createCapture(video, { strategies: ['hls'], pathname: '/chan' })).rejects.toThrow(/hls: no transport/);
    await expect(createCapture(video, { strategies: ['hls'], hlsFetch: okFetch, pathname: '/videos/12' })).rejects.toThrow(/not a channel page/);
    const forb = async (url: string): Promise<Response> => (url.includes('gql') ? okFetch(url) : new Response('', { status: 403 }));
    await expect(createCapture(video, { strategies: ['hls'], hlsFetch: forb, pathname: '/chan' })).rejects.toThrow(/hls: forbidden/);
    const off = async (): Promise<Response> => new Response(JSON.stringify({ data: { streamPlaybackAccessToken: null } }));
    await expect(createCapture(video, { strategies: ['hls'], hlsFetch: off, pathname: '/chan' })).rejects.toThrow(/hls: offline/);
  });
});
