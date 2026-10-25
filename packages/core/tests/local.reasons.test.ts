import { beforeEach, describe, expect, it } from 'vitest';
import { parseBroadcasterLanguage } from '../src/capture/hls/twitchApi';
import { detectVideoLanguage, type DocLike } from '../src/lang/detect';
import { EMPTY_CHUNKS_BEFORE_REASON, LocalReasons, REASON_ORDER, localReasons, reasonText } from '../src/localasr/localReason';
import { LocalAsrRegistry } from '../src/localasr/registry';
import { DETECT_CONFIRM, SourceLangResolver, setBroadcasterLang, getBroadcasterLang, twitchLangToIso, resetLangHints } from '../src/localasr/sourceLang';
import { PAIR_TEXT, downloadPair, pairAvailability } from '../src/localasr/translatorPair';
import type { LocalAsr, LocalAsrOptions } from '../src/localasr/types';
import { detectWhisperLanguage, languageTokenMap, type DetectPipe } from '../src/localasr/whisperLang';
import { ChromeCueTranslator, type ChromeAiEnv } from '../src/subtitles/chromeAi';
import { ChromeTextTranslator, translateWithFailover } from '../src/providers/cascade/translate';
import { LocalAsrStage } from '../src/providers/local/asr';
import type { AudioChunk } from '../src/providers/types';

// ---- fake Chrome Translator ----
function fakeEnv(avail: Record<string, string>, log: string[] = []): ChromeAiEnv {
  return {
    Translator: {
      async availability(o) {
        return avail[`${o.sourceLanguage}>${o.targetLanguage}`] ?? 'unavailable';
      },
      async create(o) {
        const key = `${o.sourceLanguage}>${o.targetLanguage}`;
        log.push(`create ${key}`);
        if (avail[key] !== 'available') o.monitor?.({ addEventListener: (_t, cb) => [0.25, 1].forEach((f) => cb({ loaded: f })) });
        return { translate: async (t: string) => `[${key}]${t}`, destroy: () => log.push(`destroy ${key}`) };
      },
    },
  };
}

describe('language resolution', () => {
  it('setting beats Twitch beats the engine beats detection', () => {
    const r = new SourceLangResolver();
    expect(r.resolve({ setting: 'de', broadcaster: 'da', engine: 'en' })).toEqual({ lang: 'de', source: 'setting' });
    expect(r.resolve({ setting: 'auto', broadcaster: 'da', engine: 'en' })).toEqual({ lang: 'da', source: 'twitch' });
    expect(r.resolve({ engine: 'sv' })).toEqual({ lang: 'sv', source: 'engine' });
    expect(r.resolve({})).toEqual({ source: 'none' });
  });
  it('trusts a detection only after two consistent chunks, then pins it', () => {
    const r = new SourceLangResolver();
    expect(r.observe('da')).toBe('da');
    // the engine echoes our single detection back: not an independent source, keep detecting
    expect(r.resolve({ engine: 'da' }).source).toBe('none');
    expect(r.observe('no')).toBe('no');
    expect(r.confirmed).toBeUndefined();
    for (let i = 0; i < DETECT_CONFIRM; i++) r.observe('da');
    expect(r.confirmed).toBe('da');
    expect(r.resolve({})).toEqual({ lang: 'da', source: 'detected' });
    expect(r.resolve({ engine: 'da' }).lang).toBe('da');
    expect(r.resolve({ setting: 'en' }).lang).toBe('en');
    r.reset();
    expect(r.resolve({}).source).toBe('none');
  });
  it('maps Twitch language codes', () => {
    expect(twitchLangToIso('DA')).toBe('da');
    expect(twitchLangToIso('ZH_HANS')).toBe('zh');
    expect(twitchLangToIso('OTHER')).toBeUndefined();
    expect(twitchLangToIso('ASL')).toBeUndefined();
    expect(twitchLangToIso(undefined)).toBeUndefined();
    expect(parseBroadcasterLanguage({ data: { user: { broadcastSettings: { language: 'DA' } } } })).toBe('DA');
    expect(parseBroadcasterLanguage({ data: { user: null } })).toBeUndefined();
    resetLangHints();
    setBroadcasterLang('SondergaardLOL', 'da');
    expect(getBroadcasterLang('sondergaardlol')).toBe('da');
    expect(getBroadcasterLang('other')).toBeUndefined();
  });
  it('the language gate takes the broadcaster language as a strong signal on Twitch', async () => {
    const doc: DocLike = {
      documentElement: { getAttribute: () => 'ru' },
      title: 'sondergaardlol - Twitch',
      location: { hostname: 'www.twitch.tv' },
      querySelector: () => null,
      querySelectorAll: () => [],
    };
    const v = await detectVideoLanguage({}, doc, { broadcasterLang: async () => 'da' });
    expect(v.lang).toBe('da');
    expect(v.how).toBe('twitch-lang');
    expect(v.confidence).toBeGreaterThanOrEqual(0.7);
  });
});

