import { describe, expect, it } from 'vitest';
import { MODEL_MIRROR_BASE, createResilientFetch, modelSourceUrls, parseHfModelUrl } from '../src/localasr/mirror';

const REV = '51eefc0af78b103839eda9e7e4f4186acc6517fe';
const HF = `https://huggingface.co/onnx-community/whisper-base.en/resolve/${REV}/onnx/encoder_model_fp16.onnx`;
const noSleep = async (): Promise<void> => {};
const bytes = (n: number, from = 0): Uint8Array<ArrayBuffer> => Uint8Array.from({ length: n }, (_, i) => (i + from) & 255);

describe('model source urls', () => {
  it('mirror first, huggingface.co last, same path layout', () => {
    expect(modelSourceUrls(HF)).toEqual([`${MODEL_MIRROR_BASE}onnx-community/whisper-base.en/resolve/${REV}/onnx/encoder_model_fp16.onnx`, HF]);
    expect(MODEL_MIRROR_BASE.endsWith('/')).toBe(true);
  });
  it('ignores unpinned or foreign urls', () => {
    expect(parseHfModelUrl('https://huggingface.co/a/b/resolve/main/x.json')).toBeUndefined();
    expect(modelSourceUrls('https://example.com/x')).toBeUndefined();
  });
});

describe('resilient fetch', () => {
  it('passes foreign urls through', async () => {
    const calls: string[] = [];
    const f = createResilientFetch((async (u: string) => (calls.push(u), new Response('x'))) as never, { sleep: noSleep });
    await f('https://example.com/a');
    expect(calls).toEqual(['https://example.com/a']);
  });

  it('falls back to HF when the mirror is down, retrying 3+1 times first', async () => {
    const calls: string[] = [];
    const base = (async (u: string) => {
      calls.push(u);
      return u.startsWith('https://huggingface.co') ? new Response(bytes(10), { headers: { 'content-length': '10' } }) : new Response('x', { status: 503 });
    }) as never;
    const res = await createResilientFetch(base, { sleep: noSleep })(HF);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes(10));
    expect(calls.filter((u) => u.includes('beget')).length).toBe(4);
    expect(calls.at(-1)).toBe(HF);
  });

  it('404 on the mirror goes straight to HF without retries', async () => {
    const calls: string[] = [];
    const base = (async (u: string) => (calls.push(u), u.includes('beget') ? new Response('', { status: 404 }) : new Response('ok'))) as never;
    await createResilientFetch(base, { sleep: noSleep })(HF);
    expect(calls.length).toBe(2);
  });

  it('returns the 404 when every source lacks the file', async () => {
    const res = await createResilientFetch((async () => new Response('', { status: 404 })) as never, { sleep: noSleep })(HF);
    expect(res.status).toBe(404);
  });

  it('error names the file and status, clipped to 200 chars', async () => {
    const f = createResilientFetch((async () => new Response('', { status: 502 })) as never, { sleep: noSleep });
    const err = await f(HF).catch((e: Error) => e);
    expect((err as Error).message).toContain('onnx/encoder_model_fp16.onnx');
    expect((err as Error).message).toContain('HTTP 502');
    expect((err as Error).message.length).toBeLessThanOrEqual(200);
  });

  it('resumes a broken stream with a Range request', async () => {
    const ranges: Array<string | undefined> = [];
    let n = 0;
    const base = (async (_u: string, init?: RequestInit) => {
      const range = (init?.headers as Record<string, string> | undefined)?.Range;
      ranges.push(range);
      if (!range) {
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(bytes(4));
            n++;
          },
          pull(c) {
            c.error(new Error('reset'));
          },
        });
        return new Response(body, { headers: { 'content-length': '10' } });
      }
      return new Response(bytes(6, 4), { status: 206, headers: { 'content-length': '6' } });
    }) as never;
    const res = await createResilientFetch(base, { sleep: noSleep })(HF);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes(10));
    expect(ranges).toEqual([undefined, 'bytes=4-']);
    expect(n).toBe(1);
  });
});
