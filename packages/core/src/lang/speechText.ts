/** Text rules shared by the dub and the subtitles: technical captions are not speech, and the translation keeps the intonation. */
import { detectTextLanguage } from './heuristic';

/** a caption that only names a sound: "Музыка", "[Music]", "(аплодисменты)", "♪" (the whole text, tags and punctuation aside) */
const NON_SPEECH_WORDS = new Set([
  'музыка', 'музыкальная заставка', 'музыкальная пауза', 'играет музыка', 'тихая музыка', 'веселая музыка', 'веселая музыка играет',
  'аплодисменты', 'смех', 'смеется', 'смеются', 'смех в зале', 'вздох', 'вздыхает', 'кашель', 'кашляет', 'шум', 'тишина', 'пауза', 'звук', 'звуки',
  'шум толпы', 'крики', 'свист', 'пение', 'поет', 'поют', 'без звука', 'неразборчиво', 'реклама', 'заставка',
  'music', 'applause', 'laughter', 'laughs', 'laughing', 'cheering', 'cheers', 'silence', 'sighs', 'coughs', 'noise', 'inaudible', 'intro music',
  'background music', 'upbeat music', 'soft music', 'music playing', 'blank audio', 'blank_audio', 'no audio', 'singing', 'crowd noise', 'sound effects',
  'im going to go', 'im going to go to the next one', 'to the next episode', 'see you in the next episode',
  'sfx', 'bleep', 'beep', 'ad', 'advertisement',
]);

const bare = (t: string): string =>
  t
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[\[\](){}*♪♫♬\u{1F3B5}\u{1F3B6}_.,!?…:;"'«»\-–—]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const RU_MUSIC = '(?:(?:тихая|громкая|спокойная|веселая|грустная|фоновая|инструментальная|ритмичная|электронная|классическая|напряженная|медленная|быстрая|легкая|плавная|драматическая|тревожная|оркестровая)\\s+)*музыка';
const EN_MUSIC = '(?:(?:soft|loud|quiet|calm|upbeat|sad|background|instrumental|rhythmic|electronic|classical|tense|slow|fast|gentle|dramatic|ominous|orchestral|suspenseful|energetic|ambient|relaxing)\\s+)*music';
const RU_MUSIC_DESCRIPTION = new RegExp(`^(?:(?:звучит|играет|слышна|продолжает звучать)\\s+${RU_MUSIC}|${RU_MUSIC}(?:\\s+(?:(?:постепенно|плавно|медленно)\\s+)?(?:звучит|играет|продолжается|затихает|стихает|нарастает|усиливается|начинается|заканчивается))?)(?:\\s+(?:без слов|без вокала|на фоне))?$`);
const EN_MUSIC_DESCRIPTION = new RegExp(`^(?:(?:there is|we hear)\\s+)?${EN_MUSIC}(?:\\s+(?:plays|is playing|continues|playing|fades(?:\\s+(?:out|in))?|swells|stops|ends|starts|resumes))?(?:\\s+(?:softly|loudly|quietly|gradually))?(?:\\s+(?:in the background|without vocals|without words))?$`);

/** true for a text with no speech in it: empty, only music notes / tags, or one of the known sound names */
export function isNonSpeech(text: string): boolean {
  const b = bare(text);
  if (!b) return true;
  if (NON_SPEECH_WORDS.has(b)) return true;
  // Acoustic descriptions, not dialogue about music or the words of a song.
  return b.includes('музыка') && RU_MUSIC_DESCRIPTION.test(b) || b.includes('music') && EN_MUSIC_DESCRIPTION.test(b);
}

const SOUND_TAGS = /\[[^\]\n]{0,100}\]|\([^)\n]{0,100}\)|\*[^*\n]{1,60}\*|[♪♫♬\u{1F3B5}\u{1F3B6}]+/gu;
const MUSIC_TAG = /music|музык|[♪♫♬\u{1F3B5}\u{1F3B6}]/iu;
const INTERJECTIONS = new Set(['oh', 'ah', 'uh', 'um', 'yeah', 'hey', 'ooh', 'о', 'ох', 'ах', 'эх', 'а', 'эй']);
const NEEDS_CLEANING = /[\[\]()*♪♫♬\u{1F3B5}\u{1F3B6}>]|[^\S ]| {2,}| [,.!?;:]|^[ ,.\-–—]| $/u;
const CENSOR_TAG = /^(?:\[\s*_{2,}\s*\]|\[\s*\*{2,}\s*\])$/;
const isSoundTag = (tag: string): boolean => !CENSOR_TAG.test(tag) && (isNonSpeech(tag) || /^\[query\]$/i.test(tag));