describe('local reasons', () => {
  it('shows the first active reason in priority order and clears', () => {
    const r = new LocalReasons();
    let n = 0;
    r.subscribe(() => n++);
    r.set('tts', reasonText.tts());
    r.set('translator', reasonText.translator('da'));
    expect(r.first()?.key).toBe('translator');
    r.set('empty', reasonText.empty(3, 'da'));
    r.set('cpu', reasonText.cpu());
    r.set('loading', reasonText.loading());
    r.set('no-model', reasonText.noModel('da'));
    expect(REASON_ORDER).toEqual(['ads', 'restart', 'no-model', 'loading', 'cpu', 'empty', 'translator', 'tts', 'late', 'live', 'quality-slow']);
    expect(r.first()?.key).toBe('no-model');
    r.clear('no-model');
    expect(r.first()?.key).toBe('loading');
    r.clearAll();
    expect(r.first()).toBeUndefined();
    expect(n).toBeGreaterThan(3);
  });
  it('names the language and the fix in Russian', () => {
    expect(reasonText.noModel('da')).toContain('датский');
    expect(reasonText.translator('da')).toContain('датский → русский');
    expect(reasonText.translator('da')).toContain('Скачать языковой пакет');
  });
});

describe('Chrome Translator route', () => {
  it('uses a downloaded direct pair', async () => {
    const t = new ChromeCueTranslator(() => fakeEnv({ 'da>ru': 'available' }));
    expect(await t.route('da')).toBe('direct');
    expect(await new ChromeTextTranslator(t).translate([{ text: 'hej', maxChars: 10 }], 'da', new AbortController().signal)).toEqual(['[da>ru]hej']);
  });
  it('never creates a downloadable pair (needs a click) and falls back to a pivot through English', async () => {
    const log: string[] = [];
    const t = new ChromeCueTranslator(() => fakeEnv({ 'da>ru': 'downloadable', 'da>en': 'available', 'en>ru': 'available' }, log));
    expect(await t.route('da')).toBe('pivot');
    expect(await new ChromeTextTranslator(t).translate([{ text: 'hej', maxChars: 10 }], 'da', new AbortController().signal)).toEqual(['[en>ru][da>en]hej']);
    expect(log).toEqual(['create da>en', 'create en>ru']);
  });
  it('reports nothing when neither route is downloaded', async () => {
    const log: string[] = [];
    const t = new ChromeCueTranslator(() => fakeEnv({ 'da>ru': 'downloadable', 'da>en': 'downloadable', 'en>ru': 'available' }, log));
    expect(await t.route('da')).toBeUndefined();
    expect(await new ChromeTextTranslator(t).isAvailable('da')).toBe(false);
    expect(log).toEqual([]);
    expect(await new ChromeTextTranslator(new ChromeCueTranslator(() => ({}))).isAvailable('da')).toBe(false);
  });
  it('translateWithFailover explains a missing pair for the local tier only', async () => {
    localReasons.clearAll();
    const none = new ChromeTextTranslator(new ChromeCueTranslator(() => fakeEnv({ 'da>ru': 'downloadable' })));
    await expect(translateWithFailover([none], [{ text: 'hej', maxChars: 5 }], 'da', new AbortController().signal, 'local')).rejects.toThrow();
    expect(localReasons.first()?.key).toBe('translator');
    expect(localReasons.first()?.text).toContain('датский');
    localReasons.clearAll();
    await expect(translateWithFailover([none], [{ text: 'hej', maxChars: 5 }], 'da', new AbortController().signal, 'groq')).rejects.toThrow();
    expect(localReasons.first()).toBeUndefined();
    const ok = new ChromeTextTranslator(new ChromeCueTranslator(() => fakeEnv({ 'da>ru': 'available' })));
    localReasons.set('translator', 'x');
    await translateWithFailover([ok], [{ text: 'hej', maxChars: 5 }], 'da', new AbortController().signal, 'local');
    expect(localReasons.first()).toBeUndefined();
  });
  it('the panel helpers report availability and download with progress', async () => {
    const env = fakeEnv({ 'da>ru': 'downloadable', 'en>ru': 'available' });
    expect(await pairAvailability('da', 'ru', env)).toBe('downloadable');
    expect(await pairAvailability('en', 'ru', env)).toBe('available');
    expect(await pairAvailability('xx', 'ru', env)).toBe('unavailable');
    expect(await pairAvailability('da', 'ru', {})).toBe('absent');
    expect(PAIR_TEXT.downloadable).toContain('скачать');
    const progress: number[] = [];
    await downloadPair('da', 'ru', (f) => progress.push(f), env);
    expect(progress).toEqual([0.25, 1, 1]);
    await expect(downloadPair('da', 'ru', undefined, {})).rejects.toThrow();
  });
});

