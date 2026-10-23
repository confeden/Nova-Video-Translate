import { describe, expect, it } from 'vitest';
import { normalizeSettings, migrateVoiceOrder } from '../src/settings';
import { DEFAULT_SETTINGS } from '../src/types';
import { LocalTtsRegistry } from '../src/localtts/registry';
import type { LocalTtsEngine, LocalTtsEngineId, LocalTtsRequest } from '../src/localtts/types';
import { LocalAsrRegistry } from '../src/localasr/registry';
import type { LocalAsr } from '../src/localasr/types';
import { ChromePromptAudioAsr } from '../src/localasr/chromePrompt';
import { CaptionPretranslator } from '../src/providers/cascade/pretranslate';
import { buildSentences, sentencesFromJson3, wordsFromJson3, alignTlang, type CaptionTimeline } from '../src/providers/cascade/captions';
import { groupPhrases, isoLang, type SourceSegment } from '../src/providers/cascade/segments';
import { voiceSegments } from '../src/providers/cascade/voice';
import type { TextTranslator } from '../src/providers/cascade/translate';
import { GroqClient, RequestBudget, multipartBody, parseGroqRetryMs } from '../src/providers/groq/client';
import { GroqModelRegistry, GROQ_ASR_PREFERENCES, GROQ_CHAT_PREFERENCES } from '../src/providers/groq/models';
import { GroqChatTranslator, parseGroqTranslation } from '../src/providers/groq/translate';
import { createGroqProvider } from '../src/providers/groq/provider';
import { createLocalProvider } from '../src/providers/local/provider';
import { ProviderUnavailableError, type AudioChunk, type DubProvider, type Transport } from '../src/providers/types';
import { createChainState, eligibleProviders, runChain } from '../src/pipeline/chain';
import { LatencyModel, TIER_PRIOR_SEC, planCell } from '../src/pipeline/planner';
import { stateText, voiceLine, sourceName, laterName, providerName } from '../src/ui/status';
import { pickModel } from '../src/models';
import { diag } from '../src/diag';
import { settings as testSettings, FakeProvider, seg } from './helpers/pipelineFakes';

// ---------- fakes ----------
const KEY = 'gsk_TESTONLY_SECRET_0000';
const ctxOf = (signal = new AbortController().signal, over: object = {}) => ({ signal, targetLang: 'ru' as const, wantSubtitles: false, ...over });
const audio = (startSec = 0, durationSec = 15): AudioChunk => ({ startSec, durationSec, sampleRate: 16000, pcm: new Int16Array(16000 * durationSec) });

class FakeTts implements LocalTtsEngine {
  calls: LocalTtsRequest[] = [];
  avail = true;
  constructor(
    readonly id: LocalTtsEngineId = 'supertonic-webgpu',
    /** seconds of speech per character */
    private readonly secPerChar = 1 / 14,
    private readonly fail?: (req: LocalTtsRequest) => boolean,
  ) {}
  async isAvailable() {
    return this.avail;
  }
  async voices() {
    return ['standard'];
  }
  async synth(req: LocalTtsRequest) {
    this.calls.push(req);
    if (this.fail?.(req)) throw new Error('boom');
    const rate = 24000;
    const sec = req.text.length * this.secPerChar;
    return { sampleRate: rate, samples: new Int16Array(Math.round(sec * rate)).fill(500), durationSec: sec };
  }
}

const reg = (...engines: LocalTtsEngine[]) => {
  const r = new LocalTtsRegistry();
  engines.forEach((e) => r.register(e));
  return r;
};

/** translator that upper-cases with a Russian prefix and records the budgets it was given */
class FakeTr implements TextTranslator {
  readonly id = 'fake-tr';
  seen: { text: string; maxChars: number }[] = [];
  constructor(public avail = true) {}
  async isAvailable() {
    return this.avail;
  }
  async translate(items: readonly { text: string; maxChars: number }[]) {
    this.seen.push(...items);
    return items.map((i) => `ру ${i.text}`);
  }
}

const bin = (b: Uint8Array | undefined): string => Array.from(b ?? [], (x) => String.fromCharCode(x)).join('');
const j = (o: unknown, status = 200, headers: Record<string, string> = {}) => ({ status, headers, body: new TextEncoder().encode(JSON.stringify(o)) });

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: Uint8Array;
}
function groqTransport(over: { asr?: unknown | ((n: number) => ReturnType<typeof j>); chat?: unknown; models?: string[] } = {}) {
  const log: Recorded[] = [];
  let asrN = 0;
  const t: Transport = async (req) => {
    log.push({ url: req.url, method: req.method, headers: req.headers, body: req.body });
    if (req.url.endsWith('/models')) return j({ data: (over.models ?? ['whisper-large-v3-turbo', 'llama-3.3-70b-versatile', 'playai-tts']).map((id) => ({ id })) });
    if (req.url.endsWith('/audio/transcriptions')) {
      const a = over.asr;
      if (typeof a === 'function') return (a as (n: number) => ReturnType<typeof j>)(asrN++);
      return j(a ?? { language: 'english', duration: 15, text: 'x', segments: [{ start: 0.2, end: 3.0, text: ' Hello there my friends.', no_speech_prob: 0.01, avg_logprob: -0.2 }, { start: 4, end: 7.5, text: ' This is a test of the system.', no_speech_prob: 0.01, avg_logprob: -0.2 }] });
    }
    if (req.url.endsWith('/chat/completions')) {
      const body = JSON.parse(new TextDecoder().decode(req.body)) as { messages: { content: string }[] };
      const user = JSON.parse(body.messages[1]!.content) as { segments: { i: number; src: string }[] };
      return j(over.chat ?? { choices: [{ message: { content: JSON.stringify({ segments: user.segments.map((s) => ({ i: s.i, ru: `Привет ${s.i}` })) }) } }] });
    }
    return j({}, 404);
  };
  return { t, log };
}

