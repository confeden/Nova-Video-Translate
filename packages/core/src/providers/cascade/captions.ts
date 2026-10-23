/**
 * Caption shortcut (D30): platform captions (YouTube json3 with word timing) -> dubbing sentences with times, so the Groq /
 * local tiers need no audio ASR at all. ASR captions have no punctuation and rolling/overlapping cues
 * (kb free_text_asr_options.md): sentences are rebuilt from the word stream, cut at pauses > 0.5 s, at final punctuation,
 * and at ~20 words; fragments < 4 words are merged into a neighbour.
 */
import { diag } from '../../diag';
import type { SubtitleCue } from '../types';
import type { CaptionInfo, CaptionsReader } from '../../subtitles/captionsBridge';
import { pickTrack } from '../../subtitles/captionsSource';
import { parseJson3 } from '../../subtitles/json3';
import { MAX_SENTENCE_WORDS, SENTENCE_PAUSE_SEC, wordCount, type SourceSegment } from './segments';

interface Word {
  start: number;
  /** known end (manual captions: next word of the same line / line end); absent = estimated from the word length */
  end?: number;
  text: string;
}

const SENTENCE_END = /[.!?…。！？]["')\]»”]*$/;
const NOISE = /^\[[^\]]*\]$|^\([^)]*\)$|^♪+$|^>>+$|^-+$/;
const MIN_FRAGMENT_WORDS = 4;

interface Json3Event {
  tStartMs?: number;
  dDurationMs?: number;
  segs?: { utf8?: string; tOffsetMs?: number }[];
}

/** estimated speaking time of a word whose true end is not known */
const estDur = (w: Word): number => Math.min(1.2, Math.max(0.25, 0.08 * w.text.length));

/** json3 events -> a clean, monotonic word stream (rolling duplicates dropped, noise tags removed) */
export function wordsFromJson3(input: string | unknown): Word[] {
  let o: unknown = input;
  if (typeof input === 'string') {
    try {
      o = JSON.parse(input);
    } catch {
      return [];
    }
  }
  const events = (o as { events?: Json3Event[] } | undefined)?.events;
  if (!Array.isArray(events)) return [];
  const words: Word[] = [];
  for (const ev of events) {
    if (typeof ev.tStartMs !== 'number' || !Array.isArray(ev.segs)) continue;
    const evStart = ev.tStartMs / 1000;
    const evEnd = evStart + (ev.dDurationMs ?? 0) / 1000;
    const timed = ev.segs.some((s) => typeof s.tOffsetMs === 'number' && s.tOffsetMs > 0);
    const parts: { start: number; text: string }[] = [];
    if (timed) {
      for (const s of ev.segs) {
        const t = (s.utf8 ?? '').replace(/\s+/g, ' ').trim();
        if (t) parts.push({ start: evStart + (s.tOffsetMs ?? 0) / 1000, text: t });
      }
    } else {
      // manual caption line: spread its words evenly over the event
      const toks = ev.segs.map((s) => s.utf8 ?? '').join('').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
      const dur = Math.max(0, evEnd - evStart);
      toks.forEach((t, i) => parts.push({ start: evStart + (dur * i) / toks.length, text: t }));
    }
    parts.forEach((p, i) => {
      if (NOISE.test(p.text)) return;
      const last = words[words.length - 1];
      // rolling ASR lines repeat the previous words: ignore anything that does not move forward in time
      if (last && (p.start < last.start - 0.001 || (p.text === last.text && Math.abs(p.start - last.start) < 0.05))) return;
      const next = parts[i + 1];
      const w: Word = { start: p.start, text: p.text };
      if (!timed) w.end = next ? next.start : Math.max(p.start + 0.2, evEnd);
      words.push(w);
    });
  }
  return words;
}

/** word stream -> sentences (see the file header for the cut rules) */
export function buildSentences(words: readonly Word[], opts: { pauseSec?: number; maxWords?: number } = {}): SourceSegment[] {
  const pause = opts.pauseSec ?? SENTENCE_PAUSE_SEC;
  const maxWords = opts.maxWords ?? MAX_SENTENCE_WORDS;
  const groups: Word[][] = [];
  let cur: Word[] = [];
  const endOf = (w: Word, next?: Word): number => {
    const e = w.end ?? w.start + estDur(w);
    return next ? Math.min(e, Math.max(w.start + 0.05, next.start)) : e;
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const prev = cur[cur.length - 1];
    if (prev && w.start - endOf(prev, w) > pause) {
      groups.push(cur);
      cur = [];
    }
    cur.push(w);
    const next = words[i + 1];
    const endsSentence = SENTENCE_END.test(w.text) && cur.length >= 3;
    if (endsSentence || cur.length >= maxWords || (!next && cur.length > 0)) {
      groups.push(cur);
      cur = [];
    }
  }
  if (cur.length) groups.push(cur);

  const toSeg = (g: Word[], nextStart?: number): SourceSegment => {
    const last = g[g.length - 1]!;
    return { start: g[0]!.start, end: endOf(last, nextStart !== undefined ? ({ start: nextStart } as Word) : undefined), text: g.map((w) => w.text).join(' ') };
  };
  let segs = groups.map((g, i) => toSeg(g, groups[i + 1]?.[0]?.start));
  // merge fragments: a group of < MIN_FRAGMENT_WORDS joins the previous one when the pause is short, else the next one
  const merged: SourceSegment[] = [];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!;
    const prev = merged[merged.length - 1];
    const prevOpen = prev && !SENTENCE_END.test(prev.text);
    if (prev && wordCount(s.text) < MIN_FRAGMENT_WORDS && s.start - prev.end <= 1.5 && wordCount(prev.text) + wordCount(s.text) <= maxWords + 4) {
      merged[merged.length - 1] = { start: prev.start, end: Math.max(prev.end, s.end), text: `${prev.text} ${s.text}` };
    } else if (prev && wordCount(prev.text) < MIN_FRAGMENT_WORDS && prevOpen && s.start - prev.end <= 1.5) {
      merged[merged.length - 1] = { start: prev.start, end: Math.max(prev.end, s.end), text: `${prev.text} ${s.text}` };
    } else merged.push(s);
  }
  segs = merged;
  // a sentence never runs into the next one
  return segs.map((s, i) => ({ ...s, end: Math.max(s.start + 0.2, Math.min(s.end, segs[i + 1]?.start ?? s.end)) }));
}