/** Keep character positions while removing a sound tag split across timed JSON3 text parts. */
export function maskSoundTags(text: string): string {
  return text.replace(SOUND_TAGS, (tag) => isSoundTag(tag) ? ' '.repeat(tag.length) : tag);
}

/** Music metadata must be a sound label, not dialogue that happens to contain the word "music". */
const isMusicLabel = (text: string): boolean => MUSIC_TAG.test(text) && !cleanSpeechText(text);

/** Only immediate music labels within two seconds may give a short caption music context. */
export function musicContextAt(spans: readonly { start: number; end: number; text: string; src?: string }[], index: number): boolean {
  const cur = spans[index];
  if (!cur || !Number.isFinite(cur.start) || !Number.isFinite(cur.end) || cur.end - cur.start > 5) return false;
  return [index - 1, index + 1].some((j) => {
    const other = spans[j];
    if (!other || !Number.isFinite(other.start) || !Number.isFinite(other.end)) return false;
    const gap = j < index ? cur.start - other.end : other.start - cur.end;
    return gap <= 2 && Math.abs(other.start - cur.start) <= 7 && (isMusicLabel(other.text) || !!other.src && isMusicLabel(other.src));
  });
}

/** Remove soundtrack tags before translation/display; repeated filler between music marks is ASR noise, not lyrics. */
export function cleanSpeechText(text: string, musicContext = false): string {
  const cleaned = NEEDS_CLEANING.test(text) ? text.replace(SOUND_TAGS, (tag) => isSoundTag(tag) ? ' ' : tag)
    .replace(/(?:^|\s)>>+(?=\s|$)/g, ' ').replace(/\s+/g, ' ').replace(/\s+([,.!?;:])/g, '$1')
    .replace(/^[\s,.\-–—]+(?=\S)/, '').trim().replace(/^[,.\-–—\s]+$/, '') : text;
  if (isNonSpeech(cleaned)) return '';
  if (musicContext || (text.match(SOUND_TAGS) ?? []).some((tag) => MUSIC_TAG.test(tag))) {
    const words = cleaned.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
    const content = words.filter((w) => !INTERJECTIONS.has(w));
    if (words.length <= 8 && (content.length === 0 || (content.length >= 2 && content.every((w) => w === content[0])))) return '';
  }
  return cleaned;
}

/** Require linguistic evidence, not just Cyrillic letters (Ukrainian etc. must still be translated). */
export function isRussianSpeech(text: string): boolean {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (letters.length < 10 || /[іїєґўјљњћђџѓќѕ]/iu.test(text)) return false;
  const detected = detectTextLanguage(text);
  return detected.lang === 'ru' && detected.confidence >= 0.75;
}

/** the terminal intonation marks of a text ("?", "!", "?!", "…"), '' when it ends in a plain stop or in a letter */
const tail = (t: string): string => /[?!…]+["')»\]]*$/.exec(t.trim())?.[0].replace(/["')»\]]+$/, '') ?? '';

/**
 * Carries the question / exclamation of the original over to its translation when the translator dropped it:
 * "Are you ready?" -> "Ты готов" gets its "?"; a plain "." in the translation of "Go!" becomes "!".
 */
export function matchIntonation(src: string, ru: string): string {
  const s = tail(src);
  const r = ru.trim();
  if (!s || !r || /[?!]$/.test(r) || (s === '…' && /…$/.test(r))) return r;
  const body = r.replace(/[.,;:…\s]+$/u, '');
  return body ? body + s : r;
}
