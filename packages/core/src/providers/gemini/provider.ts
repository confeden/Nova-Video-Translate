import { estimateF0 } from '../../audio/pitch';
import { diag } from '../../diag';
import { KeyPool } from '../../keypool';
import { pickModels, type FetchFn } from '../../models';
import type {
  AudioChunk,
  ChunkResult,
  DubProvider,
  DubSegment,
  ProviderContext,
  SubtitleCue,
} from '../types';
import { ProviderUnavailableError } from '../types';
import { GeminiClient } from './client';
import { fitSegments, type FitOptions } from './sync';
import { translateChunkAudio } from './translate';
import { joinSentences, synthesizeAllSettled, synthesizeRun, type TtsOptions, type TtsResult } from './tts';
import { GEMINI_FIXED_VOICE, GEMINI_FIXED_VOICE_NAME, chooseVoices, newVoiceMemory, type VoiceMap, type VoiceMemory } from './voices';

export type ModelRole = 'translate' | 'tts';

/** Ordered preferences; the first pattern that matches any available id wins (I2: no hardcoded ids). */
export const TRANSLATE_PREFERENCES: RegExp[] = [/3\.\d+-flash-lite$/, /flash-lite/, /flash$/];
export const TTS_PREFERENCES: RegExp[] = [/3\.1-flash-tts/, /flash-tts/, /tts/];
/** Fallback order for TTS candidates: 3.1 preview, other 3.x flash, erratic lite, 2.5, rest. Pro goes last. */
const TTS_ORDER: RegExp[] = [
  /3\.1-flash-tts/,
  /3\.\d+-flash-tts/,
  /2\.5.*tts/,
  /flash.*tts/,
  /tts/,
];
const TTS_LAST_RESORT = /pro/i;
/** *-flash-lite-tts end segments abruptly and run erratically long: after everything else. */
const TTS_DEMOTED = /flash-lite.*tts/i;

/** Ids that can never be the audio->text translate model. */
const NOT_TRANSLATE = /tts|live|audio|image|transcribe|embed|imagen|veo|aqa/i;

export interface GeminiProviderOptions {
  keys: string[] | KeyPool;
  /** user overrides (Settings.geminiModels); empty string = auto */
  models?: () => { translate?: string; tts?: string };
  /** replaces the default ListModels-based resolution entirely */
  resolveModel?: (role: ModelRole) => Promise<string>;
  fetch?: FetchFn;
  tts?: Omit<TtsOptions, 'signal'>;
  /**
   * INTERNAL override only (D20: voices are automatic, no user setting). When undefined (default) the voice is
   * chosen from the speaker's gender + f0 pitch class and kept sticky through `voiceMemory`.
   */
  voices?: Partial<VoiceMap> | (() => Partial<VoiceMap> | undefined);
  /**
   * Sticky per-video voice state (plain JSON, mutated in place). Pass one the caller persists / resets per video;
   * default: a fresh in-memory one per provider instance.
   */
  voiceMemory?: VoiceMemory;
  /** one fixed male voice for everything, no gender / f0 detection (D27); default GEMINI_FIXED_VOICE unless `voices` overrides are given. false = automatic voices (D20) */
  fixedVoice?: boolean;
  /** one TTS call per run of same-voice sentences (default true); false = one call per sentence */
  chunkCalls?: boolean;
  sync?: FitOptions;
}

const MAX_RUN_SENTENCES = 8;
const MAX_RUN_CHARS = 700;

/** Groups consecutive sentences with the same voice into runs (one TTS call each). */
function groupRuns(voices: string[], texts: string[], chunked: boolean): number[][] {
  const runs: number[][] = [];
  let cur: number[] = [];
  let chars = 0;
  for (let i = 0; i < texts.length; i++) {
    const len = texts[i]!.length;
    const same = cur.length > 0 && voices[cur[0]!] === voices[i];
    if (chunked && same && cur.length < MAX_RUN_SENTENCES && chars + len <= MAX_RUN_CHARS) {
      cur.push(i);
      chars += len;
    } else {
      if (cur.length) runs.push(cur);
      cur = [i];
      chars = len;
    }
  }
  if (cur.length) runs.push(cur);
  return runs;
}

interface VoicePhase {
  audio: (TtsResult | undefined)[];
  errors: unknown[];
}

export class GeminiProvider implements DubProvider {
  readonly id = 'gemini' as const;
  readonly label = 'Gemini';
  private readonly client: GeminiClient;
  private readonly pool: KeyPool;
  private readonly cache = new Map<ModelRole, string[]>();
  private readonly memory: VoiceMemory;

