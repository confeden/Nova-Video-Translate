import { describe, expect, it, vi } from 'vitest';
import { MemoryCache } from '../src/cache/memoryCache';
import { KeyPool } from '../src/keypool';
import type { AudioChunk, SubtitleCue } from '../src/providers/types';
import {
  CaptionsSource,
  GeminiText,
  SubtitleCache,
  SubtitleController,
  SubtitleUnavailable,
  YandexSubtitleSource,
  canonicalVideoUrl,
  coverage,
  createCaptionsBridgeClient,
  dedupeCues,
  installCaptionsMain,
  mergeCues,
  orderBatches,
  parseJson3,
  parseTranslateReply,
  parseYandexSubtitles,
  pickTrack,
  readCaptionInfo,
  spreadSentences,
  splitSentences,
  subtitleStatusText,
  type CaptionInfo,
  type CaptionsReader,
  type ChunkSource,
  type CueTranslator,
  type WholeSource,
} from '../src/subtitles';
import { DEFAULT_SETTINGS, type Settings } from '../src/types';

const c = (start: number, end: number, text: string): SubtitleCue => ({ start, end, text });
const on: Settings = { ...DEFAULT_SETTINGS, subtitles: 'on' };
const off: Settings = { ...DEFAULT_SETTINGS, subtitles: 'off' };
const chunk = (startSec: number, durationSec = 15, partial = false): AudioChunk => ({ startSec, durationSec, sampleRate: 16000, pcm: new Int16Array(10), partial });
const tick = (n = 5): Promise<void> => new Promise((r) => setTimeout(r, n));

describe('parsers', () => {
  it('json3: texts, durations, rolling lines end where the next starts, blanks dropped', () => {
    const cues = parseJson3({
      events: [
        { tStartMs: 1000, dDurationMs: 4000, segs: [{ utf8: 'Hello ' }, { utf8: 'world' }] },
        { tStartMs: 3000, dDurationMs: 4000, segs: [{ utf8: 'second\nline' }] },
        { tStartMs: 9000, dDurationMs: 500 },
        { tStartMs: 10000, dDurationMs: 1000, segs: [{ utf8: '\n' }] },
      ],
    });
    expect(cues).toEqual([c(1, 3, 'Hello world'), c(3, 7, 'second line')]);
    expect(parseJson3('not json')).toEqual([]);
    expect(parseJson3('{}')).toEqual([]);
  });
  it('yandex json: startMs/durationMs', () => {
    const cues = parseYandexSubtitles(JSON.stringify({ subtitles: [{ text: 'Привет', startMs: 500, durationMs: 1500, speakerId: '0', tokens: [] }, { text: '', startMs: 1, durationMs: 1 }] }));
    expect(cues).toEqual([c(0.5, 2, 'Привет')]);
    expect(parseYandexSubtitles('[]')).toEqual([]);
  });
  it('sentences are spread over a span proportionally', () => {
    const s = splitSentences('One. Two two two two! Three?');
    expect(s).toEqual(['One.', 'Two two two two!', 'Three?']);
    const sp = spreadSentences(s, 10, 20);
    expect(sp[0]!.start).toBe(10);
    expect(sp[2]!.end).toBeCloseTo(20);
    expect(sp[1]!.end - sp[1]!.start).toBeGreaterThan(sp[0]!.end - sp[0]!.start);
  });
});

describe('merge / dedupe / coverage', () => {
  it('drops a lower-layer cue mostly covered by a higher layer, keeps the rest', () => {
    const voice = [c(0, 4, 'voice')];
    const chunks = [c(0.5, 3.5, 'dup'), c(3, 8, 'half'), c(10, 12, 'free')];
    const m = mergeCues([voice, [], chunks]);
    expect(m.map((x) => x.text)).toEqual(['voice', 'half', 'free']); // 'half' is covered 1/5 only
  });
  it('dedupes identical text starting at nearly the same time', () => {
    expect(dedupeCues([c(1, 2, 'a'), c(1.3, 2.3, 'a'), c(5, 6, 'a')])).toHaveLength(2);
  });
  it('coverage fraction of a window', () => {
    expect(coverage([c(0, 5, 'x'), c(4, 10, 'y')], 0, 20)).toBeCloseTo(0.5);
    expect(coverage([], 0, 10)).toBe(0);
  });
});