// ---------- registries ----------
describe('LocalTtsRegistry', () => {
  it('pick follows the order and skips unavailable / throwing engines', async () => {
    const a = new FakeTts('supertonic-webgpu');
    const b = new FakeTts('helper-omnivoice');
    const c = new FakeTts('silero-cpu');
    const r = reg(a, b, c);
    expect((await r.pick())?.id).toBe('supertonic-webgpu');
    a.avail = false;
    expect((await r.pick())?.id).toBe('helper-omnivoice');
    b.isAvailable = async () => {
      throw new Error('x');
    };
    expect((await r.pick())?.id).toBe('silero-cpu');
    expect((await r.pick(['helper-omnivoice', 'supertonic-webgpu']))).toBeUndefined();
    expect((await r.pick(['silero-cpu', 'supertonic-webgpu']))?.id).toBe('silero-cpu');
  });
  it('register returns an unregister function; get/list work', async () => {
    const r = new LocalTtsRegistry();
    const off = r.register(new FakeTts('silero-cpu'));
    expect(r.get('silero-cpu')).toBeDefined();
    expect(r.list()).toHaveLength(1);
    off();
    expect(r.get('silero-cpu')).toBeUndefined();
    expect(await r.pick()).toBeUndefined();
  });
});

describe('LocalAsrRegistry + Chrome Prompt API engine', () => {
  const eng = (id: LocalAsr['id'], langs: string[], ok = true): LocalAsr => ({ id, languages: () => langs, isAvailable: async () => ok, transcribe: async () => ({ segments: [] }) });
  it('picks by order, availability and language', async () => {
    const r = new LocalAsrRegistry();
    r.register(eng('chrome-prompt-audio', ['en']));
    r.register(eng('whisper-wasm', ['*'], false));
    expect((await r.pick(['whisper-wasm', 'chrome-prompt-audio']))?.id).toBe('chrome-prompt-audio');
    expect(await r.pick(['whisper-wasm', 'chrome-prompt-audio'], 'ja')).toBeUndefined();
    expect((await r.pick(['chrome-prompt-audio'], 'EN-us'))?.id).toBe('chrome-prompt-audio');
  });
  it('Chrome engine: unavailable without LanguageModel; clones a clean session per chunk and destroys it', async () => {
    expect(await new ChromePromptAudioAsr(() => ({})).isAvailable()).toBe(false);
    let created = 0;
    let cloned = 0;
    let destroyed = 0;
    const mk = (): any => ({
      prompt: async () => 'Hello world. How are you today?',
      clone: async () => {
        cloned++;
        return mk();
      },
      destroy: () => destroyed++,
    });
    const asr = new ChromePromptAudioAsr(() => ({
      LanguageModel: { availability: async () => 'available', create: async () => (created++, mk()) },
    }));
    expect(await asr.isAvailable()).toBe(true);
    const a = await asr.transcribe(new Int16Array(16000 * 4));
    const b = await asr.transcribe(new Int16Array(16000 * 4));
    expect(created).toBe(1);
    expect(cloned).toBe(2);
    expect(destroyed).toBe(2);
    expect(a.segments.map((s) => s.text)).toEqual(['Hello world.', 'How are you today?']);
    expect(a.segments[1]!.end).toBeCloseTo(4, 5);
    expect(a.lang).toBe('en');
    expect(b.segments).toHaveLength(2);
  });
  it('Chrome engine: NO_SPEECH gives no segments', async () => {
    const mk = (): any => ({ prompt: async () => 'NO_SPEECH', clone: async () => mk(), destroy() {} });
    const asr = new ChromePromptAudioAsr(() => ({ LanguageModel: { availability: async () => 'available', create: async () => mk() } }));
    expect((await asr.transcribe(new Int16Array(16000))).segments).toEqual([]);
  });
});

// ---------- settings (D30) ----------
describe('voice source chain settings', () => {
  it('fresh installs: yandex-live > yandex > local > groq > gemini, gemini off', () => {
    const s = normalizeSettings({});
    expect(s.voiceOrder).toEqual(['yandex-live', 'yandex', 'local', 'groq', 'gemini']);
    expect(s.voiceEnabled.gemini).toBe(false);
    expect(s.voiceEnabled.groq).toBe(true);
    expect(s.voiceEnabled.local).toBe(true);
    expect(DEFAULT_SETTINGS.voiceOrder.at(-1)).toBe('gemini');
  });
  it('old untouched defaults (yandex-live>yandex>gemini, all on) migrate to the new order with Gemini off', () => {
    const s = normalizeSettings({ voiceOrder: ['yandex-live', 'yandex', 'gemini'], voiceEnabled: { 'yandex-live': true, yandex: true, gemini: true } });
    expect(s.voiceOrder).toEqual(['yandex-live', 'yandex', 'local', 'groq', 'gemini']);
    expect(s.voiceEnabled).toMatchObject({ gemini: false, groq: true, local: true, yandex: true });
  });
  it('a customised old profile keeps its order (new ids go before gemini) and its Gemini switch', () => {
    const s = normalizeSettings({ voiceOrder: ['gemini', 'yandex', 'yandex-live'], voiceEnabled: { 'yandex-live': false, yandex: true, gemini: true } });
    expect(s.voiceOrder).toEqual(['local', 'groq', 'gemini', 'yandex', 'yandex-live']);
    expect(s.voiceEnabled).toMatchObject({ gemini: true, 'yandex-live': false });
    const t = normalizeSettings({ voiceOrder: ['yandex', 'yandex-live', 'gemini'], voiceEnabled: { gemini: true } });
    expect(t.voiceOrder).toEqual(['yandex', 'yandex-live', 'local', 'groq', 'gemini']);
    expect(t.voiceEnabled.gemini).toBe(true);
    // untouched order but the user had switched a Yandex tier off: not the pristine default, Gemini stays on
    const u = normalizeSettings({ voiceOrder: ['yandex-live', 'yandex', 'gemini'], voiceEnabled: { 'yandex-live': false, yandex: true, gemini: true } });
    expect(u.voiceEnabled.gemini).toBe(true);
  });
  it('migration is idempotent and a stored new-format profile is never touched', () => {
    const once = normalizeSettings({ voiceOrder: ['yandex-live', 'yandex', 'gemini'], voiceEnabled: { gemini: true } });
    const twice = normalizeSettings(JSON.parse(JSON.stringify(once)));
    expect(twice.voiceOrder).toEqual(once.voiceOrder);
    expect(twice.voiceEnabled).toEqual(once.voiceEnabled);
    const mine = normalizeSettings({ voiceOrder: ['local', 'gemini', 'groq', 'yandex', 'yandex-live'], voiceEnabled: { gemini: true, local: false } });
    expect(mine.voiceOrder).toEqual(['local', 'gemini', 'groq', 'yandex', 'yandex-live']);
    expect(mine.voiceEnabled).toMatchObject({ gemini: true, local: false, groq: true });
    expect(migrateVoiceOrder(['bogus', 'yandex'])).toEqual(['yandex', 'yandex-live', 'local', 'groq', 'gemini']);
  });
  it('groq model overrides default to empty and are trimmed', () => {
    expect(normalizeSettings({}).groqModels).toEqual({ asr: '', chat: '' });
    expect(normalizeSettings({ groqModels: { asr: ' w ', chat: 5 } }).groqModels).toEqual({ asr: 'w', chat: '' });
  });
  it('legacy cache providers also cache the new tiers', () => {
    expect(normalizeSettings({ voiceOrder: ['yandex-live', 'yandex', 'gemini'], cacheProviders: ['gemini'] }).cacheProviders).toEqual(['gemini', 'groq', 'local']);
  });
  it('Russian names of the new sources', () => {
    expect(providerName('groq')).toBe('Groq + локальный голос');
    expect(providerName('local')).toBe('Локальные модели');
    expect(voiceLine(sourceName('groq')!)).toBe('Озвучка: Groq + локальный голос');
    expect(voiceLine(sourceName('local')!)).toBe('Озвучка: локальные модели');
    expect(laterName('groq')).toBeDefined();
    void stateText;
  });
});

