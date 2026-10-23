import { diag } from '../diag';
import type { AudioChunk, ProviderId, SubtitleCue } from '../providers/types';
import type { Settings } from '../types';
import type { SubtitleCache } from './cache';
import { coverage, dedupeCues, mergeCues, normalizeCues } from './cues';
import { SubtitleUnavailable, type ChunkSource, type WholeSource } from './types';

export interface SubtitleControllerDeps {
  getSettings(): Settings;
  /** tried in order, the first that delivers wins */
  whole: WholeSource[];
  /** used only when no whole source delivered; first available one wins, a dead one hands over to the next */
  chunk: ChunkSource[];
  cache?: SubtitleCache;
  currentTime(): number;
  /** merged cue list for the overlay (called on every change) */
  onCues(cues: SubtitleCue[]): void;
  /** visible source name ('Субтитры: Яндекс'), undefined when nothing runs */
  onStatus(label: string | undefined): void;
  /** called at most once per start(): 'Субтитры недоступны: …' reason in Russian */
  onFail(reason: string): void;
  /** delay before re-trying a failed cell (tests inject 0) */
  retryMs?: number;
}

const MAX_PENDING = 8;
const VOICE_COVER_SKIP = 0.6;
const DEAD_AFTER = 4;

interface Pending {
  chunk: AudioChunk;
  tries: number;
}

/**
 * Subtitles independent of the voice tier. Strictly opt-in (I4): nothing is called unless settings.subtitles === 'on'.
 * Chain: whole-timeline sources in order (Yandex, YouTube captions + translation) -> chunk transcription (Gemini text
 * call, then Chrome AI). Layers: voice cues (Gemini voice, from the engine) > whole > chunk, merged by time overlap.
 */
export class SubtitleController {
  private ctrl?: AbortController;
  private runId = 0;
  private label?: string;
  private failed = false;
  private voiceCues: SubtitleCue[] = [];
  private wholeCues: SubtitleCue[] = [];
  private chunkCues: SubtitleCue[] = [];
  private mode: 'idle' | 'resolving' | 'whole' | 'chunk' | 'failed' = 'idle';
  private queue: Pending[] = [];
  private active: ChunkSource | undefined;
  private dead = new Set<ChunkSource>();
  private failStreak = 0;
  private working = false;
  private voiceTier?: ProviderId;
  private seen = new Set<number>();
  private timer?: ReturnType<typeof setTimeout>;
  /** requests issued to sources, for tests / diagnostics */
  readonly stats = { chunksProcessed: 0, cacheHits: 0, skippedByVoice: 0 };

  constructor(private readonly d: SubtitleControllerDeps) {}

  get source(): string | undefined {
    return this.label;
  }
  get state(): SubtitleController['mode'] {
    return this.mode;
  }
  private get on(): boolean {
    return this.d.getSettings().subtitles === 'on';
  }

  /** Starts the chain. No-op (and no source is touched) unless subtitles are enabled. Safe to call again. */
  start(): void {
    if (!this.on || this.mode !== 'idle') return;
    this.ctrl = new AbortController();
    this.mode = 'resolving';
    this.failed = false;
    const run = ++this.runId;
    void this.resolve(run, this.ctrl.signal);
  }

  stop(): void {
    this.runId++;
    this.ctrl?.abort();
    this.ctrl = undefined;
    clearTimeout(this.timer);
    this.mode = 'idle';
    this.queue = [];
    this.seen.clear();
    this.wholeCues = [];
    this.chunkCues = [];
    this.voiceCues = [];
    this.dead.clear();
    this.active = undefined;
    this.failStreak = 0;
    this.working = false;
    this.setLabel(undefined);
    this.emit();
  }

  /** the settings changed (the toggle in the panel): off stops everything, on starts if a session is running */
  applySettings(sessionActive: boolean): void {
    if (!this.on) {
      if (this.mode !== 'idle') this.stop();
    } else if (sessionActive) this.start();
  }