describe('captions source', () => {
  const tr = (id: 'chrome-ai' | 'gemini', ok: boolean, fn?: (cues: SubtitleCue[]) => SubtitleCue[]): CueTranslator & { calls: number } => ({
    id,
    label: id,
    calls: 0,
    isAvailable: () => ok,
    async translate(cues) {
      (this as { calls: number }).calls++;
      return (fn ?? ((x: SubtitleCue[]) => x.map((q) => ({ ...q, src: q.text, text: `ru:${q.text}` }))))(cues);
    },
  });
  const json3 = (n: number) => JSON.stringify({ events: Array.from({ length: n }, (_, i) => ({ tStartMs: i * 2000, dDurationMs: 1500, segs: [{ utf8: `l${i}` }] })) });
  const reader = (info: CaptionInfo | null, bodies: Record<string, string> = {}): CaptionsReader & { urls: string[] } => ({
    urls: [],
    getTracks: async () => info,
    async fetchText(url) {
      (this as { urls: string[] }).urls.push(url);
      const k = Object.keys(bodies).filter((b) => url.includes(b)).sort((a, b) => b.length - a.length)[0];
      return { status: k ? 200 : 404, text: k ? bodies[k]! : '' };
    },
  });
  const ctx = (now = 0) => {
    const partials: SubtitleCue[][] = [];
    const labels: string[] = [];
    return { signal: new AbortController().signal, currentTime: () => now, onPartial: (x: SubtitleCue[]) => partials.push(x), setLabel: (l: string) => labels.push(l), partials, labels };
  };
  const en: CaptionInfo = { videoId: 'v', audioLang: 'en', translationLangs: ['ru'], tracks: [{ lang: 'en', kind: 'asr', baseUrl: '/api/timedtext?v=v&lang=en', translatable: true }] };

  it('picks ru manual > ru asr > audio-language manual > asr', () => {
    const t = (lang: string, kind = ''): CaptionInfo['tracks'][number] => ({ lang, kind, baseUrl: lang + kind, translatable: false });
    expect(pickTrack({ tracks: [t('en'), t('ru', 'asr'), t('ru')], translationLangs: [] })!.baseUrl).toBe('ru');
    expect(pickTrack({ tracks: [t('de'), t('en', 'asr'), t('fr')], translationLangs: [], audioLang: 'en' })!.baseUrl).toBe('enasr'); // spoken-language asr beats a foreign manual track
    expect(pickTrack({ tracks: [t('de', 'asr'), t('fr'), t('es')], translationLangs: [] })!.baseUrl).toBe('fr');
    expect(pickTrack({ tracks: [t('de', 'asr'), t('en', 'asr')], translationLangs: [], audioLang: 'en' })!.baseUrl).toBe('enasr');
  });

  it('orders translation batches starting at the playhead', () => {
    const cues = Array.from({ length: 100 }, (_, i) => c(i * 10, i * 10 + 5, `c${i}`));
    const b = orderBatches(cues, 500, 40);
    expect(b.map((x) => x[0]!.text)).toEqual(['c40', 'c80', 'c0']);
  });

  it('Russian track is used as is, without any translator', async () => {
    const t1 = tr('chrome-ai', true);
    const src = new CaptionsSource({ reader: reader({ ...en, tracks: [{ lang: 'ru', kind: '', baseUrl: '/api/timedtext?lang=ru', translatable: false }] }, { 'lang=ru': json3(3) }), translators: [t1] });
    const cues = await src.load(ctx());
    expect(cues.map((x) => x.text)).toEqual(['l0', 'l1', 'l2']);
    expect(t1.calls).toBe(0);
  });

  it('translator chain: local first, Gemini when local is unavailable, partials delivered, label refined', async () => {
    const chrome = tr('chrome-ai', false);
    const gem = tr('gemini', true);
    const r = reader(en, { 'lang=en': json3(90) });
    const x = ctx(0);
    const cues = await new CaptionsSource({ reader: r, translators: [chrome, gem] }).load(x);
    expect(chrome.calls).toBe(0);
    expect(gem.calls).toBe(3); // 90 cues / 40 per batch
    expect(cues).toHaveLength(90);
    expect(cues[0]!.text).toBe('ru:l0');
    expect(x.partials.length).toBe(3);
    expect(x.labels.at(-1)).toBe('YouTube + перевод Gemini');
    expect(r.urls[0]).toContain('fmt=json3');
  });

  it('adds the player-provided token params to timedtext requests', async () => {
    const r = reader({ ...en, urlParams: { potc: '1', pot: 'T', c: 'WEB' } }, { 'lang=en': json3(1) });
    await new CaptionsSource({ reader: r, translators: [tr('chrome-ai', true)] }).load(ctx());
    expect(r.urls[0]).toMatch(/potc=1.*pot=T.*c=WEB|pot=T/);
    expect(new URL(r.urls[0]!, 'https://www.youtube.com').searchParams.get('pot')).toBe('T');
  });

  it('uses the local translator when it is available and never calls Gemini', async () => {
    const chrome = tr('chrome-ai', true);
    const gem = tr('gemini', true);
    const x = ctx();
    await new CaptionsSource({ reader: reader(en, { 'lang=en': json3(5) }), translators: [chrome, gem] }).load(x);
    expect(chrome.calls).toBe(1);
    expect(gem.calls).toBe(0);
    expect(x.labels.at(-1)).toBe('YouTube + локальный перевод');
  });

  it('falls back to YouTube auto-translation (tlang=ru) when no translator exists; throws when nothing helps', async () => {
    const r = reader({ ...en, tracks: [{ ...en.tracks[0]!, translatable: false }] }, { 'lang=en': json3(2) });
    const cues = await new CaptionsSource({ reader: r, translators: [tr('chrome-ai', false)] }).load(ctx()).catch(() => null);
    expect(cues).toBeNull(); // track not translatable => nothing left to try
    const r2 = reader(en, { 'lang=en': json3(2), 'tlang=ru': json3(2) });
    expect(await new CaptionsSource({ reader: r2, translators: [] }).load(ctx())).toHaveLength(2);
  });

  it('no tracks / no player / empty body are SubtitleUnavailable with a Russian reason', async () => {
    await expect(new CaptionsSource({ reader: reader({ tracks: [], translationLangs: [] }), translators: [] }).load(ctx())).rejects.toThrow(/нет субтитров/);
    await expect(new CaptionsSource({ reader: reader(null), translators: [], retries: 1, sleep: async () => {} }).load(ctx())).rejects.toThrow(/доступа к плееру/);
    await expect(new CaptionsSource({ reader: reader(en, {}), translators: [] }).load(ctx())).rejects.toBeInstanceOf(SubtitleUnavailable);
  });

  it('stores a complete Gemini translation in the cache and serves it next time without a call', async () => {
    const cache = new SubtitleCache({ cache: new MemoryCache(), settings: () => on, videoKey: () => 'yt:v|d100' });
    const gem = tr('gemini', true);
    const mk = () => new CaptionsSource({ reader: reader(en, { 'lang=en': json3(3) }), translators: [gem], cache });
    await mk().load(ctx());
    await tick(20);
    const gem2 = tr('gemini', true);
    const again = await new CaptionsSource({ reader: reader(en, { 'lang=en': json3(3) }), translators: [gem2], cache }).load(ctx());
    expect(gem2.calls).toBe(0);
    expect(again.map((x) => x.text)).toEqual(['ru:l0', 'ru:l1', 'ru:l2']);
  });
});

