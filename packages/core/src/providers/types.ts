/** Shared contracts between capture, providers and playback. Keep this file dependency-free. */

/** Mono PCM captured from (or cut out of) a video, positioned on the VIDEO timeline. */
export interface AudioChunk {
  /** video time (seconds) of the first sample */
  startSec: number;
  durationSec: number;
  sampleRate: number;
  pcm: Int16Array;
  /**
   * Set by the Rechunker when the chunk covers only part of its grid cell (capture started mid-cell, or the
   * video/stream ended). Partial chunks are translated but never cached.
   */
  partial?: boolean;
  /** 'hls' capture: stamped with a PROVISIONAL clock offset (no correlation yet); the engine re-times its dubs when the real one arrives */
  provisional?: boolean;
}

export type DubAudio =
  | { kind: 'pcm'; sampleRate: number; samples: Int16Array }
  | {
      kind: 'encoded';
      mime: string;
      data: Uint8Array;
      /** seconds of lead-in at the start of the DECODED audio that must be dropped (a standalone mp3 slice carries decoder priming frames) */
      skipSec?: number;
    };

/** A piece of translated speech and the video-timeline slot it belongs to. */
export interface DubSegment {
  /** slot on the video timeline, seconds */
  start: number;
  end: number;
  audio: DubAudio;
  /** original / translated text when the provider knows it (Gemini does, Yandex does not) */
  src?: string;
  text?: string;
  /** playback-rate hint (>= 1 speed-up) the player should apply to `audio` so it fits the slot */
  rate?: number;
  /** tier that produced this segment; stamped by the engine (lets a tier switch drop its segments) */
  providerId?: ProviderId;
}

export interface SubtitleCue {
  start: number;
  end: number;
  src?: string;
  text: string;
}

export interface ProviderContext {
  signal: AbortSignal;
  targetLang: 'ru';
  /** ISO code if already known, else the provider detects it */
  sourceLang?: string;
  /** subtitles are opt-in (invariant I4): providers must NOT spend quota on them unless true */
  wantSubtitles: boolean;
  /** the video is a live stream (set by the engine) */
  live?: boolean;
  /** dynamic whole-job deadline (ms) chosen by the planner (Yandex); absent = the provider's default */
  deadlineMs?: number;
  /** the server's own estimate (s) of the remaining time: a noisy hint for the latency model, never a deadline */
  onHint?(remainingSec: number): void;
}

export interface ChunkResult {
  segments: DubSegment[];
  /** which kind of voice actually spoke (Yandex tells us via isLivelyVoice); absent = unknown / not applicable */
  voice?: 'lively' | 'standard';
  sourceLang?: string;
  subtitles?: SubtitleCue[];
  /**
   * Slots (video seconds) that were translated but could not be voiced (TTS 429/transient failure). `segments` then
   * holds only the voiced ones; such a result is incomplete and must not be cached as final.
   */
  failedSegments?: { start: number; end: number }[];
  /** real speech bursts of the chunk (VIDEO seconds) from the local VAD; additive, optional */
  speechBursts?: { start: number; end: number }[];
}

export type ProviderId = 'yandex-live' | 'yandex' | 'groq' | 'local' | 'gemini';

export interface DubProvider {
  readonly id: ProviderId;
  readonly label: string;
  /** cheap check (settings/token present, etc.) so the chain can skip a tier without a network call */
  isConfigured(): boolean;
  /**
   * Optional async readiness probe (D30 local tiers: ASR / TTS engine availability cannot be known synchronously). The engine
   * awaits it (errors ignored) before computing the usable tiers; `isConfigured()` then answers from the probe result.
   */
  probe?(): Promise<void>;
  translateChunk(chunk: AudioChunk, ctx: ProviderContext): Promise<ChunkResult>;
  /**
   * Result-cache key ingredients resolved at call time (models / voice). Absent = the cache uses 'auto'.
   * Change of any value changes the cache key.
   */
  cacheSignature?(): CacheSignature | Promise<CacheSignature>;
  /**
   * Text -> speech only (no translation): lets the cache store a text-only entry when audio cannot be
   * compressed, and re-run just the TTS step on a hit.
   */
  synthesize?(segments: TextSegment[], ctx: ProviderContext): Promise<DubSegment[]>;
}

export interface CacheSignature {
  translateModel?: string;
  ttsModel?: string;
  voice?: string;
}

export interface TextSegment {
  start: number;
  end: number;
  src?: string;
  text: string;
  rate?: number;
}

/** Raised by a provider when the chain should fall through to the next tier. */
export class ProviderUnavailableError extends Error {
  constructor(
    message: string,
    readonly providerId: ProviderId,
    /** quota / rate limit => the key pool should rotate; other => just fall through */
    /** declined = the tier works but refuses this video/language (e.g. lively voice unavailable): no retry, short skip */
    readonly kind: 'quota' | 'auth' | 'unsupported' | 'declined' | 'network' | 'failed' = 'failed',
    readonly retryAfterMs?: number,
    /** the provider watchdog deadline expired (kind is then 'network'); the chain counts these toward a tier cooldown */
    readonly timedOut = false,
  ) {
    super(message);
    this.name = 'ProviderUnavailableError';
  }
}

/**
 * Environment-neutral HTTP: extension service worker (fetch + declarativeNetRequest), Tampermonkey
 * (GM_xmlhttpRequest) and Node tests (node:https) each supply one. Yandex needs requests WITHOUT an
 * Origin header and with Sec-Fetch-Mode: no-cors (gotcha G4), which a plain fetch cannot produce.
 */
export type Transport = (req: {
  url: string;
  method: 'GET' | 'POST' | 'PUT';
  headers: Record<string, string>;
  body?: Uint8Array;
  signal?: AbortSignal;
}) => Promise<{ status: number; headers: Record<string, string>; body: Uint8Array }>;
