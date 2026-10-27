/**
 * Shared engine of the 'groq' and 'local' tiers (D30): source segments (platform captions when ready, else an ASR stage)
 * -> text translation to Russian (ordered translators with fail-over, YouTube tlang as the last resort) -> local TTS per
 * sentence -> D10 fit. Produces the same ChunkResult as every other tier, so planner / scheduler / cache / upgrade logic
 * work unchanged.
 */
import { diag } from '../../diag';
import { localReasons, reasonText } from '../../localasr/localReason';
import type { LocalTtsEngine, LocalTtsEngineId } from '../../localtts/types';
import { localTtsRegistry, type LocalTtsRegistry } from '../../localtts/registry';
import type { FitOptions } from '../gemini/sync';
import type { AudioChunk, CacheSignature, ChunkResult, DubProvider, ProviderContext, ProviderId, SubtitleCue } from '../types';
import { ProviderUnavailableError } from '../types';
import { alignTlang, censoredInRange, type CaptionTimeline } from './captions';
import { budgetFor, type SourceSegment } from './segments';
import type { CaptionPretranslator } from './pretranslate';
import { translateWithFailover, type TextItem, type TextTranslator } from './translate';
import { voiceSegments } from './voice';
import { SpeakerTracker, sentencePitch } from '../../audio/speakerGender';

/** Audio -> timed source sentences (absolute video seconds). */
export interface AsrStage {
  readonly id: string;
  /** cheap readiness (never downloads) */
  available(): Promise<boolean>;
  /** cache-key ingredient: the recognition model / engine in use */
  model(): string | Promise<string>;
  transcribe(chunk: AudioChunk, ctx: { signal: AbortSignal; sourceLang?: string; live?: boolean }): Promise<{ segments: SourceSegment[]; sourceLang?: string; speechBursts?: { start: number; end: number }[] }>;
}

export interface CascadeOptions {
  id: Extract<ProviderId, 'groq' | 'local'>;
  label: string;
  /** audio recognition; absent = captions only */
  asr?: AsrStage;
  /** extra gate (Groq: an API key is set) */
  gate?(): boolean;
  /** translators in priority order (evaluated per call: keys / settings may change) */
  translators(): TextTranslator[];
  tts?: LocalTtsRegistry;
  ttsOrder?: readonly LocalTtsEngineId[];
  voice?: string;
  /** platform captions of the current video */
  captions?: () => CaptionTimeline | undefined;
  sync?: FitOptions;
  ttsConcurrency?: number;
  ttsTimeoutMs?: number;
  /** longest wait for the caption track at the start of a chunk (default 2500 ms) */
  captionWaitMs?: number;
  /** batch pre-translation of caption tracks (shared by the tiers of one page); absent = one translator call per cell */
  pretranslate?: CaptionPretranslator;
  /** wall-clock watchdog of the whole chunk (default 90 s) */
  chunkTimeoutMs?: number;
}

export const CASCADE_CHUNK_TIMEOUT_MS = 90_000;

export class CascadeProvider implements DubProvider {
  readonly id: CascadeOptions['id'];
  readonly label: string;
  private ready = false;
  private engine?: LocalTtsEngine;
  /** session speaker class (male / female-or-child) of the ORIGINAL audio, with hysteresis */
  private readonly speaker = new SpeakerTracker();

  constructor(protected readonly o: CascadeOptions) {
    this.id = o.id;
    this.label = o.label;
  }

  private get tts(): LocalTtsRegistry {
    return this.o.tts ?? localTtsRegistry;
  }

  /** sync answer of the last probe(); false until probe() ran */
  isConfigured(): boolean {
    return this.ready && (this.o.gate?.() ?? true);
  }

  /** async readiness: a TTS engine AND (an ASR stage OR platform captions) AND a translator. Never silently "ok". */
  async usable(): Promise<boolean> {
    await this.probe();
    return this.isConfigured();
  }

