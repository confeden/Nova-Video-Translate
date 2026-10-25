/** Text-only translation to Russian for the Groq / local tiers: ordered translators with fail-over. */
import { diag } from '../../diag';
import { ChromeCueTranslator } from '../../subtitles/chromeAi';
import type { ProviderId } from '../types';
import { ProviderUnavailableError } from '../types';
import { localReasons, reasonText } from '../../localasr/localReason';

export interface TextItem {
  text: string;
  /** soft budget of Russian characters (D10: slot seconds x CHARS_PER_SEC) */
  maxChars: number;
}

export interface TextTranslator {
  readonly id: string;
  /** cheap readiness for a source language (never downloads) */
  isAvailable(sourceLang: string): Promise<boolean>;
  /** Russian text per item, same order and length; throws when it cannot deliver all of them */
  translate(items: readonly TextItem[], sourceLang: string, signal: AbortSignal): Promise<string[]>;
}

/** Chrome's built-in Translator (free, ~40 ms per sentence); one sentence per call, order preserved. */
export class ChromeTextTranslator implements TextTranslator {
  readonly id = 'chrome-translator';
  constructor(private readonly chrome: ChromeCueTranslator = new ChromeCueTranslator()) {}

  /** a downloaded direct pair, or a pivot source->en->ru when both halves are downloaded (a 'downloadable' pair is never created here: it needs a click in the panel) */
  async isAvailable(sourceLang: string): Promise<boolean> {
    return (await this.chrome.route(sourceLang)) !== undefined;
  }

  async translate(items: readonly TextItem[], sourceLang: string, signal: AbortSignal): Promise<string[]> {
    const out: string[] = [];
    for (const it of items) {
      if (signal.aborted) throw new DOMException('aborted', 'AbortError');
      out.push((await this.chrome.translateText(it.text, sourceLang)).trim());
    }
    return out;
  }
}

export interface TranslateOutcome {
  texts: string[];
  /** id of the translator that delivered */
  by: string;
}

/** Tries each available translator in order; an empty or short answer counts as a failure. Throws the last error when none delivers. */
export async function translateWithFailover(
  translators: readonly TextTranslator[],
  items: readonly TextItem[],
  sourceLang: string,
  signal: AbortSignal,
  tier: ProviderId,
): Promise<TranslateOutcome> {
  let last: unknown;
  let anyAvailable = false;
  for (const t of translators) {
    if (signal.aborted) throw new DOMException('aborted', 'AbortError');
    let ok = false;
    try {
      ok = await t.isAvailable(sourceLang);
    } catch {
      ok = false;
    }
    if (!ok) continue;
    anyAvailable = true;
    const t0 = Date.now();
    try {
      const texts = await t.translate(items, sourceLang, signal);
      if (texts.length !== items.length || texts.every((x) => !x.trim())) throw new ProviderUnavailableError(`${t.id}: incomplete translation`, tier, 'failed');
      diag.log(`${tier}-translate-ok`, { by: t.id, n: items.length, chars: texts.reduce((a, x) => a + x.length, 0), ms: Date.now() - t0 });
      if (tier === 'local') localReasons.clear('translator');
      return { texts, by: t.id };
    } catch (e) {
      if (signal.aborted) throw e;
      last = e;
      diag.log(`${tier}-translate-fail`, { by: t.id, ms: Date.now() - t0, kind: e instanceof ProviderUnavailableError ? e.kind : 'error', msg: String((e as Error)?.message ?? e).slice(0, 100) });
    }
  }
  if (!anyAvailable && tier === 'local') {
    localReasons.set('translator', reasonText.translator(sourceLang));
    diag.log('local-reason', { why: 'translator', lang: sourceLang });
  }
  throw last ?? new ProviderUnavailableError('no text translator available', tier, 'unsupported');
}