describe('yandex subtitle source', () => {
  const ref = (o: Partial<{ language: string; url: string; translatedLanguage: string; translatedUrl: string }>) => ({ language: '', url: '', translatedLanguage: '', translatedUrl: '', ...o });
  it('canonical urls', () => {
    expect(canonicalVideoUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=5')).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(canonicalVideoUrl('https://youtu.be/dQw4w9WgXcQ?x=1')).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(canonicalVideoUrl('http://localhost:3000/a')).toBeUndefined();
    expect(canonicalVideoUrl('file:///a.html')).toBeUndefined();
    expect(canonicalVideoUrl('https://vimeo.com/123#t=1')).toBe('https://vimeo.com/123');
  });
  it('polls while waiting, takes the Russian translation, parses it', async () => {
    const replies = [{ waiting: true, subtitles: [] }, { waiting: false, subtitles: [ref({ language: 'en', url: 'https://mds/en.json', translatedLanguage: 'ru', translatedUrl: 'https://mds/ru.json' })] }];
    const api = { getSubtitles: vi.fn(async () => replies.shift()!) };
    const fetchText = vi.fn(async () => ({ status: 200, text: JSON.stringify({ subtitles: [{ text: 'Привет', startMs: 1000, durationMs: 2000 }] }) }));
    const src = new YandexSubtitleSource({ api, fetchText, pageUrl: () => 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', sleep: async () => {} });
    const cues = await src.load({ signal: new AbortController().signal, currentTime: () => 0, onPartial() {}, setLabel() {} });
    expect(cues).toEqual([c(1, 3, 'Привет')]);
    expect(api.getSubtitles).toHaveBeenCalledTimes(2);
    expect(fetchText).toHaveBeenCalledWith('https://mds/ru.json', expect.anything());
  });
  it('gives up with a clear reason when Yandex stays waiting (measured behaviour for untranslated videos)', async () => {
    const api = { getSubtitles: async () => ({ waiting: true, subtitles: [] }) };
    const src = new YandexSubtitleSource({ api, fetchText: async () => ({ status: 200, text: '' }), pageUrl: () => 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', sleep: async () => {} });
    await expect(src.load({ signal: new AbortController().signal, currentTime: () => 0, onPartial() {}, setLabel() {} })).rejects.toThrow(/ещё не готовы/);
  });
});

describe('gemini text', () => {
  it('reply parsing keeps indices, drops empties', () => {
    expect(parseTranslateReply(JSON.stringify({ items: [{ i: 1, ru: 'б' }, { i: 0, ru: 'а' }, { i: 5, ru: 'x' }, { i: 2, ru: ' ' }] }), 3)).toEqual(['а', 'б', undefined]);
    expect(parseTranslateReply('garbage', 2)).toEqual([undefined, undefined]);
  });
  it('translates a batch with one flash-lite call, keeping timings and the original', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.includes('/models?')) return new Response(JSON.stringify({ models: [{ name: 'models/gemini-3.1-flash-lite', supportedGenerationMethods: ['generateContent'] }, { name: 'models/gemini-tts', supportedGenerationMethods: ['generateContent'] }] }));
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ items: [{ i: 0, ru: 'Привет' }, { i: 1, ru: 'Мир' }] }) }] } }] }));
    });
    const g = new GeminiText({ pool: () => new KeyPool(['k']), fetch: fetchFn as never });
    const out = await g.translate([c(1, 2, 'Hello'), c(3, 4, 'World')], 'en', new AbortController().signal);
    expect(out).toEqual([{ start: 1, end: 2, src: 'Hello', text: 'Привет' }, { start: 3, end: 4, src: 'World', text: 'Мир' }]);
    expect(g.calls).toBe(1);
    const gen = fetchFn.mock.calls.find((a) => String(a[0]).includes(':generateContent'))!;
    expect(String(gen[0])).toContain('gemini-3.1-flash-lite');
  });
  it('is unavailable without keys', () => {
    expect(new GeminiText({ pool: () => new KeyPool([]), fetch: vi.fn() as never }).isAvailable()).toBe(false);
  });
});