export const sentencesFromJson3 = (input: string | unknown): SourceSegment[] => buildSentences(wordsFromJson3(input));

const isRu = (lang: string): boolean => /^ru(-|$)/i.test(lang);

export interface CaptionTimeline {
  /** cheap, no waiting: sentences if already loaded */
  peek(): { sentences: SourceSegment[]; lang: string; audioLang?: string } | undefined;
  /** loads (once) and resolves with the sentences, or undefined when the video has no usable captions; waits at most `maxWaitMs` */
  get(signal?: AbortSignal, maxWaitMs?: number): Promise<{ sentences: SourceSegment[]; lang: string; audioLang?: string } | undefined>;
  /** YouTube's own machine translation (tlang=ru) of the same track as raw cues, or undefined */
  machineRu?(signal?: AbortSignal): Promise<SubtitleCue[] | undefined>;
  /** forget everything (new video) */
  reset(): void;
}

function withParam(url: string, k: string, v: string): string {
  const u = new URL(url, 'https://www.youtube.com');
  u.searchParams.set(k, v);
  return u.toString();
}

export interface YoutubeCaptionTimelineOptions {
  reader: CaptionsReader;
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** CaptionTimeline over the page's YouTube player (CaptionsReader bridge). Loads the whole track once. */
export class YoutubeCaptionTimeline implements CaptionTimeline {
  private loaded?: { sentences: SourceSegment[]; lang: string; audioLang?: string; baseUrl: string; translatable: boolean; params?: Record<string, string>; ruAvail: boolean };
  private pending?: Promise<void>;
  private failed = false;
  private mt?: Promise<SubtitleCue[] | undefined>;

  constructor(private readonly o: YoutubeCaptionTimelineOptions) {}

  reset(): void {
    this.loaded = undefined;
    this.pending = undefined;
    this.failed = false;
    this.mt = undefined;
  }

  peek(): { sentences: SourceSegment[]; lang: string; audioLang?: string } | undefined {
    const l = this.loaded;
    return l ? { sentences: l.sentences, lang: l.lang, audioLang: l.audioLang } : undefined;
  }

  async get(signal?: AbortSignal, maxWaitMs = 4000): Promise<{ sentences: SourceSegment[]; lang: string; audioLang?: string } | undefined> {
    if (!this.loaded && !this.failed) {
      this.pending ??= this.load().catch((e) => {
        this.failed = true;
        diag.log('captions-timeline-failed', { msg: String((e as Error)?.message ?? e).slice(0, 100) });
      });
      await Promise.race([this.pending, new Promise<void>((r) => setTimeout(r, maxWaitMs))]);
    }
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    return this.peek();
  }

  private async load(): Promise<void> {
    const sleep = this.o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    let info: CaptionInfo | null = null;
    for (let i = 0; i <= (this.o.retries ?? 3) && !info; i++) {
      info = await this.o.reader.getTracks();
      if (!info) await sleep(700);
    }
    if (!info || info.tracks.length === 0) {
      this.failed = true;
      return;
    }
    const track = pickTrack(info)!;
    let url = withParam(track.baseUrl, 'fmt', 'json3');
    for (const [k, v] of Object.entries(info.urlParams ?? {})) url = withParam(url, k, v);
    const r = await this.o.reader.fetchText(url);
    const sentences = r.status === 200 ? sentencesFromJson3(r.text) : [];
    diag.log('captions-timeline', { lang: track.lang, kind: track.kind || 'manual', status: r.status, sentences: sentences.length });
    if (sentences.length === 0) {
      this.failed = true;
      return;
    }
    this.loaded = {
      sentences,
      lang: track.lang.split('-')[0]!.toLowerCase(),
      audioLang: info.audioLang?.split('-')[0]?.toLowerCase(),
      baseUrl: track.baseUrl,
      translatable: track.translatable,
      params: info.urlParams,
      ruAvail: info.translationLangs.includes('ru'),
    };
  }

  machineRu(): Promise<SubtitleCue[] | undefined> {
    this.mt ??= (async () => {
      const l = this.loaded;
      if (!l || !l.translatable || !l.ruAvail || isRu(l.lang)) return undefined;
      let url = withParam(withParam(l.baseUrl, 'fmt', 'json3'), 'tlang', 'ru');
      for (const [k, v] of Object.entries(l.params ?? {})) url = withParam(url, k, v);
      const r = await this.o.reader.fetchText(url);
      const cues = r.status === 200 ? parseJson3(r.text) : [];
      diag.log('captions-timeline-tlang', { status: r.status, cues: cues.length });
      return cues.length ? cues : undefined;
    })().catch(() => undefined);
    return this.mt;
  }
}

/** text of the machine-translated cues that overlap a sentence (by start time), for the tlang translation fallback */
export function alignTlang(seg: SourceSegment, cues: readonly SubtitleCue[]): string {
  const parts: string[] = [];
  for (const c of cues) {
    const mid = (c.start + c.end) / 2;
    if (mid >= seg.start - 0.2 && mid < seg.end + 0.2) parts.push(c.text);
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}
