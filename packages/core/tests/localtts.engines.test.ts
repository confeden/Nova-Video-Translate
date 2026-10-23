import { describe, expect, it } from 'vitest';
import { AUTO_ENGINE_ORDER, LOCAL_TTS_ENGINES, LOCAL_TTS_SAMPLE_TEXT, allUnits, engineInfo, hasVoice, resolveVoice, unitFor } from '../src/localtts/catalog';
import { LocalTtsRegistry, orderWithPreference } from '../src/localtts/registry';
import type { LocalTtsEngine, LocalTtsEngineId, LocalTtsRequest } from '../src/localtts/types';
import { createRemoteEngine, type LttsTransport } from '../src/localtts/supertonic/client';
import { downloadModel, type ModelStore } from '../src/localtts/supertonic/download';
import { LTTS_ENV_KEY, unitStateKey, type LttsEnv, type LttsOp, type LttsState } from '../src/localtts/supertonic/protocol';
import { normalizeSettings } from '../src/settings';
import { DEFAULT_SETTINGS } from '../src/types';
import { autoEngine, engineOptionLabel, engineState, panelStateFrom, stateWord } from '../src/ui/localTtsSection';
import { SILERO_FILES, SILERO_VOICES } from '../src/localtts/silero/constants';
import { prepareSileroText } from '../src/localtts/silero/text';

const fakeEngine = (id: LocalTtsEngineId, available: boolean, calls: LocalTtsRequest[] = []): LocalTtsEngine => ({
  id,
  isAvailable: async () => available,
  voices: async () => engineInfo(id)?.voices.map((v) => v.id) ?? [],
  synth: async (r) => {
    calls.push(r);
    return { sampleRate: 24000, samples: new Int16Array(10), durationSec: 0.1 };
  },
});

describe('catalog', () => {
  it('GPU group = Supertonic WebGPU; CPU group = Silero, Piper, Supertonic WASM (slow, last)', () => {
    expect(LOCAL_TTS_ENGINES.filter((e) => e.group === 'gpu').map((e) => e.id)).toEqual(['supertonic-webgpu']);
    expect(LOCAL_TTS_ENGINES.filter((e) => e.group === 'cpu').map((e) => e.id)).toEqual(['silero-cpu', 'piper-wasm', 'supertonic-wasm']);
    expect(engineInfo('supertonic-wasm')!.speedNote).toBe('медленно');
    expect(engineInfo('supertonic-webgpu')!.needsGpu).toBe(true);
  });

  it('Supertonic exposes all ten voices, M1 default; Silero only eugene + xenia', () => {
    const st = engineInfo('supertonic-webgpu')!;
    expect(st.voices.map((v) => v.id)).toEqual(['M1', 'M2', 'M3', 'M4', 'M5', 'F1', 'F2', 'F3', 'F4', 'F5']);
    expect(st.defaultVoice).toBe('M1');
    expect(engineInfo('supertonic-wasm')!.voices).toEqual(st.voices);
    expect(engineInfo('silero-cpu')!.voices.map((v) => [v.id, v.gender])).toEqual([['eugene', 'm'], ['xenia', 'f']]);
    expect(SILERO_VOICES.map((v) => v.id)).toEqual(['eugene', 'xenia']);
    expect(engineInfo('piper-wasm')!.voices.map((v) => v.id).sort()).toEqual(['denis', 'dmitri', 'irina', 'ruslan']);
  });

  it('voice resolution falls back to the engine default', () => {
    expect(resolveVoice('supertonic-webgpu', 'F3')).toBe('F3');
    expect(resolveVoice('supertonic-webgpu', 'eugene')).toBe('M1');
    expect(resolveVoice('silero-cpu', undefined)).toBe('eugene');
    expect(hasVoice('silero-cpu', 'aidar')).toBe(false);
    expect(hasVoice('silero-cpu', 'xenia')).toBe(true);
  });

  it('Supertonic engines share ONE download unit; Piper has one unit per voice incl. the shared phonemizer data', () => {
    expect(unitFor('supertonic-webgpu')!.id).toBe('supertonic');
    expect(unitFor('supertonic-wasm')!.id).toBe('supertonic');
    expect(unitStateKey('supertonic')).toBe('nvt.localtts.supertonic'); // legacy key kept
    const a = unitFor('piper-wasm', 'dmitri')!;
    const b = unitFor('piper-wasm', 'irina')!;
    expect(a.id).toBe('piper:dmitri');
    expect(b.id).toBe('piper:irina');
    expect(a.files.some((f) => f.path.endsWith('.data'))).toBe(true);
    expect(a.files.filter((f) => f.path.endsWith('.onnx'))).toHaveLength(1);
    expect(a.total).toBeGreaterThan(80e6);
    expect(a.total).toBeLessThan(90e6);
    expect(allUnits().map((u) => u.id).sort()).toEqual(['piper:denis', 'piper:dmitri', 'piper:irina', 'piper:ruslan', 'silero', 'supertonic']);
  });

  it('every manifest file has a size and a sha256 when it is large (integrity)', () => {
    for (const u of allUnits()) {
      for (const f of u.files) {
        expect(f.size).toBeGreaterThan(0);
        if (f.size > 1e6) expect(f.sha256, `${u.id}/${f.path}`).toMatch(/^[0-9a-f]{64}$/);
      }
    }
  });

  it('Silero is published on the VPS and the size total matches the file list', () => {
    expect(unitFor('silero-cpu')!.published).toBe(true);
    expect(unitFor('silero-cpu')!.baseUrl).toBe('http://212.116.115.237:8081/silero/');
    expect(SILERO_FILES.reduce((a, f) => a + f.size, 0)).toBe(unitFor('silero-cpu')!.total);
  });

  it('sample text is three sentences', () => {
    expect(LOCAL_TTS_SAMPLE_TEXT.split(/(?<=\.)\s/)).toHaveLength(3);
  });
});