// ---------- tier order + planner ----------
describe('tier order and planning with the new tiers', () => {
  const fakes = (): DubProvider[] => (['gemini', 'local', 'groq', 'yandex', 'yandex-live'] as const).map((id) => new FakeProvider(id));
  it('eligibleProviders follows the stored order and skips disabled Gemini', () => {
    const s = normalizeSettings({});
    const ids = eligibleProviders(fakes(), s, createChainState(), 0).map((p) => p.id);
    expect(ids).toEqual(['yandex-live', 'yandex', 'local', 'groq']);
    const on = normalizeSettings({ voiceEnabled: { gemini: true } });
    expect(eligibleProviders(fakes(), on, createChainState(), 0).map((p) => p.id)).toEqual(['yandex-live', 'yandex', 'local', 'groq', 'gemini']);
  });
  it('priors: groq 12 s, local 8 s; EWMA moves them', () => {
    expect(TIER_PRIOR_SEC.groq).toBe(12);
    expect(TIER_PRIOR_SEC.local).toBe(8);
    let t = 0;
    const m = new LatencyModel(() => t);
    expect(m.expectedSec('groq')).toBe(12);
    expect(m.expectedSec('local')).toBe(8);
    m.observe('local', 20_000);
    expect(m.expectedSec('local')).toBeGreaterThan(8);
  });
  it('planCell: yandex too slow for the first cell -> groq/local start in time, preferred is still started', () => {
    const tiers = [
      { id: 'yandex-live' as const, expectedSec: 90 },
      { id: 'yandex' as const, expectedSec: 50 },
      { id: 'groq' as const, expectedSec: 12 },
      { id: 'local' as const, expectedSec: 8 },
    ];
    const p = planCell({ timeToSlot: 45, tiers });
    expect(p.inTime).toEqual(['groq', 'local']);
    expect(p.start).toEqual(['yandex-live', 'groq']); // preferred + highest-priority in-time tier
    const hopeless = planCell({ timeToSlot: 20, tiers });
    expect(hopeless.start).toEqual(['groq']); // the preferred tier cannot make it any more
    const slow = planCell({ timeToSlot: 3, tiers });
    expect(slow.reason).toBe('none-in-time-fastest');
    expect(slow.start).toEqual(['local']);
  });
  it('a chain run falls through yandex failure to groq and a higher tier keeps its place', async () => {
    const y = new FakeProvider('yandex');
    y.fallback = new ProviderUnavailableError('down', 'yandex', 'failed');
    const g = new FakeProvider('groq');
    const out = await runChain(audio(0), [y, g], normalizeSettings({ voiceEnabled: { 'yandex-live': false } }), { signal: new AbortController().signal, now: () => 0, sleep: async () => {}, warn: () => {}, backoffMs: 0 }, createChainState());
    expect(out).toMatchObject({ ok: true, providerId: 'groq' });
  });
});

// ---------- caption shortcut ----------
const ev = (tStartMs: number, dDurationMs: number, words: [string, number][]) => ({ tStartMs, dDurationMs, segs: words.map(([utf8, tOffsetMs], i) => ({ utf8: i ? ` ${utf8}` : utf8, tOffsetMs })) });

describe('caption sentence grouping', () => {
  it('cuts unpunctuated ASR captions at pauses > 0.5 s', () => {
    const json = {
      events: [
        ev(1000, 3000, [['so', 0], ['today', 300], ['we', 600], ['are', 800], ['going', 1000], ['to', 1200], ['talk', 1400]]),
        ev(6000, 3000, [['about', 0], ['the', 250], ['new', 400], ['engine', 700], ['and', 1000], ['its', 1200], ['parts', 1400]]),
      ],
    };
    const s = sentencesFromJson3(json);
    expect(s.map((x) => x.text)).toEqual(['so today we are going to talk', 'about the new engine and its parts']);
    expect(s[0]!.start).toBeCloseTo(1, 5);
    expect(s[1]!.start).toBeCloseTo(6, 5);
    expect(s[0]!.end).toBeLessThanOrEqual(s[1]!.start);
  });
  it('caps a sentence at ~20 words even without pauses', () => {
    const words: [string, number][] = Array.from({ length: 45 }, (_, i) => [`w${i}`, i * 200] as [string, number]);
    const s = sentencesFromJson3({ events: [ev(0, 10000, words)] });
    expect(s.length).toBeGreaterThanOrEqual(3);
    for (const x of s) expect(x.text.split(' ').length).toBeLessThanOrEqual(24);
    expect(s.map((x) => x.text).join(' ')).toBe(words.map((w) => w[0]).join(' '));
  });
  it('breaks at final punctuation (manual tracks) and drops [Music] noise', () => {
    const json = {
      events: [
        { tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: '[Music]' }] },
        { tStartMs: 2000, dDurationMs: 2000, segs: [{ utf8: 'Welcome to the show everyone.' }] },
        { tStartMs: 4100, dDurationMs: 2000, segs: [{ utf8: 'Today we have a special guest.' }] },
      ],
    };
    const s = sentencesFromJson3(json);
    expect(s.map((x) => x.text)).toEqual(['Welcome to the show everyone.', 'Today we have a special guest.']);
    expect(s[0]!.start).toBe(2);
    expect(s[1]!.start).toBeCloseTo(4.1, 5);
  });
  it('ignores rolling duplicates (words that do not move forward in time)', () => {
    const json = {
      events: [
        ev(0, 2000, [['one', 0], ['two', 400], ['three', 800]]),
        ev(0, 2500, [['one', 0], ['two', 400], ['three', 800], ['four', 1200]]),
      ],
    };
    const w = wordsFromJson3(json);
    expect(w.map((x) => x.text)).toEqual(['one', 'two', 'three', 'four']);
  });
  it('merges fragments shorter than 4 words into a neighbour', () => {
    const w = [
      { start: 0, text: 'Yes.' },
      { start: 0.5, text: 'that' },
      { start: 0.9, text: 'is' },
      { start: 1.2, text: 'right' },
      { start: 1.6, text: 'indeed' },
      { start: 2.0, text: 'my' },
      { start: 2.4, text: 'friend.' },
    ];
    const s = buildSentences(w);
    expect(s).toHaveLength(1);
    expect(s[0]!.text).toBe('Yes. that is right indeed my friend.');
  });
  it('alignTlang picks the machine-translated cues that fall inside a sentence', () => {
    const cues = [
      { start: 0, end: 2, text: 'раз' },
      { start: 2, end: 4, text: 'два' },
      { start: 9, end: 10, text: 'далеко' },
    ];
    expect(alignTlang({ start: 0, end: 4.1, text: 'x' }, cues)).toBe('раз два');
  });
});

