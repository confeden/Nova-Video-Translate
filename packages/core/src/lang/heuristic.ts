/**
 * Offline text-language heuristic: script statistics + marker letters + stop words. Not a general detector: it separates
 * what matters for NVT (Russian vs other Cyrillic vs Latin-script languages vs CJK/Hangul/etc.) with an honest
 * confidence. Pure and synchronous.
 */

export interface TextLang {
  lang?: string;
  confidence: number;
  how: string;
}

const STOP: Record<string, string> = {
  // Cyrillic
  ru: 'и в не на что я он с это как но по к у из за от так же вы мы все его для или бы уже есть был была были быть только если когда еще ещё может при этот эти того чем там тут то мне меня тебя нас вас ему ей их они она оно себя до про без под над после очень можно будет нет да вот какой какая какие почему где кто чего всё',
  uk: 'вдома відео україні україна українською приготувати покроковий пояснюю привіт дякую і й та що не на з до як це від для але вже є також його її їх мене тобі бути треба дуже який яка яке коли тому щоб чи при він вона вони ми ви ти я так ще лише тільки після перед між про без над під за ось де хто чому цей ця ці той ті якщо може можна буде немає',
  bg: 'и на за се да е от са не че по със като това той тя ние вие те аз ти ми му или но ако при все още само много може бъде беше бяха този тази тези там тук как кой коя какво защо',
  be: 'і ў не на з да што як гэта ад для але ўжо таксама мне бы быць трэба вельмі які якая калі таму каб ці ён яна яны мы вы ты так толькі пасля',
  sr: 'и у је да се на за не су са од као али ће то ово шта',
  mk: 'и во е да се на за не со од како но',
  // Latin
  en: 'the and of to in is you that it for on with as this are was be by not or have from at your we how what why who my me i up out about all can will just more when new best top gonna never official',
  es: 'el la los las de que y en un una es por con para no se su al lo como más pero sus le ya o este sí porque esta entre cuando muy sin sobre también me hasta hay donde quien desde todo nos durante todos uno les ni contra otros ese eso ante ellos e esto antes algunos qué unos yo otro otras otra él tanto esa estos mucho quienes nada muchos cual poco ella estar estas algunas algo nosotros cómo',
  de: 'der die das und ist nicht ein eine zu den mit von sie auf für ich es auch dem im des dass wie wir bei sich als aus oder nach wird noch nur über zum zur aber hat war wenn kann',
  fr: 'le la les des est et en un une du que qui dans pour pas sur au avec ce il elle nous vous ils sont plus par mais comme ou où fait être très aussi cette ces son sa ses leur tout faire',
  pt: 'o a os as de do da dos das e em um uma para com não que se por mais como mas foi ao ele ela são também seu sua já você está isso muito tem nos até quando só pelo pela',
  it: 'il lo la i gli le di che e è un una per non con del della dei delle da in su come più ma anche sono questo questa io tu lui lei noi voi loro ci ha hanno essere molto',
  tr: 've bir bu için ile de da çok daha gibi ama ne mi mı var yok ben sen o biz siz onlar en kadar sonra olarak',
  pl: 'i w nie na się z to jest że do jak o ale po co tak za od czy jego dla już tylko przez ten ma być był',
  nl: 'de het een en van is dat op te in niet voor met zijn ook er maar om aan bij als ze nog naar dit',
  id: 'yang dan di ini itu dengan untuk tidak dari pada adalah akan juga saya kami kita atau ke ada',
  sv: 'och att det är som en på av för med inte den till har',
};

const CYR = ['ru', 'uk', 'bg', 'be', 'sr', 'mk'];
const LAT = ['en', 'es', 'de', 'fr', 'pt', 'it', 'tr', 'pl', 'nl', 'id', 'sv'];

/** word -> languages that list it (a hit counts 1/n for each, so shared words discriminate less) */
const WORD_LANGS = new Map<string, string[]>();
for (const [lang, words] of Object.entries(STOP)) {
  for (const w of words.split(' ')) {
    const arr = WORD_LANGS.get(w);
    if (arr) {
      if (!arr.includes(lang)) arr.push(lang);
    } else WORD_LANGS.set(w, [lang]);
  }
}