  /** Gemini-voice cues from the engine (full list each time) */
  setVoiceCues(cues: readonly SubtitleCue[]): void {
    if (!this.on) return;
    this.voiceCues = normalizeCues(cues);
    this.emit();
  }

  /** which tier voiced the latest chunk; with Gemini voicing the engine already produces cues */
  noteVoiceTier(id: ProviderId): void {
    this.voiceTier = id;
  }

  /** every rechunked chunk from EngineEvents.onChunk */
  feedChunk(chunk: AudioChunk): void {
    if (!this.on || this.mode === 'idle' || this.mode === 'whole' || this.mode === 'failed') return;
    if (this.seen.has(chunk.startSec) && !this.queue.some((p) => p.chunk.startSec === chunk.startSec)) return;
    const i = this.queue.findIndex((p) => p.chunk.startSec === chunk.startSec);
    if (i >= 0) this.queue[i] = { chunk, tries: this.queue[i]!.tries };
    else this.queue.push({ chunk, tries: 0 });
    // memory: while the chain is still resolving keep only the latest few chunks
    while (this.queue.length > MAX_PENDING) this.queue.shift();
    // next microtask: chunks fed in the same tick are ordered by time before the first one is taken
    if (this.mode === 'chunk') void Promise.resolve().then(() => this.pump());
  }

  // ---- internals ----

  private async resolve(run: number, signal: AbortSignal): Promise<void> {
    const reasons: string[] = [];
    for (const src of this.d.whole) {
      if (run !== this.runId) return;
      let ok = false;
      try {
        ok = await src.isAvailable();
      } catch {
        ok = false;
      }
      if (!ok) {
        reasons.push(`${src.label}: ${src.unavailableReason?.() ?? 'недоступно'}`);
        diag.log('subs-source-skip', { source: src.id });
        continue;
      }
      this.setLabel(`${src.label}…`);
      let committed = false;
      try {
        const cues = await src.load({
          signal,
          currentTime: () => this.d.currentTime(),
          onPartial: (c) => {
            if (run !== this.runId || c.length === 0) return;
            committed = true;
            this.mode = 'whole';
            this.queue = [];
            this.wholeCues = c;
            this.emit();
          },
          setLabel: (l) => {
            if (run === this.runId) this.setLabel(l);
          },
        });
        if (run !== this.runId) return;
        if (cues.length > 0) {
          this.mode = 'whole';
          this.queue = [];
          this.wholeCues = cues;
          this.setLabel(this.labelIsRefined(src) ? this.label : src.label);
          diag.log('subs-source', { source: src.id, cues: cues.length });
          this.emit();
          return;
        }
        reasons.push(`${src.label}: нет текста`);
      } catch (e) {
        if (run !== this.runId || signal.aborted) return;
        const msg = e instanceof SubtitleUnavailable ? e.message : String((e as Error)?.message ?? e).slice(0, 100);
        diag.log('subs-source-failed', { source: src.id, error: msg });
        if (committed) {
          // had partial output: keep it, do not fall through to a second source
          this.fail(`${src.label}: ${msg}`, true);
          return;
        }
        reasons.push(`${src.label}: ${msg}`);
      }
    }
    if (run !== this.runId) return;
    // no whole-timeline source delivered: transcribe chunks
    this.mode = 'chunk';
    this.setLabel(undefined);
    await this.pickChunkSource(reasons);
    if (this.mode === 'chunk') void this.pump();
  }

  private labelIsRefined(src: WholeSource): boolean {
    return !!this.label && this.label !== `${src.label}…` && this.label !== src.label;
  }

  private async pickChunkSource(reasons: string[]): Promise<void> {
    const run = this.runId;
    for (const s of this.d.chunk) {
      if (this.dead.has(s)) continue;
      let ok = false;
      try {
        ok = await s.isAvailable();
      } catch {
        ok = false;
      }
      if (run !== this.runId) return;
      if (ok) {
        this.active = s;
        this.setLabel(s.label);
        diag.log('subs-source', { source: s.id, mode: 'chunks' });
        return;
      }
      reasons.push(`${s.label}: ${s.unavailableReason?.() ?? 'недоступно'}`);
      this.dead.add(s);
    }
    this.active = undefined;
    this.fail(reasons.join('; ') || 'нет источника субтитров');
  }