  constructor(private readonly opts: GeminiProviderOptions) {
    this.pool = Array.isArray(opts.keys) ? new KeyPool(opts.keys) : opts.keys;
    this.client = new GeminiClient({ keys: this.pool, fetch: opts.fetch });
    this.memory = opts.voiceMemory ?? newVoiceMemory();
  }

  isConfigured(): boolean {
    return this.pool.current() !== undefined;
  }

  async resolveModel(role: ModelRole, signal?: AbortSignal): Promise<string> {
    const [first] = await this.resolveModels(role, signal);
    if (first === undefined) {
      throw new ProviderUnavailableError(`no Gemini ${role} model available`, 'gemini', 'unsupported');
    }
    return first;
  }

  /** Ordered candidates for a role: user override first, then ListModels matches (cached). */
  async resolveModels(role: ModelRole, signal?: AbortSignal): Promise<string[]> {
    if (this.opts.resolveModel) return [await this.opts.resolveModel(role)];
    const override = this.opts.models?.()[role]?.trim();
    const listed = await this.listCandidates(role, signal);
    const out = override ? [override, ...listed.filter((m) => m !== override)] : listed;
    if (out.length === 0) {
      throw new ProviderUnavailableError(`no Gemini ${role} model available`, 'gemini', 'unsupported');
    }
    return out;
  }

  private async listCandidates(role: ModelRole, signal?: AbortSignal): Promise<string[]> {
    const cached = this.cache.get(role);
    if (cached) return cached;
    const models = await this.client.listModels(signal);
    const ids = models
      .filter((m) => m.supportedGenerationMethods.includes('generateContent'))
      .map((m) => m.id)
      .filter((id) => role !== 'translate' || !NOT_TRANSLATE.test(id));
    let picked: string[];
    if (role === 'translate') {
      picked = pickModels(ids, TRANSLATE_PREFERENCES);
    } else {
      const all = pickModels(ids, [...TTS_ORDER, TTS_DEMOTED]);
      const rank = (m: string) => (TTS_DEMOTED.test(m) ? 2 : TTS_LAST_RESORT.test(m) ? 1 : 0);
      picked = [0, 1, 2].flatMap((r) => all.filter((m) => rank(m) === r));
    }
    this.cache.set(role, picked);
    return picked;
  }

  /**
   * Runs `fn` with the candidate models. A user override is tried alone first (no ListModels call);
   * only if its quota is exhausted are the ListModels candidates appended.
   */
  private async withModels<T>(
    role: ModelRole,
    signal: AbortSignal | undefined,
    fn: (models: string[]) => Promise<T>,
  ): Promise<T> {
    const override = this.opts.resolveModel ? undefined : this.opts.models?.()[role]?.trim();
    if (!override) return fn(await this.resolveModels(role, signal));
    try {
      return await fn([override]);
    } catch (e) {
      if (!(e instanceof ProviderUnavailableError) || e.kind !== 'quota') throw e;
      let rest: string[];
      try {
        rest = await this.listCandidates(role, signal);
      } catch {
        throw e;
      }
      const more = rest.filter((m) => m !== override);
      if (more.length === 0) throw e;
      return fn([override, ...more]);
    }
  }

  /** Voices every sentence: one call per same-voice run, split by silence alignment, per-sentence fallback. */
  private async voicePhase(
    models: string[],
    texts: string[],
    voices: string[],
    signal: AbortSignal,
  ): Promise<VoicePhase> {
    const audio: (TtsResult | undefined)[] = new Array(texts.length);
    const errors: unknown[] = [];
    const runs = groupRuns(voices, texts, this.opts.chunkCalls !== false);
    const base = { ...this.opts.tts, signal };
    let next = 0;
    let stop = false;
    const fatal = (e: unknown) => e instanceof ProviderUnavailableError && (e.kind === 'quota' || e.kind === 'auth');
    const worker = async () => {
      while (!stop) {
        const run = runs[next++];
        if (!run) return;
        const voice = voices[run[0]!];
        const t0 = Date.now();
        const rt = run.map((i) => texts[i]!);
        const info: Record<string, unknown> = { sentences: run.length, chars: rt.join('').length, voice };
        try {
          if (run.length > 1) {
            const r = await synthesizeRun(this.client, models, rt, { ...base, voice });
            info.sec = Math.round(r.whole.seconds * 10) / 10;
            info.confidence = Math.round(r.align.confidence * 100) / 100;
            if (r.clips) {
              run.forEach((i, k) => (audio[i] = r.clips![k]));
              info.aligned = true;
              info.ms = Date.now() - t0;
              diag.log('gemini-tts-run', info);
              continue;
            }
            info.aligned = false;
            info.reason = r.align.reason;
          }
          // single sentence, or the alignment was not trustworthy: one call per sentence
          const settled = await synthesizeAllSettled(
            this.client,
            models,
            run.map((i) => ({ text: texts[i]!, voice })),
            base,
          );
          settled.forEach((s, k) => {
            if (s.result) audio[run[k]!] = s.result;
            else {
              errors.push(s.error);
              if (fatal(s.error)) stop = true;
            }
          });
          info.fallback = run.length > 1;
        } catch (e) {
          if (signal.aborted) throw e;
          errors.push(e);
          info.error = e instanceof ProviderUnavailableError ? e.kind : String(e).slice(0, 80);
          if (fatal(e)) stop = true;
        }
        info.ms = Date.now() - t0;
        diag.log('gemini-tts-run', info);
      }
    };
    const n = Math.max(1, Math.min(this.opts.tts?.concurrency ?? 3, runs.length));
    await Promise.all(Array.from({ length: n }, worker));
    // nothing voiced because of quota/auth: let withModels try the other model candidates
    if (!audio.some(Boolean)) {
      const q = errors.find(fatal);
      if (q) throw q;
    }
    return { audio, errors };
  }