describe('registry honours the user choice', () => {
  const mk = (avail: Partial<Record<LocalTtsEngineId, boolean>>, calls: LocalTtsRequest[] = []) => {
    const r = new LocalTtsRegistry();
    for (const id of AUTO_ENGINE_ORDER) r.register(fakeEngine(id, avail[id] ?? false, calls));
    return r;
  };

  it('auto: GPU engine first, then CPU engines in quality order', async () => {
    expect((await mk({ 'supertonic-webgpu': true, 'silero-cpu': true }).pick())!.id).toBe('supertonic-webgpu');
    expect((await mk({ 'silero-cpu': true, 'piper-wasm': true, 'supertonic-wasm': true }).pick())!.id).toBe('silero-cpu');
    expect((await mk({ 'piper-wasm': true, 'supertonic-wasm': true }).pick())!.id).toBe('piper-wasm');
    expect((await mk({ 'supertonic-wasm': true }).pick())!.id).toBe('supertonic-wasm');
    expect(await mk({}).pick()).toBeUndefined();
  });

  it('the selected engine goes first, unavailable choice falls back to auto order', async () => {
    const r = mk({ 'supertonic-webgpu': true, 'silero-cpu': true, 'piper-wasm': true });
    r.setPreference(() => ({ engine: 'piper-wasm', voice: '' }));
    expect((await r.pick())!.id).toBe('piper-wasm');
    r.setPreference(() => ({ engine: 'supertonic-wasm', voice: '' })); // not available => automatic order
    expect((await r.pick())!.id).toBe('supertonic-webgpu');
    r.setPreference(() => ({ engine: 'auto', voice: '' }));
    expect((await r.pick())!.id).toBe('supertonic-webgpu');
  });

  it('the preference is read on every pick (settings change applies at once)', async () => {
    const r = mk({ 'supertonic-webgpu': true, 'silero-cpu': true });
    let engine: 'auto' | LocalTtsEngineId = 'auto';
    r.setPreference(() => ({ engine, voice: '' }));
    expect((await r.pick())!.id).toBe('supertonic-webgpu');
    engine = 'silero-cpu';
    expect((await r.pick())!.id).toBe('silero-cpu');
  });

  it("the user's voice is applied unless the caller names a valid voice of that engine", async () => {
    const calls: LocalTtsRequest[] = [];
    const r = mk({ 'silero-cpu': true }, calls);
    r.setPreference(() => ({ engine: 'silero-cpu', voice: 'xenia' }));
    const e = (await r.pick())!;
    await e.synth({ text: 'a' });
    await e.synth({ text: 'b', voice: 'standard' }); // not a voice id of this engine
    await e.synth({ text: 'c', voice: 'eugene' });
    expect(calls.map((c) => c.voice)).toEqual(['xenia', 'xenia', 'eugene']);
  });

  it("a voice of another engine is ignored (falls to the engine's own default)", async () => {
    const calls: LocalTtsRequest[] = [];
    const r = mk({ 'piper-wasm': true }, calls);
    r.setPreference(() => ({ engine: 'silero-cpu', voice: 'xenia' }));
    await (await r.pick())!.synth({ text: 'a' });
    expect(calls[0]!.voice).toBeUndefined();
  });

  it('orderWithPreference', () => {
    expect(orderWithPreference(AUTO_ENGINE_ORDER, 'auto')).toEqual([...AUTO_ENGINE_ORDER]);
    expect(orderWithPreference(AUTO_ENGINE_ORDER, 'piper-wasm')[0]).toBe('piper-wasm');
    expect(orderWithPreference(AUTO_ENGINE_ORDER, 'piper-wasm')).toHaveLength(AUTO_ENGINE_ORDER.length);
    expect(orderWithPreference(AUTO_ENGINE_ORDER, 'bogus' as never)).toEqual([...AUTO_ENGINE_ORDER]);
  });
});