const SCRIPTS: Array<[string, RegExp]> = [
  ['cyr', /\p{Script=Cyrillic}/u],
  ['lat', /\p{Script=Latin}/u],
  ['kana', /[\p{Script=Hiragana}\p{Script=Katakana}]/u],
  ['han', /\p{Script=Han}/u],
  ['hangul', /\p{Script=Hangul}/u],
  ['arab', /\p{Script=Arabic}/u],
  ['hebr', /\p{Script=Hebrew}/u],
  ['grek', /\p{Script=Greek}/u],
  ['thai', /\p{Script=Thai}/u],
  ['deva', /\p{Script=Devanagari}/u],
];

/** removes what carries no language: URLs, mentions, emoji, digits, punctuation, timestamps */
export function cleanText(raw: string): string {
  return raw
    .replace(/https?:\/\/\S+|www\.\S+/gi, ' ')
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, ' ')
    .replace(/@\w+/g, ' ')
    .replace(/\p{Extended_Pictographic}|\p{Emoji_Presentation}|[‍️⃣]/gu, ' ')
    .replace(/[\p{N}\p{P}\p{S}_]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const count = (s: string, chars: string): number => {
  let n = 0;
  for (const ch of s) if (chars.includes(ch)) n++;
  return n;
};

const lenFactor = (letters: number): number => Math.min(1, Math.sqrt(letters / 10));
const confOf = (margin: number): number => 0.3 + 0.65 * (1 - Math.exp(-Math.max(0, margin) / 2.5));

function pickBest(scores: Record<string, number>, langs: string[]): { best: string; margin: number } {
  const sorted = langs.map((l) => [l, scores[l] ?? 0] as const).sort((a, b) => b[1] - a[1]);
  return { best: sorted[0]![0], margin: sorted[0]![1] - (sorted[1]?.[1] ?? 0) };
}

function stopScores(words: string[], langs: string[]): Record<string, number> {
  const sc: Record<string, number> = {};
  for (const w of words) {
    const arr = WORD_LANGS.get(w);
    if (!arr) continue;
    const mine = arr.filter((l) => langs.includes(l));
    if (mine.length === 0) continue;
    for (const l of mine) sc[l] = (sc[l] ?? 0) + 1 / mine.length;
  }
  return sc;
}

function cyrillic(text: string, words: string[]): TextLang {
  const t = text.toLowerCase();
  const sc = stopScores(words, CYR);
  for (const l of ['bg', 'be', 'sr', 'mk']) if (sc[l]) sc[l] *= 0.5; // rare on video platforms and they share much vocabulary with ru: stop words alone are weak evidence
  sc.ru = (sc.ru ?? 0) + 0.5; // prior: most Cyrillic video text is Russian
  const ruM = Math.min(6, count(t, 'ёыэ') * 1.5);
  const ukM = Math.min(6, count(t, 'іїєґ') * 1.5);
  const beM = count(t, 'ў') * 4;
  const srM = Math.min(8, count(t, 'јљњћђџ') * 3);
  const mkM = Math.min(8, count(t, 'ѓќѕ') * 3);
  const hasRuOnly = ruM > 0;
  sc.ru += ruM + count(t, 'ъ') * 0.3 - (ukM > 0 ? 3 : 0) - (beM > 0 ? 3 : 0) - (srM > 0 || mkM > 0 ? 3 : 0);
  sc.uk = (sc.uk ?? 0) + ukM - (hasRuOnly ? 2 : 0);
  sc.be = (sc.be ?? 0) + beM + count(t, 'і') * 0.5 - (count(t, 'иъщ') > 1 ? 2 : 0);
  sc.bg = (sc.bg ?? 0) + count(t, 'ъ') * 0.7 - (hasRuOnly ? 2 : 0) - (ukM > 0 ? 2 : 0);
  sc.sr = (sc.sr ?? 0) + srM - (hasRuOnly ? 2 : 0);
  sc.mk = (sc.mk ?? 0) + mkM - (hasRuOnly ? 2 : 0);
  const { best, margin } = pickBest(sc, CYR);
  // Cyrillic text with no evidence for any other Cyrillic language is most likely Russian
  const quiet = best === 'ru' && CYR.every((l) => l === 'ru' || (sc[l] ?? 0) <= 0.75);
  return { lang: best, confidence: confOf(margin + (quiet ? 1 : 0)), how: 'heuristic' };
}

function latin(text: string, words: string[]): TextLang {
  const t = text.toLowerCase();
  const sc = stopScores(words, LAT);
  const has = (chars: string): number => count(t, chars);
  sc.es = (sc.es ?? 0) + has('ñ¿¡') * 2;
  sc.de = (sc.de ?? 0) + has('ß') * 3 + (has('äöü') > 0 && has('ñãõçğşı') === 0 ? 1 : 0);
  sc.fr = (sc.fr ?? 0) + has('çèêâîôûœëù') * 1 + (/\b[ldjmtsn]['’]/.test(t) ? 1.5 : 0);
  sc.pt = (sc.pt ?? 0) + has('ãõ') * 2.5;
  sc.it = (sc.it ?? 0) + has('ìò') * 1.5;
  sc.tr = (sc.tr ?? 0) + has('ığş') * 2.5;
  sc.pl = (sc.pl ?? 0) + has('ąęłńśźż') * 2.5;
  sc.sv = (sc.sv ?? 0) + has('å') * 2;
  const vi = (t.match(/[Ạ-ỹơư]/g) ?? []).length;
  if (vi >= 2) return { lang: 'vi', confidence: Math.min(0.9, 0.5 + vi * 0.05), how: 'heuristic' };
  const { best, margin } = pickBest(sc, LAT);
  if ((sc[best] ?? 0) === 0) return { lang: 'en', confidence: 0.2, how: 'heuristic' };
  return { lang: best, confidence: confOf(margin), how: 'heuristic' };
}

/** Language of a free text (title / description / heading). `lang` is undefined when there is nothing to judge. */
export function detectTextLanguage(raw: string): TextLang {
  const text = cleanText(raw ?? '');
  const n: Record<string, number> = {};
  let letters = 0;
  for (const ch of text) {
    for (const [name, re] of SCRIPTS) {
      if (re.test(ch)) {
        n[name] = (n[name] ?? 0) + 1;
        letters++;
        break;
      }
    }
  }
  if (letters < 3) return { confidence: 0, how: 'heuristic' };
  const tokens = text.toLowerCase().split(' ');
  const cyrWords = tokens.filter((w) => /\p{Script=Cyrillic}/u.test(w));
  const latWords = tokens.filter((w) => /^[\p{Script=Latin}'’]+$/u.test(w));
  const cyr = n.cyr ?? 0;
  const lat = n.lat ?? 0;
  const cjk = (n.kana ?? 0) + (n.han ?? 0);
  const out = (lang: string, conf: number, share: number): TextLang => ({ lang, confidence: Math.min(0.97, conf * (0.55 + 0.45 * share) * lenFactor(letters)), how: 'heuristic' });
  // non-alphabetic scripts: the script decides
  if ((n.kana ?? 0) > 0 && (n.kana ?? 0) >= 0.1 * cjk) return out('ja', n.kana! >= 3 ? 0.97 : 0.75, cjk / letters);
  if ((n.hangul ?? 0) >= 2 && (n.hangul ?? 0) >= 0.4 * letters) return out('ko', 0.97, n.hangul! / letters);
  if ((n.han ?? 0) >= 2 && (n.han ?? 0) >= 0.4 * letters) return out('zh', n.han! >= 4 ? 0.9 : 0.6, n.han! / letters);
  const other: Array<[string, string]> = [['hebr', 'he'], ['grek', 'el'], ['thai', 'th'], ['deva', 'hi']];
  for (const [sc, lang] of other) if ((n[sc] ?? 0) >= 2 && (n[sc] ?? 0) >= 0.5 * letters) return out(lang, 0.93, n[sc]! / letters);
  if ((n.arab ?? 0) >= 2 && (n.arab ?? 0) >= 0.5 * letters) {
    const lang = /[پچژگ]/.test(text) ? 'fa' : /[ڈٹڑںے]/.test(text) ? 'ur' : 'ar';
    return out(lang, lang === 'ar' ? 0.8 : 0.7, n.arab! / letters);
  }
  // alphabetic: Cyrillic vs Latin by words with letters, Latin brand names inside Russian text are tolerated
  const cyrShare = cyr / Math.max(1, cyr + lat);
  const useCyr = cyr >= 3 && (cyrShare >= 0.35 || cyrWords.length >= latWords.length);
  if (useCyr) {
    const r = cyrillic(text, cyrWords);
    return out(r.lang!, r.confidence, cyrShare);
  }
  if (lat >= 3) {
    const r = latin(text, latWords);
    return out(r.lang!, r.confidence, lat / letters);
  }
  return { confidence: 0, how: 'heuristic' };
}
