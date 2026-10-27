import { diag } from '../diag';
import type { SubtitleCue } from '../providers/types';
import type { CaptionInfo, CaptionTrack, CaptionsReader } from './captionsBridge';
import type { SubtitleCache } from './cache';
import { attachOriginal, normalizeCues } from './cues';
import { parseJson3 } from './json3';
import { BATCH_SIZE } from './geminiText';
import { SubtitleUnavailable, type CueTranslator, type WholeLoadCtx, type WholeSource } from './types';

const isRu = (lang: string): boolean => /^ru(-|$)/i.test(lang);

/**
 * Track to read: a manual Russian one, else (only when the audio is not Russian) the audio-language track, else a
 * Russian auto-generated one, else the first. An auto-translated Russian track on a foreign-audio video is not the
 * original: it would show Russian as "Оригинал" (0.3.26: diag showed `ru asr` picked for an English video).
 */
export function pickTrack(info: CaptionInfo): CaptionTrack | undefined {
  const t = info.tracks;
  const manual = (x: CaptionTrack): boolean => x.kind !== 'asr';
  const audio = info.audioLang?.toLowerCase();
  const sameAudio = (x: CaptionTrack): boolean => !!audio && x.lang.toLowerCase().split('-')[0] === audio;
  const foreignAudio = !!audio && !isRu(audio);
  return (
    t.find((x) => isRu(x.lang) && manual(x)) ??
    (foreignAudio ? undefined : t.find((x) => isRu(x.lang))) ??
    t.find((x) => manual(x) && sameAudio(x)) ??
    t.find((x) => sameAudio(x)) ??
    t.find((x) => manual(x) && !(foreignAudio && isRu(x.lang))) ??
    t.find((x) => x.kind === 'asr' && !(foreignAudio && isRu(x.lang))) ??
    (foreignAudio ? t.find((x) => !isRu(x.lang)) : t[0])
  );
}

/** Batches of `size` cues, nearest to `now` first (the viewer needs the text around the playhead before the rest). */
export function orderBatches(cues: readonly SubtitleCue[], now: number, size = BATCH_SIZE): SubtitleCue[][] {
  const batches: SubtitleCue[][] = [];
  for (let i = 0; i < cues.length; i += size) batches.push(cues.slice(i, i + size));
  const cur = Math.max(
    0,
    batches.findIndex((b) => b[b.length - 1]!.end > now),
  );
  return [...batches.slice(cur), ...batches.slice(0, cur)];
}

/** A non-Russian track in the audio language (manual first), or undefined when the audio language is unknown or Russian. */
export function originalTrack(info: CaptionInfo): CaptionTrack | undefined {
  const audio = info.audioLang?.toLowerCase();
  if (!audio || isRu(audio)) return undefined;
  const same = (x: CaptionTrack): boolean => x.lang.toLowerCase().split('-')[0] === audio.split('-')[0];
  const others = info.tracks.filter((x) => !isRu(x.lang) && same(x));
  return others.find((x) => x.kind !== 'asr') ?? others[0];
}

function withParam(url: string, k: string, v: string): string {
  const u = new URL(url, 'https://www.youtube.com');
  u.searchParams.set(k, v);
  return u.toString();
}

