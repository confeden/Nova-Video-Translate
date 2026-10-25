import { describe, expect, it } from 'vitest';
import {
  HF_REMOTE_HOST,
  createSessionWithFallback,
  describeError,
  downloadWhisperFiles,
  verifyWhisperFiles,
  whisperCacheKey,
  whisperFileList,
  type CacheLike,
} from '../src/localasr/whisperDownload';
import { transformersDtype } from '../src/localasr/whisperModels';
import { createResilientFetch } from '../src/localasr/mirror';

async function node(spec: string): Promise<any> {
  return import(/* @vite-ignore */ spec);
}

const INFO = { id: 'onnx-community/whisper-base.en', revision: '51eefc0af78b103839eda9e7e4f4186acc6517fe' };

class FakeCache implements CacheLike {
  store = new Map<string, Uint8Array>();
  async match(k: string): Promise<Response | undefined> {
    const v = this.store.get(k);
    return v ? new Response(v.slice()) : undefined;
  }
  async put(k: string, r: Response): Promise<void> {
    this.store.set(k, new Uint8Array(await r.arrayBuffer()));
  }
}

const sizeOfFile = (f: string): number => 100 + f.length;
/** serves every file of the HF url with a deterministic body; `fail` makes chosen files break */
function fakeFetch(opts: { missing?: Set<string>; calls?: string[] } = {}): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    opts.calls?.push(url);
    const file = url.split('/resolve/')[1]!.split('/').slice(1).join('/');
    if (opts.missing?.has(file)) return new Response('', { status: 404 });
    const n = sizeOfFile(file);
    return new Response(new Uint8Array(n).fill(7), { headers: { 'content-length': String(n), 'content-type': 'application/octet-stream' } });
  }) as typeof fetch;
}

describe('file list', () => {
  it('q8 uses _quantized, fp16 uses _fp16, both include the tokenizer/config files', () => {
    const q8 = whisperFileList('q8').map((f) => f.file);
    const fp16 = whisperFileList('fp16').map((f) => f.file);
    expect(q8).toContain('onnx/encoder_model_quantized.onnx');
    expect(q8).toContain('onnx/decoder_model_merged_quantized.onnx');
    expect(fp16).toContain('onnx/encoder_model_fp16.onnx');
    expect(fp16).toContain('onnx/decoder_model_merged_fp16.onnx');
    for (const l of [q8, fp16]) for (const f of ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'preprocessor_config.json', 'generation_config.json']) expect(l).toContain(f);
    const mixed = whisperFileList('gpu-mixed').map((f) => f.file);
    expect(mixed).toContain('onnx/encoder_model.onnx'); // transformers.js fp32 => '' suffix
    expect(mixed).toContain('onnx/decoder_model_merged_q4.onnx'); // q4 => '_q4'
    expect(mixed.filter((f) => f.startsWith('onnx/')).length).toBe(2);
    expect(transformersDtype('gpu-mixed')).toEqual({ encoder_model: 'fp32', decoder_model_merged: 'q4' });
    expect(transformersDtype('q8')).toBe('q8');
    expect(whisperFileList('q8').find((f) => f.file === 'generation_config.json')?.optional).toBe(true);
  });
});

describe('cache key', () => {
  it('is the HF resolve URL with the pinned revision (what transformers.js getModelFile uses)', () => {
    expect(whisperCacheKey(INFO.id, INFO.revision, 'onnx/encoder_model_quantized.onnx')).toBe(`${HF_REMOTE_HOST}onnx-community/whisper-base.en/resolve/${INFO.revision}/onnx/encoder_model_quantized.onnx`);
  });

  // runs the real transformers.js getModelFile (Node child process) against a Cache seeded under our keys, remote disabled
  it('transformers.js getModelFile finds files stored under our keys without network', async () => {
    const fs = await node('node:fs');
    const path = await node('node:path');
    const url = await node('node:url');
    const cp = await node('node:child_process');
    const dir = path.dirname(url.fileURLToPath(import.meta.url));
    const hub = path.resolve(dir, '../../../node_modules/@huggingface/transformers/src/utils/hub.js');
    if (!fs.existsSync(hub)) return; // transformers.js not installed here
    const file = 'onnx/encoder_model_quantized.onnx';
    const seed = { [whisperCacheKey(INFO.id, INFO.revision, file)]: [1, 2, 3, 4] };
    const r = cp.spawnSync((await node('node:process')).execPath, [path.join(dir, 'helpers/hubCacheProbe.mjs'), hub, JSON.stringify(seed), INFO.id, INFO.revision, file], { encoding: 'utf8', timeout: 30_000 });
    expect(r.status, String(r.stderr)).toBe(0);
    // a hit, and an optional file that is not cached resolves to null instead of reaching for the network
    expect(JSON.parse(r.stdout.slice(r.stdout.indexOf('{')))).toEqual({ hit: [1, 2, 3, 4], optionalMissing: null });
  }, 30_000);
});

