/**
 * "Why is nothing audible" for the local tier (D29: no overlay banners; the text goes to the player-button tooltip and the
 * panel status line). The local pipeline stages report conditions here; the UI shows the FIRST active one in REASON_ORDER.
 * Texts are Russian, never contain audio or recognised text. Dependency-free.
 */
import { langName } from '../lang/names';

export type LocalReasonKey = 'ads' | 'no-model' | 'loading' | 'cpu' | 'empty' | 'translator' | 'tts' | 'late' | 'live' | 'quality-slow' | 'restart';

/** priority: the first active reason is the one shown */
export const REASON_ORDER: readonly LocalReasonKey[] = ['ads', 'restart', 'no-model', 'loading', 'cpu', 'empty', 'translator', 'tts', 'late', 'live', 'quality-slow'];

/** consecutive chunks without any recognised phrase before 'empty' is reported */
export const EMPTY_CHUNKS_BEFORE_REASON = 3;

const lname = (lang: string | undefined): string => (lang && lang !== 'auto' ? langName(lang) : '');

export const reasonText = {
  qualitySlow: (): string => 'Яндекс не успевает, работает быстрый режим',
  live: (): string => 'Прямой эфир: перевод локальными моделями',
  ads: (): string => 'Идёт реклама: перевод начнётся после неё',
  restart: (): string => 'Перевод перезапускается…',
  noModel(lang: string | undefined): string {
    const l = lname(lang);
    return l
      ? `Нет модели Whisper для языка «${l}»: скачайте многоязычную модель (base или small) в настройках, блок «Локальное распознавание речи»`
      : 'Нет скачанной многоязычной модели Whisper: скачайте её в настройках, блок «Локальное распознавание речи» (английские модели не понимают другие языки)';
  },
  loading: (): string => 'Загружается модель Whisper — первый фрагмент будет готов через некоторое время',
  cpu: (): string => 'Видеокарта (WebGPU) недоступна — Whisper работает на процессоре, перевод может отставать',
  empty(n: number, lang: string | undefined): string {
    const l = lname(lang);
    return `Речь не распознана ${n} фрагмента(ов) подряд${l ? ` (язык: ${l})` : ''} — в потоке тишина или выбран не тот язык оригинала`;
  },
  translator(lang: string | undefined): string {
    const l = lname(lang) || 'исходный';
    return `Нет языкового пакета Chrome для перевода «${l} → русский»: настройки → «Локальное распознавание речи» → «Скачать языковой пакет»`;
  },
  late: (sec: number): string => `Перевод опаздывает: озвучка готова на ${sec} с позже речи и пропускается — модели не успевают за потоком`,
  tts: (): string => 'Не скачана модель локального голоса: скачайте её в настройках, блок «Локальный голос»',
};

type Listener = () => void;

export class LocalReasons {
  private readonly active = new Map<LocalReasonKey, string>();
  private readonly listeners = new Set<Listener>();

  set(key: LocalReasonKey, text: string): void {
    if (this.active.get(key) === text) return;
    this.active.set(key, text);
    this.emit();
  }

  clear(key: LocalReasonKey): void {
    if (this.active.delete(key)) this.emit();
  }

  clearAll(): void {
    if (this.active.size === 0) return;
    this.active.clear();
    this.emit();
  }

  /** the highest-priority active reason */
  first(): { key: LocalReasonKey; text: string } | undefined {
    for (const key of REASON_ORDER) {
      const text = this.active.get(key);
      if (text) return { key, text };
    }
    return undefined;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch {
        /* observers must not break the pipeline */
      }
    }
  }
}

/** one per page: the local tier of the current page reports here */
export const localReasons = new LocalReasons();