export interface CaptionsSourceOptions {
  reader: CaptionsReader;
  /** tried in order: Chrome built-in Translator, then Gemini */
  translators: CueTranslator[];
  cache?: SubtitleCache;
  /** host check (cheap); default: a youtube.com page */
  isSupportedPage?: () => boolean;
  /** player may not have the response yet right after navigation */
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** S2: YouTube caption tracks (read in the page's MAIN world) + local / Gemini translation to Russian. */
export class CaptionsSource implements WholeSource {
  readonly id = 'captions' as const;
  readonly label = 'YouTube';
  constructor(private readonly o: CaptionsSourceOptions) {}

  isAvailable(): boolean {
    return (this.o.isSupportedPage ?? (() => typeof location !== 'undefined' && /(^|\.)youtube(-nocookie)?\.com$/.test(location.hostname)))();
  }
  unavailableReason(): string {
    return 'это не YouTube';
  }

  private async tracks(): Promise<CaptionInfo> {
    const sleep = this.o.sleep ?? defaultSleep;
    for (let i = 0; i <= (this.o.retries ?? 3); i++) {
      const info = await this.o.reader.getTracks();
      if (info) return info;
      await sleep(700);
    }
    throw new SubtitleUnavailable('нет доступа к плееру');
  }

  private async fetchCues(url: string, params?: Record<string, string>): Promise<SubtitleCue[]> {
    let u = withParam(url, 'fmt', 'json3');
    for (const [k, v] of Object.entries(params ?? {})) u = withParam(u, k, v);
    const r = await this.o.reader.fetchText(u);
    const cues = r.status === 200 ? parseJson3(r.text) : [];
    diag.log('subs-captions-fetch', { status: r.status, bytes: r.text.length, cues: cues.length });
    return cues;
  }

  async load(ctx: WholeLoadCtx): Promise<SubtitleCue[]> {
    const info = await this.tracks();
    if (info.tracks.length === 0) throw new SubtitleUnavailable('у видео нет субтитров');
    const track = pickTrack(info)!;
    diag.log('subs-captions-track', { lang: track.lang, kind: track.kind || 'manual', tracks: info.tracks.length, translatable: track.translatable });
    const src = await this.fetchCues(track.baseUrl, info.urlParams);
    if (src.length === 0) throw new SubtitleUnavailable(info.urlParams ? 'не отдал текст субтитров' : 'не отдал текст субтитров (плеер ещё не выдал токен)');
    if (isRu(track.lang)) {
      // the Russian track is the translation: its original-language track (the audio language) gives the "Оригинал" line
      const original = originalTrack(info);
      if (!original) return src;
      const originalCues = await this.fetchCues(original.baseUrl, info.urlParams);
      return attachOriginal(src, originalCues);
    }

    const lang = track.lang.split('-')[0]!;
    const cacheKind = `cap:${track.lang}:${track.kind || 'm'}`;
    const cached = await this.o.cache?.get(cacheKind, 'whole');
    if (cached && cached.length > 0) {
      ctx.setLabel('YouTube + перевод (кэш)');
      return cached;
    }

    let lastReason = 'нет переводчика: включите встроенный ИИ Chrome или добавьте ключ Gemini';
    for (const tr of this.o.translators) {
      let ok = false;
      try {
        ok = await tr.isAvailable(lang);
      } catch {
        ok = false;
      }
      if (!ok) continue;
      const result: SubtitleCue[] = [];
      let complete = true;
      try {
        for (const batch of orderBatches(src, ctx.currentTime())) {
          if (ctx.signal.aborted) throw new DOMException('aborted', 'AbortError');
          const got = await tr.translate(batch, lang, ctx.signal);
          if (got.length < batch.length) complete = false;
          result.push(...got);
          if (result.length > 0) {
            ctx.setLabel(`YouTube + ${tr.id === 'chrome-ai' ? 'локальный перевод' : 'перевод Gemini'}`);
            ctx.onPartial(normalizeCues(result));
          }
        }
      } catch (e) {
        if ((e as { name?: string })?.name === 'AbortError' || ctx.signal.aborted) throw e;
        diag.log('subs-captions-translator-failed', { translator: tr.id, error: String((e as Error)?.message ?? e).slice(0, 120), got: result.length });
        lastReason = e instanceof SubtitleUnavailable ? e.message : `перевод (${tr.label}) не удался`;
        if (result.length > 0) return normalizeCues(result); // committed: keep what exists
        continue;
      }
      const final = normalizeCues(result);
      if (final.length > 0) {
        if (complete && tr.id === 'gemini') void this.o.cache?.put(cacheKind, 'whole', final);
        return final;
      }
    }

    // last resort: YouTube's own machine translation of the track
    if (track.translatable && info.translationLangs.includes('ru')) {
      const ru = await this.fetchCues(withParam(track.baseUrl, 'tlang', 'ru'), info.urlParams);
      if (ru.length > 0) {
        ctx.setLabel('YouTube (автоперевод)');
        return attachOriginal(normalizeCues(ru), src);
      }
    }
    throw new SubtitleUnavailable(lastReason);
  }
}
