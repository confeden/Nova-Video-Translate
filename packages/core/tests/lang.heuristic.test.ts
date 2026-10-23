import { describe, expect, it } from 'vitest';
import { detectTextLanguage } from '../src/lang/heuristic';
import { normLang } from '../src/lang/names';

/** [text, expected language] — realistic video titles / descriptions */
const CASES: Array<[string, string]> = [
  // Russian
  ['Как приготовить борщ в домашних условиях: пошаговый рецепт', 'ru'],
  ['ЖЁСТКАЯ ПАРОДИЯ на ЕГЭ — что будет, если не сдать?', 'ru'],
  ['Привет, друзья! Сегодня мы разберём, почему этот фильм так всех удивил. Подписывайтесь на канал и ставьте лайк 👍🔥', 'ru'],
  ['Почему в России дорожает жильё? Объясняю на пальцах', 'ru'],
  ['🔥🔥🔥 ТОП 10 лучших игр этого года!!! 🎮🎮 смотреть всем #игры #топ', 'ru'],
  ['Лекция 5. Квадратные уравнения и их корни', 'ru'],
  // Ukrainian
  ['Як приготувати борщ вдома: покроковий рецепт з фото', 'uk'],
  ['Чому в Україні дорожчає житло? Пояснюю на пальцях. Підписуйтесь на канал!', 'uk'],
  ['Це відео про те, як ми їздили в Карпати й що там побачили', 'uk'],
  // English
  ['Rick Astley - Never Gonna Give You Up (Official Music Video)', 'en'],
  ['How to build a PC in 2024: the complete beginner guide', 'en'],
  ['Why is everyone talking about this new AI model? What you need to know', 'en'],
  ['I tried the world\'s most expensive pizza 🍕 and it was not what I expected', 'en'],
  // Spanish / German / French / Portuguese / Italian
  ['Cómo preparar una paella valenciana auténtica para toda la familia', 'es'],
  ['Los mejores trucos de Minecraft que no sabías, ¡sorpréndete!', 'es'],
  ['Wie man in 10 Minuten ein Brot backt – das einfache Rezept für Anfänger', 'de'],
  ['Die Wahrheit über das Wetter in Deutschland und warum es so ist', 'de'],
  ['Comment faire des crêpes parfaites : la recette de ma grand-mère', 'fr'],
  ['Como fazer um bolo de cenoura fofinho e muito fácil, você vai amar', 'pt'],
  ['Come preparare la pasta alla carbonara: la ricetta originale romana', 'it'],
  // Turkish / Polish
  ['Evde kolay pizza nasıl yapılır? Bu tarif çok basit ve lezzetli', 'tr'],
  ['Jak zrobić pyszne pierogi w domu? Przepis, który zawsze wychodzi', 'pl'],
  // Japanese / Chinese / Korean
  ['【初心者向け】簡単にできる家庭料理の作り方を紹介します', 'ja'],
  ['新しいゲーム機を買ってみた！開封レビュー', 'ja'],
  ['如何在家做出好吃的红烧肉，简单又美味的做法', 'zh'],
  ['집에서 쉽게 만드는 김치찌개 레시피 | 백종원', 'ko'],
];

describe('detectTextLanguage', () => {
  for (const [text, lang] of CASES) {
    it(`${lang}: ${text.slice(0, 40)}`, () => {
      const r = detectTextLanguage(text);
      expect(r.lang).toBe(lang);
      expect(r.confidence).toBeGreaterThan(0.5);
    });
  }

  it('confident Russian text clears the 0.8 skip threshold when it is long enough', () => {
    const r = detectTextLanguage('Привет, друзья! Сегодня мы разберём, почему этот фильм так всех удивил. Подписывайтесь на канал и ставьте лайк');
    expect(r.lang).toBe('ru');
    expect(r.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('Russian with Latin brand names is still Russian but with lower confidence', () => {
    const r = detectTextLanguage('iPhone 15 Pro обзор');
    expect(r.lang).toBe('ru');
    expect(r.confidence).toBeLessThan(0.8);
  });

  it('English text with a single Russian word is not Russian', () => {
    expect(detectTextLanguage('Moscow metro tour: the most beautiful stations explained, спасибо').lang).toBe('en');
  });

  it('short and degenerate input gets no or low confidence, never a confident wrong answer', () => {
    expect(detectTextLanguage('').lang).toBeUndefined();
    expect(detectTextLanguage('   ').confidence).toBe(0);
    expect(detectTextLanguage('🔥🔥🔥 !!! 123 456').lang).toBeUndefined();
    expect(detectTextLanguage('https://youtu.be/abcdef 12:34').lang).toBeUndefined();
    expect(detectTextLanguage('ok').lang).toBeUndefined();
    const short = detectTextLanguage('Привет');
    expect(short.confidence).toBeLessThan(0.8);
    expect(detectTextLanguage('Vlog #12').confidence).toBeLessThan(0.5);
  });

  it('emoji, hashtags and timestamps do not disturb the verdict', () => {
    const r = detectTextLanguage('00:00 Начало 😀 02:15 Главное 🎉 05:40 Итоги #влог @channel https://t.me/x');
    expect(r.lang).toBe('ru');
  });

  it('Belarusian / Bulgarian / Serbian are not mistaken for Russian', () => {
    expect(detectTextLanguage('Гэта відэа пра тое, як мы ездзілі ў Мінск і што ўбачылі').lang).toBe('be');
    expect(detectTextLanguage('Това видео е за това как се прави най-добрата баница със сирене').lang).toBe('bg');
    expect(detectTextLanguage('Ово је видео о томе како се прави најбољи ћевапи код куће, шта ћете').lang).toBe('sr');
  });
});

describe('normLang', () => {
  it('normalises tags', () => {
    expect(normLang('ru-RU')).toBe('ru');
    expect(normLang('zh-Hans')).toBe('zh');
    expect(normLang('en.4')).toBe('en');
    expect(normLang('iw')).toBe('he');
    expect(normLang('und')).toBeUndefined();
    expect(normLang('')).toBeUndefined();
    expect(normLang(undefined)).toBeUndefined();
  });
});
