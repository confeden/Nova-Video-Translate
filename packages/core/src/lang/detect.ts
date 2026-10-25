/**
 * Early, cheap "what language is this video in" gate. Gathers signals (YouTube player response through the MAIN-world
 * caption bridge, page metadata, title/description text) and combines them; a provider-reported language overrides.
 * Nothing here touches the network and nothing is sent anywhere; no page text reaches the diag log.
 */
import type { CaptionInfo, CaptionsReader } from '../subtitles/captionsBridge';
import { diag } from '../diag';
import { detectTextLanguage } from './heuristic';
import { normLang } from './names';

export interface LangSignal {
  lang: string;
  confidence: number;
  /** machine tag: yt-audio | yt-asr | yt-track | yt-text | page-text | in-language | html-lang | og-locale | track | provider | settings | cache */
  how: string;
  tier: number;
}

export interface LangVerdict {
  /** undefined = could not be determined */
  lang?: string;
  confidence: number;
  /** tag of the leading signal */
  how: string;
  signals: LangSignal[];
}

/** a result at or above this confidence is trusted enough to skip a Russian video / to tell a provider the source */
export const SKIP_CONFIDENCE = 0.8;
export const PASS_CONFIDENCE = 0.7;

const TIER: Record<string, number> = {
  provider: 4, settings: 4, cache: 4,
  'yt-audio': 3, 'yt-asr': 3, 'twitch-lang': 3,
  'yt-text': 2, 'page-text': 2, 'in-language': 2,
  'yt-track': 1, 'html-lang': 1, 'og-locale': 1, track: 1,
};

const sig = (lang: string | null | undefined, confidence: number, how: string): LangSignal | undefined => {
  const l = normLang(lang ?? undefined);
  return l ? { lang: l, confidence, how, tier: TIER[how] ?? 1 } : undefined;
};

/** Combines signals: the highest tier with a credible signal leads; agreeing signals add up, disagreeing ones weaken. */
export function combineSignals(signals: LangSignal[]): LangVerdict {
  const sigs = signals.filter((s) => s.confidence >= 0.2);
  if (sigs.length === 0) return { confidence: 0, how: 'none', signals };
  let top = Math.max(...sigs.filter((s) => s.confidence >= 0.5).map((s) => s.tier), -1);
  if (top < 0) top = Math.max(...sigs.map((s) => s.tier));
  const inTop = sigs.filter((s) => s.tier === top);
  const lead = inTop.reduce((a, b) => (b.confidence > a.confidence ? b : a));
  let miss = 1 - lead.confidence;
  for (const s of sigs) if (s !== lead && s.lang === lead.lang) miss *= 1 - s.confidence;
  let conf = 1 - miss;
  for (const s of sigs) {
    if (s.lang === lead.lang) continue;
    conf *= 1 - 0.35 * s.confidence * (s.tier >= lead.tier ? 1 : 0.6);
  }
  return { lang: lead.lang, confidence: Math.min(0.99, Math.round(conf * 100) / 100), how: lead.how, signals };
}

/** A language reported by a provider (Gemini sourceLang, Yandex response) replaces the early guess. */
export function withProviderLang(v: LangVerdict | undefined, lang: string | undefined, how = 'provider'): LangVerdict | undefined {
  const s = sig(lang, 0.99, how);
  if (!s) return v;
  return { lang: s.lang, confidence: 0.99, how, signals: [...(v?.signals ?? []), s] };
}

export interface TextLangResult {
  lang: string;
  confidence: number;
}

export type TextDetector = (text: string) => Promise<TextLangResult | undefined>;

interface ChromeLd {
  detect(text: string): Promise<Array<{ detectedLanguage?: string; confidence?: number }>>;
}
let chromeLd: Promise<ChromeLd | undefined> | undefined;

/** Chrome built-in LanguageDetector when it is already usable (never triggers a model download). */
export const chromeTextDetector: TextDetector = async (text) => {
  const LD = (globalThis as unknown as { LanguageDetector?: { availability(): Promise<string>; create(): Promise<ChromeLd> } }).LanguageDetector;
  if (typeof LD === 'undefined' || !LD) return undefined;
  try {
    chromeLd ??= LD.availability().then(
      (a) => (a === 'available' ? LD.create() : undefined),
      () => undefined,
    );
    const d = await chromeLd;
    if (!d) return undefined;
    const r = (await d.detect(text))?.[0];
    const lang = normLang(r?.detectedLanguage);
    return lang ? { lang, confidence: Math.min(0.97, r?.confidence ?? 0.5) } : undefined;
  } catch {
    return undefined;
  }
};

/** Text language: Chrome detector when usable (>= 30 chars), else/plus the offline heuristic. */
export async function detectText(text: string, detector: TextDetector | undefined = chromeTextDetector): Promise<TextLangResult | undefined> {
  const h = detectTextLanguage(text);
  const hr = h.lang && h.confidence > 0 ? { lang: h.lang, confidence: h.confidence } : undefined;
  let c: TextLangResult | undefined;
  if (detector && text.trim().length >= 30) {
    try {
      c = await detector(text.slice(0, 1000));
    } catch {
      c = undefined;
    }
  }
  if (c && c.confidence < 0.5) c = undefined;
  if (!c) return hr;
  if (!hr) return c;
  if (c.lang === hr.lang) return { lang: c.lang, confidence: Math.min(0.97, 1 - (1 - c.confidence) * (1 - hr.confidence * 0.5)) };
  return c.confidence * 0.85 >= hr.confidence ? { lang: c.lang, confidence: c.confidence * 0.85 } : hr;
}

