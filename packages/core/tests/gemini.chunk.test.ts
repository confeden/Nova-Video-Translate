import { describe, expect, it } from 'vitest';
import { diag } from '../src/diag';
import { GeminiProvider } from '../src/providers/gemini/provider';
import { synthesizeRun, joinSentences } from '../src/providers/gemini/tts';
import { GeminiClient } from '../src/providers/gemini/client';
import { KeyPool } from '../src/keypool';
import { GEMINI_FIXED_VOICE_NAME, chooseVoices, classifyPitch, newVoiceMemory, resolveSpeakerVoice, VOICE_TABLE } from '../src/providers/gemini/voices';
import { ProviderUnavailableError, type AudioChunk } from '../src/providers/types';
import { concat, silence, voiced } from './helpers/wavFile';

const json = (obj: unknown, status = 200) => new Response(JSON.stringify(obj), { status });
const b64 = (pcm: Int16Array) => {
  let s = '';
  for (const b of new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)) s += String.fromCharCode(b);
  return btoa(s);
};
const audioResp = (pcm: Int16Array) =>
  json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: b64(pcm) } }] } }] });
const textResp = (t: unknown) => json({ candidates: [{ content: { parts: [{ text: JSON.stringify(t) }] } }] });
const MODELS = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-tts-preview'].map((n) => ({
  name: `models/${n}`,
  supportedGenerationMethods: ['generateContent'],
}));
const SR = 24000;
const ctx = (wantSubtitles = false) => ({ signal: new AbortController().signal, targetLang: 'ru' as const, wantSubtitles });
const chunkOf = (f0: number): AudioChunk => ({
  startSec: 100,
  durationSec: 12,
  sampleRate: SR,
  pcm: voiced(SR, 12, f0),
});
const noSleep = { sleep: async () => {} };

interface Call {
  text: string;
  voice: string;
  seed: unknown;
  temperature: unknown;
}

function setup(
  segments: { start: number; end: number; src: string; ru: string; gender?: string; speaker?: string }[],
  tts: (call: Call, n: number) => Response,
  sourceLang = 'en',
) {
  const calls: Call[] = [];
  const fetchFn = async (url: string, init?: RequestInit) => {
    if (url.includes('/models?')) return json({ models: MODELS });
    if (url.includes('flash-tts')) {
      const body = JSON.parse(init!.body as string);
      const call: Call = {
        text: body.contents[0].parts[0].text,
        voice: body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName,
        seed: body.generationConfig.seed,
        temperature: body.generationConfig.temperature,
      };
      calls.push(call);
      expect(body.contents[0].parts).toHaveLength(1); // G6: text only
      return tts(call, calls.length - 1);
    }
    return textResp({ source_lang: sourceLang, segments });
  };
  return { fetchFn, calls };
}

const TWO = [
  { start: 0, end: 4, src: 'Hello', ru: 'Привет всем друзья мои', gender: 'male' },
  { start: 4, end: 9, src: 'Second', ru: 'Это вторая фраза нашей беседы сегодня', gender: 'male' },
];
// 22 and 37 chars -> speech 2.2 s and 3.7 s with a 0.45 s pause
const twoSentenceAudio = () => concat(voiced(SR, 2.2, 120), silence(SR, 0.45), voiced(SR, 3.7, 121));

