import { describe, expect, it } from 'vitest';
import { TranslationEngine, type EngineWarning, type LanguageInfo } from '../src/pipeline';
import { combineSignals, detectVideoLanguage, withProviderLang, type DocLike, type LangSignal, type LangVerdict, type TextDetector } from '../src/lang/detect';
import { createLangStore } from '../src/lang/store';
import { languageStatusText } from '../src/ui/status';
import { MemoryCache } from '../src/cache';
import { normalizeSettings } from '../src/settings';
import type { CaptionInfo, CaptionsReader } from '../src/subtitles';
import type { CaptureOptions } from '../src/capture';
import type { Settings } from '../src/types';
import { FakeCapture, FakeProvider, FakeScheduler, FakeVideo, chunk, flush, instantSleep, seg, settings } from './helpers/pipelineFakes';

const S = (lang: string, confidence: number, how: string, tier: number): LangSignal => ({ lang, confidence, how, tier });

describe('combineSignals', () => {
  it('nothing => undefined verdict', () => {
    expect(combineSignals([]).lang).toBeUndefined();
    expect(combineSignals([S('en', 0.1, 'html-lang', 1)]).lang).toBeUndefined();
  });
  it('the higher tier leads and agreeing lower tiers add confidence', () => {
    const v = combineSignals([S('ru', 0.92, 'yt-asr', 3), S('ru', 0.85, 'yt-text', 2), S('en', 0.1, 'html-lang', 1)]);
    expect(v.lang).toBe('ru');
    expect(v.confidence).toBeGreaterThan(0.95);
    expect(v.how).toBe('yt-asr');
  });
  it('a disagreeing text signal keeps a Russian ASR verdict below the skip threshold', () => {
    const v = combineSignals([S('ru', 0.92, 'yt-asr', 3), S('en', 0.9, 'yt-text', 2)]);
    expect(v.lang).toBe('ru');
    expect(v.confidence).toBeLessThan(0.8);
  });
  it('a low-tier signal never outvotes a credible higher tier', () => {
    expect(combineSignals([S('en', 0.97, 'yt-audio', 3), S('ru', 0.9, 'page-text', 2), S('ru', 0.5, 'html-lang', 1)]).lang).toBe('en');
  });
  it('a provider-reported language overrides everything', () => {
    const early = combineSignals([S('ru', 0.95, 'yt-asr', 3)]);
    const v = withProviderLang(early, 'en')!;
    expect(v).toMatchObject({ lang: 'en', how: 'provider' });
    expect(v.confidence).toBeGreaterThanOrEqual(0.99);
    expect(withProviderLang(early, undefined)).toBe(early);
  });
});

function fakeDoc(o: { host?: string; lang?: string; title?: string; h1?: string; desc?: string; inLanguage?: string; srclang?: string } = {}): DocLike {
  const el = (attrs: Record<string, string>, text = '') => ({ getAttribute: (n: string) => attrs[n] ?? null, textContent: text });
  return {
    documentElement: { getAttribute: (n: string) => (n === 'lang' ? (o.lang ?? null) : null) },
    title: o.title ?? '',
    location: { hostname: o.host ?? 'example.com' },
    querySelector(sel: string) {
      if (sel.includes('og:title')) return null;
      if (sel.includes('name="description"') && o.desc) return el({ content: o.desc });
      if (sel.includes('inLanguage') && o.inLanguage) return el({ content: o.inLanguage });
      if (sel.includes('track') && o.srclang) return el({ srclang: o.srclang });
      return null;
    },
    querySelectorAll(sel: string) {
      return sel === 'h1' && o.h1 ? [el({}, o.h1)] : [];
    },
  };
}
const video = (title = '') => ({ title, getAttribute: () => null });
const noChrome: TextDetector = async () => undefined;

function reader(info: CaptionInfo | null): CaptionsReader {
  return { getTracks: async () => info, fetchText: async () => ({ status: 0, text: '' }) };
}