  async probe(): Promise<void> {
    const gate = this.o.gate?.() ?? true;
    if (!gate) {
      this.ready = false;
      return;
    }
    this.engine = await this.tts.pick(this.o.ttsOrder);
    if (!this.engine && this.id === 'local') this.noTts();
    let source = false;
    let asrOk = false;
    if (this.o.asr) {
      try {
        asrOk = await this.o.asr.available();
      } catch {
        asrOk = false;
      }
      source = asrOk;
    }
    const cap = this.o.captions?.();
    if (!source && cap) source = !!(await cap.get(undefined, this.o.captionWaitMs ?? 3000).catch(() => undefined));
    let translate = false;
    for (const t of this.o.translators()) {
      try {
        if (await t.isAvailable('en')) {
          translate = true;
          break;
        }
      } catch {
        /* next */
      }
    }
    if (!translate && cap?.machineRu) translate = !!cap.peek();
    this.ready = !!this.engine && source && translate;
    diag.log(`${this.id}-probe`, { tts: this.engine?.id, asr: asrOk, captions: !!cap?.peek(), translate, usable: this.ready });
  }

  private noTts(): void {
    localReasons.set('tts', reasonText.tts());
    diag.log('local-reason', { why: 'tts' });
  }

  async cacheSignature(): Promise<CacheSignature> {
    const engine = this.engine ?? (await this.tts.pick(this.o.ttsOrder));
    // the user's pinned male / female voices change the audio, so they are part of the key (auto = unchanged key)
    const pref = this.tts.preference();
    const pinned = [pref?.voiceMale, pref?.voiceFemale].map((v) => (v && v !== 'auto' ? v : '')).join('/');
    return { translateModel: this.o.asr ? await this.o.asr.model() : 'captions', ttsModel: engine?.id ?? 'none', voice: (this.o.voice ?? 'standard') + (pinned !== '/' ? `+${pinned}` : '') };
  }

