import { diag } from '../../diag';
import { YANDEX_SOURCE_LANGS } from '../../lang/names';
import type { AudioChunk, ChunkResult, DubProvider, ProviderContext, ProviderId, Transport } from '../types';
import { ProviderUnavailableError } from '../types';
import { YandexClient, YandexError, type YandexClientOptions } from './client';
import { LIVE_ETA_DEADLINE_PAD_MS } from '../../pipeline/planner';
import { createFullTrackProber, type FullTrackProber } from './fullTrack';

export interface YandexProviderOptions extends YandexClientOptions {
  /** share one client (and its session cache) between `yandex` and `yandex-live` */
  client?: YandexClient;
}

abstract class YandexBase implements DubProvider {
  abstract readonly id: ProviderId;
  abstract readonly label: string;
  protected readonly client: YandexClient;
  protected abstract readonly lively: boolean;

  constructor(transport: Transport, opts: YandexProviderOptions = {}) {
    this.client = opts.client ?? new YandexClient(transport, opts);
  }

  abstract isConfigured(): boolean;

  async translateChunk(chunk: AudioChunk, ctx: ProviderContext): Promise<ChunkResult> {
    try {
      const meta: { lively?: boolean } = {};
      const data = await this.client.translatePcm(chunk.pcm, chunk.sampleRate, {
        signal: ctx.signal,
        lively: this.lively,
        // a detected / chosen source language is used when Yandex supports it; otherwise 'auto' (the client maps it to 'en' for lively voices, as VOT does)
        sourceLang: ctx.sourceLang && ctx.sourceLang !== 'ru' && YANDEX_SOURCE_LANGS.has(ctx.sourceLang) ? ctx.sourceLang : undefined,
        targetLang: ctx.targetLang,
        meta,
        jobMs: ctx.deadlineMs,
        onHint: ctx.onHint,
        // D26 live policy: the live tier may run until the server ETA + 60 s before its deadline cuts it off
        etaMarginMs: this.lively ? LIVE_ETA_DEADLINE_PAD_MS : undefined,
      });
      // Subtitles: the Yandex subtitle endpoint is not implemented, so it is never called (invariant I4)
      // and no cues are returned even when ctx.wantSubtitles is true.
      return {
        segments: [
          {
            start: chunk.startSec,
            end: chunk.startSec + chunk.durationSec,
            audio: { kind: 'encoded', mime: 'audio/mpeg', data },
          },
        ],
        voice: this.lively && meta.lively ? 'lively' : 'standard',
        sourceLang: ctx.sourceLang,
      };
    } catch (e) {
      // Yandex answers FAILED "...в нём нет речи" for music / silence: a clean empty result, not a failure to retry
      if (e instanceof YandexError && e.kind === 'unsupported' && /нет речи|no speech/i.test(e.message)) {
        diag.log('yandex-no-speech', { cell: chunk.startSec, dur: chunk.durationSec });
        return { segments: [], sourceLang: ctx.sourceLang };
      }
      if (e instanceof YandexError) throw new ProviderUnavailableError(e.message, this.id, e.kind, e.retryAfterMs, e.timedOut);
      throw e; // AbortError and unexpected bugs propagate as-is
    }
  }
}

export class YandexProvider extends YandexBase {
  readonly id = 'yandex' as const;
  readonly label = 'Yandex';
  protected readonly lively = false;
  isConfigured(): boolean {
    return true;
  }
}

export class YandexLiveProvider extends YandexBase {
  readonly id = 'yandex-live' as const;
  readonly label = 'Yandex (live voices)';
  protected readonly lively = true;
  private readonly getToken?: YandexClientOptions['getToken'];

  constructor(transport: Transport, opts: YandexProviderOptions = {}) {
    super(transport, opts);
    this.getToken = opts.getToken;
  }

  /** Cheap synchronous check; an async token getter counts as configured (the real check happens on use). */
  isConfigured(): boolean {
    const t = this.getToken?.();
    return t instanceof Promise ? true : !!t;
  }
}

/** Both tiers sharing one client / session cache. */
export function createYandexProviders(
  transport: Transport,
  opts: YandexClientOptions = {},
): { yandex: YandexProvider; yandexLive: YandexLiveProvider; fullTrack: FullTrackProber } {
  const client = new YandexClient(transport, opts);
  return {
    yandex: new YandexProvider(transport, { client }),
    yandexLive: new YandexLiveProvider(transport, { ...opts, client }),
    fullTrack: createFullTrackProber(client, { now: opts.now, sleep: opts.sleep }),
  };
}