describe('error normalisation', () => {
  const ctx = { stage: 'session-create' as const, model: 'onnx-community/whisper-tiny.en', device: 'webgpu' as const, dtype: 'q8' as const, deviceMemory: 8, gpu: true, f16: false };
  it('a thrown number becomes an ORT error code with context', () => {
    const s = describeError(26624112, ctx);
    expect(s).toMatch(/^ORT error code 26624112 \(stage: session-create, model: whisper-tiny\.en, device: webgpu, dtype: q8, deviceMemory: 8GB, gpu: yes, f16: no\)$/);
  });
  it('a numeric string / numeric message is treated as a code too', () => {
    expect(describeError('171749624', ctx)).toContain('ORT error code 171749624');
    expect(describeError(new Error('459887608'), ctx)).toContain('ORT error code 459887608');
    expect(describeError({ message: 459887608 }, ctx)).toContain('ORT error code 459887608');
  });
  it('keeps real messages, never returns a bare number, handles junk', () => {
    expect(describeError(new Error('no WebGPU'), { stage: 'download' })).toBe('no WebGPU (stage: download)');
    for (const v of [undefined, null, {}, 0, 5, [], Symbol.iterator as unknown]) expect(describeError(v, { stage: 'transcribe' })).not.toMatch(/^\d+$/);
    expect(describeError(undefined, { stage: 'transcribe' })).toContain('unknown error');
    expect(describeError(new Error('x'.repeat(1000)), ctx).length).toBeLessThanOrEqual(240);
  });
});

describe('download-only flow', () => {
  it('stores every file under the transformers.js key with real byte progress and verifies', async () => {
    const cache = new FakeCache();
    const progress: Array<[number, number]> = [];
    const res = await downloadWhisperFiles({ info: INFO, dtype: 'q8', fetch: fakeFetch(), cache, onProgress: (l, t) => progress.push([l, t]) });
    const list = whisperFileList('q8');
    expect(res.map((r) => r.file)).toEqual(list.map((f) => f.file));
    for (const f of list) expect(cache.store.get(whisperCacheKey(INFO.id, INFO.revision, f.file))?.length).toBe(sizeOfFile(f.file));
    const sum = list.reduce((a, f) => a + sizeOfFile(f.file), 0);
    expect(progress.at(-1)).toEqual([sum, sum]);
    expect(progress.every(([l, t]) => l <= t)).toBe(true);
    const expected = Object.fromEntries(res.map((r) => [r.file, r.bytes]));
    expect(await verifyWhisperFiles(cache, INFO, 'q8', expected)).toEqual({ ok: true, missing: [], bad: [] });
  });

  it('skips cached files (resume) and tolerates a missing optional file', async () => {
    const cache = new FakeCache();
    const calls: string[] = [];
    const missing = new Set(['generation_config.json']);
    await downloadWhisperFiles({ info: INFO, dtype: 'fp16', fetch: fakeFetch({ calls, missing }), cache });
    expect(calls.length).toBe(whisperFileList('fp16').length);
    calls.length = 0;
    const again = await downloadWhisperFiles({ info: INFO, dtype: 'fp16', fetch: fakeFetch({ calls, missing }), cache });
    expect(calls).toEqual([whisperCacheKey(INFO.id, INFO.revision, 'generation_config.json')]); // only the file that was never stored
    expect(again.filter((r) => r.cached).length).toBe(whisperFileList('fp16').length - 1);
  });

  it('a missing required file fails; verification reports missing / wrong-size files', async () => {
    const cache = new FakeCache();
    await expect(downloadWhisperFiles({ info: INFO, dtype: 'q8', fetch: fakeFetch({ missing: new Set(['tokenizer.json']) }), cache })).rejects.toThrow(/tokenizer\.json: HTTP 404/);
    const v = await verifyWhisperFiles(cache, INFO, 'q8');
    expect(v.ok).toBe(false);
    expect(v.missing).toContain('tokenizer.json');

    const full = new FakeCache();
    const res = await downloadWhisperFiles({ info: INFO, dtype: 'q8', fetch: fakeFetch(), cache: full });
    const expected = Object.fromEntries(res.map((r) => [r.file, r.bytes]));
    expected['config.json'] = 1;
    expect((await verifyWhisperFiles(full, INFO, 'q8', expected)).bad).toEqual(['config.json']);
  });

  it('cancel aborts with AbortError and leaves no partial entry', async () => {
    const cache = new FakeCache();
    let n = 0;
    await expect(downloadWhisperFiles({ info: INFO, dtype: 'q8', fetch: fakeFetch(), cache, isCancelled: () => ++n > 3 })).rejects.toMatchObject({ name: 'AbortError' });
    expect(cache.store.size).toBeLessThan(whisperFileList('q8').length);
  });

  it('works through the mirror-first resilient fetch (cache key stays the HF url)', async () => {
    const cache = new FakeCache();
    const hits: string[] = [];
    const base = (async (u: string) => {
      hits.push(u);
      return u.startsWith('https://huggingface.co') ? new Response('x'.repeat(10), { headers: { 'content-length': '10' } }) : new Response('', { status: 404 });
    }) as never;
    const f = createResilientFetch(base, { sleep: async () => {} });
    await downloadWhisperFiles({ info: INFO, dtype: 'q8', fetch: f, cache });
    expect(hits[0]).toContain('beget');
    expect([...cache.store.keys()].every((k) => k.startsWith('https://huggingface.co/'))).toBe(true);
  });
});

