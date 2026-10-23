import { videoCacheKey, videoKey, withCache, type ResultCache } from '../cache';
import { createLangStore, detectVideoLanguage } from '../lang';
import { createCapture } from '../capture';
import { TranslationEngine, type EngineState, type EngineWarning, type LanguageInfo } from '../pipeline';
import { GeminiProvider } from '../providers/gemini';
import { diag } from '../diag';
import type { CacheSignature, DubProvider, SubtitleCue, Transport } from '../providers/types';
import type { FullTrackProber } from '../providers/yandex/fullTrack';
import { KeyPool } from '../keypool';
import {
  ChromeAudioChunkSource,
  ChromeCueTranslator,
  CaptionsSource,
  GeminiText,
  SubtitleCache,
  SubtitleController,
  chromeAiFacts,
  createCaptionsBridgeClient,
  createYandexSubtitleSource,
  subtitleStatusText,
  type CaptionsReader,
  type WholeSource,
} from '../subtitles';
import { createAudioTracksBridgeClient, type AudioTracksController } from '../nativedub';
import type { Settings } from '../types';
import { mountPlayerButton, watchVideos, type ButtonState, type PlayerButton } from './playerButton';
import { openPagePanel, type PagePanelHandle } from './pagePanel';
import type { SettingsPanelHost } from './settingsPanel';
import { createSubtitleOverlay, SUBS_CSS, type SubtitleOverlay } from './subtitleOverlay';
import { buildDiagReport, isActiveState, languageStatusText, laterName, providerName, sourceName, type TranslateStatus } from './status';

const IDLE_TITLE = 'Перевести видео (NVT)';
const TITLES: Record<string, string> = {
  idle: IDLE_TITLE,
  loading: 'Подготовка перевода… (нажмите, чтобы остановить)',
  active: 'Перевод включён (нажмите, чтобы выключить)',
  error: 'Ошибка перевода — нажмите, чтобы повторить',
  ru: 'Видео уже на русском',
  native: 'Используется родная русская дорожка (нажмите, чтобы выключить)',
};

/** Who voiced the video: shown in the button tooltip and (via the host) the settings page. */
export function voiceLabel(providerId: string, voice?: 'lively' | 'standard'): string {
  if (providerId === 'gemini') return 'Gemini';
  if (providerId === 'groq') return 'Groq + локальный голос';
  if (providerId === 'local') return 'локальные модели';
  if (providerId === 'yandex-live') return voice === 'standard' ? 'Яндекс — обычные' : 'Яндекс — живые голоса';
  return 'Яндекс — обычные';
}

/** Outcome of the latest attempt of a tier, for the settings page ("Последняя попытка живых голосов"). */
export interface VoiceReport {
  at: number;
  providerId: string;
  outcome: 'ok' | 'declined' | 'auth-rejected' | 'no-token' | 'failed';
  /** for outcome 'ok': what actually spoke */
  voice?: 'lively' | 'standard';
  label?: string;
  detail?: string;
}

/** Gemini provider rebuilt when the keys change (voices are chosen automatically by the provider, D20) (the engine keeps one provider list for its whole life). */
export class LiveGemini implements DubProvider {
  readonly id = 'gemini' as const;
  readonly label = 'Gemini';
  private inner?: GeminiProvider;
  private sig = '';
  private keyPool?: KeyPool;
  constructor(
    private readonly get: () => Settings,
    private readonly fetchFn: (input: string, init?: RequestInit) => Promise<Response>,
  ) {}
  private cur(): GeminiProvider {
    const s = this.get();
    const sig = `${s.geminiKeys.join('\n')}`;
    if (!this.inner || sig !== this.sig) {
      this.sig = sig;
      this.keyPool = new KeyPool(s.geminiKeys);
      this.inner = new GeminiProvider({
        keys: this.keyPool,
        models: () => this.get().geminiModels,
        fetch: this.fetchFn,
      });
    }
    return this.inner;
  }
  isConfigured(): boolean {
    return this.cur().isConfigured();
  }
  /** the key pool shared with the text-only subtitle calls (one quota picture for both) */
  pool(): KeyPool | undefined {
    this.cur();
    return this.keyPool;
  }
  get fetch(): (input: string, init?: RequestInit) => Promise<Response> {
    return this.fetchFn;
  }
  translateChunk: DubProvider['translateChunk'] = (c, ctx) => this.cur().translateChunk(c, ctx);
  /** user-selected models; '' = resolved automatically => 'auto' in the cache key (voice: the provider may add its own later) */
  cacheSignature(): CacheSignature {
    const s = this.get();
    return { translateModel: s.geminiModels.translate, ttsModel: s.geminiModels.tts };
  }
}