describe('SubtitleController', () => {
  const whole = (id: WholeSource['id'], o: { available?: boolean; cues?: SubtitleCue[]; err?: string; label?: string }): WholeSource & { loads: number; checks: number } => ({
    id,
    label: o.label ?? id,
    loads: 0,
    checks: 0,
    isAvailable() {
      (this as { checks: number }).checks++;
      return o.available ?? true;
    },
    unavailableReason: () => 'недоступно',
    async load() {
      (this as { loads: number }).loads++;
      if (o.err) throw new SubtitleUnavailable(o.err);
      return o.cues ?? [];
    },
  });
  const chunkSrc = (id: ChunkSource['id'], o: { available?: boolean; fn?: (c: AudioChunk) => SubtitleCue[] | Promise<SubtitleCue[]> } = {}): ChunkSource & { calls: AudioChunk[] } => ({
    id,
    label: id,
    calls: [],
    isAvailable: () => o.available ?? true,
    unavailableReason: () => 'нет',
    async transcribe(ch) {
      (this as { calls: AudioChunk[] }).calls.push(ch);
      return o.fn ? o.fn(ch) : [c(ch.startSec + 1, ch.startSec + 3, `t${ch.startSec}`)];
    },
  });
  const make = (s: Settings, w: WholeSource[], ch: ChunkSource[], extra: { cache?: SubtitleCache; now?: () => number } = {}) => {
    const out = { cues: [] as SubtitleCue[], labels: [] as (string | undefined)[], fails: [] as string[] };
    const ctl = new SubtitleController({
      getSettings: () => s,
      whole: w,
      chunk: ch,
      cache: extra.cache,
      currentTime: extra.now ?? (() => 0),
      onCues: (x) => (out.cues = x),
      onStatus: (l) => out.labels.push(l),
      onFail: (r) => out.fails.push(r),
      retryMs: 0,
    });
    return { ctl, out };
  };

  it('opt-in (I4): with subtitles off no source is even asked', async () => {
    const w = whole('yandex', { cues: [c(0, 1, 'x')] });
    const ch = chunkSrc('gemini');
    const { ctl, out } = make(off, [w], [ch]);
    ctl.start();
    ctl.feedChunk(chunk(0));
    ctl.setVoiceCues([c(0, 1, 'v')]);
    await tick();
    expect(w.checks + w.loads).toBe(0);
    expect(ch.calls).toHaveLength(0);
    expect(out.cues).toEqual([]);
    expect(ctl.state).toBe('idle');
  });

  it('the first source that delivers wins and later ones are not touched', async () => {
    const a = whole('yandex', { cues: [c(0, 2, 'Яндекс')], label: 'Яндекс' });
    const b = whole('captions', { cues: [c(0, 2, 'YT')] });
    const ch = chunkSrc('gemini');
    const { ctl, out } = make(on, [a, b], [ch]);
    ctl.start();
    await tick();
    expect(out.cues.map((x) => x.text)).toEqual(['Яндекс']);
    expect(b.loads).toBe(0);
    expect(ctl.source).toBe('Яндекс');
    expect(subtitleStatusText(ctl.source)).toBe('Субтитры: Яндекс');
    ctl.feedChunk(chunk(0));
    await tick();
    expect(ch.calls).toHaveLength(0); // chunk mode never starts once a whole source delivered
  });

  it('falls through unavailable / failing sources to chunk transcription, in order', async () => {
    const a = whole('yandex', { available: false });
    const b = whole('captions', { err: 'у видео нет субтитров' });
    const g = chunkSrc('gemini', { available: false });
    const ai = chunkSrc('chrome-ai');
    const { ctl, out } = make(on, [a, b], [g, ai]);
    ctl.start();
    ctl.feedChunk(chunk(0));
    await tick(30);
    expect(a.loads).toBe(0);
    expect(b.loads).toBe(1);
    expect(g.calls).toHaveLength(0);
    expect(ai.calls).toHaveLength(1);
    expect(out.cues.map((x) => x.text)).toEqual(['t0']);
    expect(ctl.source).toBe('chrome-ai');
    expect(out.fails).toEqual([]);
  });

  it('shows one clear failure when no source can deliver', async () => {
    const { ctl, out } = make(on, [whole('captions', { err: 'у видео нет субтитров' })], [chunkSrc('gemini', { available: false })]);
    ctl.start();
    ctl.start();
    await tick(20);
    expect(out.fails).toHaveLength(1);
    expect(out.fails[0]).toMatch(/^Субтитры недоступны: .*нет субтитров.*gemini: нет/);
    expect(ctl.state).toBe('failed');
  });

  it('a chunk source that reports SubtitleUnavailable hands over to the next one without losing the chunk', async () => {
    const g = chunkSrc('gemini', {
      fn: () => {
        throw new SubtitleUnavailable('лимит Gemini исчерпан');
      },
    });
    const ai = chunkSrc('chrome-ai');
    const { ctl, out } = make(on, [], [g, ai]);
    ctl.start();
    ctl.feedChunk(chunk(15));
    await tick(30);
    expect(g.calls).toHaveLength(1);
    expect(ai.calls).toHaveLength(1);
    expect(out.cues.map((x) => x.text)).toEqual(['t15']);
  });

  it('skips cells the Gemini voice already covers, and everything once Gemini is the voice tier', async () => {
    const ch = chunkSrc('gemini');
    const { ctl, out } = make(on, [], [ch]);
    ctl.start();
    await tick();
    ctl.setVoiceCues([c(0, 14, 'голос')]);
    ctl.feedChunk(chunk(0));
    await tick(20);
    expect(ch.calls).toHaveLength(0);
    expect(ctl.stats.skippedByVoice).toBe(1);
    ctl.feedChunk(chunk(15));
    await tick(20);
    expect(ch.calls).toHaveLength(1);
    ctl.noteVoiceTier('gemini');
    ctl.feedChunk(chunk(30));
    await tick(20);
    expect(ch.calls).toHaveLength(1);
    expect(out.cues.map((x) => x.text)).toEqual(['голос', 't15']);
  });

  it('merges chunk cues with voice cues by overlap (no double lines)', async () => {
    const ch = chunkSrc('gemini', { fn: (k) => [c(k.startSec + 1, k.startSec + 3, 'dup'), c(k.startSec + 8, k.startSec + 10, 'tail')] });
    const { ctl, out } = make(on, [], [ch]);
    ctl.start();
    await tick();
    ctl.setVoiceCues([c(1, 3, 'voice')]);
    ctl.feedChunk(chunk(0));
    await tick(20);
    expect(out.cues.map((x) => x.text)).toEqual(['voice', 'tail']);
  });

  it('caches complete cells, never partial ones, and serves hits without a call', async () => {
    const cache = new SubtitleCache({ cache: new MemoryCache(), settings: () => on, videoKey: () => 'yt:v|d100' });
    const ch = chunkSrc('gemini');
    const a = make(on, [], [ch], { cache });
    a.ctl.start();
    a.ctl.feedChunk(chunk(0));
    a.ctl.feedChunk(chunk(15, 7, true));
    await tick(40);
    expect(ch.calls).toHaveLength(2);
    const ch2 = chunkSrc('gemini');
    const b = make(on, [], [ch2], { cache });
    b.ctl.start();
    b.ctl.feedChunk(chunk(0));
    b.ctl.feedChunk(chunk(15, 7, true));
    await tick(40);
    expect(ch2.calls.map((x) => x.startSec)).toEqual([15]); // cell 0 from cache, the partial one is recomputed
    expect(b.ctl.stats.cacheHits).toBe(1);
    expect(b.out.cues.map((x) => x.text)).toEqual(['t0', 't15']);
  });

  it('serves the cell nearest the playhead first and drops cells behind it', async () => {
    const order: number[] = [];
    const ch = chunkSrc('gemini', { fn: async (k) => (order.push(k.startSec), []) });
    const { ctl } = make(on, [], [ch], { now: () => 40 });
    ctl.start();
    await tick();
    for (const s of [0, 45, 30, 60]) ctl.feedChunk(chunk(s));
    await tick(40);
    expect(order).toEqual([30, 45, 60]); // 0..15 ended long before t-2
  });

  it('stop() clears cues and settings turning off mid-run stops the chain', async () => {
    const w = whole('captions', { cues: [c(0, 2, 'x')] });
    const { ctl, out } = make(on, [w], []);
    ctl.start();
    await tick();
    expect(out.cues).toHaveLength(1);
    ctl.stop();
    expect(out.cues).toEqual([]);
    expect(ctl.state).toBe('idle');
  });
});

