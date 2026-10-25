import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCAL_ASR_ORDER, LocalAsrRegistry } from '../src/localasr/registry';
import type { LocalAsr } from '../src/localasr/types';
import { createWhisperAsr, lasrStateIsReady, type LasrTransport } from '../src/localasr/whisperClient';
import { WHISPER_MODELS, isWhisperModelId, pickWhisperModel, planDtype, whisperBytes, whisperModelInfo, type LocalAsrModelChoice } from '../src/localasr/whisperModels';
import { LASR_MSG, lasrStateKey, type LasrOp, type LasrState } from '../src/localasr/whisperProtocol';
import { isEmptyWhisperOutput, pcmStats, rmsInt16, splitPlainTranscript, whisperToSegments } from '../src/localasr/whisperText';
import { diag } from '../src/diag';
import { b64ToInt16 } from '../src/localtts/supertonic/pcm';
import { normalizeSettings } from '../src/settings';
import { DEFAULT_SETTINGS } from '../src/types';
import { asrModelState } from '../src/ui/localAsrSection';

const BASE_EN = 'onnx-community/whisper-base.en';
const MULTI = 'onnx-community/whisper-base';

const readyState = (id: string): LasrState => ({ model: 'ready', loaded: 1, total: 1, rev: whisperModelInfo(id)!.revision, updatedAt: 1, device: 'webgpu', dtype: 'fp16' });

function fakeTransport(states: Record<string, LasrState | undefined>, reply?: (op: LasrOp) => unknown): LasrTransport & { sent: LasrOp[] } {
  const sent: LasrOp[] = [];
  return {
    sent,
    async send(op) {
      sent.push(op);
      return reply ? reply(op) : { ok: true, segments: [{ start: 0.5, end: 2, text: 'hello world' }], ms: 400, device: 'webgpu', dtype: 'fp16' };
    },
    async readState(id) {
      return states[id];
    },
  };
}

describe('whisper catalog', () => {
  it('pins a 40-char revision and sizes for every model, q8 smaller than fp16 and gpu-mixed', () => {
    for (const m of WHISPER_MODELS) {
      expect(m.revision).toMatch(/^[0-9a-f]{40}$/);
      expect(m.bytes.q8).toBeLessThan(m.bytes.fp16);
      expect(m.bytes['gpu-mixed']).toBeGreaterThan(m.bytes.q8);
      expect(m.bytes['gpu-mixed']).toBeLessThan(600_000_000); // fp32 encoder of small is ~353 MB, under the 500 MB budget
    }
    expect(WHISPER_MODELS.filter((m) => m.multilingual).map((m) => m.id)).toEqual([MULTI, 'onnx-community/whisper-small']);
  });
  it('plans gpu-mixed only on WebGPU with shader-f16, q8 elsewhere, WASM without WebGPU', () => {
    expect(planDtype({ gpu: true, f16: true })).toEqual({ device: 'webgpu', dtype: 'gpu-mixed' });
    expect(planDtype({ gpu: true, f16: false })).toEqual({ device: 'wasm', dtype: 'q8' }); // q8 never runs on the WebGPU EP
    expect(planDtype({ gpu: false })).toEqual({ device: 'wasm', dtype: 'q8' });
    expect(planDtype(undefined)).toEqual({ device: 'wasm', dtype: 'q8' });
    const m = whisperModelInfo(BASE_EN)!;
    expect(whisperBytes(m, { gpu: true, f16: true })).toBe(m.bytes['gpu-mixed']);
    expect(whisperBytes(m, undefined)).toBe(m.bytes.q8);
  });
  it('picks by choice and language', () => {
    const all = new Set(WHISPER_MODELS.map((m) => m.id as string));
    expect(pickWhisperModel('auto', 'en-US', all)).toBe(BASE_EN);
    expect(pickWhisperModel('auto', 'en', new Set([MULTI]))).toBe(MULTI);
    expect(pickWhisperModel('auto', 'de', all)).toBe('onnx-community/whisper-small');
    expect(pickWhisperModel('auto', 'de', new Set([MULTI]))).toBe(MULTI);
    // unknown language: an English-only model would turn Danish speech into garbage
    expect(pickWhisperModel('auto', undefined, all)).toBe('onnx-community/whisper-small');
    expect(pickWhisperModel('auto', 'auto', new Set([BASE_EN]))).toBeUndefined();
    expect(pickWhisperModel('onnx-community/whisper-base.en', 'da', new Set([BASE_EN]))).toBeUndefined();
    expect(pickWhisperModel('onnx-community/whisper-base.en', 'en', new Set([BASE_EN]))).toBe(BASE_EN);
    expect(pickWhisperModel('auto', 'de', new Set([BASE_EN]))).toBeUndefined();
    expect(pickWhisperModel('auto', 'en', new Set([MULTI]))).toBe(MULTI);
    expect(pickWhisperModel('auto', undefined, new Set())).toBeUndefined();
    expect(pickWhisperModel('onnx-community/whisper-tiny.en', 'en', new Set([BASE_EN]))).toBeUndefined();
    expect(pickWhisperModel('onnx-community/whisper-tiny.en', 'en', new Set(['onnx-community/whisper-tiny.en']))).toBe('onnx-community/whisper-tiny.en');
  });
});