describe('whisper language detection', () => {
  const lang_to_id = { '<|en|>': 50259, '<|da|>': 50285, '<|no|>': 50288, '<|transcribe|>': 50359 };
  const pipeWith = (token: number | undefined): DetectPipe => ({
    processor: async () => ({ input_features: 'feat' }),
    model: {
      generation_config: { decoder_start_token_id: 50258, lang_to_id },
      generate: async (o) => {
        expect(o.decoder_input_ids).toEqual([50258]);
        expect(o.max_new_tokens).toBe(1);
        return token === undefined ? [[50258]] : { tolist: () => [[50258, token]] };
      },
    },
  });
  it('reads the language token after the start token', async () => {
    expect(languageTokenMap(lang_to_id).get(50285)).toBe('da');
    expect(languageTokenMap(lang_to_id).has(50359)).toBe(false);
    expect(await detectWhisperLanguage(pipeWith(50285), new Float32Array(16))).toBe('da');
  });
  it('answers undefined for a non-language token or a model without language tokens', async () => {
    expect(await detectWhisperLanguage(pipeWith(50359), new Float32Array(16))).toBeUndefined();
    expect(await detectWhisperLanguage(pipeWith(undefined), new Float32Array(16))).toBeUndefined();
    const noGc: DetectPipe = { processor: async () => ({ input_features: 1 }), model: { generate: async () => [[1]] } };
    expect(await detectWhisperLanguage(noGc, new Float32Array(1))).toBeUndefined();
  });
});

describe('LocalAsrStage language flow and empty-transcript reason', () => {
  const chunk = (): AudioChunk => ({ startSec: 10, durationSec: 5, sampleRate: 16000, pcm: Int16Array.from({ length: 80000 }, (_, i) => Math.round(12000 * Math.sin(i / 20) * Math.max(0, Math.sin(i / 2500)))) }) as unknown as AudioChunk;
  type Reply = { segments: Array<{ start: number; end: number; text: string }>; lang?: string; detected?: boolean };
  function engine(reply: (o: LocalAsrOptions) => Reply): LocalAsr & { calls: Array<string | undefined> } {
    const calls: Array<string | undefined> = [];
    return {
      id: 'whisper-webgpu',
      calls,
      isAvailable: async () => true,
      languages: () => ['*'],
      transcribe: async (_p, o = {}) => {
        calls.push(o.lang);
        return reply(o);
      },
    };
  }
  const stageFor = (e: LocalAsr, setting?: string, broadcaster?: string): LocalAsrStage => {
    const reg = new LocalAsrRegistry();
    reg.register(e);
    return new LocalAsrStage(reg, ['whisper-webgpu'], () => setting, () => broadcaster);
  };
  const sig = new AbortController().signal;
  beforeEach(() => localReasons.clearAll());

  it('passes the Twitch broadcaster language to Whisper and returns it to the engine', async () => {
    const e = engine(() => ({ segments: [{ start: 0, end: 2, text: 'Hej verden' }], lang: 'da' }));
    const r = await stageFor(e, 'auto', 'da').transcribe(chunk(), { signal: sig });
    expect(e.calls).toEqual(['da']);
    expect(r.sourceLang).toBe('da');
    expect(r.segments[0]!.start).toBe(10);
  });
  it('an explicit setting beats the broadcaster language', async () => {
    const e = engine(() => ({ segments: [{ start: 0, end: 1, text: 'Hallo' }], lang: 'de' }));
    await stageFor(e, 'de', 'da').transcribe(chunk(), { signal: sig });
    expect(e.calls).toEqual(['de']);
  });
  it('detects until two chunks agree, then stops detecting', async () => {
    const e = engine((o) => ({ segments: [{ start: 0, end: 1, text: 'Hej' }], lang: o.lang ?? 'da', detected: !o.lang }));
    const st = stageFor(e);
    let echoed: string | undefined;
    for (let i = 0; i < 4; i++) echoed = (await st.transcribe(chunk(), { signal: sig, sourceLang: echoed })).sourceLang;
    expect(e.calls).toEqual([undefined, undefined, 'da', 'da']);
    expect(echoed).toBe('da');
  });
  it('reports an empty transcript after N consecutive empty chunks and clears on speech', async () => {
    let speech = false;
    const e = engine(() => ({ segments: speech ? [{ start: 0, end: 1, text: 'Hej' }] : [], lang: 'da' }));
    const st = stageFor(e, 'auto', 'da');
    for (let i = 0; i < EMPTY_CHUNKS_BEFORE_REASON - 1; i++) await st.transcribe(chunk(), { signal: sig });
    expect(localReasons.first()).toBeUndefined();
    await st.transcribe(chunk(), { signal: sig });
    expect(localReasons.first()?.key).toBe('empty');
    expect(localReasons.first()?.text).toContain('датский');
    speech = true;
    await st.transcribe(chunk(), { signal: sig });
    expect(localReasons.first()).toBeUndefined();
  });
  it('reports a missing model (with the language) when no engine can serve it', async () => {
    const reg = new LocalAsrRegistry();
    const st = new LocalAsrStage(reg, ['whisper-webgpu'], () => 'auto', () => 'da');
    expect(await st.available()).toBe(false);
    expect(localReasons.first()?.key).toBe('no-model');
    await expect(st.transcribe(chunk(), { signal: sig })).rejects.toThrow();
    expect(localReasons.first()?.text).toContain('датский');
  });
});