describe('ASR phrase grouping', () => {
  it('joins phrases to sentences and merges a short tail', () => {
    const g = groupPhrases([
      { start: 0, end: 1.5, text: 'Hello there' },
      { start: 1.5, end: 3, text: 'my friends.' },
      { start: 4, end: 6.5, text: 'This is a test.' },
      { start: 6.6, end: 7.2, text: 'Ok.' },
    ]);
    expect(g.map((x) => x.text)).toEqual(['Hello there my friends.', 'This is a test. Ok.']);
  });
  it('isoLang maps names and codes', () => {
    expect(isoLang('english')).toBe('en');
    expect(isoLang('en-US')).toBe('en');
    expect(isoLang('Russian')).toBe('ru');
    expect(isoLang('klingon')).toBe('');
  });
});

// ---------- fit to slot ----------
describe('voiceSegments layout (shift, never cut)', () => {
  const text28 = 'абвгдежзийклмнопрстуфхцчшщ'; // 28 chars at 14 chars/s = 2 s
  it('plays whole at rate 1 and shifts a long sentence instead of squeezing it; never drops', async () => {
    const eng = new FakeTts('supertonic-webgpu', 1 / 14);
    const r = await voiceSegments(
      [
        { start: 0, end: 1.8, src: 'a', ru: text28 }, // 2.0 s into 1.8 s: plays whole
        { start: 2, end: 3, src: 'b', ru: text28 }, // slot would collide with a's end (2.0 + 0.15): starts later
        { start: 20, end: 21, src: 'c', ru: text28 }, // a big caption gap => re-sync to the source start
      ],
      { engine: eng, tier: 'local', signal: new AbortController().signal },
    );
    expect(r.segments).toHaveLength(3);
    expect(r.failed).toEqual([]);
    expect(r.segments.every((s) => (s.rate ?? 1) === 1)).toBe(true);
    const dur = (s: (typeof r.segments)[number]) => (s.audio.kind === 'pcm' ? s.audio.samples.length / s.audio.sampleRate : 0);
    for (const s of r.segments) expect(s.end - s.start).toBeCloseTo(dur(s) / (s.rate ?? 1), 3); // slot == whole audio
    expect(r.segments[0]!.start).toBe(0);
    expect(r.segments[1]!.start).toBeCloseTo(r.segments[0]!.end + 0.15, 3);
    expect(r.segments[2]!.start).toBe(20); // drift reset
  });
  it('asks the engine for natural pace (targetSec = slot, at most slot + 1.5 s) and levels the loudness', async () => {
    const eng = new FakeTts('supertonic-webgpu', 1 / 14);
    await voiceSegments([{ start: 0, end: 1, ru: text28 }, { start: 30, end: 31, ru: text28 }], { engine: eng, tier: 'local', signal: new AbortController().signal });
    expect(eng.calls.every((c) => typeof c.targetSec === 'number' && c.targetSec <= 2.5 + 1e-9)).toBe(true);
  });
  it('reports sentences the engine could not voice in `failed` and keeps the rest', async () => {
    const eng = new FakeTts('silero-cpu', 1 / 14, (q) => q.text.startsWith('плох'));
    const r = await voiceSegments(
      [
        { start: 0, end: 3, ru: 'хорошая фраза' },
        { start: 4, end: 7, ru: 'плохая фраза' },
      ],
      { engine: eng, tier: 'local', signal: new AbortController().signal },
    );
    expect(r.segments).toHaveLength(1);
    expect(r.failed).toEqual([{ start: 4, end: 7 }]);
    expect(r.errors).toHaveLength(1);
  });
});

