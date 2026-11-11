import { describe, expect, it } from 'vitest';
import { dropWeakSegments } from '../src/localasr/asrText';
import { isNonSpeech, isRussianSpeech, matchIntonation } from '../src/lang/speechText';

describe('dropWeakSegments', () => {
  const bursts = [{ start: 2, end: 2.15 }, { start: 5, end: 7 }];
  it('drops a short text over almost no speech, keeps one over real speech', () => {
    const segs = [
      { start: 1.9, end: 2.3, text: 'So' },
      { start: 5, end: 7, text: "I'm going to go" },
      { start: 0, end: 8, text: 'a long sentence with many more than five words here' },
    ];
    expect(dropWeakSegments(segs, bursts).map((s) => s.text)).toEqual(["I'm going to go", 'a long sentence with many more than five words here']);
  });
  it('a known filler needs a second of speech', () => {
    const b = [{ start: 5, end: 5.7 }];
    expect(dropWeakSegments([{ start: 4.5, end: 6, text: "I'm going to go." }], b)).toHaveLength(0);
  });
});

describe('speechText', () => {
  it('flags sound names, not speech', () => {
    for (const t of ['Музыка', '[Музыка]', '(Music)', '♪♪', 'Аплодисменты.', 'Applause']) expect(isNonSpeech(t)).toBe(true);
    for (const t of ['Музыка была тихой', 'Hello']) expect(isNonSpeech(t)).toBe(false);
  });
  it('carries ? and ! to the translation', () => {
    expect(matchIntonation('Are you ready?', 'Ты готов.')).toBe('Ты готов?');
    expect(matchIntonation('Go!', 'Вперёд')).toBe('Вперёд!');
    expect(matchIntonation('Fine.', 'Хорошо.')).toBe('Хорошо.');
    expect(matchIntonation('Why?', 'Почему?')).toBe('Почему?');
  });
  it('filters soundtrack descriptions while preserving dialogue about music and actual lyrics', () => {
    for (const t of ['Звучит спокойная инструментальная музыка без слов.', '[Играет тихая фоновая музыка]', 'Soft instrumental music plays in the background.']) expect(isNonSpeech(t), t).toBe(true);
    for (const t of ['Мне нравится эта музыка.', 'Музыка была тихой', 'We hear music when we walk home', '♪ Take me home, country roads ♪']) expect(isNonSpeech(t), t).toBe(false);
  });
  it('detects actual Russian text independently of a stale English language hint', () => {
    expect(isRussianSpeech('Это русская речь, её не нужно переводить ещё раз.')).toBe(true);
    expect(isRussianSpeech('Мы будем говорить о том, как это работает.')).toBe(true);
    for (const t of ['Це українська мова, її треба перекласти.', 'Гэта беларуская мова, якую трэба перакласці.', 'This is English speech.', 'Москва', 'Това е български език и трябва да се преведе.']) expect(isRussianSpeech(t), t).toBe(false);
  });
});

import { collapseRepeats } from '../src/providers/cascade/guard';
describe('collapseRepeats', () => {
  it('drops the first copy of a phrase looped inside one segment', () => {
    expect(collapseRepeats("I'm going to go. The I'm going to go to the next one.")).toBe("I'm going to go to the next one.");
    expect(collapseRepeats('a normal sentence with no loop')).toBe('a normal sentence with no loop');
  });
});