describe('whisper settings', () => {
  it('defaults to auto and normalises garbage back to auto', () => {
    expect(DEFAULT_SETTINGS.localAsrModel).toBe('auto');
    expect(normalizeSettings({}).localAsrModel).toBe('auto');
    expect(normalizeSettings({ localAsrModel: 'evil/model' }).localAsrModel).toBe('auto');
    expect(normalizeSettings({ localAsrModel: 42 }).localAsrModel).toBe('auto');
    expect(normalizeSettings({ localAsrModel: MULTI }).localAsrModel).toBe(MULTI);
    expect(isWhisperModelId(BASE_EN)).toBe(true);
  });
});

describe('whisper registry', () => {
  it('puts whisper-webgpu first and keeps chrome-prompt-audio as the fallback', async () => {
    expect(DEFAULT_LOCAL_ASR_ORDER[0]).toBe('whisper-webgpu');
    expect(DEFAULT_LOCAL_ASR_ORDER).toContain('chrome-prompt-audio');
    const fallback: LocalAsr = { id: 'chrome-prompt-audio', isAvailable: async () => true, languages: () => ['en'], transcribe: async () => ({ segments: [] }) };
    const reg = new LocalAsrRegistry();
    reg.register(fallback);
    // not downloaded -> the fallback serves
    const none = createWhisperAsr(fakeTransport({}));
    reg.register(none);
    expect((await reg.pick())?.id).toBe('chrome-prompt-audio');
    // downloaded -> whisper wins
    const ok = createWhisperAsr(fakeTransport({ [BASE_EN]: readyState(BASE_EN) }));
    reg.register(ok);
    expect((await reg.pick(undefined, 'en'))?.id).toBe('whisper-webgpu');
  });
  it('skips the English-only model for another language until a multilingual one is downloaded', async () => {
    const states: Record<string, LasrState | undefined> = { [BASE_EN]: readyState(BASE_EN) };
    const asr = createWhisperAsr(fakeTransport(states));
    const reg = new LocalAsrRegistry();
    reg.register(asr);
    expect(await reg.pick(undefined, 'de')).toBeUndefined();
    states[MULTI] = readyState(MULTI);
    expect((await reg.pick(undefined)) && asr.languages()).toEqual(['*']);
    expect((await reg.pick(undefined, 'de'))?.id).toBe('whisper-webgpu');
  });
});