  private fail(reason: string, keepCues = false): void {
    if (!keepCues) this.mode = 'failed';
    this.queue = [];
    if (!this.failed) {
      this.failed = true;
      diag.log('subs-failed', { reason });
      this.d.onFail(`Субтитры недоступны: ${reason.length > 220 ? `${reason.slice(0, 217)}…` : reason}`);
    }
    if (!keepCues) this.setLabel(undefined);
  }

  private async pump(): Promise<void> {
    if (this.working || this.mode !== 'chunk') return;
    if (!this.active) {
      await this.pickChunkSource([]);
      if (!this.active) return;
    }
    this.working = true;
    const run = this.runId;
    const signal = this.ctrl!.signal;
    try {
      while (run === this.runId && this.mode === 'chunk' && this.queue.length > 0 && this.active) {
        const now = this.d.currentTime();
        // drop cells already behind the playhead, then take the nearest one ahead
        this.queue = this.queue.filter((p) => p.chunk.startSec + p.chunk.durationSec > now - 2);
        this.queue.sort((a, b) => a.chunk.startSec - b.chunk.startSec);
        const item = this.queue.shift();
        if (!item) break;
        const c = item.chunk;
        const end = c.startSec + c.durationSec;
        if (this.voiceTier === 'gemini' || coverage(this.voiceCues, c.startSec, end) >= VOICE_COVER_SKIP) {
          this.stats.skippedByVoice++;
          this.seen.add(c.startSec);
          continue;
        }
        const src = this.active;
        const kind = `chunk:${src.id}`;
        const cell = c.startSec;
        const hit = c.partial ? undefined : await this.d.cache?.get(kind, cell);
        if (run !== this.runId) return;
        let cues: SubtitleCue[] | undefined = hit;
        if (hit) this.stats.cacheHits++;
        else {
          try {
            cues = await src.transcribe(c, signal);
            this.failStreak = 0;
            this.stats.chunksProcessed++;
            if (!c.partial) void this.d.cache?.put(kind, cell, cues);
          } catch (e) {
            if (run !== this.runId || signal.aborted) return;
            const unavailable = e instanceof SubtitleUnavailable;
            diag.log('subs-chunk-failed', { source: src.id, cell, error: String((e as Error)?.message ?? e).slice(0, 100) });
            if (unavailable || ++this.failStreak >= DEAD_AFTER) {
              this.dead.add(src);
              this.active = undefined;
              this.queue.unshift(item);
              await this.pickChunkSource([`${src.label}: ${(e as Error)?.message ?? 'сбой'}`]);
              if (!this.active) return;
              continue;
            }
            if (++item.tries <= 1) {
              this.queue.unshift(item);
              await new Promise((r) => (this.timer = setTimeout(r, this.d.retryMs ?? 4000)));
            }
            continue;
          }
        }
        this.seen.add(c.startSec);
        if (cues && cues.length > 0) {
          this.chunkCues = dedupeCues([...this.chunkCues, ...cues]);
          this.emit();
        }
      }
    } finally {
      if (run === this.runId) this.working = false;
    }
    if (run === this.runId && this.mode === 'chunk' && this.queue.length > 0 && this.active) void this.pump();
  }

  private setLabel(l: string | undefined): void {
    if (this.label === l) return;
    this.label = l;
    this.d.onStatus(l);
  }

  private emit(): void {
    this.d.onCues(mergeCues([this.voiceCues, this.wholeCues, this.chunkCues]));
  }
}

/** Status line text for the settings panel / diagnostics. */
export function subtitleStatusText(label: string | undefined): string | undefined {
  return label ? `Субтитры: ${label}` : undefined;
}