/** The slice of Document the detector reads (fakeable). */
export interface DocLike {
  documentElement?: { getAttribute(n: string): string | null } | null;
  title?: string;
  location?: { hostname?: string };
  querySelector(sel: string): { getAttribute(n: string): string | null; textContent?: string | null } | null;
  querySelectorAll(sel: string): ArrayLike<{ getAttribute(n: string): string | null; textContent?: string | null }>;
}

export interface DetectOptions {
  captions?: CaptionsReader;
  textDetector?: TextDetector;
  /** wait for the MAIN-world player reader (ms) */
  captionsTimeoutMs?: number;
  captionsRetryMs?: number;
  /** Twitch: the channel's broadcaster language (ISO code or undefined); asked only when given */
  broadcasterLang?: () => Promise<string | undefined>;
}

const YT_HOST = /(^|\.)(youtube\.com|youtube-nocookie\.com)$/;

function ytSignals(info: CaptionInfo): LangSignal[] {
  const out: LangSignal[] = [];
  const push = (s: LangSignal | undefined): void => void (s && out.push(s));
  push(sig(info.audioLang, 0.97, 'yt-audio'));
  const asr = info.tracks.filter((t) => t.kind === 'asr');
  // exactly one ASR track = the spoken language (YouTube recognises the speech in the original language only)
  if (asr.length >= 1) push(sig(asr[0]!.lang, asr.length === 1 ? 0.92 : 0.8, 'yt-asr'));
  else if (info.tracks.length > 0) {
    // manual tracks may be translations; the first listed is usually the original
    push(sig(info.tracks[0]!.lang, info.tracks.length === 1 ? 0.55 : 0.4, 'yt-track'));
  }
  return out;
}

async function textSignal(text: string, how: string, det: TextDetector | undefined): Promise<LangSignal | undefined> {
  const r = await detectText(text, det);
  return r ? sig(r.lang, r.confidence * 0.92, how) : undefined;
}

const meta = (doc: DocLike, sel: string, attr = 'content'): string => {
  try {
    return doc.querySelector(sel)?.getAttribute(attr)?.trim() ?? '';
  } catch {
    return '';
  }
};

/** Visible text of the page that describes the video (title, h1, description meta); each part clipped. */
function pageText(doc: DocLike, video: { title?: string; getAttribute?(n: string): string | null }): string {
  const parts: string[] = [];
  const add = (s: string | null | undefined, max = 300): void => {
    const t = (s ?? '').trim();
    if (t) parts.push(t.slice(0, max));
  };
  add(video.title);
  add(video.getAttribute?.('aria-label'));
  add(meta(doc, 'meta[property="og:title"]'));
  add(doc.title);
  try {
    for (const h of Array.from(doc.querySelectorAll('h1')).slice(0, 2)) add(h.textContent);
  } catch {
    /* ignore */
  }
  add(meta(doc, 'meta[property="og:description"]'), 500);
  add(meta(doc, 'meta[name="description"]'), 500);
  return parts.join('. ');
}

/**
 * Detects the spoken language of the video on this page. Never throws; `lang` undefined = could not be determined.
 * Logs the decision to diag (signal tags and scores only, never page text).
 */
export async function detectVideoLanguage(
  video: { title?: string; getAttribute?(n: string): string | null },
  doc: DocLike,
  opts: DetectOptions = {},
): Promise<LangVerdict> {
  const signals: LangSignal[] = [];
  const add = (s: LangSignal | undefined): void => void (s && signals.push(s));
  const onYt = YT_HOST.test(doc.location?.hostname ?? '');
  let ytText = '';
  if (opts.captions && onYt) {
    try {
      const timeout = opts.captionsTimeoutMs ?? 600;
      let info = await opts.captions.getTracks(timeout);
      // right after an SPA navigation the player still holds the previous response (reader answers null): one retry
      if (!info) {
        await new Promise((r) => setTimeout(r, opts.captionsRetryMs ?? 400));
        info = await opts.captions.getTracks(timeout);
      }
      if (info) {
        for (const s of ytSignals(info)) add(s);
        ytText = [info.title, info.description].filter(Boolean).join('. ');
        if (ytText) add(await textSignal(ytText, 'yt-text', opts.textDetector));
      }
    } catch {
      /* the reader is optional */
    }
  }
  if (opts.broadcasterLang) {
    try {
      add(sig(await opts.broadcasterLang(), 0.95, 'twitch-lang'));
    } catch {
      /* optional */
    }
  }
  const htmlLang = doc.documentElement?.getAttribute('lang');
  // on YouTube <html lang> is the viewer's interface language, not the video's
  add(sig(htmlLang, onYt ? 0.1 : 0.55, 'html-lang'));
  add(sig(meta(doc, 'meta[property="og:locale"]').replace('_', '-'), onYt ? 0.1 : 0.45, 'og-locale'));
  add(sig(meta(doc, '[itemprop="inLanguage"]') || meta(doc, 'meta[itemprop="inLanguage"]'), 0.7, 'in-language'));
  try {
    const tr = doc.querySelector('video track[kind="subtitles"][default], video track[default]');
    add(sig(tr?.getAttribute('srclang'), 0.35, 'track'));
  } catch {
    /* ignore */
  }
  if (!ytText) add(await textSignal(pageText(doc, video), 'page-text', opts.textDetector));
  const v = combineSignals(signals);
  diag.log('lang-gate-detect', {
    lang: v.lang ?? '?',
    conf: v.confidence,
    how: v.how,
    sig: signals.map((s) => `${s.how}:${s.lang}:${s.confidence.toFixed(2)}`).join(' '),
    yt: onYt,
  });
  return v;
}