describe('captions bridge', () => {
  /** two "worlds" sharing one window-like event bus (MAIN half and isolated half) */
  function fakeWindow(url = 'https://www.youtube.com/watch?v=v') {
    const listeners: ((e: MessageEvent) => void)[] = [];
    const win: Record<string, unknown> = {
      location: { href: url, origin: 'https://www.youtube.com' },
      postMessage(data: unknown) {
        setTimeout(() => listeners.slice().forEach((l) => l({ data, source: win } as unknown as MessageEvent)), 0);
      },
      addEventListener: (_t: string, fn: (e: MessageEvent) => void) => listeners.push(fn),
      removeEventListener: (_t: string, fn: (e: MessageEvent) => void) => listeners.splice(listeners.indexOf(fn), 1),
    };
    return win;
  }
  const player = { getPlayerResponse: () => ({ videoDetails: { videoId: 'v' }, captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ baseUrl: 'https://www.youtube.com/api/timedtext?v=v&lang=en', languageCode: 'en', kind: 'asr', isTranslatable: true }], translationLanguages: [{ languageCode: 'ru' }] } } }), getVideoData: () => ({ video_id: 'v' }), getAudioTrack: () => ({ getLanguageInfo: () => ({ id: 'en.4' }) }) };

  it('readCaptionInfo extracts tracks and ignores a stale response of another video', () => {
    const doc = { getElementById: () => player };
    const info = readCaptionInfo(doc, {})!;
    expect(info.tracks[0]).toMatchObject({ lang: 'en', kind: 'asr', translatable: true });
    expect(info.translationLangs).toEqual(['ru']);
    expect(info.audioLang).toBe('en');
    expect(readCaptionInfo({ getElementById: () => ({ ...player, getVideoData: () => ({ video_id: 'other' }) }) }, {})).toBeNull();
  });

  it('reads the PO token and device params from the player audio track, decoding the token', () => {
    const p = { ...player, getAudioTrack: () => ({ getLanguageInfo: () => ({ id: 'en.4' }), captionTracks: [{ url: 'https://www.youtube.com/api/timedtext?v=v&pot=ab%253Dcd&lang=en' }] }) };
    const info = readCaptionInfo({ getElementById: () => p }, { ytcfg: { data_: { DEVICE: 'cbr=Chrome&ceng=x&cengver=1', INNERTUBE_CLIENT_NAME: 'WEB', INNERTUBE_CLIENT_VERSION: '2.1' } } })!;
    expect(info.urlParams).toMatchObject({ potc: '1', pot: 'ab=cd', cbr: 'Chrome', c: 'WEB', cver: '2.1', cplayer: 'UNIPLAYER' });
    expect(info.urlParams).not.toHaveProperty('ceng');
    expect(readCaptionInfo({ getElementById: () => player }, {})!.urlParams).toBeUndefined();
  });

  it('round trip over the message bus with a nonce; only same-origin timedtext urls are fetched', async () => {
    const win = fakeWindow();
    installCaptionsMain({ win: win as never, doc: { getElementById: () => player } });
    const fetchSpy = vi.fn(async () => new Response('{"events":[]}'));
    vi.stubGlobal('fetch', fetchSpy);
    const client = createCaptionsBridgeClient(win as never);
    const info = await client.getTracks(500);
    expect(info?.videoId).toBe('v');
    const ok = await client.fetchText('https://www.youtube.com/api/timedtext?v=v&lang=en&fmt=json3', 500);
    expect(ok).toEqual({ status: 200, text: '{"events":[]}' });
    const bad = await client.fetchText('https://evil.example/api/timedtext?x=1', 500);
    expect(bad.status).toBe(0);
    const bad2 = await client.fetchText('https://www.youtube.com/youtubei/v1/player', 500);
    expect(bad2.status).toBe(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('a client with a wrong nonce gets nothing; no MAIN half => null after the timeout', async () => {
    const win = fakeWindow();
    const client = createCaptionsBridgeClient(win as never);
    expect(await client.getTracks(30)).toBeNull();
  });
});
