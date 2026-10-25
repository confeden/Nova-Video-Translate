import { diag } from '../../diag';
import type { AsrStage } from '../cascade/provider';
import type { AudioChunk } from '../types';
import type { SourceSegment } from '../cascade/segments';

export type LiveAsrMode = 'auto' | 'local' | 'groq';

type Transcribed = { segments: SourceSegment[]; sourceLang?: string; speechBursts?: { start: number; end: number }[] };

/** per-request budget of the cloud recognizer; past it the chunk is recognised locally instead */
export const GROQ_ASR_TIMEOUT_MS = 8000;
/** consecutive failures that put Groq on cooldown, and for how long */
export const GROQ_ASR_FAILS_BEFORE_COOLDOWN = 2;
export const GROQ_ASR_COOLDOWN_MS = 120_000;
/** auto: Groq slower than local by more than this for this many chunks in a row -> local for LOCAL_PREFERRED_MS */
export const GROQ_SLOWER_BY_MS = 1500;
export const GROQ_SLOWER_CHUNKS = 5;
export const LOCAL_PREFERRED_MS = 300_000;
const EWMA = 0.3;

export interface HybridLiveAsrOptions {
  local: AsrStage;
  groq: AsrStage;
  /** a Groq key exists (nothing is ever sent without one) */
  hasKey(): boolean;
  /** settings.liveAsr */
  mode(): LiveAsrMode;
  now?(): number;
  timeoutMs?: number;
}

/**
 * ASR stage of the local tier. Local chunks go to the local engine. LIVE chunks go to Groq Whisper when the setting allows it
 * (auto / groq) and a key exists; any error / 429 / timeout recognises that chunk locally, two failures in a row put Groq on a
 * 2 min cooldown. In 'auto' the choice is measured: both latencies are tracked (EWMA) and Groq is dropped for 5 min when it is
 * slower than the local engine by more than 1.5 s for 5 chunks in a row. The key is never logged.
 */
export class HybridLiveAsr implements AsrStage {
  readonly id = 'local-asr';
  private fails = 0;
  private cooldownUntil = 0;
  private localUntil = 0;
  private slowRun = 0;
  private groqMs?: number;
  private localMs?: number;
  private chosen = '';
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(private readonly o: HybridLiveAsrOptions) {
    this.now = o.now ?? Date.now;
    this.timeoutMs = o.timeoutMs ?? GROQ_ASR_TIMEOUT_MS;
  }

  private cloudAllowed(): boolean {
    return this.o.mode() !== 'local' && this.o.hasKey();
  }

  async available(): Promise<boolean> {
    if (this.cloudAllowed()) return true; // Groq can recognise without a downloaded model; a failure still falls back to local
    return this.o.local.available();
  }

  model(): string | Promise<string> {
    return this.o.local.model();
  }

  private choose(why: string, groq: boolean): void {
    const c = groq ? 'groq' : 'local';
    if (c === this.chosen) return;
    this.chosen = c;
    diag.log('asr-choice', { chosen: c, why, groqMs: this.groqMs !== undefined ? Math.round(this.groqMs) : undefined, localMs: this.localMs !== undefined ? Math.round(this.localMs) : undefined });
  }

  private async runLocal(chunk: AudioChunk, ctx: { signal: AbortSignal; sourceLang?: string; live?: boolean }): Promise<Transcribed> {
    const t0 = this.now();
    const r = await this.o.local.transcribe(chunk, ctx);
    const ms = this.now() - t0;
    this.localMs = this.localMs === undefined ? ms : this.localMs + EWMA * (ms - this.localMs);
    return r;
  }

  async transcribe(chunk: AudioChunk, ctx: { signal: AbortSignal; sourceLang?: string; live?: boolean }): Promise<Transcribed> {
    const t = this.now();
    const mode = this.o.mode();
    if (!ctx.live || !this.cloudAllowed()) {
      if (ctx.live) this.choose(mode === 'local' ? 'setting' : 'no-key', false);
      return this.runLocal(chunk, ctx);
    }
    if (t < this.cooldownUntil) {
      this.choose('cooldown', false);
      return this.runLocal(chunk, ctx);
    }
    if (mode === 'auto' && t < this.localUntil) {
      this.choose('slower', false);
      return this.runLocal(chunk, ctx);
    }
    this.choose(mode === 'groq' ? 'setting' : 'auto', true);
    const ac = new AbortController();
    const onParent = (): void => ac.abort();
    ctx.signal.addEventListener('abort', onParent, { once: true });
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        ac.abort();
        reject(new Error('groq asr timeout'));
      }, this.timeoutMs);
    });
    deadline.catch(() => {}); // the race below consumes it; this keeps a late rejection from being reported as unhandled
    try {
      const r = await Promise.race([this.o.groq.transcribe(chunk, { signal: ac.signal, sourceLang: ctx.sourceLang, live: ctx.live }), deadline]);
      const ms = this.now() - t;
      this.groqMs = this.groqMs === undefined ? ms : this.groqMs + EWMA * (ms - this.groqMs);
      this.fails = 0;
      if (mode === 'auto' && this.localMs !== undefined) {
        this.slowRun = ms - this.localMs > GROQ_SLOWER_BY_MS ? this.slowRun + 1 : 0;
        if (this.slowRun >= GROQ_SLOWER_CHUNKS) {
          this.slowRun = 0;
          this.localUntil = this.now() + LOCAL_PREFERRED_MS;
          this.chosen = '';
          this.choose('slower', false);
        }
      }
      return r;
    } catch (e) {
      if (ctx.signal.aborted) throw e; // the user / the engine cancelled the chunk: not a Groq fault
      const reason = timedOut ? 'timeout' : (e as { kind?: string })?.kind === 'quota' ? '429' : 'error';
      this.slowRun = 0;
      this.fails++;
      let cooldownSec = 0;
      if (this.fails >= GROQ_ASR_FAILS_BEFORE_COOLDOWN) {
        this.cooldownUntil = this.now() + GROQ_ASR_COOLDOWN_MS;
        this.fails = 0;
        cooldownSec = GROQ_ASR_COOLDOWN_MS / 1000;
      }
      diag.log('groq-asr-fallback', { reason, cooldownSec }); // never the error text: it may echo request details
      return this.runLocal(chunk, ctx);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onParent);
    }
  }
}