  async translateChunk(chunk: AudioChunk, ctx: ProviderContext): Promise<ChunkResult> {
    const ac = new AbortController();
    const onParent = (): void => ac.abort();
    ctx.signal.addEventListener('abort', onParent, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, this.o.chunkTimeoutMs ?? CASCADE_CHUNK_TIMEOUT_MS);
    try {
      return await this.run(chunk, { ...ctx, signal: ac.signal });
    } catch (e) {
      if (timedOut && !ctx.signal.aborted) throw new ProviderUnavailableError(`${this.label}: chunk timeout`, this.id, 'network', undefined, true);
      throw e;
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onParent);
    }
  }

  /** per sentence: the speaker class after hearing it ('m' until a confident female phrase); never throws */
  private classifySpeakers(chunk: AudioChunk, segs: readonly SourceSegment[], bursts?: readonly { start: number; end: number }[]): ('m' | 'f')[] {
    const cls = (): 'm' | 'f' => (this.speaker.state === 'female_or_child' ? 'f' : 'm');
    const out: ('m' | 'f')[] = [];
    if (chunk.pcm.length === 0) return segs.map(cls);
    let top: { f0: number; voicedSec: number; tilt?: number; gender: string } | undefined;
    for (const s of segs) {
      try {
        const p = sentencePitch(chunk.pcm, chunk.sampleRate, chunk.startSec, s, bursts);
        const u = this.speaker.update(p.f0, p.voicedSec, p.tilt, s.end);
        out.push(cls());
        if (!top || p.voicedSec > top.voicedSec) top = { f0: p.f0, voicedSec: p.voicedSec, tilt: p.tilt, gender: u.gender };
      } catch {
        out.push(cls());
      }
    }
    if (top) diag.log('speaker', { f0Hz: Math.round(top.f0), voicedSec: Math.round(top.voicedSec * 10) / 10, ...(top.tilt !== undefined ? { tilt: top.tilt } : {}), gender: top.gender, state: this.speaker.state });
    return out;
  }

  private async run(chunk: AudioChunk, ctx: ProviderContext): Promise<ChunkResult> {
    const id = this.id;
    const t0 = Date.now();
    const end = chunk.startSec + chunk.durationSec;
    const engine = this.engine ?? (await this.tts.pick(this.o.ttsOrder));
    if (!engine) {
      if (id === 'local') this.noTts();
      throw new ProviderUnavailableError('no local TTS engine available', id, 'unsupported');
    }
    if (id === 'local') localReasons.clear('tts');
    this.engine = engine;

    // 1. source sentences: captions shortcut first, else ASR
    let segs: SourceSegment[] = [];
    let bursts: { start: number; end: number }[] | undefined;
    let sourceLang = ctx.sourceLang ?? '';
    let from: 'captions' | 'asr' = 'asr';
    let nextStart: number | undefined;
    const cap = this.o.captions?.();
    const rawTrack = cap ? await cap.get(ctx.signal, this.o.captionWaitMs ?? 2500) : undefined;
    // 0.3.6 censorship bypass: platform captions write a bleeped word as [ __ ] (the audio still has it). A chunk with such a
    // placeholder is transcribed from the audio instead, when an ASR is available (Groq Whisper / local Whisper).
    const censored = !!rawTrack && censoredInRange(rawTrack.sentences, chunk.startSec, end - chunk.startSec);
    const track = censored && this.o.asr ? undefined : rawTrack;
    if (censored) diag.log(`${id}-censor-bypass`, { cell: chunk.startSec, asr: !!this.o.asr });
    if (track) {
      from = 'captions';
      sourceLang = track.lang || sourceLang;
      const all = track.sentences;
      if (track.lang === 'ru' && track.audioLang === 'ru') return { segments: [], sourceLang: 'ru' };
      segs = all.filter((s) => s.start >= chunk.startSec && s.start < end);
      const last = segs[segs.length - 1];
      nextStart = last ? all[all.indexOf(last) + 1]?.start : undefined;
      diag.log(`${id}-asr-ok`, { from, sentences: segs.length, lang: sourceLang, ms: Date.now() - t0 });
    } else if (this.o.asr) {
      const a0 = Date.now();
      diag.log(`${id}-asr-start`, { asr: this.o.asr.id, chunkSec: Math.round(chunk.durationSec * 10) / 10 });
      const r = await this.o.asr.transcribe(chunk, { signal: ctx.signal, sourceLang: ctx.sourceLang, live: ctx.live });
      segs = r.segments;
      bursts = r.speechBursts;
      sourceLang = r.sourceLang || sourceLang;
      diag.log(`${id}-asr-ok`, { from, asr: this.o.asr.id, sentences: segs.length, lang: sourceLang, ms: Date.now() - a0 });
    } else {
      throw new ProviderUnavailableError('no captions and no ASR engine', id, 'unsupported');
    }
    // a Russian caption track over non-Russian audio is already the translation
    const ruTrackAsTranslation = from === 'captions' && sourceLang === 'ru';
    if (sourceLang === 'ru' && !ruTrackAsTranslation) return { segments: [], sourceLang: 'ru' };
    if (segs.length === 0) return { segments: [], sourceLang: sourceLang || undefined };

    // 2. translation
    let texts: string[];
    if (ruTrackAsTranslation) {
      texts = segs.map((s) => s.text);
    } else {
      const items: TextItem[] = segs.map((s) => ({ text: s.text, maxChars: budgetFor(s.end - s.start) }));
      // captions: take the sentences from the batch store (one request per ~50 sentences, translated ahead of the playhead)
      let pre: (string | undefined)[] | undefined;
      const store = this.o.pretranslate;
      if (from === 'captions' && track && store && segs.length > 0) {
        const idx0 = track.sentences.indexOf(segs[0]!);
        if (idx0 >= 0) {
          // holes (undefined) are allowed: they are asked again below, the translated rest of the cell is kept
          const read = (): (string | undefined)[] | undefined => {
            const got = segs.map((_, k) => store.peek(track.sentences, idx0 + k));
            return got.some((x) => x) ? got : undefined;
          };
          await store.ensure(track.sentences, sourceLang, idx0, 8000).catch(() => false);
          pre = read();
          if (!pre || pre.some((x) => !x)) {
            // the cell crosses a batch boundary: ask for the batch of its last sentence too
            await store.ensure(track.sentences, sourceLang, idx0 + segs.length - 1, 8000).catch(() => false);
            pre = read();
          }
          if (pre) diag.log(`${id}-translate-ok`, { by: 'pretranslated', n: segs.length, chars: pre.reduce((a, x) => a + (x?.length ?? 0), 0), ms: Date.now() - t0 });
        }
      }
      try {
        if (pre) texts = pre.map((x) => x ?? '');
        else texts = (await translateWithFailover(this.o.translators(), items, sourceLang || 'en', ctx.signal, id)).texts;
        // sentences left empty (no store answer, or the translator skipped them) are asked again alone, once; a cell that is
        // entirely empty already failed as a whole and is not retried here
        const holes = texts.flatMap((t, i) => (t.trim() ? [] : [i]));
        if (holes.length > 0 && holes.length < texts.length) {
          const again = await translateWithFailover(this.o.translators(), holes.map((i) => items[i]!), sourceLang || 'en', ctx.signal, id).then(
            (r) => r.texts,
            () => [] as string[],
          );
          holes.forEach((i, k) => (texts[i] = (again[k] ?? '').trim()));
          diag.log(`${id}-translate-holes`, { holes: holes.length, n: texts.length, filled: holes.filter((i) => texts[i]).length });
        }
      } catch (e) {
        const mt = from === 'captions' && !ctx.signal.aborted ? await cap?.machineRu?.(ctx.signal) : undefined;
        if (!mt) throw e;
        texts = segs.map((s) => alignTlang(s, mt as SubtitleCue[]));
        diag.log(`${id}-translate-ok`, { by: 'tlang', n: segs.length, chars: texts.reduce((a, x) => a + x.length, 0) });
      }
    }
    const genders = this.classifySpeakers(chunk, segs, bursts);
    const items = segs.map((s, i) => ({ start: s.start, end: s.end, src: s.text, ru: (texts[i] ?? '').trim(), gender: genders[i] })).filter((x) => x.ru);
    if (items.length === 0) throw new ProviderUnavailableError('translation is empty', id, 'failed');

    // 3. voice + fit
    void this.tts.calibrate(engine.id);
    const v = await voiceSegments(items, { engine, tier: id, signal: ctx.signal, voice: this.o.voice, voiceFor: (g) => this.tts.voiceFor(engine.id, g), concurrency: this.o.ttsConcurrency, timeoutMs: this.o.ttsTimeoutMs, sync: this.o.sync, limitEnd: nextStart ?? end });
    if (v.segments.length === 0) {
      const first = v.errors[0];
      throw first instanceof Error ? first : new ProviderUnavailableError('tts failed for every sentence', id, 'failed');
    }
    const result: ChunkResult = { segments: v.segments.map((s) => ({ ...s, providerId: id })), sourceLang: ruTrackAsTranslation ? (track?.audioLang ?? 'en') : sourceLang || undefined };
    if (bursts && bursts.length) result.speechBursts = bursts;
    if (ctx.wantSubtitles) result.subtitles = items.map((x) => ({ start: x.start, end: x.end, src: x.src, text: x.ru }));
    if (v.failed.length > 0) {
      result.failedSegments = v.failed;
      diag.log(`${id}-partial`, { voiced: v.segments.length, failed: v.failed.length });
    }
    diag.log(`${id}-chunk-ok`, { from, sentences: items.length, voiced: v.segments.length, ms: Date.now() - t0 });
    return result;
  }
}