describe('settings normalisation of the local voice', () => {
  it('defaults', () => {
    expect(DEFAULT_SETTINGS.localTtsEngine).toBe('auto');
    expect(normalizeSettings({}).localTtsEngine).toBe('auto');
    expect(normalizeSettings({}).localTtsVoice).toBe('');
  });
  it('accepts a known engine + one of its voices', () => {
    const s = normalizeSettings({ localTtsEngine: 'silero-cpu', localTtsVoice: 'xenia' });
    expect([s.localTtsEngine, s.localTtsVoice]).toEqual(['silero-cpu', 'xenia']);
  });
  it('rejects unknown engines and voices of another engine', () => {
    expect(normalizeSettings({ localTtsEngine: 'nope' }).localTtsEngine).toBe('auto');
    expect(normalizeSettings({ localTtsEngine: 'silero-cpu', localTtsVoice: 'aidar' }).localTtsVoice).toBe('');
    expect(normalizeSettings({ localTtsEngine: 'supertonic-webgpu', localTtsVoice: 'F4' }).localTtsVoice).toBe('F4');
    expect(normalizeSettings({ localTtsVoice: '../x y' }).localTtsVoice).toBe('');
    expect(normalizeSettings({ localTtsEngine: 7, localTtsVoice: 7 }).localTtsEngine).toBe('auto');
  });
});

describe('remote engines over a fake transport', () => {
  const ready = (rev: string, over: Partial<LttsState> = {}): LttsState => ({ model: 'ready', loaded: 1, total: 1, rev, updatedAt: 1, ...over });
  const transport = (states: Record<string, LttsState | undefined>, env?: LttsEnv) => {
    const sent: LttsOp[] = [];
    const t: LttsTransport = {
      async send(op) {
        sent.push(op);
        return { ok: true };
      },
      async readState(unitId = 'supertonic') {
        return states[unitId];
      },
      async readEnv() {
        return env;
      },
    };
    return { t, sent };
  };
  const rev = (id: LocalTtsEngineId, voice?: string): string => unitFor(id, voice)!.rev;

  it('WebGPU engine needs WebGPU; the WASM engine of the same model does not', async () => {
    const states = { supertonic: ready(rev('supertonic-webgpu')) };
    const noGpu = transport(states, { gpu: false }).t;
    expect(await createRemoteEngine('supertonic-webgpu', noGpu).isAvailable()).toBe(false);
    expect(await createRemoteEngine('supertonic-wasm', noGpu).isAvailable()).toBe(true);
    expect(await createRemoteEngine('supertonic-webgpu', transport(states, { gpu: true }).t).isAvailable()).toBe(true);
  });

  it('Silero is available only when its unit is ready for the current revision', async () => {
    expect(await createRemoteEngine('silero-cpu', transport({ silero: ready(rev('silero-cpu')) }).t).isAvailable()).toBe(true);
    expect(await createRemoteEngine('silero-cpu', transport({ silero: ready('old') }).t).isAvailable()).toBe(false);
    expect(await createRemoteEngine('silero-cpu', transport({}).t).isAvailable()).toBe(false);
  });

  it('Piper lists only downloaded voices and synthesises with one of them', async () => {
    const { t, sent } = transport({ 'piper:irina': ready(rev('piper-wasm', 'irina')) });
    const e = createRemoteEngine('piper-wasm', t);
    expect(await e.isAvailable()).toBe(true);
    expect(await e.voices()).toEqual(['irina']);
    await e.synth({ text: 'x', voice: 'dmitri' }).catch(() => undefined); // not downloaded => the downloaded voice is used
    expect(sent[0]).toMatchObject({ op: 'synth', engine: 'piper-wasm', voice: 'irina' });
    expect(await createRemoteEngine('piper-wasm', transport({}).t).isAvailable()).toBe(false);
  });

  it('synth sends the engine id and a valid voice (unknown voice -> default)', async () => {
    const { t, sent } = transport({ silero: ready(rev('silero-cpu')) });
    const e = createRemoteEngine('silero-cpu', t);
    await e.synth({ text: 'x', voice: 'M1' }).catch(() => undefined);
    await e.synth({ text: 'y', voice: 'xenia' }).catch(() => undefined);
    expect(sent.map((s) => (s as { voice: string }).voice)).toEqual(['eugene', 'xenia']);
    expect(sent.every((s) => (s as { engine: string }).engine === 'silero-cpu')).toBe(true);
  });

  it('storage keys', () => {
    expect(unitStateKey('silero')).toBe('nvt.localtts.u.silero');
    expect(LTTS_ENV_KEY).toBe('nvt.localtts.env');
  });
});