describe('detectVideoLanguage', () => {
  it('generic page: Russian html lang + Russian title => ru above the skip threshold', async () => {
    const v = await detectVideoLanguage(video('Тестовое видео про перевод и озвучку'), fakeDoc({ lang: 'ru', title: 'Тест перевода видео' }), { textDetector: noChrome });
    expect(v.lang).toBe('ru');
    expect(v.confidence).toBeGreaterThanOrEqual(0.8);
  });
  it('generic page: Latin title under a Russian html lang is not Russian', async () => {
    const v = await detectVideoLanguage(video('How to build a PC in 2024: the complete beginner guide'), fakeDoc({ lang: 'ru', title: 'How to build a PC' }), { textDetector: noChrome });
    expect(v.lang).toBe('en');
  });
  it('generic page without any signal => undefined', async () => {
    const v = await detectVideoLanguage(video(''), fakeDoc(), { textDetector: noChrome });
    expect(v.lang).toBeUndefined();
  });
  it('inLanguage and the default track are used', async () => {
    const v = await detectVideoLanguage(video(''), fakeDoc({ inLanguage: 'ja', srclang: 'ja' }), { textDetector: noChrome });
    expect(v.lang).toBe('ja');
  });
  it('YouTube: ASR track + audio track decide, interface html lang is ignored', async () => {
    const info: CaptionInfo = { videoId: 'x', tracks: [{ lang: 'en', kind: 'asr', baseUrl: 'u', translatable: true }], translationLangs: ['ru'], audioLang: 'en', title: 'Rick Astley - Never Gonna Give You Up (Official Music Video)' };
    const v = await detectVideoLanguage(video(''), fakeDoc({ host: 'www.youtube.com', lang: 'ru' }), { captions: reader(info), textDetector: noChrome });
    expect(v).toMatchObject({ lang: 'en', how: 'yt-audio' });
    expect(v.confidence).toBeGreaterThanOrEqual(0.9);
  });
  it('YouTube: Russian ASR + Russian description => skip-grade', async () => {
    const info: CaptionInfo = { tracks: [{ lang: 'ru', kind: 'asr', baseUrl: 'u', translatable: true }], translationLangs: [], title: 'Почему дорожает жильё? Объясняю на пальцах', description: 'Подписывайтесь на канал и ставьте лайк, дальше будет только интереснее' };
    const v = await detectVideoLanguage(video(''), fakeDoc({ host: 'www.youtube.com', lang: 'en' }), { captions: reader(info), textDetector: noChrome });
    expect(v.lang).toBe('ru');
    expect(v.confidence).toBeGreaterThanOrEqual(0.9);
  });
  it('the caption reader is not consulted off YouTube, and a null reader answer falls back to page text', async () => {
    let calls = 0;
    const r: CaptionsReader = { getTracks: async () => (calls++, null), fetchText: async () => ({ status: 0, text: '' }) };
    await detectVideoLanguage(video('Hello world'), fakeDoc(), { captions: r, textDetector: noChrome });
    expect(calls).toBe(0);
    const v = await detectVideoLanguage(video('Wie man in 10 Minuten ein Brot backt – das einfache Rezept'), fakeDoc({ host: 'youtube.com' }), { captions: r, textDetector: noChrome, captionsRetryMs: 1 });
    expect(calls).toBe(2);
    expect(v.lang).toBe('de');
  });
  it('Chrome LanguageDetector result is used when available', async () => {
    const det: TextDetector = async () => ({ lang: 'pl', confidence: 0.95 });
    const v = await detectVideoLanguage(video('Jak zrobić pyszne pierogi w domu? Przepis, który zawsze wychodzi'), fakeDoc(), { textDetector: det });
    expect(v.lang).toBe('pl');
  });
});

// ---- engine gate ----

function setup(over: Partial<Settings> = {}, verdict?: LangVerdict | (() => Promise<LangVerdict>), withStore = true) {
  const video = new FakeVideo();
  const providers = [new FakeProvider('yandex-live'), new FakeProvider('yandex'), new FakeProvider('gemini')];
  const caps: FakeCapture[] = [];
  const scheds: FakeScheduler[] = [];
  const states: string[] = [];
  const warnings: EngineWarning[] = [];
  const langs: LanguageInfo[] = [];
  let detects = 0;
  const cache = new MemoryCache();
  const key = 'yt:abc';
  const engine = new TranslationEngine({
    video: video as unknown as HTMLVideoElement,
    audioCtx: {} as AudioContext,
    providers,
    settings: settings({ voiceOrder: ['gemini', 'yandex', 'yandex-live'], ...over }),
    events: { onState: (s) => states.push(s), onWarning: (w) => warnings.push(w), onLanguage: (l) => langs.push(l) },
    detectLanguage: verdict
      ? async () => {
          detects++;
          return typeof verdict === 'function' ? verdict() : verdict;
        }
      : undefined,
    langStore: withStore ? createLangStore(cache, () => key) : undefined,
    createCapture: (async (_v: unknown, _o: CaptureOptions = {}) => {
      const c = new FakeCapture();
      caps.push(c);
      return c;
    }) as never,
    createScheduler: ((_v: unknown, _c: unknown, o: any) => {
      const s = new FakeScheduler(o);
      scheds.push(s);
      return s;
    }) as never,
    now: () => 0,
    sleep: instantSleep(),
    retryDelayMs: 10,
  });
  return { video, engine, providers, by: (id: string) => providers.find((p) => p.id === id)!, caps, scheds, states, warnings, langs, cache, detects: () => detects };
}

