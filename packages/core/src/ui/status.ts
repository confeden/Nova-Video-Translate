import type { EngineState, LanguageInfo } from '../pipeline';
import { howLabel, langName } from '../lang/names';
import type { ProviderId } from '../providers/types';
import type { Settings } from '../types';
import { diag } from '../diag';

/** What the settings panel's top block shows about the video it controls (extension popup gets it by messaging). */
export interface TranslateStatus {
  state: EngineState;
  provider?: string;
  /** who actually voices now, e.g. 'Яндекс — обычные' */
  voice?: string;
  /** subtitle source line, e.g. 'Субтитры: Яндекс'; present only while subtitles are enabled and a source is known */
  subtitles?: string;
  /** recent warnings / errors, Russian, newest last */
  warnings: string[];
  /** "Язык оригинала: английский (по субтитрам YouTube)"; absent until the language gate ran */
  language?: string;
  /** the video was skipped as Russian: the panel offers "Всё равно перевести" */
  canForce?: boolean;
  /** host name of the page the status comes from */
  page?: string;
  /** 'starting' for a long time on Yandex with nothing voiced (engine detail.slow): the panel line explains the wait */
  slow?: 'wait' | 'switch';
  /** while 'starting': estimated seconds until the first dub and the source expected to deliver it (Russian name) */
  etaSec?: number;
  etaSource?: string;
  /** the user's top tier takes over later than the one voicing now (Russian name, e.g. 'живые голоса') */
  later?: string;
  /** why the local tier produced nothing audible yet (first blocking reason, Russian); absent when there is none */
  reason?: string;
}

export function isActiveState(s: EngineState): boolean {
  return s === 'starting' || s === 'translating' || s === 'buffering';
}

const STATE_TEXT: Record<EngineState, string> = {
  idle: 'Перевод выключен',
  stopped: 'Перевод выключен',
  starting: 'Подготовка перевода…',
  buffering: 'Буферизация перевода…',
  translating: 'Идёт перевод',
  error: 'Ошибка перевода',
  'skipped-ru': 'Видео уже на русском',
  'native-dub': 'Родная русская дорожка',
};

/** Panel line about the spoken language of the video. */
export function languageStatusText(l: LanguageInfo | undefined): string | undefined {
  if (!l) return undefined;
  const name = langName(l.lang);
  if (l.unverified) return l.lang ? `Язык оригинала: возможно ${name}` : 'Язык оригинала: не определён';
  const tail = l.skipped ? ` — перевод не нужен` : '';
  return `Язык оригинала: ${name} (${howLabel(l.how)})${tail}`;
}

export function stateText(s: EngineState, slow?: 'wait' | 'switch', prep?: { etaSec?: number; source?: string }): string {
  void slow; // slow-start hints are problem details: diagnostics only
  if (s === 'starting' && prep && prep.etaSec !== undefined) {
    return `Подготовка перевода… первый фрагмент через ~${Math.max(1, Math.round(prep.etaSec))} с${prep.source ? ` (${prep.source})` : ''}`;
  }
  return STATE_TEXT[s] ?? s;
}

/** Short Russian names of a tier as the thing that will voice later ("Gemini → живые голоса позже"). */
const LATER_NAMES: Record<ProviderId, string> = { 'yandex-live': 'живые голоса', yandex: 'обычные голоса Яндекса', groq: 'Groq + локальный голос', local: 'локальные модели', gemini: 'Gemini' };
const SOURCE_NAMES: Record<ProviderId, string> = { 'yandex-live': 'живые голоса Яндекса', yandex: 'Яндекс', groq: 'Groq + локальный голос', local: 'локальные модели', gemini: 'Gemini' };

export function laterName(id: ProviderId | undefined): string | undefined {
  return id ? LATER_NAMES[id] : undefined;
}
export function sourceName(id: ProviderId | undefined): string | undefined {
  return id ? SOURCE_NAMES[id] : undefined;
}

/** "Озвучка: Gemini → живые голоса позже" */
export function voiceLine(voice: string, later?: string): string {
  return later ? `Озвучка: ${voice} → ${later} позже` : `Озвучка: ${voice}`;
}

const PROVIDER_NAMES: Record<ProviderId, string> = { 'yandex-live': 'Яндекс — живые голоса', yandex: 'Яндекс — обычные', groq: 'Groq + локальный голос', local: 'Локальные модели', gemini: 'Gemini' };

export function providerName(id: string | undefined): string | undefined {
  return id ? (PROVIDER_NAMES[id as ProviderId] ?? id) : undefined;
}

/** Plain summary of settings for diagnostics: NO keys, tokens or key fragments (field names avoid 'key'/'token': diag redacts those). */
export function settingsSummary(s: Settings): Record<string, string | number | boolean> {
  return {
    providers: s.voiceOrder.map((id) => `${id}:${s.voiceEnabled[id] === false ? 'off' : 'on'}`).join(' > '),
    subtitles: s.subtitles === 'on',
    cacheOn: s.cacheEnabled,
    cacheDays: s.cacheDays,
    geminiCount: s.geminiKeys.length,
    yandexSignedIn: !!s.yandexToken,
    autoTranslate: s.autoTranslate === 'on',
    skipRussian: s.skipRussian !== 'off',
    preferNativeDub: s.preferNativeDub !== false,
    sourceLang: s.sourceLang,
    clickAction: s.clickAction,
    volOrig: s.originalVolume,
    volDub: s.translationVolume,
  };
}

export function buildDiagReport(opts: { version?: string; settings?: Settings; pageHost?: string; status?: TranslateStatus | null }): string {
  const head: Record<string, unknown> = {
    version: opts.version ?? 'dev',
    ua: typeof navigator !== 'undefined' ? navigator.userAgent : '',
    page: opts.pageHost ?? (typeof location !== 'undefined' ? location.hostname : ''),
  };
  if (opts.settings) Object.assign(head, settingsSummary(opts.settings));
  if (opts.status) {
    head.state = opts.status.state;
    head.voice = opts.status.voice ?? '';
    head.subs = opts.status.subtitles ?? '';
    head.warns = opts.status.warnings.length;
  }
  return diag.report(head);
}