export interface PageRuntimeHost {
  loadSettings(): Promise<Settings>;
  /** called once, lazily, when the first translation starts */
  createProviders(getSettings: () => Settings): DubProvider[];
  /** capture factory (the userscript passes one bound to its same-realm MSE tap) */
  createCapture?: typeof createCapture;
  /** result cache shared by all videos of this runtime (extension: messages to the background; userscript: page IndexedDB) */
  cache?: ResultCache;
  /** persists the latest voicing outcome (extension: chrome.storage.local, userscript: GM storage) */
  reportVoice?(r: VoiceReport): void;
  /** settings storage / account operations; with it a click on the player button opens the in-page panel */
  settingsHost?: SettingsPanelHost;
  /** Yandex full-track prober (created together with the Yandex providers); absent = chunk mode only */
  fullTrack?(): FullTrackProber | undefined;
  /** HTTP for the Yandex subtitle endpoint (same transport as the Yandex provider); absent = the Yandex subtitle source is skipped */
  subtitleTransport?: () => Transport;
  /** reader of the page player's caption tracks; default: the postMessage bridge to the MAIN-world half */
  captions?: () => CaptionsReader;
  /** page-world reader / switcher of the YouTube audio tracks (native Russian dub); default: the postMessage bridge */
  audioTracks?: () => AudioTracksController;
  /** build version: "NVT vX loaded" in the console once per page and "Версия X" in the panel */
  version?: string;
}

export interface VideoControllerHandle {
  readonly video: HTMLVideoElement;
  readonly btn: PlayerButton;
  readonly state: EngineState;
  /** the video already plays and the settings allow auto-start: start (called once the settings have loaded) */
  autoStartIfPlaying(): void;
  readonly provider?: string;
  readonly active: boolean;
  toggle(): Promise<void>;
  /** translate even though the video was detected as Russian */
  forceTranslate(): Promise<void>;
  applySettings(s: Settings): void;
  status(): TranslateStatus;
  /** shows `text` on the subtitle overlay for a few seconds, independent of any subtitle source */
  showTestCue(text: string): void;
  /** the NVT button was clicked (settings panel or direct toggle, per `clickAction`) */
  onButton(): void;
  openPanel(): void;
}

export interface PageRuntime {
  readonly controllers: Set<VideoControllerHandle>;
  readonly debug: {
    log: unknown[];
    controllers: Set<VideoControllerHandle>;
    settings: () => Settings | undefined;
    showTestCue: (text?: string) => boolean;
  };
  /** status of the largest video, null when there is none */
  status(): TranslateStatus | null;
  toggle(): Promise<TranslateStatus | null>;
  /** translate the largest video even though it was detected as Russian */
  forceTranslate(): Promise<TranslateStatus | null>;
  showTestCue(text: string): boolean;
  diagReport(): string;
  clearDiag(): void;
  /** opens the in-page panel next to the largest video's button (standalone, centered, when there is no video) */
  openPanel(): void;
  /** the Yandex login or settings changed elsewhere: redraw an open panel */
  refreshPanel(): void;
  settings(): Settings | undefined;
  /** new settings from storage: kept by the runtime and pushed to every live engine and overlay */
  applySettings(s: Settings): void;
  /** controller of the largest connected video, if any */
  largest(): VideoControllerHandle | undefined;
  /** attach a controller to every (non-tiny) <video> in `doc`, now and later */
  watch(doc: Document, onController?: (c: VideoControllerHandle) => void): () => void;
}

