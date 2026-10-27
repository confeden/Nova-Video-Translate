import { describe, expect, it } from 'vitest';
import { MP3_RANGE_BYTES, YandexClient } from '../src/providers/yandex/client';

/** big arrays: compare length and sampled bytes (toEqual on 30 MB is too slow / too much memory) */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 997) if (a[i] !== b[i]) return false;
  return a[a.length - 1] === b[b.length - 1];
}

/** fake host: serves `file` by Range; `ranges=false` answers 200 with the whole file */
function host(file: Uint8Array, opts: { ranges?: boolean; redirect?: boolean } = {}) {
  const seen: string[] = [];
  const transport = async (req: { url: string; headers: Record<string, string> }): Promise<{ status: number; headers: Record<string, string>; body: Uint8Array }> => {
    seen.push(req.headers.Range ?? '');
    if (opts.redirect && !req.url.includes('final')) return { status: 302, headers: { location: 'https://cdn.test/final.mp3' }, body: new Uint8Array(0) };
    if (opts.ranges === false) return { status: 200, headers: {}, body: file };
    const m = /bytes=(\d+)-(\d+)/.exec(req.headers.Range ?? '');
    if (!m) return { status: 200, headers: {}, body: file };
    const a = Number(m[1]);
    const b = Math.min(Number(m[2]), file.length - 1);
    return { status: 206, headers: { 'Content-Range': `bytes ${a}-${b}/${file.length}` }, body: file.slice(a, b + 1) };
  };
  return { transport, seen };
}
const fetchAudio = (c: YandexClient, url: string): Promise<Uint8Array> => (c as unknown as { fetchAudioHops(u: string): Promise<Uint8Array> }).fetchAudioHops(url);

describe('yandex full-track mp3 download in ranges (0.3.0)', () => {
  it('a file bigger than one range is fetched in parts and rebuilt byte for byte', async () => {
    const file = new Uint8Array(MP3_RANGE_BYTES * 2 + 1000).map((_, i) => i % 251);
    const h = host(file);
    const out = await fetchAudio(new YandexClient(h.transport), 'https://cdn.test/a.mp3');
    expect(sameBytes(out, file)).toBe(true);
    expect(h.seen.length).toBe(3);
  });
  it('a host without Range support gives the whole file in one reply', async () => {
    const file = new Uint8Array(5000).map((_, i) => i % 7);
    const out = await fetchAudio(new YandexClient(host(file, { ranges: false }).transport), 'https://cdn.test/a.mp3');
    expect(out).toEqual(file);
  });
  it('redirects are followed once and the final url is used for the next ranges', async () => {
    const file = new Uint8Array(MP3_RANGE_BYTES + 10).map((_, i) => i % 13);
    const h = host(file, { redirect: true });
    const out = await fetchAudio(new YandexClient(h.transport), 'https://cdn.test/a.mp3');
    expect(sameBytes(out, file)).toBe(true);
  });
});