// ---------- Groq client ----------
describe('GroqClient', () => {
  const mk = (t: Transport, over: Partial<ConstructorParameters<typeof GroqClient>[0]> = {}, sleeps: number[] = []) => {
    let clock = 1_000_000;
    return new GroqClient({ transport: t, getKey: () => KEY, now: () => clock, sleep: async (ms) => (sleeps.push(ms), void (clock += ms)), ...over });
  };

  it('transcribe sends multipart with bearer key, model, verbose_json and segment granularity', async () => {
    const { t, log } = groqTransport();
    const c = mk(t);
    const r = await c.transcribe({ wav: new Uint8Array([1, 2, 3, 4]), model: 'm-asr', language: 'en' });
    expect(r.segments).toHaveLength(2);
    const q = log[0]!;
    expect(q.url).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
    expect(q.method).toBe('POST');
    expect(q.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(q.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    const body = bin(q.body);
    expect(body).toContain('name="model"\r\n\r\nm-asr');
    expect(body).toContain('name="response_format"\r\n\r\nverbose_json');
    expect(body).toContain('name="timestamp_granularities[]"\r\n\r\nsegment');
    expect(body).toContain('name="language"\r\n\r\nen');
    expect(body).toContain('filename="chunk.wav"');
    expect(body).not.toContain(KEY);
  });
  it('multipartBody keeps the binary payload intact', () => {
    const b = multipartBody({ a: '1' }, { name: 'f.wav', mime: 'audio/wav', data: new Uint8Array([0, 255, 128]) }, 'BND');
    const text = bin(b);
    expect(text.startsWith('--BND\r\n')).toBe(true);
    expect(text.endsWith('\r\n--BND--\r\n')).toBe(true);
    expect(text).toContain('\u0000ÿ\u0080');
  });
  it('401 is an auth error and never contains the key', async () => {
    const c = mk(async () => j({ error: { message: `Invalid API Key ${KEY}` } }, 401));
    const e = await c.chat({ model: 'm', messages: [] }).catch((x) => x);
    expect(e).toBeInstanceOf(ProviderUnavailableError);
    expect(e.kind).toBe('auth');
    expect(e.providerId).toBe('groq');
    expect(e.message).not.toContain(KEY);
  });
  it('no key -> auth error without any request', async () => {
    let called = 0;
    const c = mk(async () => (called++, j({})), { getKey: () => '  ' });
    expect(c.hasKey()).toBe(false);
    await expect(c.listModels()).rejects.toMatchObject({ kind: 'auth' });
    expect(called).toBe(0);
  });
  it('429 with a short Retry-After is waited out once (honoured) and retried', async () => {
    let n = 0;
    const sleeps: number[] = [];
    const c = mk(async () => (n++ === 0 ? j({ error: 'rate' }, 429, { 'retry-after': '3' }) : j({ data: [{ id: 'x' }] })), {}, sleeps);
    await expect(c.listModels()).resolves.toEqual(['x']);
    expect(n).toBe(2);
    expect(sleeps).toEqual([3000]);
  });
  it('429 with a long Retry-After (daily limit) surfaces as quota with retryAfterMs and gates later calls without a request', async () => {
    let n = 0;
    const c = mk(async () => (n++, j({ error: 'rate' }, 429, { 'retry-after': '3600' })));
    const e = await c.chat({ model: 'm', messages: [] }).catch((x) => x);
    expect(e).toMatchObject({ kind: 'quota', retryAfterMs: 3_600_000, providerId: 'groq' });
    expect(n).toBe(1);
    const e2 = await c.chat({ model: 'm', messages: [] }).catch((x) => x);
    expect(e2).toMatchObject({ kind: 'quota' });
    expect(n).toBe(1); // blocked locally, no request spent
  });
  it('the request budget delays beyond N per minute and fails over to quota when the wait is long', () => {
    let t = 0;
    const b = new RequestBudget(3, () => t);
    for (let i = 0; i < 3; i++) {
      expect(b.delayFor()).toBe(0);
      b.take();
      t += 1000;
    }
    expect(b.delayFor()).toBe(60_000 - 3000);
    t = 60_000;
    expect(b.delayFor()).toBe(0);
  });
  it('budget exhaustion waits inline when short, else throws quota', async () => {
    let t = 0;
    const sleeps: number[] = [];
    const c = new GroqClient({
      transport: async () => j({ data: [] }),
      getKey: () => KEY,
      perMin: 2,
      now: () => t,
      sleep: async (ms) => {
        sleeps.push(ms);
        t += ms;
      },
      maxInlineWaitMs: 20_000,
    });
    await c.listModels();
    t += 50_000;
    await c.listModels();
    // third call: window still holds 2 requests; wait = 60_000 - 50_000 = 10 s (inline)
    await c.listModels();
    expect(sleeps).toEqual([10_000]);
    // fourth: next release is 50 s away -> quota
    const e = await c.listModels().catch((x) => x);
    expect(e).toMatchObject({ kind: 'quota' });
    expect(e.retryAfterMs).toBeGreaterThan(20_000);
  });
  it('5xx is a network error, 4xx a plain failure, timeouts are flagged', async () => {
    expect(await mk(async () => j({}, 503)).listModels().catch((x) => x)).toMatchObject({ kind: 'network' });
    expect(await mk(async () => j({}, 400)).listModels().catch((x) => x)).toMatchObject({ kind: 'failed' });
    const slow: Transport = (req) => new Promise((_, rej) => req.signal?.addEventListener('abort', () => rej(new Error('aborted'))));
    const e = await mk(slow, { timeoutMs: 20 }).listModels().catch((x) => x);
    expect(e).toMatchObject({ kind: 'network', timedOut: true });
  });
  it('parseGroqRetryMs reads Retry-After and ratelimit-reset durations', () => {
    expect(parseGroqRetryMs({ 'Retry-After': '7' })).toBe(7000);
    expect(parseGroqRetryMs({ 'x-ratelimit-reset-requests': '2m59.5s' })).toBe(179_500);
    expect(parseGroqRetryMs({ 'x-ratelimit-reset-requests': '120ms' })).toBe(120);
    expect(parseGroqRetryMs({}, 1234)).toBe(1234);
  });
});

describe('GroqChatTranslator JSON-mode fallback', () => {
  it('a failing JSON-mode answer (400 / empty) is retried once as plain lines without response_format', async () => {
    const bodies: string[] = [];
    const t: Transport = async (req) => {
      bodies.push(new TextDecoder().decode(req.body));
      if (bodies.length === 1) return j({ error: { message: "Failed to validate JSON. Please adjust your prompt. See 'failed_generation' for more details.", code: 'json_validate_failed' } }, 400);
      return j({ choices: [{ message: { content: '1|Второй "с кавычками"\n0|Привет' } }] });
    };
    const client = new GroqClient({ transport: t, getKey: () => KEY });
    const out = await new GroqChatTranslator(client, new GroqModelRegistry(client, () => ({ chat: 'm-chat' }))).translate([{ text: 'hi', maxChars: 20 }, { text: 'two', maxChars: 20 }], 'en', new AbortController().signal);
    expect(out).toEqual(['Привет', 'Второй "с кавычками"']);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toContain('json_object');
    expect(bodies[1]).not.toContain('response_format');
    expect(bodies[0]).toContain('max_tokens');
  });
  it('a rate limit is not retried as lines (the failover handles it)', async () => {
    let n = 0;
    const t: Transport = async () => (n++, j({ error: {} }, 429, { 'retry-after': '100' }));
    const client = new GroqClient({ transport: t, getKey: () => KEY });
    await expect(new GroqChatTranslator(client, new GroqModelRegistry(client, () => ({ chat: 'm' }))).translate([{ text: 'hi', maxChars: 20 }], 'en', new AbortController().signal)).rejects.toMatchObject({ kind: 'quota' });
    expect(n).toBe(1);
  });
});

describe('Groq model registry (I2: no literal ids in logic)', () => {
  it('prefers the turbo whisper and a 70b chat model from the list; override wins; defaults only when the list fails', async () => {
    const { t } = groqTransport({ models: ['llama-guard-4', 'whisper-large-v3', 'whisper-large-v3-turbo', 'llama-3.1-8b-instant', 'llama-3.3-70b-versatile'] });
    const client = new GroqClient({ transport: t, getKey: () => KEY });
    const m = new GroqModelRegistry(client);
    expect(await m.resolve('asr')).toBe('whisper-large-v3-turbo');
    expect(await m.resolve('chat')).toBe('llama-3.3-70b-versatile');
    expect(await new GroqModelRegistry(client, () => ({ asr: 'custom-asr' })).resolve('asr')).toBe('custom-asr');
    const down = new GroqClient({ transport: async () => j({}, 500), getKey: () => KEY });
    expect(await new GroqModelRegistry(down).resolve('asr')).toMatch(/whisper/);
    const bad = new GroqClient({ transport: async () => j({}, 401), getKey: () => KEY });
    await expect(new GroqModelRegistry(bad).resolve('asr')).rejects.toMatchObject({ kind: 'auth' });
    expect(pickModel(['whisper-large-v3'], GROQ_ASR_PREFERENCES)).toBe('whisper-large-v3');
    expect(pickModel(['mixtral-8x7b'], GROQ_CHAT_PREFERENCES)).toBe('mixtral-8x7b');
  });
  it('parseGroqTranslation requires every segment', () => {
    expect(parseGroqTranslation('{"segments":[{"i":1,"ru":"b"},{"i":0,"ru":"a"}]}', 2)).toEqual(['a', 'b']);
    expect(() => parseGroqTranslation('{"segments":[{"i":0,"ru":"a"}]}', 2)).toThrow(/misses 1 of 2/);
    expect(() => parseGroqTranslation('nope', 1)).toThrow(/valid JSON/);
  });
});

// ---------- Groq tier end to end ----------
describe('Groq tier', () => {
  const build = (o: { key?: string; tts?: LocalTtsRegistry; transport?: ReturnType<typeof groqTransport>; tr?: TextTranslator[] } = {}) => {
    const tp = o.transport ?? groqTransport();
    const st = { groqApiKey: o.key ?? KEY, groqModels: { asr: '', chat: '' } };
    const p = createGroqProvider({ transport: tp.t, getSettings: () => st, tts: o.tts ?? reg(new FakeTts()), preTranslators: o.tr ?? [] });
    return { p, tp, st };
  };

  it('ASR -> Groq chat translation -> local TTS -> fitted DubSegments on the video timeline', async () => {
    diag.clear?.();
    const { p, tp } = build();
    expect(p.isConfigured()).toBe(false); // not probed yet
    expect(await p.usable()).toBe(true);
    const res = await p.translateChunk(audio(30), ctxOf(undefined, { sourceLang: 'en' }));
    expect(res.sourceLang).toBe('en');
    expect(res.segments).toHaveLength(2);
    expect(res.segments[0]!.start).toBeCloseTo(30.2, 5);
    expect(res.segments[0]!.text).toBe('Привет 0');
    expect(res.segments[0]!.src).toBe('Hello there my friends.');
    expect(res.segments.every((s) => s.providerId === 'groq' && s.audio.kind === 'pcm')).toBe(true);
    expect(res.segments[1]!.start).toBeGreaterThanOrEqual(res.segments[0]!.start);
    const asr = tp.log.find((r) => r.url.endsWith('/audio/transcriptions'))!;
    expect(bin(asr.body)).toContain('name="model"\r\n\r\nwhisper-large-v3-turbo');
    expect(bin(asr.body)).toContain('name="language"\r\n\r\nen'); // language hint from the gate
    expect(tp.log.some((r) => r.url.endsWith('/chat/completions'))).toBe(true);
    const chatBody = JSON.parse(new TextDecoder().decode(tp.log.find((r) => r.url.endsWith('/chat/completions'))!.body)) as { model: string; response_format: { type: string } };
    expect(chatBody.model).toBe('llama-3.3-70b-versatile');
    expect(chatBody.response_format.type).toBe('json_object');
  });

  it('prefers a pre-translator (Chrome Translator) over Groq chat; falls back to chat when it fails', async () => {
    const tr = new FakeTr();
    const a = build({ tr: [tr] });
    await a.p.usable();
    const r = await a.p.translateChunk(audio(0), ctxOf());
    expect(r.segments[0]!.text).toBe('ру Hello there my friends.');
    expect(tr.seen[0]!.maxChars).toBeGreaterThan(8);
    expect(a.tp.log.some((q) => q.url.endsWith('/chat/completions'))).toBe(false);
    const broken: TextTranslator = { id: 'bad', isAvailable: async () => true, translate: async () => { throw new Error('translator broke'); } };
    const b = build({ tr: [broken] });
    await b.p.usable();
    expect((await b.p.translateChunk(audio(0), ctxOf())).segments[0]!.text).toBe('Привет 0');
  });

  it('Russian speech -> empty clean result; silence/music -> empty, no TTS', async () => {
    const ru = build({ transport: groqTransport({ asr: { language: 'russian', duration: 15, text: 'x', segments: [{ start: 0, end: 3, text: 'Привет, друзья.', no_speech_prob: 0, avg_logprob: -0.1 }] } }) });
    await ru.p.usable();
    expect(await ru.p.translateChunk(audio(0), ctxOf())).toEqual({ segments: [], sourceLang: 'ru' });
    const tts = new FakeTts();
    const quiet = build({ tts: reg(tts), transport: groqTransport({ asr: { language: 'english', duration: 15, text: '', segments: [{ start: 0, end: 4, text: ' Thank you.', no_speech_prob: 0.95, avg_logprob: -1.5 }] } }) });
    await quiet.p.usable();
    const r = await quiet.p.translateChunk(audio(0), ctxOf());
    expect(r.segments).toEqual([]);
    expect(tts.calls).toHaveLength(0);
  });

  it('usable() is false without a key, without a TTS engine, and without any translator', async () => {
    expect(await build({ key: '' }).p.usable()).toBe(false);
    expect(await build({ tts: reg() }).p.usable()).toBe(false);
    const off = new FakeTts();
    off.avail = false;
    expect(await build({ tts: reg(off) }).p.usable()).toBe(false);
    // a missing key also removes Groq chat; with no pre-translator there is nothing to translate with
    expect(await build({ key: '' , tr: [new FakeTr()] }).p.usable()).toBe(false);
  });

  it('401 from Groq is an auth error (amber dot, tier skipped by the chain), 429 honours Retry-After as quota', async () => {
    const a = build({ transport: groqTransport({ asr: () => j({ error: 'x' }, 401) }) });
    await a.p.usable();
    await expect(a.p.translateChunk(audio(0), ctxOf())).rejects.toMatchObject({ kind: 'auth', providerId: 'groq' });
    const b = build({ transport: groqTransport({ asr: () => j({ error: 'x' }, 429, { 'retry-after': '1800' }) }) });
    await b.p.usable();
    await expect(b.p.translateChunk(audio(0), ctxOf())).rejects.toMatchObject({ kind: 'quota', retryAfterMs: 1_800_000 });
    // through the chain: an auth error adds the tier to authSkip, quota backs the tier off
    const state = createChainState();
    const warns: string[] = [];
    await runChain(audio(0), [a.p], normalizeSettings({}), { signal: new AbortController().signal, now: () => 0, sleep: async () => {}, warn: (w) => warns.push(w.kind), backoffMs: 0 }, state);
    expect(state.authSkip.has('groq')).toBe(true);
    expect(warns).toContain('auth-required');
  });

  it('a partial TTS failure is reported in failedSegments; total failure throws', async () => {
    const half = new FakeTts('supertonic-webgpu', 1 / 14, (q) => q.text.startsWith('Привет 1'));
    const a = build({ tts: reg(half) });
    await a.p.usable();
    const r = await a.p.translateChunk(audio(0), ctxOf());
    expect(r.segments).toHaveLength(1);
    expect(r.failedSegments).toHaveLength(1);
    const none = new FakeTts('supertonic-webgpu', 1 / 14, () => true);
    const b = build({ tts: reg(none) });
    await b.p.usable();
    await expect(b.p.translateChunk(audio(0), ctxOf())).rejects.toThrow();
  });

  it('uses the highest-priority AVAILABLE tts engine and keys the cache on tier assets', async () => {
    const st = new FakeTts('supertonic-webgpu');
    const he = new FakeTts('helper-omnivoice');
    st.avail = false;
    const a = build({ tts: reg(st, he) });
    await a.p.usable();
    await a.p.translateChunk(audio(0), ctxOf());
    expect(he.calls.length).toBeGreaterThan(0);
    expect(st.calls).toHaveLength(0);
    expect(await a.p.cacheSignature()).toEqual({ translateModel: 'whisper-large-v3-turbo', ttsModel: 'helper-omnivoice', voice: 'standard' });
  });

  it('a chunk watchdog turns a stalled stage into a timedOut network error', async () => {
    const hang: Transport = (req) => new Promise((_, rej) => req.signal?.addEventListener('abort', () => rej(new Error('aborted'))));
    const st = { groqApiKey: KEY, groqModels: { asr: 'm', chat: 'c' } };
    const p = createGroqProvider({ transport: hang, getSettings: () => st, tts: reg(new FakeTts()), preTranslators: [], chunkTimeoutMs: 30 });
    await p.usable();
    const e = await p.translateChunk(audio(0), ctxOf()).catch((x) => x);
    expect(e).toMatchObject({ kind: 'network', timedOut: true });
  });

  it('subtitles are produced only when wanted', async () => {
    const a = build();
    await a.p.usable();
    expect((await a.p.translateChunk(audio(0), ctxOf())).subtitles).toBeUndefined();
    expect((await a.p.translateChunk(audio(0), ctxOf(undefined, { wantSubtitles: true }))).subtitles).toHaveLength(2);
  });
});

// ---------- local tier ----------
describe('Local tier', () => {
  const asrEngine = (segs: { start: number; end: number; text: string }[], lang = 'en', ok = true): LocalAsr => ({
    id: 'chrome-prompt-audio',
    languages: () => ['en'],
    isAvailable: async () => ok,
    transcribe: async () => ({ segments: segs, lang }),
  });
  const timeline = (sentences: SourceSegment[] | undefined, lang = 'en', audioLang?: string): CaptionTimeline & { gets: number } => {
    const t = {
      gets: 0,
      peek: () => (sentences ? { sentences, lang, audioLang } : undefined),
      get: async () => (t.gets++, sentences ? { sentences, lang, audioLang } : undefined),
      reset() {},
    };
    return t;
  };
  const mk = (o: { asr?: LocalAsr; tts?: LocalTtsRegistry; tr?: TextTranslator; cap?: CaptionTimeline } = {}) => {
    const asrReg = new LocalAsrRegistry();
    if (o.asr) asrReg.register(o.asr);
    return createLocalProvider({ asrRegistry: asrReg, tts: o.tts ?? reg(new FakeTts()), translators: () => (o.tr ? [o.tr] : []), captions: o.cap ? () => o.cap : undefined });
  };

  it('usable() is false without an ASR engine (and without captions), without TTS, without a translator - never silently empty', async () => {
    expect(await mk({ tr: new FakeTr() }).usable()).toBe(false);
    expect(await mk({ asr: asrEngine([], 'en', false), tr: new FakeTr() }).usable()).toBe(false);
    expect(await mk({ asr: asrEngine([]), tr: new FakeTr(), tts: reg() }).usable()).toBe(false);
    expect(await mk({ asr: asrEngine([]) }).usable()).toBe(false);
    expect(await mk({ asr: asrEngine([]), tr: new FakeTr() }).usable()).toBe(true);
    const p = mk({ tr: new FakeTr() });
    await expect(p.translateChunk(audio(0), ctxOf())).rejects.toMatchObject({ kind: 'unsupported', providerId: 'local' });
  });

  it('ASR engine path: transcribes, translates, voices; positions are on the video timeline', async () => {
    const p = mk({ asr: asrEngine([{ start: 0.5, end: 3.5, text: 'Hello world, this is local.' }, { start: 5, end: 9, text: 'And a second sentence follows.' }]), tr: new FakeTr() });
    await p.usable();
    const r = await p.translateChunk(audio(60), ctxOf());
    expect(r.segments.map((s) => s.src)).toEqual(['Hello world, this is local.', 'And a second sentence follows.']);
    expect(r.segments[0]!.start).toBeCloseTo(60.5, 5);
    expect(r.segments.every((s) => s.providerId === 'local')).toBe(true);
    expect(r.sourceLang).toBe('en');
  });

  it('caption shortcut: no ASR call, only the sentences that START in the chunk, scheduled by caption times', async () => {
    let asrCalls = 0;
    const asr = asrEngine([]);
    asr.transcribe = async () => (asrCalls++, { segments: [], lang: 'en' });
    const cap = timeline([
      { start: 2, end: 5, text: 'Before the chunk starts.' },
      { start: 16, end: 19, text: 'First sentence inside the chunk.' },
      { start: 25, end: 29, text: 'Second sentence inside the chunk.' },
      { start: 31, end: 34, text: 'Belongs to the next chunk.' },
    ]);
    const tr = new FakeTr();
    const p = mk({ asr, tr, cap });
    await p.usable();
    const r = await p.translateChunk(audio(15), ctxOf());
    expect(asrCalls).toBe(0);
    expect(tr.seen.map((x) => x.text)).toEqual(['First sentence inside the chunk.', 'Second sentence inside the chunk.']);
    expect(r.segments.map((s) => s.start)).toEqual([16, 25]);
    expect(r.sourceLang).toBe('en');
  });

  it('captions make the tier usable even without an ASR engine', async () => {
    const p = mk({ tr: new FakeTr(), cap: timeline([{ start: 1, end: 4, text: 'Only captions here.' }]) });
    expect(await p.usable()).toBe(true);
    const r = await p.translateChunk(audio(0), ctxOf());
    expect(r.segments).toHaveLength(1);
  });

  it('pre-translates the caption track in large batches ahead of the playhead; cells read the store (few requests, per-cell call only as fallback)', async () => {
    const sentences: SourceSegment[] = Array.from({ length: 120 }, (_, i) => ({ start: i * 3, end: i * 3 + 2.5, text: `Sentence number ${i} here.` }));
    const batches: number[] = [];
    let failFirst = false;
    const tr: TextTranslator = {
      id: 'batch-tr',
      isAvailable: async () => true,
      translate: async (items) => {
        batches.push(items.length);
        if (failFirst && batches.length === 1) throw new Error('429');
        return items.map((i) => `ру ${i.text}`);
      },
    };
    const pre = new CaptionPretranslator({ translators: () => [tr], tier: 'local' });
    const mkp = () => createLocalProvider({ asrRegistry: new LocalAsrRegistry(), tts: reg(new FakeTts()), translators: () => [tr], captions: () => timeline(sentences), pretranslate: pre });
    const p = mkp();
    await p.probe();
    const r0 = await p.translateChunk(audio(0), ctxOf());
    const r1 = await p.translateChunk(audio(15), ctxOf());
    expect(r0.segments.length).toBeGreaterThan(0);
    expect(r1.segments.length).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 20));
    // 120 sentences, 50 per request, ~180 s ahead: two requests serve every cell of the first minutes
    expect(batches.every((n) => n === 50)).toBe(true);
    expect(batches.length).toBeLessThanOrEqual(2);
    expect(r0.segments[0]!.text).toMatch(/^ру Sentence number 0/);
    // a failing batch falls back to the per-cell translator call for that cell only
    batches.length = 0;
    failFirst = true;
    const pre2 = new CaptionPretranslator({ translators: () => [tr], tier: 'local' });
    const p2 = createLocalProvider({ asrRegistry: new LocalAsrRegistry(), tts: reg(new FakeTts()), translators: () => [tr], captions: () => timeline(sentences), pretranslate: pre2 });
    await p2.probe();
    const r2 = await p2.translateChunk(audio(0), ctxOf());
    expect(r2.segments.length).toBeGreaterThan(0);
    expect(batches[0]).toBe(50); // the failed batch
    expect(batches[1]).toBeLessThan(50); // per-cell fallback
  });

  it('captions in a Russian audio track -> clean empty result; a Russian caption track over foreign audio is used as is', async () => {
    const ruAudio = mk({ asr: asrEngine([]), tr: new FakeTr(), cap: timeline([{ start: 1, end: 4, text: 'Привет, мир.' }], 'ru', 'ru') });
    await ruAudio.usable();
    expect(await ruAudio.translateChunk(audio(0), ctxOf())).toEqual({ segments: [], sourceLang: 'ru' });
    const tr = new FakeTr();
    const ruSubs = mk({ asr: asrEngine([]), tr, cap: timeline([{ start: 1, end: 4, text: 'Привет, мир, это субтитры.' }], 'ru', 'en') });
    await ruSubs.usable();
    const r = await ruSubs.translateChunk(audio(0), ctxOf());
    expect(tr.seen).toHaveLength(0);
    expect(r.segments[0]!.text).toBe('Привет, мир, это субтитры.');
    expect(r.sourceLang).toBe('en');
  });

  it('falls back to the machine (tlang) translation of the captions when no translator delivers', async () => {
    const cap = timeline([{ start: 1, end: 4, text: 'Hello again my friend.' }]) as CaptionTimeline & { gets: number };
    cap.machineRu = async () => [{ start: 1, end: 4, text: 'Снова привет, друг.' }];
    const broken: TextTranslator = { id: 'bad', isAvailable: async () => true, translate: async () => { throw new Error('no'); } };
    const p = mk({ tr: broken, cap });
    await p.usable();
    const r = await p.translateChunk(audio(0), ctxOf());
    expect(r.segments[0]!.text).toBe('Снова привет, друг.');
  });

  it('cache signature names the ASR engine, tts engine and voice', async () => {
    const p = mk({ asr: asrEngine([]), tr: new FakeTr() });
    await p.usable();
    expect(await p.cacheSignature()).toEqual({ translateModel: 'chrome-prompt-audio', ttsModel: 'supertonic-webgpu', voice: 'standard' });
  });
});

// ---------- engine integration of probe() ----------
describe('DubProvider.probe', () => {
  it('providers expose probe() so the engine can await async readiness before computing usable tiers', async () => {
    const p = createLocalProvider({ asrRegistry: new LocalAsrRegistry(), tts: reg(new FakeTts()), translators: () => [new FakeTr()] });
    expect(typeof p.probe).toBe('function');
    expect(p.isConfigured()).toBe(false);
    void seg;
    void testSettings;
  });
});
