import { diag } from '../diag';
import type { SubtitleCue, Transport } from '../providers/types';
import { YandexClient, type YandexSubtitleRef } from '../providers/yandex/client';
import { attachOriginal } from './cues';
import { parseYandexSubtitles } from './json3';
import { SubtitleUnavailable, type WholeLoadCtx, type WholeSource } from './types';

/** The slice of YandexClient this source uses (fakeable). */
export interface YandexSubsApi {
  getSubtitles(videoUrl: string, requestLang: string, signal?: AbortSignal): Promise<{ waiting: boolean; subtitles: YandexSubtitleRef[] }>;
}

export interface YandexSubtitleSourceOptions {
  api: YandexSubsApi;
  /** GET of a subtitle JSON on mds.yandex.net (same transport as the translate calls) */
  fetchText: (url: string, signal: AbortSignal) => Promise<{ status: number; text: string }>;
  pageUrl: () => string;
  /** source language of the video when known (YouTube audio/caption language), else 'en' */
  langHint?: () => Promise<string | undefined> | string | undefined;
  /** polls while Yandex answers `waiting` (it never finishes for videos Yandex did not translate itself: measured) */
  maxTries?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** URL form Yandex knows: YouTube watch URL for the YouTube family, otherwise the page URL without hash. */
export function canonicalVideoUrl(pageUrl: string): string | undefined {
  let u: URL;
  try {
    u = new URL(pageUrl);
  } catch {
    return undefined;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
  if (/(^|\.)youtube\.com$/.test(u.hostname)) {
    const id = u.searchParams.get('v') ?? /^\/(?:shorts|embed|live)\/([\w-]{11})/.exec(u.pathname)?.[1];
    return id ? `https://www.youtube.com/watch?v=${id}` : undefined;
  }
  if (u.hostname === 'youtu.be') {
    const id = u.pathname.slice(1, 12);
    return id ? `https://www.youtube.com/watch?v=${id}` : undefined;
  }
  if (/^(localhost|127\.|\[::1\])/.test(u.hostname) || u.hostname.endsWith('.localhost')) return undefined;
  u.hash = '';
  return u.toString();
}

/** S1: Yandex /video-subtitles/get-subtitles. Works only for videos Yandex already holds a translation of. */
export class YandexSubtitleSource implements WholeSource {
  readonly id = 'yandex' as const;
  readonly label = 'Яндекс';
  constructor(private readonly o: YandexSubtitleSourceOptions) {}

  isAvailable(): boolean {
    return canonicalVideoUrl(this.o.pageUrl()) !== undefined;
  }
  unavailableReason(): string {
    return 'для этой страницы нет адреса видео, который знает Яндекс';
  }

  async load(ctx: WholeLoadCtx): Promise<SubtitleCue[]> {
    const url = canonicalVideoUrl(this.o.pageUrl());
    if (!url) throw new SubtitleUnavailable(this.unavailableReason());
    const lang = (await this.o.langHint?.()) || 'en';
    const sleep = this.o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const tries = this.o.maxTries ?? 2;
    let res: Awaited<ReturnType<YandexSubsApi['getSubtitles']>> | undefined;
    for (let i = 0; i < tries; i++) {
      try {
        res = await this.o.api.getSubtitles(url, lang, ctx.signal);
      } catch (e) {
        if (ctx.signal.aborted) throw e;
        throw new SubtitleUnavailable(`сервис недоступен (${String((e as Error)?.message ?? e).slice(0, 80)})`);
      }
      diag.log('subs-yandex', { try: i, waiting: res.waiting, items: res.subtitles.length, lang });
      if (res.subtitles.length > 0 || !res.waiting) break;
      if (i < tries - 1) await sleep(this.o.pollMs ?? 3000);
    }
    if (!res || res.subtitles.length === 0) throw new SubtitleUnavailable(res?.waiting ? 'субтитры для этого видео ещё не готовы' : 'нет субтитров для этого видео');
    const ru = res.subtitles.find((s) => s.translatedLanguage === 'ru' && s.translatedUrl) ?? res.subtitles.find((s) => s.language === 'ru' && s.url);
    const pick = ru ? (ru.translatedLanguage === 'ru' && ru.translatedUrl ? ru.translatedUrl : ru.url) : undefined;
    if (!pick) throw new SubtitleUnavailable('нет русских субтитров');
    const r = await this.o.fetchText(pick, ctx.signal);
    const cues = r.status === 200 ? parseYandexSubtitles(r.text) : [];
    diag.log('subs-yandex-fetch', { status: r.status, cues: cues.length });
    if (cues.length === 0) throw new SubtitleUnavailable('не отдал текст субтитров');
    // the translated track is the only one in Russian: its original-language twin (ru.url) gives the "Оригинал" line
    if (pick === ru?.translatedUrl && ru.url && ru.language !== 'ru') {
      const o = await this.o.fetchText(ru.url, ctx.signal).catch(() => undefined);
      if (o?.status === 200) return attachOriginal(cues, parseYandexSubtitles(o.text));
    }
    return cues;
  }
}

/** Builds the source over a Transport (extension service worker / GM_xmlhttpRequest / node). */
export function createYandexSubtitleSource(transport: Transport, opts: Omit<YandexSubtitleSourceOptions, 'api' | 'fetchText'>): YandexSubtitleSource {
  const client = new YandexClient(transport);
  return new YandexSubtitleSource({
    ...opts,
    api: client,
    async fetchText(url, signal) {
      const res = await transport({ url, method: 'GET', headers: { Accept: '*/*', 'Sec-Fetch-Mode': 'no-cors' }, signal });
      return { status: res.status, text: new TextDecoder().decode(res.body) };
    },
  });
}