describe('per-chunk TTS (one call for same-voice sentences)', () => {
  it('voices two sentences with ONE call, text only, split by the pause', async () => {
    const s = setup(TWO, () => audioResp(twoSentenceAudio()));
    const p = new GeminiProvider({ keys: ['k'], fetch: s.fetchFn, tts: { guard: false } });
    const res = await p.translateChunk(chunkOf(120), ctx());
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]!.text).toBe('Привет всем друзья мои.\nЭто вторая фраза нашей беседы сегодня.');
    expect(res.segments).toHaveLength(2);
    expect(res.failedSegments).toBeUndefined();
    const sec = res.segments.map((x) => (x.audio.kind === 'pcm' ? x.audio.samples.length / x.audio.sampleRate : 0));
    expect(sec[0]).toBeGreaterThan(2.0);
    expect(sec[0]).toBeLessThan(2.6);
    expect(sec[1]).toBeGreaterThan(3.5);
    expect(sec[1]).toBeLessThan(4.1);
  });

  it('same voice, temperature and seed on every call of a video', async () => {
    const s = setup(TWO, () => audioResp(twoSentenceAudio()));
    const p = new GeminiProvider({ keys: ['k'], fetch: s.fetchFn, tts: { guard: false } });
    await p.translateChunk(chunkOf(120), ctx());
    await p.translateChunk(chunkOf(122), ctx());
    expect(new Set(s.calls.map((c) => c.voice)).size).toBe(1);
    expect(new Set(s.calls.map((c) => c.seed)).size).toBe(1);
    expect(new Set(s.calls.map((c) => c.temperature)).size).toBe(1);
  });

  it('falls back to one call per sentence when the audio cannot be aligned', async () => {
    const s = setup(TWO, (_c, n) => audioResp(n === 0 ? voiced(SR, 6, 120) : voiced(SR, 2.4, 120))); // no pause in call 0
    const p = new GeminiProvider({ keys: ['k'], fetch: s.fetchFn, tts: { guard: false } });
    const res = await p.translateChunk(chunkOf(120), ctx());
    expect(s.calls).toHaveLength(3);
    expect(s.calls[1]!.text).toBe('Привет всем друзья мои.');
    expect(res.segments).toHaveLength(2);
    expect(diag.entries().some((e) => e.ev === 'gemini-tts-run' && e.data?.aligned === false)).toBe(true);
  });

  it('different voices (speaker change) are separate runs', async () => {
    const segs = [{ ...TWO[0]!, speaker: 'S1' }, { ...TWO[1]!, gender: 'female', speaker: 'S2' }];
    const s = setup(segs, () => audioResp(voiced(SR, 2, 150)));
    const p = new GeminiProvider({ keys: ['k'], fetch: s.fetchFn, fixedVoice: false, tts: { guard: false } });
    await p.translateChunk(chunkOf(120), ctx());
    expect(s.calls).toHaveLength(2);
    expect(new Set(s.calls.map((c) => c.voice)).size).toBe(2);
  });

  it('synthesizeRun / joinSentences basics', async () => {
    expect(joinSentences(['a  b', 'c!', 'd?'])).toBe('a b.\nc!\nd?');
    const c = new GeminiClient({ keys: new KeyPool(['k']), fetch: async () => audioResp(twoSentenceAudio()) });
    const r = await synthesizeRun(c, 'm', ['x'.repeat(22), 'y'.repeat(37)], { guard: false });
    expect(r.clips).toHaveLength(2);
    expect(r.align.confidence).toBeGreaterThan(0.5);
  });
});