const V = (lang: string | undefined, confidence: number, how = 'yt-asr'): LangVerdict => ({ lang, confidence, how, signals: [] });

describe('engine language gate', () => {
  it('Russian video: no capture, no scheduler (no ducking), no provider call; state skipped-ru', async () => {
    const e = setup({}, V('ru', 0.95));
    await e.engine.start();
    await flush();
    expect(e.engine.state).toBe('skipped-ru');
    expect(e.caps).toHaveLength(0);
    expect(e.scheds).toHaveLength(0);
    expect(e.providers.every((p) => p.calls.length === 0)).toBe(true);
    expect(e.warnings.map((w) => w.kind)).toEqual(['already-russian']);
    expect(e.langs.at(-1)).toMatchObject({ lang: 'ru', skipped: true });
  });

  it('the Russian verdict is cached per video: the second start does not even detect', async () => {
    const e = setup({}, V('ru', 0.95));
    await e.engine.start();
    await flush();
    expect(e.detects()).toBe(1);
    await e.engine.start();
    expect(e.engine.state).toBe('skipped-ru');
    expect(e.detects()).toBe(1);
    expect(e.langs.at(-1)).toMatchObject({ how: 'cache', skipped: true });
  });

  it('English video: proceeds and the detected language reaches the provider context', async () => {
    const e = setup({}, V('en', 0.95, 'yt-audio'));
    await e.engine.start();
    e.caps[0]!.emit(chunk(0));
    await flush();
    expect(e.by('gemini').calls[0]!.ctx.sourceLang).toBe('en');
    expect(e.langs[0]).toMatchObject({ lang: 'en', unverified: false });
  });

  it('unknown language: proceeds, marked unverified, no source passed; a provider answer verifies it', async () => {
    const e = setup({}, V(undefined, 0));
    await e.engine.start();
    expect(e.warnings.map((w) => w.kind)).toContain('language-unverified');
    expect(e.langs[0]).toMatchObject({ unverified: true });
    e.caps[0]!.emit(chunk(0));
    await flush();
    expect(e.by('gemini').calls[0]!.ctx.sourceLang).toBeUndefined();
    expect(e.langs.at(-1)).toMatchObject({ lang: 'en', unverified: false, how: 'provider' });
  });

  it('low-confidence Russian guess does not skip (unverified), then Gemini says ru after the first chunk => stops at once', async () => {
    const e = setup({}, V('ru', 0.6, 'page-text'));
    e.by('gemini').fallback = { segments: [], sourceLang: 'ru' };
    await e.engine.start();
    expect(e.engine.state).toBe('starting');
    e.caps[0]!.emit(chunk(0));
    await flush();
    expect(e.engine.state).toBe('skipped-ru');
    expect(e.scheds.at(-1)!.disposed).toBeGreaterThan(0);
    expect(e.langs.at(-1)).toMatchObject({ how: 'provider', skipped: true });
    // and it is remembered
    const again = await e.cache.get('lang|yt:abc');
    expect(again?.sourceLang).toBe('ru');
  });

  it('force: a video detected as Russian is translated, the provider decides the source (nothing passed)', async () => {
    const e = setup({}, V('ru', 0.95));
    await e.engine.start({ force: true });
    expect(e.engine.state).toBe('starting');
    e.caps[0]!.emit(chunk(0));
    await flush();
    expect(e.by('gemini').calls[0]!.ctx.sourceLang).toBeUndefined();
    expect(e.langs[0]).toMatchObject({ lang: 'ru', forced: true });
  });

  it('force survives a provider that reports ru (no stop)', async () => {
    const e = setup({}, V('ru', 0.95));
    e.by('gemini').fallback = { segments: [seg(0)], sourceLang: 'ru' };
    await e.engine.start({ force: true });
    e.caps[0]!.emit(chunk(0));
    await flush();
    expect(e.engine.state).not.toBe('skipped-ru');
  });

  it('skipRussian off: translates a Russian video', async () => {
    const e = setup({ skipRussian: 'off' }, V('ru', 0.95));
    await e.engine.start();
    expect(e.engine.state).toBe('starting');
    expect(e.caps).toHaveLength(1);
  });

  it('explicit source language bypasses the gate (even for a "Russian" page) and is passed on', async () => {
    const e = setup({ sourceLang: 'ja' }, V('ru', 0.99));
    await e.engine.start();
    e.caps[0]!.emit(chunk(0));
    await flush();
    expect(e.detects()).toBe(0);
    expect(e.by('gemini').calls[0]!.ctx.sourceLang).toBe('ja');
    expect(e.langs[0]).toMatchObject({ lang: 'ja', how: 'settings' });
  });

  it('a failing detector does not block translation', async () => {
    const e = setup({}, async () => {
      throw new Error('boom');
    });
    await e.engine.start();
    expect(e.engine.state).toBe('starting');
    expect(e.langs[0]).toMatchObject({ unverified: true });
  });

  it('stop() while the gate is still detecting leaves the engine stopped', async () => {
    let release!: (v: LangVerdict) => void;
    const e = setup({}, () => new Promise<LangVerdict>((r) => (release = r)));
    const p = e.engine.start();
    await flush(2);
    e.engine.stop();
    release(V('en', 0.95));
    await p;
    expect(e.engine.state).toBe('stopped');
    expect(e.caps).toHaveLength(0);
  });

  it('without a detector the engine behaves as before (no gate)', async () => {
    const e = setup({}, undefined, false);
    await e.engine.start();
    expect(e.engine.state).toBe('starting');
    expect(e.langs).toHaveLength(0);
  });
});

