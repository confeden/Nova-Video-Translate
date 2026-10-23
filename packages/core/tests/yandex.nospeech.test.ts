import { describe, expect, it } from 'vitest';
import { YandexProvider } from '../src/providers/yandex/provider';
import { YandexError } from '../src/providers/yandex/client';

const fakeClient = (err: Error) => ({ translatePcm: async () => Promise.reject(err) }) as never;
const chunk = { startSec: 0, durationSec: 15, sampleRate: 16000, pcm: new Int16Array(8) };
const ctx = { signal: new AbortController().signal, targetLang: 'ru' as const, wantSubtitles: false };

describe('Yandex "no speech" answer', () => {
  it('is a clean empty result (no retry, no failure) for music / silence', async () => {
    const p = new YandexProvider({} as never, { client: fakeClient(new YandexError('Не удалось перевести видео — похоже, в нём нет речи', 'unsupported')) });
    const r = await p.translateChunk(chunk, ctx);
    expect(r.segments).toEqual([]);
  });

  it('other unsupported failures still throw', async () => {
    const p = new YandexProvider({} as never, { client: fakeClient(new YandexError('Возникла ошибка при переводе', 'unsupported')) });
    await expect(p.translateChunk(chunk, ctx)).rejects.toThrow();
  });
});
