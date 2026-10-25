/** Language codes: normalisation, Russian names (UI) and the Yandex source-language set. */

const NAMES: Record<string, string> = {
  ru: 'русский', en: 'английский', ja: 'японский', zh: 'китайский', ko: 'корейский', es: 'испанский', de: 'немецкий',
  fr: 'французский', pt: 'португальский', it: 'итальянский', tr: 'турецкий', uk: 'украинский', pl: 'польский',
  be: 'белорусский', bg: 'болгарский', ar: 'арабский', he: 'иврит', el: 'греческий', th: 'тайский', hi: 'хинди',
  nl: 'нидерландский', id: 'индонезийский', vi: 'вьетнамский', sv: 'шведский', sr: 'сербский', mk: 'македонский',
  fa: 'персидский', ur: 'урду', cs: 'чешский', da: 'датский', no: 'норвежский', fi: 'финский', hu: 'венгерский', ro: 'румынский',
  hr: 'хорватский', sk: 'словацкий', lt: 'литовский', lv: 'латышский', et: 'эстонский', ca: 'каталанский',
};

const ALIASES: Record<string, string> = { iw: 'he', in: 'id', ji: 'yi', nb: 'no', nn: 'no', jp: 'ja', cn: 'zh', ua: 'uk', 'ru-ru': 'ru' };

/** 'ru-RU' / 'ru_RU' / 'zh-Hans' / 'en.4' -> 'ru' / 'zh' / 'en'; unknown/und/empty -> undefined */
export function normLang(code: string | undefined | null): string | undefined {
  if (typeof code !== 'string') return undefined;
  const base = code.trim().toLowerCase().split(/[-_.]/)[0] ?? '';
  if (!/^[a-z]{2,3}$/.test(base) || base === 'und' || base === 'mul' || base === 'zxx') return undefined;
  return ALIASES[base] ?? base;
}

/** Russian adjective for the language ("английский"); unknown codes are returned as-is */
export function langName(code: string | undefined): string {
  if (!code) return 'не определён';
  return NAMES[code] ?? code;
}

/** Source languages the Yandex voice-over backend accepts (VOT availableLangs, minus 'auto') */
export const YANDEX_SOURCE_LANGS: ReadonlySet<string> = new Set(['ru', 'en', 'zh', 'ko', 'ar', 'fr', 'it', 'es', 'de', 'ja']);

/** options of the "Язык оригинала" select: [code, label] */
export const SOURCE_LANG_OPTIONS: ReadonlyArray<readonly [string, string]> = [
  ['auto', 'Авто'], ['en', 'Английский'], ['ja', 'Японский'], ['zh', 'Китайский'], ['ko', 'Корейский'], ['es', 'Испанский'],
  ['de', 'Немецкий'], ['fr', 'Французский'], ['pt', 'Португальский'], ['it', 'Итальянский'], ['tr', 'Турецкий'],
  ['uk', 'Украинский'], ['pl', 'Польский'],
];

const HOW: Record<string, string> = {
  'yt-audio': 'по аудиодорожке YouTube',
  'yt-asr': 'по субтитрам YouTube',
  'yt-track': 'по дорожкам субтитров YouTube',
  'yt-text': 'по названию и описанию',
  'page-text': 'по тексту страницы',
  'in-language': 'по метаданным страницы',
  'html-lang': 'по языку страницы',
  'og-locale': 'по метаданным страницы',
  track: 'по дорожке субтитров',
  'twitch-lang': 'по языку трансляции Twitch',
  provider: 'по ответу сервиса перевода',
  settings: 'выбран в настройках',
  cache: 'из кэша',
};

export function howLabel(how: string): string {
  return HOW[how] ?? how;
}

/** languages offered next to the Chrome Translator pair row (code order = popularity on live streams) */
export const TRANSLATOR_SOURCE_LANGS: readonly string[] = ['en', 'da', 'sv', 'no', 'fi', 'de', 'fr', 'es', 'pt', 'it', 'pl', 'tr', 'uk', 'cs', 'nl', 'ja', 'ko', 'zh'];