describe('status text', () => {
  it('shows the language and how it was found, or the reason for the skip', () => {
    expect(languageStatusText({ lang: 'en', confidence: 0.97, how: 'yt-asr', unverified: false })).toBe('Язык оригинала: английский (по субтитрам YouTube)');
    expect(languageStatusText({ lang: 'ru', confidence: 0.9, how: 'page-text', unverified: false, skipped: true })).toContain('перевод не нужен');
    expect(languageStatusText({ confidence: 0, how: 'none', unverified: true })).toContain('не определён');
    expect(languageStatusText(undefined)).toBeUndefined();
  });
});

describe('settings migration', () => {
  it('old stored settings gain the defaults', () => {
    const s = normalizeSettings({ originalVolume: 0.5, autoTranslate: 'on' });
    expect(s.skipRussian).toBe('on');
    expect(s.sourceLang).toBe('auto');
  });
  it('validates values', () => {
    expect(normalizeSettings({ skipRussian: 'off' }).skipRussian).toBe('off');
    expect(normalizeSettings({ skipRussian: 'maybe' }).skipRussian).toBe('on');
    expect(normalizeSettings({ sourceLang: ' JA ' }).sourceLang).toBe('ja');
    expect(normalizeSettings({ sourceLang: 'klingon!' }).sourceLang).toBe('auto');
    expect(normalizeSettings({ sourceLang: 5 }).sourceLang).toBe('auto');
  });
});

describe('Yandex source language', () => {
  const run = async (sourceLang: string | undefined): Promise<string | undefined> => {
    const { YandexProvider } = await import('../src/providers/yandex/provider');
    let seen: string | undefined = 'unset';
    const client = { translatePcm: async (_p: unknown, _r: unknown, o: { sourceLang?: string }) => ((seen = o.sourceLang), new Uint8Array(4)) };
    const p = new YandexProvider({} as never, { client: client as never });
    await p.translateChunk(chunk(0), { signal: new AbortController().signal, targetLang: 'ru', sourceLang, wantSubtitles: false });
    return seen;
  };
  it('uses the detected language when Yandex supports it, else leaves it to Yandex (auto)', async () => {
    expect(await run('ja')).toBe('ja');
    expect(await run('en')).toBe('en');
    expect(await run('uk')).toBeUndefined();
    expect(await run('ru')).toBeUndefined();
    expect(await run(undefined)).toBeUndefined();
  });
});