describe('session creation with WASM retry', () => {
  const base = { model: INFO.id, caps: { deviceMemory: 4, gpu: true, f16: false } };

  it('no retry when the first session works', async () => {
    const calls: string[] = [];
    const r = await createSessionWithFallback({ ...base, plan: { device: 'webgpu', dtype: 'fp16' }, factory: async (d, t) => (calls.push(`${d}/${t}`), 'pipe') });
    expect(r).toMatchObject({ value: 'pipe', device: 'webgpu', dtype: 'fp16', fellBack: false });
    expect(calls).toEqual(['webgpu/fp16']);
  });

  it('a WebGPU failure thrown as a number retries on wasm/q8, ensures the q8 files and resets first', async () => {
    const calls: string[] = [];
    const r = await createSessionWithFallback({
      ...base,
      plan: { device: 'webgpu', dtype: 'fp16' },
      factory: async (d, t) => {
        calls.push(`${d}/${t}`);
        if (d === 'webgpu') throw 26624112;
        return 'cpu-pipe';
      },
      ensureFiles: async (t) => void calls.push(`ensure:${t}`),
      reset: async () => void calls.push('reset'),
    });
    expect(r).toMatchObject({ value: 'cpu-pipe', device: 'wasm', dtype: 'q8', fellBack: true });
    expect(r.firstError).toContain('ORT error code 26624112');
    expect(calls).toEqual(['webgpu/fp16', 'reset', 'ensure:q8', 'wasm/q8']);
  });

  it('a failing gpu-mixed tries a cached alternative GPU dtype before falling to wasm', async () => {
    const calls: string[] = [];
    const r = await createSessionWithFallback({
      ...base,
      plan: { device: 'webgpu', dtype: 'gpu-mixed' },
      gpuAlternatives: ['gpu-mixed', 'fp16'],
      factory: async (d, t) => {
        calls.push(`${d}/${t}`);
        if (t === 'gpu-mixed') throw 26624112;
        return 'gpu16';
      },
      reset: async () => void calls.push('reset'),
    });
    expect(r).toMatchObject({ value: 'gpu16', device: 'webgpu', dtype: 'fp16', fellBack: false });
    expect(calls).toEqual(['webgpu/gpu-mixed', 'reset', 'webgpu/fp16']);
  });

  it('both failing gives one readable error with both causes, no bare number', async () => {
    const err = await createSessionWithFallback({ ...base, plan: { device: 'webgpu', dtype: 'q8' }, factory: async (d) => { throw d === 'webgpu' ? 171749624 : new Error('out of memory'); } }).catch((e: Error) => e);
    expect((err as Error).message).toContain('out of memory (stage: session-create');
    expect((err as Error).message).toContain('device: wasm');
    expect((err as Error).message).toContain('ORT error code 171749624');
  });

  it('a WASM plan does not retry and is normalised', async () => {
    let n = 0;
    const err = await createSessionWithFallback({ ...base, plan: { device: 'wasm', dtype: 'q8' }, factory: async () => (n++, Promise.reject(459887608)) }).catch((e: Error) => e);
    expect(n).toBe(1);
    expect((err as Error).message).toMatch(/^ORT error code 459887608 \(stage: session-create/);
  });
});