describe('whisper client', () => {
  it('is unavailable for a stale revision, a half-downloaded state and an unknown model', async () => {
    expect(lasrStateIsReady({ ...readyState(BASE_EN), rev: 'old' }, BASE_EN)).toBe(false);
    expect(lasrStateIsReady({ ...readyState(BASE_EN), model: 'downloading' }, BASE_EN)).toBe(false);
    expect(lasrStateIsReady(readyState(BASE_EN), 'x/y')).toBe(false);
    expect(await createWhisperAsr(fakeTransport({ [BASE_EN]: { ...readyState(BASE_EN), rev: 'old' } })).isAvailable()).toBe(false);
  });
  it('sends 16 kHz PCM as base64, no language for English-only models, and maps the reply', async () => {
    const t = fakeTransport({ [BASE_EN]: readyState(BASE_EN) });
    const asr = createWhisperAsr(t);
    const pcm = Int16Array.from([1, -2, 3, 4000]);
    const r = await asr.transcribe(pcm, { lang: 'en-GB' });
    expect(r.segments).toEqual([{ start: 0.5, end: 2, text: 'hello world' }]);
    expect(r.lang).toBe('en');
    const op = t.sent[0]!;
    expect(op.op).toBe('transcribe');
    if (op.op !== 'transcribe') throw new Error('unreachable');
    expect(op.model).toBe(BASE_EN);
    expect(op.lang).toBeUndefined();
    expect(Array.from(b64ToInt16(op.pcmB64))).toEqual([1, -2, 3, 4000]);
  });
  it('logs pcm stats and the raw text head with every transcription, and ONE asr-empty per run of empty answers', async () => {
    const empty = { ok: true, segments: [], ms: 3000, device: 'wasm', dtype: 'q8', pcmRms: 0.0512, pcmPeak: 0.68, rawLen: 0, rawHead: '', tsRetry: true };
    const full = { ok: true, segments: [{ start: 0, end: 1, text: 'hi' }], ms: 3000, device: 'wasm', dtype: 'q8', pcmRms: 0.05, pcmPeak: 0.5, rawLen: 2, rawHead: 'hi' };
    const replies = [empty, empty, full, empty];
    const asr = createWhisperAsr(fakeTransport({ [BASE_EN]: readyState(BASE_EN) }, () => replies.shift()));
    diag.clear();
    for (let i = 0; i < 4; i++) await asr.transcribe(new Int16Array(16000), { lang: 'en' });
    const entries = diag.entries();
    const tr = entries.filter((e: { ev: string }) => e.ev === 'localasr-transcribe').slice(-4);
    expect(tr[0]!.data).toMatchObject({ segs: 0, rms: 0.051, peak: 0.68, rawLen: 0, raw60: '', tsRetry: true });
    expect(tr[2]!.data).toMatchObject({ segs: 1, rawLen: 2, raw60: 'hi' });
    expect(entries.filter((e: { ev: string }) => e.ev === 'asr-empty')).toHaveLength(2); // run 1 (chunks 1-2) and run 2 (chunk 4)
  });
  it('passes the stream language to a multilingual model, lets it detect on auto', async () => {
    const t = fakeTransport({ [MULTI]: readyState(MULTI) });
    const asr = createWhisperAsr(t, () => MULTI);
    await asr.transcribe(new Int16Array(160), { lang: 'de-AT' });
    await asr.transcribe(new Int16Array(160), { lang: 'auto' });
    await asr.transcribe(new Int16Array(160));
    const langs = t.sent.map((o) => (o.op === 'transcribe' ? o.lang : 'x'));
    expect(langs).toEqual(['de', undefined, undefined]);
  });
  it('rejects with ProviderUnavailableError when nothing is downloaded, and surfaces worker errors', async () => {
    await expect(createWhisperAsr(fakeTransport({})).transcribe(new Int16Array(16))).rejects.toMatchObject({ name: 'ProviderUnavailableError' });
    const bad = createWhisperAsr(fakeTransport({ [BASE_EN]: readyState(BASE_EN) }, () => ({ ok: false, error: 'boom' })));
    await expect(bad.transcribe(new Int16Array(16), { lang: 'en' })).rejects.toThrow(/boom/);
    const mute = createWhisperAsr(fakeTransport({ [BASE_EN]: readyState(BASE_EN) }, () => undefined));
    await expect(mute.transcribe(new Int16Array(16), { lang: 'en' })).rejects.toThrow(/no answer/);
  });
  it('aborts: sends an abort op and rejects with AbortError', async () => {
    const t = fakeTransport({ [BASE_EN]: readyState(BASE_EN) }, (op) => (op.op === 'transcribe' ? new Promise(() => {}) : { ok: true }));
    const asr = createWhisperAsr(t);
    const ac = new AbortController();
    const p = asr.transcribe(new Int16Array(16), { signal: ac.signal, lang: 'en' });
    await new Promise((r) => setTimeout(r, 5));
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(t.sent.some((o) => o.op === 'abort')).toBe(true);
    await expect(asr.transcribe(new Int16Array(16), { signal: ac.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('honours an explicit model choice', async () => {
    const t = fakeTransport({ [BASE_EN]: readyState(BASE_EN) });
    const choice: LocalAsrModelChoice = 'onnx-community/whisper-tiny.en';
    expect(await createWhisperAsr(t, () => choice).isAvailable()).toBe(false);
    expect(await createWhisperAsr(t, () => BASE_EN).isAvailable()).toBe(true);
  });
  it('state keys and message type are stable', () => {
    expect(LASR_MSG).toBe('nvt-lasr');
    expect(lasrStateKey(BASE_EN)).toBe('nvt.localasr.m.onnx-community_whisper-base.en');
  });
});

describe('whisper text', () => {
  it('maps timed chunks, closes the open end at the clip end, drops bracketed marks', () => {
    const segs = whisperToSegments(
      { chunks: [{ text: ' [BLANK_AUDIO]', timestamp: [0, 1] }, { text: ' Hello there.', timestamp: [1, 2.5] }, { text: ' (music)', timestamp: [2.5, 3] }, { text: ' Bye', timestamp: [3, null] }] },
      6,
    );
    expect(segs).toEqual([{ start: 1, end: 2.5, text: 'Hello there.' }, { start: 3, end: 6, text: 'Bye' }]);
  });
  it('falls back to one segment over the clip when there are no chunks', () => {
    expect(whisperToSegments({ text: ' just text ' }, 5)).toEqual([{ start: 0, end: 5, text: 'just text' }]);
    expect(whisperToSegments({ text: '  ' }, 5)).toEqual([]);
    expect(whisperToSegments(undefined, 5)).toEqual([]);
  });
  it('splits a timestamp-less transcript into sentences spread over the clip in proportion to their length', () => {
    const segs = whisperToSegments({ text: ' Hi there. How are you doing today? Fine.' }, 10);
    expect(segs.map((s) => s.text)).toEqual(['Hi there.', 'How are you doing today?', 'Fine.']);
    expect(segs[0]!.start).toBe(0);
    expect(segs[2]!.end).toBeCloseTo(10, 6);
    expect(segs[1]!.start).toBeCloseTo(segs[0]!.end, 6);
    expect(segs[1]!.end - segs[1]!.start).toBeGreaterThan(segs[0]!.end - segs[0]!.start);
    expect(splitPlainTranscript('   ', 5)).toEqual([]);
  });
  it('tells an empty pipeline output (the whisper .en timestamps failure) from a real one', () => {
    expect(isEmptyWhisperOutput({ text: '', chunks: [] })).toBe(true);
    expect(isEmptyWhisperOutput({ text: ' ', chunks: [{ text: ' ', timestamp: [0, 1] }] })).toBe(true);
    expect(isEmptyWhisperOutput(undefined)).toBe(true);
    expect(isEmptyWhisperOutput({ text: 'x' })).toBe(false);
    expect(isEmptyWhisperOutput({ text: '', chunks: [{ text: ' hi', timestamp: [0, 1] }] })).toBe(false);
  });
  it('pcmStats gives rms and peak on the 0..1 scale', () => {
    const s = pcmStats(Int16Array.from([16384, -16384, 0, 0]));
    expect(s.peak).toBeCloseTo(0.5, 5);
    expect(s.rms).toBeCloseTo(Math.sqrt(0.125), 5);
  });
  it('collapses a looping phrase (3+ repeats) but keeps a genuine double', () => {
    const rep = (n: number) => whisperToSegments({ chunks: Array.from({ length: n }, (_, i) => ({ text: 'Thank you.', timestamp: [i, i + 1] as [number, number] })) }, n);
    expect(rep(2)).toHaveLength(2);
    expect(rep(6)).toEqual([{ start: 0, end: 1, text: 'Thank you.' }, { start: 1, end: 6, text: 'Thank you.' }]);
  });
  it('measures silence', () => {
    expect(rmsInt16(new Int16Array(100))).toBe(0);
    expect(rmsInt16(new Int16Array(0))).toBe(0);
    expect(rmsInt16(new Int16Array(100).fill(16384))).toBeCloseTo(0.5, 3);
  });
});

describe('local ASR panel state', () => {
  it('reports none / downloading / ready per model, never unsupported for a missing GPU', () => {
    const m = whisperModelInfo(BASE_EN)!;
    expect(asrModelState(m, null).state.phase).toBe('none');
    const info = { env: { gpu: false, offscreen: true }, units: { [BASE_EN]: { ...readyState(BASE_EN), model: 'downloading' as const, loaded: 5, total: 10 } } };
    expect(asrModelState(m, info).state.phase).toBe('downloading');
    expect(asrModelState(m, { env: { gpu: false }, units: { [BASE_EN]: readyState(BASE_EN) } }).state.phase).toBe('ready');
    expect(asrModelState(m, { env: {}, units: { [BASE_EN]: { ...readyState(BASE_EN), rev: 'old' } } }).state.phase).toBe('none');
    expect(asrModelState(m, { env: { offscreen: false }, units: {} }).state.phase).toBe('unsupported');
  });
});