/** Shared by the MV3 content script and the userscript: one controller per <video> (button, engine, subtitles). */
export function createPageRuntime(host: PageRuntimeHost): PageRuntime {
  let settings: Settings | undefined;
  // a video that was already playing before the settings arrived gets its auto-start here (no 'play' event will come again)
  const ready = host.loadSettings().then((s) => {
    settings = s;
    for (const c of controllers) c.autoStartIfPlaying();
  });
  const controllers = new Set<VideoControllerHandle>();
  let audioCtx: AudioContext | undefined;
  let providers: DubProvider[] | undefined;
  let captionsReader: CaptionsReader | undefined;
  let chromeTranslator: ChromeCueTranslator | undefined;
  let geminiText: GeminiText | undefined;
  let chromeAudio: ChromeAudioChunkSource | undefined;

  // verification hook: engine events without keys or audio
  const dbg = {
    log: [] as unknown[],
    controllers,
    settings: () => settings,
    showTestCue: (text = 'Тестовый субтитр NVT'): boolean => api.showTestCue(text),
  };
  const note = (e: Record<string, unknown>): void => {
    dbg.log.push({ t: Math.round(performance.now()), ...e });
    if (dbg.log.length > 300) dbg.log.shift();
  };

  const getProviders = (): DubProvider[] => (providers ??= host.createProviders(() => settings!));
  /** per video: the cache key depends on the video identity */
  const providersFor = (video: HTMLVideoElement): DubProvider[] => {
    const base = getProviders();
    const cache = host.cache;
    if (!cache) return base;
    return base.map((p) =>
      withCache(p, cache, {
        videoKey: () => videoCacheKey(video, location.href),
        settings: () => settings!,
        onHit: (h) => note({ type: 'cache-hit', providerId: h.providerId, startSec: h.startSec }),
        log: (m) => note({ type: 'cache-log', msg: m }),
      }),
    );
  };

  let audioTracksCtl: AudioTracksController | undefined;
  const getAudioTracks = (): AudioTracksController => (audioTracksCtl ??= host.audioTracks?.() ?? createAudioTracksBridgeClient());
  const getReader = (): CaptionsReader => (captionsReader ??= host.captions?.() ?? createCaptionsBridgeClient());

  /** subtitle sources shared by all videos of the page (cheap to build, nothing is called until subtitles are on) */
  const makeSubtitleController = (
    video: HTMLVideoElement,
    cb: { onCues(c: SubtitleCue[]): void; onStatus(l: string | undefined): void; onFail(r: string): void },
  ): SubtitleController => {
    const reader = getReader();
    const live = getProviders().find((p): p is LiveGemini => p instanceof LiveGemini);
    chromeTranslator ??= new ChromeCueTranslator();
    chromeAudio ??= new ChromeAudioChunkSource(chromeTranslator);
    if (live) geminiText ??= new GeminiText({ pool: () => live.pool(), fetch: live.fetch, modelOverride: () => settings?.geminiModels.translate });
    const cache = host.cache ? new SubtitleCache({ cache: host.cache, settings: () => settings!, videoKey: () => videoCacheKey(video, location.href) }) : undefined;
    const whole: WholeSource[] = [];
    const transport = host.subtitleTransport?.();
    if (transport) {
      whole.push(
        createYandexSubtitleSource(transport, {
          pageUrl: () => location.href,
          langHint: async () => {
            const info = await reader.getTracks(400);
            return info?.audioLang ?? info?.tracks.find((x) => x.kind === 'asr')?.lang?.split('-')[0];
          },
        }),
      );
    }
    whole.push(new CaptionsSource({ reader, translators: geminiText ? [chromeTranslator, geminiText] : [chromeTranslator], cache }));
    return new SubtitleController({
      getSettings: () => settings!,
      whole,
      chunk: geminiText ? [geminiText, chromeAudio] : [chromeAudio],
      cache,
      currentTime: () => video.currentTime,
      onCues: cb.onCues,
      onStatus: cb.onStatus,
      onFail: cb.onFail,
    });
  };

  // ---- in-page settings panel (one at a time) ----
  let panel: PagePanelHandle | undefined;
  let panelOwner: VideoController | undefined;
  const largestCtl = (): VideoController | undefined => api.largest() as VideoController | undefined;
  const diagText = (): string => buildDiagReport({ version: host.version, settings, status: api.status() });
  const closePanel = (): void => {
    panel?.close();
    panel = undefined;
    panelOwner = undefined;
  };
  const panelHostFor = (owner: VideoController | undefined): SettingsPanelHost => ({
    ...host.settingsHost!,
    version: host.version,
    getTranslateStatus: async () => (owner ?? largestCtl())?.status() ?? null,
    async forceTranslate() {
      const c = owner ?? largestCtl();
      if (!c) return null;
      await Promise.race([c.forceTranslate(), new Promise((r) => setTimeout(r, 200))]);
      return c.status();
    },
    async toggleTranslate() {
      const c = owner ?? largestCtl();
      if (!c) return null;
      // start() resolves only once the first chunks are ready (tens of seconds): do not hold the button for that
      await Promise.race([c.toggle(), new Promise((r) => setTimeout(r, 200))]);
      return c.status();
    },
    getDiagReport: async () => ({ text: diagText(), source: location.hostname }),
    clearDiag: async () => diag.clear(),
    async showTestCue(text) {
      const c = owner ?? largestCtl();
      c?.showTestCue(text);
      return !!c;
    },
  });
  const openPanelFor = (owner: VideoController | undefined): void => {
    if (!host.settingsHost) return;
    closePanel();
    panelOwner = owner;
    panel = openPagePanel({
      host: panelHostFor(owner),
      anchor: owner?.btn.el,
      onClose: () => {
        panel = undefined;
        panelOwner = undefined;
      },
    });
  };

  let loggedLoaded = false;
  const logLoaded = (): void => {
    if (loggedLoaded || !host.version) return;
    loggedLoaded = true;
    console.log(`NVT v${host.version} loaded`);
    diag.log('loaded', { version: host.version, page: location.hostname });
  };
  // iframes log when their first player attaches, the top frame immediately: once per page, not per frame
  if (window.top === window) logLoaded();

  class VideoController implements VideoControllerHandle {
    engine?: TranslationEngine;
    state: EngineState = 'idle';
    provider?: string;
    private slow?: 'wait' | 'switch';
    private eta?: { sec?: number; source?: string; at: number };
    private later?: string;
    private userStopped = false;
    private readonly subs: SubtitleOverlay;
    /** full problem details: shown ONLY in the diagnostics report (never in the panel / tooltip) */
    private warnings: string[] = [];
    /** problems the USER can fix (no Yandex login, bad Gemini key, no source at all): the only reason for the amber dot */
    private fixable = new Set<string>();
    private titleKey = 'idle';
    private voice?: string;
    private lang?: LanguageInfo;
    /** when the engine last skipped this video as Russian (a second click within 10 s forces translation) */
    private skippedAt = 0;
    private subsCtl?: SubtitleController;
    private subsLabel?: string;
    readonly btn: PlayerButton;

    /** videoKey at the moment the running / skipped session started (undefined = unknown: every reload counts as a new video) */
    private sessionKey?: string;
    /** duration of the video the session runs on (first finite value seen); a different one = another clip in the same element (ad, autoplay) */
    private sessionDur?: number;
    /** the session was reset by a media event: the next play/playing/loadedmetadata starts the new video (autoTranslate) */
    private pendingAuto = false;

    private canAutoStart(): boolean {
      return settings?.autoTranslate === 'on' && !this.active && !this.userStopped && this.state !== 'skipped-ru';
    }

    private readonly onPlay = (): void => {
      if (this.canAutoStart()) {
        this.pendingAuto = false;
        void this.start();
      }
    };

    /** events after a reset that did not bring a `play` (YouTube SPA navigation: emptied, play, loadstart all within ms) */
    private readonly onMediaReady = (): void => {
      if (this.pendingAuto && !this.video.paused && this.canAutoStart()) {
        this.pendingAuto = false;
        void this.start();
      }
    };

    /**
     * A media reload (emptied / loadstart) of the video the session already runs on must not end it: YouTube reloads the
     * element on setAudioTrack, quality / stream refreshes, and fires emptied -> play -> loadstart on SPA navigation
     * (the `play` already started the session of the NEW video). Same = same non-empty videoKey as at session start.
     */
    private sameVideo(): boolean {
      const k = videoKey(this.video, location.href);
      return k !== undefined && k === this.sessionKey;
    }

    private resetSession(why: string): void {
      this.userStopped = false;
      const had = this.active || this.state === 'skipped-ru';
      if (this.active) this.stop(false);
      if (this.state === 'skipped-ru') {
        // a new video in the same player: the Russian verdict belonged to the previous one
        this.state = 'idle';
        this.lang = undefined;
        this.skippedAt = 0;
        this.setButton('idle', 'idle');
      }
      this.sessionKey = undefined;
      this.sessionDur = undefined;
      if (had) {
        this.pendingAuto = true;
        diag.log('video-reset', { why, key: videoKey(this.video, location.href), dur: Number.isFinite(this.video.duration) ? Math.round(this.video.duration) : null });
      }
    }

    private readonly onEmptied = (): void => {
      if ((this.active || this.state === 'skipped-ru' || this.userStopped) && this.sameVideo()) {
        diag.log('video-reload-kept', { ev: 'emptied', key: this.sessionKey, state: this.state });
        return;
      }
      this.resetSession('emptied');
    };

    /** a new source was attached (SPA navigation reuses the element; `emptied` is not guaranteed): reset when it is another video */
    private readonly onLoadStart = (): void => {
      if (!this.active && this.state !== 'skipped-ru') return;
      if (this.sameVideo()) {
        diag.log('video-reload-kept', { ev: 'loadstart', key: this.sessionKey, state: this.state });
        return;
      }
      this.resetSession('loadstart');
    };

    /** the same key but another duration: a different clip in the same element (ad, playlist autoplay on one URL) */
    private readonly onMeta = (): void => {
      const d = this.video.duration;
      if (this.active || this.state === 'skipped-ru') {
        if (Number.isFinite(d) && d > 0) {
          if (this.sessionDur === undefined) this.sessionDur = d;
          else if (Math.abs(d - this.sessionDur) > 1) this.resetSession('duration');
        }
      }
      this.onMediaReady();
    };

    autoStartIfPlaying(): void {
      if (!this.video.paused) this.onPlay();
    }

    constructor(readonly video: HTMLVideoElement) {
      this.subs = createSubtitleOverlay(video, () => this.host());
      this.btn = mountPlayerButton(video, { onClick: () => this.onButton(), title: IDLE_TITLE });
      video.addEventListener('play', this.onPlay);
      video.addEventListener('playing', this.onMediaReady);
      video.addEventListener('loadedmetadata', this.onMeta);
      video.addEventListener('emptied', this.onEmptied);
      video.addEventListener('loadstart', this.onLoadStart);
      if (!video.paused) this.onPlay();
    }

    get active(): boolean {
      return this.state === 'starting' || this.state === 'translating' || this.state === 'buffering' || this.state === 'native-dub';
    }

    onButton(): void {
      if (settings?.clickAction === 'toggle' || !host.settingsHost) void this.toggle();
      else if (panel?.isOpen && panelOwner === this) closePanel();
      else this.openPanel();
    }

    openPanel(): void {
      openPanelFor(this);
    }

    status(): TranslateStatus {
      return {
        state: this.state,
        provider: this.provider,
        voice: this.active ? this.voice : undefined,
        subtitles: settings?.subtitles === 'on' ? subtitleStatusText(this.subsLabel) : undefined,
        warnings: [...this.warnings],
        language: languageStatusText(this.lang),
        canForce: this.state === 'skipped-ru',
        page: location.hostname,
        slow: this.state === 'starting' ? this.slow : undefined,
        etaSec: this.state === 'starting' && this.eta?.sec !== undefined ? Math.max(0, this.eta.sec - (Date.now() - this.eta.at) / 1000) : undefined,
        etaSource: this.state === 'starting' ? this.eta?.source : undefined,
        later: this.active ? this.later : undefined,
      };
    }

    showTestCue(text: string): void {
      this.subs.showTest(text);
    }

    async toggle(): Promise<void> {
      if (this.active) this.stop(true);
      // the first click on a Russian video only explained why nothing happens; the second one (within 10 s) forces it
      else await this.start(this.state === 'skipped-ru' && Date.now() - this.skippedAt < 10_000);
    }

    async forceTranslate(): Promise<void> {
      if (this.active) return;
      await this.start(true);
    }

    private setButton(b: ButtonState, key: string): void {
      this.btn.setState(b);
      this.titleKey = key;
      this.refreshButton();
    }

    /** Tooltip + warning dot on the player button: the only on-player status (no banners over the video). */
    private refreshButton(): void {
      const base = TITLES[this.titleKey] ?? IDLE_TITLE;
      const lines = [base];
      if (this.voice && (this.titleKey === 'active' || this.titleKey === 'loading')) lines.push(`Озвучка: ${this.voice}`);
      this.btn.el.title = lines.join(String.fromCharCode(10));
      if (this.fixable.size > 0) this.btn.el.dataset.warn = '1';
      else delete this.btn.el.dataset.warn;
    }

    private onVoice(providerId: string, voice?: 'lively' | 'standard'): void {
      const label = voiceLabel(providerId, voice);
      note({ type: 'voice', providerId, voice });
      host.reportVoice?.({ at: Date.now(), providerId, outcome: 'ok', voice, label });
      this.fixable.delete('no-source');
      if (label === this.voice) return;
      this.voice = label;
      this.refreshButton();
    }

    async start(force = false): Promise<void> {
      await ready;
      if (!settings) return;
      this.userStopped = false;
      this.pendingAuto = false;
      this.sessionKey = videoKey(this.video, location.href);
      this.sessionDur = Number.isFinite(this.video.duration) && this.video.duration > 0 ? this.video.duration : undefined;
      this.voice = undefined;
      this.warnings = [];
      this.fixable.clear();
      this.refreshButton();
      this.lang = undefined;
      if (settings.voiceEnabled['yandex-live'] !== false && !settings.yandexToken) {
        host.reportVoice?.({ at: Date.now(), providerId: 'yandex-live', outcome: 'no-token' });
        this.addWarning('Живые голоса: вы не вошли в Яндекс (Настройки → Яндекс)', 'yandex-login');
      }
      audioCtx ??= new AudioContext();
      void audioCtx.resume().catch(() => {});
      this.engine?.stop();
      this.engine = new TranslationEngine({
        video: this.video,
        audioCtx,
        providers: providersFor(this.video),
        fullTrack: host.fullTrack?.(),
        audioTracks: getAudioTracks(),
        videoKey: () => videoKey(this.video, location.href),
        settings,
        detectLanguage: () => detectVideoLanguage(this.video, document, { captions: getReader() }),
        langStore: host.cache ? createLangStore(host.cache, () => videoKey(this.video, location.href)) : undefined,
        createCapture: host.createCapture ?? ((v, o) => createCapture(v, o)),
        events: {
          onState: (s, d) => {
            this.slow = d?.slow;
            this.eta = d?.preparing ? { sec: d.etaSec, source: sourceName(d.etaProvider), at: Date.now() } : undefined;
            this.later = laterName(d?.later);
            this.onState(s, d?.provider, d?.captureKind);
          },
          onWarning: (w) => this.onWarning(w),
          onLanguage: (l) => {
            this.lang = l;
            note({ type: 'language', lang: l.lang, conf: l.confidence, how: l.how, unverified: l.unverified, skipped: !!l.skipped });
          },
          onVoice: (v) => {
            this.subsCtl?.noteVoiceTier(v.providerId);
            this.onVoice(v.providerId, v.voice);
          },
          // Gemini-voice cues are one layer of the subtitle controller (it merges them with the other sources)
          onSubtitles: (c) => this.subsController().setVoiceCues(c),
          onChunk: (c) => this.subsCtl?.feedChunk(c),
        },
      });
      // subtitles follow the session but never wait for / depend on a voice tier (no-op unless subtitles are on, I4)
      if (settings.subtitles === 'on') {
        void chromeAiFacts().then((f) => diag.log('chrome-ai', f), () => {});
        this.subsController().start();
      }
      await this.engine.start({ force });
    }

    private subsController(): SubtitleController {
      return (this.subsCtl ??= makeSubtitleController(this.video, {
        onCues: (c) => {
          this.subs.setCues(c);
          this.renderSubs();
        },
        onStatus: (l) => {
          this.subsLabel = l;
          note({ type: 'subs-source', label: l });
        },
        onFail: (r) => {
          this.addWarning(r);
        },
      }));
    }

    stop(byUser: boolean): void {
      if (byUser) this.userStopped = true;
      this.engine?.stop();
    }

    private onState(s: EngineState, provider?: string, captureKind?: string): void {
      this.state = s;
      if (provider) this.provider = provider;
      note({ type: 'state', state: s, provider, captureKind, err: this.engine?.lastError, vol: this.video.volume });
      if (s === 'starting' || s === 'buffering') this.setButton('loading', 'loading');
      else if (s === 'translating') this.setButton('active', 'active');
      else if (s === 'native-dub') this.setButton('active', 'native');
      else if (s === 'error') {
        this.setButton('error', 'error');
      } else if (s === 'skipped-ru') {
        this.skippedAt = Date.now();
        this.setButton('idle', 'ru');
      }
      else this.setButton('idle', 'idle');
      // an engine error keeps whole-timeline subtitles (they do not need the voice); a stop/idle/ru-skip ends them
      if (!this.active && s !== 'error') {
        this.subsCtl?.stop();
        this.subs.setCues([]);
      }
      this.renderSubs();
      if (s === 'error') this.addWarning(`Не удалось запустить перевод${this.engine?.lastError ? `: ${this.engine.lastError}` : ''}`);
    }

    private onWarning(w: EngineWarning): void {
      note({ type: 'warning', kind: w.kind, providerId: w.providerId });
      const who = w.providerId === 'gemini' ? 'Gemini' : w.providerId === 'yandex-live' ? 'Яндекс (живые голоса)' : 'Яндекс';
      const live = w.providerId === 'yandex-live';
      if (w.providerId === 'yandex-live' || w.providerId === 'yandex') {
        const outcome = w.kind === 'auth-required' ? 'auth-rejected' : w.kind === 'tier-declined' ? 'declined' : w.kind === 'provider-failed' ? 'failed' : undefined;
        if (outcome) host.reportVoice?.({ at: Date.now(), providerId: w.providerId, outcome, detail: w.message.slice(0, 160) });
      }
      let text: string;
      let fixable: string | undefined;
      switch (w.kind) {
        case 'tier-declined':
          text = live ? 'Живые голоса недоступны для этого видео — использую обычные' : `Источник «${who}» не подходит для этого видео`;
          break;
        case 'quota-exhausted':
          text = w.providerId === 'gemini' ? 'Лимит Gemini исчерпан — добавьте другой ключ в настройках' : `Лимит «${who}» исчерпан, попробуйте позже`;
          break;
        case 'auth-required':
          text = w.providerId === 'gemini' ? 'Ключ Gemini не принят — проверьте его в настройках' : 'Токен Яндекса не принят — войдите снова в настройках';
          if (w.providerId === 'gemini') {
            // fixable by the user only when Gemini is all there is
            if (settings && settings.voiceEnabled.yandex === false && settings.voiceEnabled['yandex-live'] === false) fixable = 'gemini-key';
          } else if (w.providerId === 'yandex-live') fixable = 'yandex-login';
          break;
        case 'already-russian':
          text = 'Видео уже на русском — нажмите ещё раз, чтобы всё равно перевести';
          break;
        case 'language-unverified':
          // not an error: the status line says the language is checked on the first result
          return;
        case 'no-provider':
          text = 'Нет доступного источника озвучки — проверьте настройки';
          fixable = 'no-source';
          break;
        case 'capture-tainted':
          text = 'Не удалось получить звук этого видео напрямую, пробую другой способ';
          break;
        case 'dub-late':
          text = 'Перевод приходит с опозданием — на этом участке слышен оригинал';
          break;
        case 'chunk-failed':
          text = 'Часть видео не удалось озвучить ни одним источником — слышен оригинал';
          break;
        case 'dub-decode-failed':
          text = 'Не удалось воспроизвести озвучку этого фрагмента';
          break;
        default:
          text = `Источник «${who}» временно недоступен`;
      }
      this.addWarning(text, fixable);
    }

    private addWarning(text: string, fixable?: string): void {
      if (fixable) this.fixable.add(fixable);
      if (this.warnings[this.warnings.length - 1] === text) {
        this.refreshButton();
        return;
      }
      this.warnings.push(text);
      if (this.warnings.length > 5) this.warnings.shift();
      this.refreshButton();
    }

    // ---- overlays ----

    private host(): HTMLElement | null {
      const h = this.video.closest<HTMLElement>('.html5-video-player') ?? this.video.parentElement;
      if (h && getComputedStyle(h).position === 'static') h.style.position = 'relative';
      return h;
    }

    private renderSubs(): void {
      const subsRunning = !!this.subsCtl && this.subsCtl.state !== 'idle' && this.subsCtl.state !== 'failed';
      this.subs.setEnabled(settings?.subtitles === 'on' && (this.active || subsRunning));
    }

    applySettings(s: Settings): void {
      this.engine?.updateSettings(s);
      if (s.subtitles === 'on') {
        if ((this.active || this.state === 'error') && this.subsCtl?.state !== 'failed') this.subsController().applySettings(true);
      } else this.subsCtl?.applySettings(false);
      this.renderSubs();
    }

    destroy(): void {
      this.subs.destroy();
    }
  }

  ensureStyle();
  const api: PageRuntime = {
    controllers,
    debug: dbg,
    settings: () => settings,
    status: () => largestCtl()?.status() ?? null,
    async toggle() {
      const c = largestCtl();
      if (!c) return null;
      await Promise.race([c.toggle(), new Promise((r) => setTimeout(r, 200))]);
      return c.status();
    },
    async forceTranslate() {
      const c = largestCtl();
      if (!c) return null;
      await Promise.race([c.forceTranslate(), new Promise((r) => setTimeout(r, 200))]);
      return c.status();
    },
    showTestCue(text) {
      const c = largestCtl();
      c?.showTestCue(text);
      return !!c;
    },
    diagReport: diagText,
    clearDiag: () => diag.clear(),
    openPanel() {
      if (panel?.isOpen) return closePanel();
      openPanelFor(largestCtl());
    },
    refreshPanel: () => panel?.refresh(),
    applySettings(s) {
      settings = s;
      for (const c of controllers) c.applySettings(s);
    },
    largest() {
      let best: VideoControllerHandle | undefined;
      for (const c of controllers) {
        if (!c.video.isConnected) continue;
        const a = c.video.clientWidth * c.video.clientHeight;
        if (!best || a > best.video.clientWidth * best.video.clientHeight) best = c;
      }
      return best;
    },
    watch(doc, onController) {
      const attach = (video: HTMLVideoElement): void => {
        logLoaded();
        const c = new VideoController(video);
        controllers.add(c);
        onController?.(c);
      };
      const big = (v: HTMLVideoElement): boolean => {
        const r = v.getBoundingClientRect();
        return r.width >= 200 && r.height >= 120;
      };
      return watchVideos(doc, (video) => {
        if (big(video)) return attach(video);
        // tiny/hidden previews (hover thumbnails, tracking pixels) are skipped, but a player whose <video> is created
        // before layout (YouTube) grows later: attach once it reaches a real size
        if (typeof ResizeObserver === 'undefined') return;
        const ro = new ResizeObserver(() => {
          if (!video.isConnected) return ro.disconnect();
          if (!big(video)) return;
          ro.disconnect();
          attach(video);
        });
        ro.observe(video);
      });
    },
  };
  return api;
}

function ensureStyle(): void {
  if (document.getElementById('nvt-page-style')) return;
  const s = document.createElement('style');
  s.id = 'nvt-page-style';
  s.textContent = `
${SUBS_CSS}`;
  (document.head ?? document.documentElement).appendChild(s);
}
