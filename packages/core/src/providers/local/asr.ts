import { DEFAULT_LOCAL_ASR_ORDER, localAsrRegistry, type LocalAsrRegistry } from '../../localasr/registry';
import type { LocalAsr, LocalAsrEngineId } from '../../localasr/types';
import { diag } from '../../diag';
import { twitchChannelFromPath } from '../../capture/hls/playlist';
import { EMPTY_CHUNKS_BEFORE_REASON, localReasons, reasonText } from '../../localasr/localReason';
import { anchorSentences } from '../../localasr/anchor';
import { vadBursts, type VadResult } from '../../localasr/vad';
import { dropLeadingWords, overlapWords, stripNonSpeech } from '../../localasr/asrText';
import { SourceLangResolver, getBroadcasterLang, setResolvedSourceLang } from '../../localasr/sourceLang';
import { resampleInt16 } from '../gemini/translate';
import { ProviderUnavailableError, type AudioChunk } from '../types';
import type { AsrStage } from '../cascade/provider';
import { groupPhrases, isoLang, type SourceSegment } from '../cascade/segments';

/** ASR stage over the LocalAsr registry (Chrome Prompt API audio, whisper-wasm, helper): picks the first available engine. */
/** audio of the previous live chunk that is transcribed again at the start of the next one (measured: +9..35 % words at 8 s chunks) */
export const ASR_OVERLAP_SEC = 1.5;
/** overlap only for the live grid (cells <= this long); VOD chunks are long enough that a border cuts few words */
const OVERLAP_MAX_CHUNK_SEC = 10;
/** local-coverage diag every N chunks */
const COVERAGE_EVERY = 5;
/** the Whisper engines run without timestamps: their sentence times are estimates, re-anchored to the VAD bursts */
const isWhisper = (id: string): boolean => id.startsWith('whisper');

export class LocalAsrStage implements AsrStage {
  readonly id = 'local-asr';
  private last?: LocalAsr;
  private emptyRun = 0;
  private lastLang = '';
  /** the previous chunk: end time, its last ASR_OVERLAP_SEC of 16 kHz audio and its recognised text (for the overlap trick) */
  private prev?: { endSec: number; tail: Int16Array; text: string };
  private chunkNo = 0;
  private cov = { chunks: 0, chars: 0, sec: 0, empty: 0 };
  readonly resolver = new SourceLangResolver();
  constructor(
    private readonly registry: LocalAsrRegistry = localAsrRegistry,
    private readonly order: readonly LocalAsrEngineId[] = DEFAULT_LOCAL_ASR_ORDER,
    /** settings.sourceLang ('auto' or an ISO code) */
    private readonly getSourceSetting: () => string | undefined = () => undefined,
    /** broadcaster language of the current page (Twitch); default: the hint registry for the channel in the address bar */
    private readonly getBroadcaster: () => string | undefined = () => getBroadcasterLang(typeof location !== 'undefined' ? twitchChannelFromPath(location.pathname) : undefined),
  ) {}

  private pick(lang?: string): Promise<LocalAsr | undefined> {
    return this.registry.pick(this.order, lang);
  }

  async available(): Promise<boolean> {
    this.last = await this.pick();
    if (!this.last) {
      localReasons.set('no-model', reasonText.noModel(undefined));
      diag.log('local-reason', { why: 'no-model', lang: '?' });
    }
    return !!this.last;
  }

  model(): string {
    return this.last?.id ?? 'none';
  }