describe('download honours per-file URLs and verifies sha256', () => {
  const mkStore = () => {
    const files = new Map<string, Uint8Array>();
    const done = new Set<string>();
    const store: ModelStore = {
      size: async (p) => files.get(p)?.length ?? 0,
      isDone: async (p) => done.has(p),
      markDone: async (p) => void done.add(p),
      open: async (p, off) => {
        const cur = files.get(p) ?? new Uint8Array(0);
        let buf = cur.slice(0, off);
        return {
          write: async (c) => {
            const n = new Uint8Array(buf.length + c.length);
            n.set(buf);
            n.set(c, buf.length);
            buf = n;
            files.set(p, buf);
          },
          checkpoint: async () => undefined,
          close: async () => files.set(p, buf) && undefined,
        };
      },
      remove: async (p) => void files.delete(p),
      sha256: async (p) => {
        const d = await crypto.subtle.digest('SHA-256', files.get(p)! as BufferSource);
        return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
      },
    };
    return { store, files };
  };
  const body = new TextEncoder().encode('hello world');
  const sha = async (b: Uint8Array): Promise<string> => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', b as BufferSource)), (x) => x.toString(16).padStart(2, '0')).join('');

  it('fetches f.url when present, base+path otherwise', async () => {
    const urls: string[] = [];
    const fetchFn = (async (u: string) => {
      urls.push(u);
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;
    const { store } = mkStore();
    await downloadModel({
      files: [{ path: 'a.bin', size: body.length }, { path: 'b.bin', size: body.length, url: 'https://cdn.example/pinned/b.bin' }],
      baseUrl: 'https://base.example/',
      store,
      fetch: fetchFn,
    });
    expect(urls).toEqual(['https://base.example/a.bin', 'https://cdn.example/pinned/b.bin']);
  });

  it('a wrong sha256 is rejected and the file removed', async () => {
    const fetchFn = (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
    const { store, files } = mkStore();
    await expect(
      downloadModel({ files: [{ path: 'x', size: body.length, sha256: '0'.repeat(64) }], baseUrl: 'https://b/', store, fetch: fetchFn, retries: 0 }),
    ).rejects.toMatchObject({ kind: 'checksum' });
    expect(files.has('x')).toBe(false);
    const ok = await sha(body);
    await downloadModel({ files: [{ path: 'y', size: body.length, sha256: ok }], baseUrl: 'https://b/', store, fetch: fetchFn });
    expect(files.get('y')!.length).toBe(body.length);
  });
});

describe('settings panel helpers', () => {
  it('unpublished model shows an honest reason; WebGPU engines need the GPU, CPU engines do not', () => {
    expect(panelStateFrom(undefined, { needsGpu: false, published: false }).message).toBe('модель ещё не опубликована');
    expect(panelStateFrom(undefined, { needsGpu: true, env: { gpu: false } }).phase).toBe('unsupported');
    expect(panelStateFrom(undefined, { needsGpu: false, env: { gpu: false } }).phase).toBe('none');
    expect(panelStateFrom({ model: 'ready', loaded: 5, total: 5, rev: 'old', updatedAt: 1 }, { needsGpu: false, rev: 'new' }).phase).toBe('none');
  });

  it('dropdown label: name, size, speed note, state', () => {
    const info = engineInfo('piper-wasm')!;
    const lab = engineOptionLabel(info, 81e6, { phase: 'downloading', loaded: 40e6, total: 80e6 });
    expect(lab).toContain('Piper');
    expect(lab).toContain('81 МБ');
    expect(lab).toContain(info.speedNote);
    expect(lab.endsWith('50%')).toBe(true);
    expect(stateWord({ phase: 'ready', loaded: 1, total: 1 })).toBe('готова');
    expect(stateWord({ phase: 'none', loaded: 0, total: 1 })).toBe('не скачана');
  });

  it('engineState follows the selected voice for per-voice engines; autoEngine uses the registry order', () => {
    const piper = engineInfo('piper-wasm')!;
    const u = unitFor('piper-wasm', 'irina')!;
    const pi = { env: {}, units: { [u.id]: { model: 'ready' as const, loaded: 1, total: 1, rev: u.rev, updatedAt: 1 } } };
    expect(engineState(piper, 'irina', pi).state.phase).toBe('ready');
    expect(engineState(piper, 'dmitri', pi).state.phase).toBe('none');
    expect(autoEngine({ voice: 'irina' }, pi)).toBe('piper-wasm');
    const st = unitFor('supertonic-wasm')!;
    const both = { env: { gpu: false }, units: { ...pi.units, supertonic: { model: 'ready' as const, loaded: 1, total: 1, rev: st.rev, updatedAt: 1 } } };
    expect(autoEngine({ voice: 'irina' }, both)).toBe('piper-wasm'); // WebGPU missing => GPU engine skipped, Piper before slow Supertonic WASM
  });
});

describe('Silero text preprocessing smoke', () => {
  it('lowercases, keeps the model alphabet and flags empty text', () => {
    const r = prepareSileroText('Привет, МИР! 123');
    expect(r.hasText).toBe(true);
    expect(r.sentence.startsWith('привет, мир')).toBe(true);
    expect(prepareSileroText('123 !!!').hasText).toBe(false);
  });
});

describe('registry demotes a starved engine in automatic mode', () => {
  const slowEngine = (id: LocalTtsEngineId, now: { t: number }, wallMs: number): LocalTtsEngine => ({
    id,
    isAvailable: async () => true,
    voices: async () => ['M1'],
    synth: async () => {
      now.t += wallMs;
      return { sampleRate: 24000, samples: new Int16Array(24000 * 3), durationSec: 3 };
    },
  });

  it('two consecutive non-real-time calls push the GPU engine behind the CPU engines; recovery after the cooldown', async () => {
    const now = { t: 0 };
    const r = new LocalTtsRegistry();
    r.now = () => now.t;
    r.register(slowEngine('supertonic-webgpu', now, 11_000)); // 11 s for 3 s of audio (starved GPU)
    r.register(slowEngine('silero-cpu', now, 400));
    const first = (await r.pick())!;
    expect(first.id).toBe('supertonic-webgpu');
    await first.synth({ text: 'a' });
    expect((await r.pick())!.id).toBe('supertonic-webgpu'); // one slow call (cold start) is forgiven
    await (await r.pick())!.synth({ text: 'b' });
    expect((await r.pick())!.id).toBe('silero-cpu');
    now.t += 5 * 60_000 + 1;
    expect((await r.pick())!.id).toBe('supertonic-webgpu'); // retried after the cooldown
  });

  it('an explicit user choice is never demoted (health only reorders the automatic mode)', async () => {
    const now = { t: 0 };
    const r = new LocalTtsRegistry();
    r.now = () => now.t;
    const e = slowEngine('supertonic-webgpu', now, 11_000);
    r.register(e);
    r.register(slowEngine('silero-cpu', now, 400));
    r.setPreference(() => ({ engine: 'supertonic-webgpu', voice: '' }));
    for (let i = 0; i < 4; i++) await (await r.pick())!.synth({ text: 'x' });
    expect((await r.pick())!.id).toBe('supertonic-webgpu');
    r.setPreference(() => ({ engine: 'auto', voice: '' }));
    // health is tracked in every mode: back in automatic mode the genuinely starved engine is already behind the CPU one
    expect((await r.pick())!.id).toBe('silero-cpu');
  });
});