describe('partial failure and NO_SPEECH', () => {
  it('returns the voiced segments plus failedSegments when some TTS calls fail', async () => {
    const s = setup(TWO, (c) => (c.text.startsWith('Это') ? json({}, 400) : audioResp(voiced(SR, 2, 120))));
    const p = new GeminiProvider({ keys: ['k'], fetch: s.fetchFn, chunkCalls: false, tts: { guard: false, ...noSleep } });
    const res = await p.translateChunk(chunkOf(120), ctx(true));
    expect(res.segments).toHaveLength(1);
    expect(res.failedSegments).toEqual([{ start: 104, end: 109 }]);
    expect(res.subtitles).toHaveLength(2);
  });

  it('throws quota only when NOTHING could be voiced', async () => {
    const s = setup(TWO, () => json({ error: { status: 'RESOURCE_EXHAUSTED' } }, 429));
    const p = new GeminiProvider({ keys: ['k'], fetch: s.fetchFn, tts: { guard: false, ...noSleep } });
    const err = await p.translateChunk(chunkOf(120), ctx()).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderUnavailableError);
    expect(err.kind).toBe('quota');
  });

  it('transient failure of every segment surfaces the error instead of an empty result', async () => {
    const s = setup(TWO, () => json({}, 400));
    const p = new GeminiProvider({ keys: ['k'], fetch: s.fetchFn, chunkCalls: false, tts: { guard: false, ...noSleep } });
    await expect(p.translateChunk(chunkOf(120), ctx())).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it('music / silence: zero segments, no TTS, no language leaked', async () => {
    const s = setup([], () => audioResp(voiced(SR, 1, 100)), 'und');
    const p = new GeminiProvider({ keys: ['k'], fetch: s.fetchFn });
    const res = await p.translateChunk(chunkOf(120), ctx());
    expect(res).toEqual({ segments: [], sourceLang: undefined });
    expect(s.calls).toHaveLength(0);
    const e = diag.entries().filter((x) => x.ev === 'gemini-translate').pop();
    expect(e?.data?.reason).toBe('no-speech');
  });

  it('logs gemini-translate with counts and chars/sec', async () => {
    diag.clear();
    const s = setup(TWO, () => audioResp(twoSentenceAudio()));
    const p = new GeminiProvider({ keys: ['k'], fetch: s.fetchFn, tts: { guard: false } });
    await p.translateChunk(chunkOf(120), ctx());
    const e = diag.entries().find((x) => x.ev === 'gemini-translate');
    expect(e?.data).toMatchObject({ segments: 2, source_lang: 'en', ruChars: 59, speechSec: 9 });
    expect(e?.data?.expectedChars).toBe(126);
  });
});

describe('fixed bridge voice (D27)', () => {
  it('one fixed male voice for every segment; no gender / f0 detection (voice memory untouched, no gemini-voices diag)', async () => {
    const segs = [{ ...TWO[0]!, speaker: 'S1' }, { ...TWO[1]!, gender: 'female', speaker: 'S2' }];
    const s = setup(segs, () => audioResp(voiced(SR, 2, 150)));
    const mem = newVoiceMemory();
    diag.clear();
    const p = new GeminiProvider({ keys: ['k'], fetch: s.fetchFn, voiceMemory: mem, tts: { guard: false } });
    await p.translateChunk(chunkOf(120), ctx());
    expect(s.calls.length).toBeGreaterThan(0);
    expect(new Set(s.calls.map((c) => c.voice))).toEqual(new Set([GEMINI_FIXED_VOICE_NAME]));
    expect(GEMINI_FIXED_VOICE_NAME).toBe(VOICE_TABLE.male.mid[0]);
    expect(mem.centroids).toHaveLength(0);
    expect(diag.entries().some((e) => e.ev === 'gemini-voices')).toBe(false);
  });
});

describe('automatic voices (D20)', () => {
  it('classifyPitch has hysteresis', () => {
    expect(classifyPitch('male', 100)).toBe('low');
    expect(classifyPitch('male', 120)).toBe('mid');
    expect(classifyPitch('male', 150)).toBe('high');
    expect(classifyPitch('male', 108, 'low')).toBe('low'); // within +8 Hz of the 105 boundary
    expect(classifyPitch('male', 115, 'low')).toBe('mid');
    expect(classifyPitch('female', 130)).toBe('low');
    expect(classifyPitch('female', 200)).toBe('mid');
    expect(classifyPitch('female', 260)).toBe('high');
  });

  it('picks voice by gender + f0 class, and keeps it sticky across chunks', () => {
    const mem = newVoiceMemory();
    const seg = [{ start: 0, end: 5, gender: 'male' as const, speaker: 'S1' }];
    expect(chooseVoices(seg, () => 95, mem)[0]?.voice).toBe(VOICE_TABLE.male.low[0]);
    // the next chunk measures slightly different f0 (same speaker): same voice
    expect(chooseVoices(seg, () => 104, mem)[0]?.voice).toBe(VOICE_TABLE.male.low[0]);
    expect(chooseVoices(seg, () => 108, mem)[0]?.voice).toBe(VOICE_TABLE.male.low[0]);
    expect(mem.centroids).toHaveLength(1);
    const female = [{ start: 0, end: 5, gender: 'female' as const, speaker: 'S1' }];
    expect(chooseVoices(female, () => 260, mem)[0]?.voice).toBe(VOICE_TABLE.female.high[0]);
    expect(chooseVoices(female, () => 200, mem)[0]?.voice).toBe(VOICE_TABLE.female.mid[0]);
  });

  it('two same-gender speakers of different pitch get different voices; unknown f0 reuses the known one', () => {
    const mem = newVoiceMemory();
    const a = resolveSpeakerVoice(mem, 'male', 95);
    const b = resolveSpeakerVoice(mem, 'male', 150);
    expect(a.voice).not.toBe(b.voice);
    expect(resolveSpeakerVoice(mem, 'male', 0).voice).toBe(a.voice);
    expect(resolveSpeakerVoice(mem, 'male', 97).voice).toBe(a.voice);
  });

  it('unknown gender at the start of a chunk inherits the previous chunk gender', () => {
    const mem = newVoiceMemory();
    chooseVoices([{ start: 0, end: 5, gender: 'female' }], () => 200, mem);
    const r = chooseVoices([{ start: 0, end: 5, gender: 'unknown' }], () => 200, mem);
    expect(r[0]?.profile).toBe('female');
  });

  it('the provider measures f0 on the original chunk audio and picks the class voice', async () => {
    const s = setup(TWO, () => audioResp(twoSentenceAudio()));
    const mem = newVoiceMemory();
    const p = new GeminiProvider({ keys: ['k'], fetch: s.fetchFn, voiceMemory: mem, fixedVoice: false, tts: { guard: false } });
    await p.translateChunk(chunkOf(95), ctx());
    expect(s.calls[0]!.voice).toBe(VOICE_TABLE.male.low[0]);
    expect(mem.centroids[0]?.f0).toBeGreaterThan(90);
    expect(mem.centroids[0]?.f0).toBeLessThan(100);
  });

  it('internal override still wins', async () => {
    const s = setup(TWO, () => audioResp(twoSentenceAudio()));
    const p = new GeminiProvider({ keys: ['k'], fetch: s.fetchFn, voices: { male: 'Puck' }, tts: { guard: false } });
    await p.translateChunk(chunkOf(95), ctx());
    expect(s.calls[0]!.voice).toBe('Puck');
  });
});

describe('model fall-through on 5xx', () => {
  it('a 503 "high demand" on the first candidate moves on to the next model', async () => {
    const urls: string[] = [];
    const c = new GeminiClient({
      keys: new KeyPool(['k']),
      fetch: async (u: string) => {
        urls.push(u);
        return u.includes('/A:') ? json({ error: { message: 'high demand' } }, 503) : textResp({ ok: 1 });
      },
    });
    const r = await c.generateContent(['A', 'B'], {});
    expect(r.candidates).toBeDefined();
    expect(urls.map((u) => /models\/([^:]+):/.exec(u)![1])).toEqual(['A', 'B']);
  });

  it('every candidate failing with 5xx surfaces a network-kind error', async () => {
    const c = new GeminiClient({ keys: new KeyPool(['k']), fetch: async () => json({}, 503) });
    const err = await c.generateContent(['A', 'B'], {}).catch((e) => e);
    expect(err.kind).toBe('network');
  });
});

describe('translate prompt', () => {
  it('budget is a soft guideline and sentences must not be dropped', async () => {
    const { buildPrompt } = await import('../src/providers/gemini/translate');
    const p = buildPrompt(15);
    expect(p).toMatch(/soft/i);
    expect(p).toMatch(/never skip/i);
    expect(p).not.toMatch(/compress or paraphrase it to fit/);
  });
});