  async transcribe(chunk: AudioChunk, ctx: { signal: AbortSignal; sourceLang?: string }): Promise<{ segments: SourceSegment[]; sourceLang?: string; speechBursts?: { start: number; end: number }[] }> {
    // source language: setting > Twitch broadcaster > what the engine knows > Whisper detection (pinned after two agreeing chunks)
    const res = this.resolver.resolve({ setting: this.getSourceSetting(), broadcaster: this.getBroadcaster(), engine: ctx.sourceLang });
    const known = res.lang;
    setResolvedSourceLang(known);
    const eng = (await this.pick(known)) ?? this.last;
    if (!eng) {
      localReasons.set('no-model', reasonText.noModel(known));
      diag.log('local-reason', { why: 'no-model', lang: known ?? '?' });
      throw new ProviderUnavailableError('no local ASR engine available', 'local', 'unsupported');
    }
    this.last = eng;
    localReasons.clear('no-model');
    const pcm = resampleInt16(chunk.pcm, chunk.sampleRate, 16000);
    // overlap: the last 1.5 s of the previous chunk lead this one so a word cut by the border is heard whole; the words that
    // come out twice are dropped by text alignment below (Whisper engines only, contiguous live cells only)
    const pv = this.prev;
    const useOverlap = eng.id !== 'chrome-prompt-audio' && !!pv && chunk.durationSec <= OVERLAP_MAX_CHUNK_SEC && Math.abs(chunk.startSec - pv.endSec) < 0.35;
    const lead = useOverlap ? pv!.tail : new Int16Array(0);
    let input = pcm;
    if (lead.length) {
      input = new Int16Array(lead.length + pcm.length);
      input.set(lead);
      input.set(pcm, lead.length);
    }
    this.prev = undefined; // a failed / aborted call must not leave a stale tail
    // VAD runs next to the ASR request (the request is off-thread; ~1 ms for 8 s of audio)
    const asrP = eng.transcribe(input, { lang: known, signal: ctx.signal });
    const v0 = performance.now();
    let vad: VadResult | undefined;
    try {
      vad = vadBursts(input, 16000);
    } catch {
      vad = undefined;
    }
    const vadMs = performance.now() - v0;
    const r = await asrP;
    if (vad && ++this.chunkNo % COVERAGE_EVERY === 0) diag.log('vad', { bursts: vad.bursts.length, speechSec: Math.round(vad.speechSec * 10) / 10, noiseFloor: Math.round(vad.noiseFloorDb), ms: Math.round(vadMs * 10) / 10 });
    const leadSec = lead.length / 16000;
    const detected = r.detected ? this.resolver.observe(r.lang) : undefined;
    const lang = known || detected || isoLang(r.lang) || '';
    if (lang !== this.lastLang) {
      this.lastLang = lang;
      setResolvedSourceLang(lang);
      diag.log('local-lang', { lang: lang || '?', how: known ? res.source : detected ? (this.resolver.confirmed ? 'detected-pinned' : 'detected') : 'engine' });
    }
    // Whisper's descriptions of sound ([query], (music), notes) are not speech
    const speech = r.segments.map((s) => ({ ...s, text: stripNonSpeech(s.text) })).filter((s) => s.text);
    const fullText = speech.map((s) => s.text).join(' ');
    this.prev = { endSec: chunk.startSec + chunk.durationSec, tail: pcm.subarray(Math.max(0, pcm.length - Math.round(ASR_OVERLAP_SEC * 16000))), text: fullText };
    let segsOut = speech;
    if (useOverlap && pv) {
      const k = overlapWords(pv.text, fullText);
      if (k > 0) segsOut = dropLeadingWords(speech, k);
    }
    // anchor the sentences to the real speech bursts (context bursts excluded); no burst after the context = no speech
    let burstsOut: { start: number; end: number }[] | undefined;
    if (vad && segsOut.length > 0 && isWhisper(eng.id)) {
      const inSec = input.length / 16000;
      const placed = anchorSentences(segsOut.map((s) => s.text), vad.bursts, inSec, { contextSec: leadSec });
      if (placed.length === 0) {
        diag.log('chunk-no-speech', { text: fullText.length, bursts: vad.bursts.length, speechSec: Math.round(vad.speechSec * 10) / 10 });
        segsOut = [];
      } else {
        segsOut = placed;
        diag.log('anchor', { s: placed.length, b: vad.bursts.length, first: Math.round((placed[0]!.start - leadSec) * 100) / 100, last: Math.round((placed[placed.length - 1]!.end - leadSec) * 100) / 100 });
      }
    }
    if (vad) burstsOut = vad.bursts.filter((b) => b.end > leadSec).map((b) => ({ start: chunk.startSec + Math.max(0, b.start - leadSec), end: chunk.startSec + Math.min(chunk.durationSec, b.end - leadSec) }));
    // an empty transcript N times in a row is worth telling the user about (silence, or the wrong language)
    if (segsOut.length === 0) {
      this.emptyRun++;
      if (this.emptyRun >= EMPTY_CHUNKS_BEFORE_REASON) {
        localReasons.set('empty', reasonText.empty(this.emptyRun, lang));
        if (this.emptyRun === EMPTY_CHUNKS_BEFORE_REASON) diag.log('local-reason', { why: 'empty', n: this.emptyRun, lang: lang || '?' });
      }
    } else {
      this.emptyRun = 0;
      localReasons.clear('empty');
    }
    // coverage counters (chars per audio second of the NEW audio; text dropped as overlap is not counted)
    const c = this.cov;
    c.chunks++;
    c.sec += chunk.durationSec;
    c.chars += segsOut.reduce((n, s) => n + s.text.length, 0);
    if (segsOut.length === 0) c.empty++;
    if (c.chunks >= COVERAGE_EVERY) {
      diag.log('local-coverage', { charsPerSec: c.sec > 0 ? Math.round((c.chars / c.sec) * 10) / 10 : 0, emptyChunks: c.empty, chunks: c.chunks, model: r.model ?? eng.id, device: r.device ?? '?', chunkSec: Math.round(chunk.durationSec * 10) / 10, overlap: useOverlap });
      this.cov = { chunks: 0, chars: 0, sec: 0, empty: 0 };
    }
    const phrases = segsOut.map((s) => ({ start: chunk.startSec + Math.max(0, s.start - leadSec), end: chunk.startSec + Math.min(Math.max(0, s.end - leadSec), chunk.durationSec), text: s.text }));
    return { segments: lang === 'ru' ? [] : groupPhrases(phrases), sourceLang: lang || undefined, speechBursts: burstsOut };
  }
}
