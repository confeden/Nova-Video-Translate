/**
 * Batch pre-translation of platform captions (owner: one Groq chat call per 15 s cell hit the 18 req/min budget and the 429s).
 * The sentence list of a caption track is known up front, so it is translated AHEAD of the playhead in large batches
 * (BATCH sentences per request, one request in flight), kept in memory by sentence index, and each cell takes its sentences from
 * the store; the per-cell call remains the fallback. A failing batch only backs off itself (the translators' own fail-over runs
 * inside it); the cell then uses the per-cell path, and the batch is retried later.
 */
import { diag } from '../../diag';
import type { ProviderId } from '../types';
import { budgetFor, type SourceSegment } from './segments';
import { translateWithFailover, type TextTranslator } from './translate';

export const PRETRANSLATE_BATCH = 50;
/** translate this far (video seconds) ahead of the earliest requested sentence */
export const PRETRANSLATE_AHEAD_SEC = 180;
const RETRY_AFTER_MS = 20_000;

interface TrackState {
  sentences: readonly SourceSegment[];
  lang: string;
  ru: Map<number, string>;
  /** batch start index -> promise of that batch (in flight or done) */
  batches: Map<number, Promise<boolean>>;
  retryAt: Map<number, number>;
  horizon: number;
  running: boolean;
}

export interface PretranslatorOptions {
  /** translators in priority order (evaluated per batch: keys / settings may change) */
  translators(): TextTranslator[];
  tier: ProviderId;
  batch?: number;
  aheadSec?: number;
  now?: () => number;
}

export class CaptionPretranslator {
  private readonly tracks = new WeakMap<readonly SourceSegment[], TrackState>();
  private readonly ctrl = new AbortController();

  constructor(private readonly o: PretranslatorOptions) {}

  private state(sentences: readonly SourceSegment[], lang: string): TrackState {
    let s = this.tracks.get(sentences);
    if (!s) this.tracks.set(sentences, (s = { sentences, lang, ru: new Map(), batches: new Map(), retryAt: new Map(), horizon: -1, running: false }));
    return s;
  }

  private get batchSize(): number {
    return this.o.batch ?? PRETRANSLATE_BATCH;
  }

  /** translated text of sentence `idx`, if the store has it */
  peek(sentences: readonly SourceSegment[], idx: number): string | undefined {
    return this.tracks.get(sentences)?.ru.get(idx);
  }

  private translateBatch(st: TrackState, b0: number): Promise<boolean> {
    const existing = st.batches.get(b0);
    if (existing) return existing;
    const total = st.sentences.slice(b0, b0 + this.batchSize).length;
    // one request for the whole batch; a content failure (invalid JSON / empty answer on odd input such as lyrics) is retried as
    // two halves, a rate limit is not split (it backs the batch off and the cells use the per-cell path meanwhile)
    const run = async (from: number, n: number, depth: number): Promise<boolean> => {
      const items = st.sentences.slice(from, from + n).map((s) => ({ text: s.text, maxChars: budgetFor(s.end - s.start) }));
      const t0 = Date.now();
      try {
        const r = await translateWithFailover(this.o.translators(), items, st.lang || 'en', this.ctrl.signal, this.o.tier);
        r.texts.forEach((t, i) => {
          if (t.trim()) st.ru.set(from + i, t.trim());
        });
        diag.log('pretranslate-ok', { from, n: items.length, by: r.by, ms: Date.now() - t0 });
        return true;
      } catch (e) {
        if (this.ctrl.signal.aborted) return false;
        const quota = (e as { kind?: string })?.kind === 'quota';
        diag.log('pretranslate-fail', { from, n, quota, msg: String((e as Error)?.message ?? e).slice(0, 100) });
        // a content failure (one sentence the model refuses, or a short answer) is cut down to single sentences, so the rest of
        // the batch is still translated; only the sentence that really fails is left without a translation
        if (!quota && n > 1 && depth < 6) {
          const h = Math.ceil(n / 2);
          const a1 = await run(from, h, depth + 1);
          const a2 = await run(from + h, n - h, depth + 1);
          return a1 && a2;
        }
        st.retryAt.set(b0, (this.o.now ?? Date.now)() + RETRY_AFTER_MS);
        return false;
      }
    };
    const p = run(b0, total, 0).finally(() => {
      // a failed batch is forgotten so that a later call may retry it (after retryAt)
      for (let i = 0; i < total; i++) if (!st.ru.has(b0 + i)) return void st.batches.delete(b0);
    });
    st.batches.set(b0, p);
    return p;
  }

  /**
   * Makes sure the batch holding sentence `idx` is translated (waiting at most `maxWaitMs`) and keeps translating ahead in the
   * background. Resolves true when sentence `idx` is in the store.
   */
  async ensure(sentences: readonly SourceSegment[], lang: string, idx: number, maxWaitMs: number): Promise<boolean> {
    const st = this.state(sentences, lang);
    if (st.ru.has(idx)) {
      this.runAhead(st, idx);
      return true;
    }
    const b0 = Math.floor(idx / this.batchSize) * this.batchSize;
    const now = (this.o.now ?? Date.now)();
    if ((st.retryAt.get(b0) ?? 0) > now) return false;
    const p = this.translateBatch(st, b0);
    this.runAhead(st, idx);
    const done = await Promise.race([p, new Promise<boolean>((r) => setTimeout(() => r(false), maxWaitMs))]);
    return done && st.ru.has(idx);
  }

  /** background loop: next batches until the horizon (earliest requested sentence + aheadSec) is covered; one request at a time */
  private runAhead(st: TrackState, idx: number): void {
    const t0 = st.sentences[idx]?.start ?? 0;
    st.horizon = Math.max(st.horizon, t0 + (this.o.aheadSec ?? PRETRANSLATE_AHEAD_SEC));
    if (st.running) return;
    st.running = true;
    void (async () => {
      try {
        let b0 = Math.floor(idx / this.batchSize) * this.batchSize;
        while (b0 < st.sentences.length && st.sentences[b0]!.start <= st.horizon && !this.ctrl.signal.aborted) {
          const now = (this.o.now ?? Date.now)();
          if ((st.retryAt.get(b0) ?? 0) > now) break;
          const ok = await this.translateBatch(st, b0);
          if (!ok) break;
          b0 += this.batchSize;
        }
      } finally {
        st.running = false;
      }
    })();
  }

  dispose(): void {
    this.ctrl.abort();
  }
}