  async translateChunk(chunk: AudioChunk, ctx: ProviderContext): Promise<ChunkResult> {
    const tr = await this.withModels('translate', ctx.signal, (models) =>
      translateChunkAudio(this.client, models, chunk, {
        sourceLangHint: ctx.sourceLang,
        signal: ctx.signal,
      }),
    );
    if (tr.sourceLang === 'ru') return { segments: [], sourceLang: 'ru' };
    // no speech / music: a clean empty result (the engine must not duck for it)
    if (tr.segments.length === 0) return { segments: [], sourceLang: tr.sourceLang || undefined };

    let choices: Array<{ voice: string }>;
    if (this.opts.fixedVoice ?? (GEMINI_FIXED_VOICE && this.opts.voices === undefined)) {
      choices = tr.segments.map(() => ({ voice: GEMINI_FIXED_VOICE_NAME }));
    } else {
      const vopt = typeof this.opts.voices === 'function' ? this.opts.voices() : this.opts.voices;
      const auto = chooseVoices(
        tr.segments,
        (idx) =>
          estimateF0(chunk.pcm, chunk.sampleRate, {
            ranges: idx.map((i) => [tr.segments[i]!.start, tr.segments[i]!.end] as [number, number]),
          }).f0,
        this.memory,
        vopt,
      );
      diag.log('gemini-voices', {
        voices: auto.map((c) => c.voice).join(','),
        f0: auto.map((c) => Math.round(c.f0)).join(','),
        cls: auto.map((c) => c.cls ?? '-').join(','),
      });
      choices = auto;
    }
    const texts = tr.segments.map((s) => joinSentences([s.ru])); // consistent punctuation for every call
    const phase = await this.withModels('tts', ctx.signal, (models) =>
      this.voicePhase(
        models,
        texts,
        choices.map((c) => c.voice),
        ctx.signal,
      ),
    );
    const audio = phase.audio;
    if (!audio.some(Boolean)) {
      // sentences existed but none could be voiced (transient failures): surface the first error
      const first = phase.errors[0];
      throw first instanceof Error
        ? first
        : new ProviderUnavailableError('tts failed for every segment', 'gemini', 'failed');
    }

    const fits = fitSegments(
      tr.segments.map((s, i) => ({
        start: s.start,
        end: s.end,
        ttsSeconds: audio[i]?.seconds ?? 0,
        text: s.ru,
      })),
      { limitEnd: chunk.durationSec, ...this.opts.sync },
    );

    const segments: DubSegment[] = [];
    const subtitles: SubtitleCue[] = [];
    const failed: { start: number; end: number }[] = [];
    tr.segments.forEach((s, i) => {
      const a = audio[i];
      const f = fits[i];
      if (ctx.wantSubtitles) {
        subtitles.push({ start: chunk.startSec + s.start, end: chunk.startSec + s.end, src: s.src, text: s.ru });
      }
      if (!a || !f) {
        failed.push({ start: chunk.startSec + s.start, end: chunk.startSec + s.end });
        return;
      }
      segments.push({
        start: chunk.startSec + f.start,
        end: chunk.startSec + f.end,
        audio: { kind: 'pcm', sampleRate: a.sampleRate, samples: a.pcm },
        src: s.src,
        text: s.ru,
        rate: f.rate,
      });
    });
    const result: ChunkResult = { segments, sourceLang: tr.sourceLang };
    if (ctx.wantSubtitles) result.subtitles = subtitles;
    if (failed.length > 0) {
      result.failedSegments = failed;
      diag.log('gemini-partial', { voiced: segments.length, failed: failed.length });
    }
    return result;
  }
}
