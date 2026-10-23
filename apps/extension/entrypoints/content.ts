import { CaptionPretranslator, ChromePromptAudioAsr, ChromeTextTranslator, GroqChatTranslator, LiveGemini, YoutubeCaptionTimeline, createCaptionsBridgeClient, createGroqProvider, createLocalProvider, createPageRuntime, createRemoteCache, createYandexProviders, diag, localAsrRegistry, localTtsRegistry, type CacheMessage, type CacheReply, type DubProvider, type FullTrackProber, type VoiceReport } from '@nvt/core';
import { browser } from 'wxt/browser';
import { createSwTransport, transportFetch } from '../utils/swTransport';
import { VOICE_STATUS_KEY, YANDEX_AUTH_KEY, YANDEX_LOGIN_ERROR_KEY, loadSettings, onSettingsChanged } from '../utils/settings';
import { createBaseHost } from '../utils/panelHost';
import { registerExtensionLocalTts } from '../utils/localtts/engine';
import { NVT_VERSION } from '../utils/version';

let lastKey = '';
/** latest Yandex-tier attempt + latest voiced chunk, for the options page; written only when something changed */
function reportVoice(r: VoiceReport): void {
  const isLive = r.providerId === 'yandex-live';
  const key = `${r.providerId}|${r.outcome}|${r.voice ?? ''}`;
  if (key === lastKey) return;
  lastKey = key;
  void browser.storage.local.get(VOICE_STATUS_KEY).then((got) => {
    const st = (got[VOICE_STATUS_KEY] ?? {}) as { live?: VoiceReport; voiced?: VoiceReport };
    if (r.outcome === 'ok') st.voiced = r;
    if (isLive) st.live = r;
    return browser.storage.local.set({ [VOICE_STATUS_KEY]: st });
  }).catch(() => {});
}

let subsTransport: ReturnType<typeof createSwTransport> | undefined;

export default defineContentScript({
  matches: ['<all_urls>'],
  allFrames: true,
  main() {
    let fullTrack: FullTrackProber | undefined;
    // platform captions for the caption shortcut of the groq/local tiers (YouTube only; reset when the video changes)
    const reader = createCaptionsBridgeClient();
    const timeline = new YoutubeCaptionTimeline({ reader });
    let timelineVid = '';
    const youtubeCaptions = () => {
      if (!/(^|\.)youtube\.com$/.test(location.hostname)) return undefined;
      const vid = new URLSearchParams(location.search).get('v') ?? location.pathname;
      if (vid !== timelineVid) {
        timelineVid = vid;
        timeline.reset();
      }
      return timeline;
    };
    const runtime = createPageRuntime({
      loadSettings,
      reportVoice,
      version: NVT_VERSION,
      settingsHost: createBaseHost(),
      subtitleTransport: () => (subsTransport ??= createSwTransport()),
      cache: createRemoteCache((m: CacheMessage) => browser.runtime.sendMessage(m) as Promise<CacheReply | undefined>),
      fullTrack: () => fullTrack,
      captions: () => reader,
      createProviders(getSettings) {
        const transport = createSwTransport();
        const y = createYandexProviders(transport, { getToken: () => getSettings().yandexToken });
        fullTrack = y.fullTrack;
        // D30 local tiers: engines register once per page; the Supertonic engine talks to the service worker / offscreen document
        const tts = registerExtensionLocalTts(getSettings);
        localAsrRegistry.register(new ChromePromptAudioAsr());
        const chrome = new ChromeTextTranslator();
        // one batch store for both tiers: the caption track is translated 50 sentences per request, ahead of the playhead
        let groqChat: GroqChatTranslator | undefined;
        const translators = () => (groqChat ? [chrome, groqChat] : [chrome]); // GroqChatTranslator.isAvailable() is false without a key
        const pretranslate = new CaptionPretranslator({ translators, tier: 'groq' });
        const groq = createGroqProvider({ transport, getSettings, captions: youtubeCaptions, pretranslate });
        groqChat = new GroqChatTranslator(groq.client, groq.models);
        const local = createLocalProvider({ captions: youtubeCaptions, translators, pretranslate });
        // load the model + compile the shaders as soon as a local tier is in play and the model is already downloaded (no-op otherwise)
        const s = getSettings();
        if (s.voiceEnabled.groq !== false || s.voiceEnabled.local !== false) void tts.warmUp();
        return [y.yandexLive, y.yandex, groq, local, new LiveGemini(getSettings, transportFetch(transport))] satisfies DubProvider[];
      },
    });
    // verification hook (isolated world): engine events without keys or audio
    (globalThis as unknown as { __nvt?: typeof runtime.debug }).__nvt = runtime.debug;

    onSettingsChanged((s) => runtime.applySettings(s));
    runtime.watch(document);

    // local log sink (tools/diag-server.mjs): new diagnostics go to the background every 3 s; no sink running = nothing sent
    setInterval(() => {
      const entries = diag.drainUnsent();
      if (entries.length > 0) void browser.runtime.sendMessage({ type: 'nvt-diag-push', page: location.hostname, entries }).catch(() => {});
    }, 3000);

    // the Yandex login finishes in another tab: redraw an open in-page panel
    browser.storage.onChanged.addListener((c, area) => {
      if (area === 'local' && (YANDEX_AUTH_KEY in c || YANDEX_LOGIN_ERROR_KEY in c || VOICE_STATUS_KEY in c)) runtime.refreshPanel();
    });

    // popup / options page <-> this tab. Frames without a player stay silent for status/toggle/test-cue (another
    // frame answers); diagnostics: a frame with players answers at once, the top frame after a short grace period.
    browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg?.type !== 'nvt-panel') return false;
      const hasVideo = runtime.controllers.size > 0;
      switch (msg.op) {
        case 'status': {
          const status = runtime.status();
          if (!status) return false;
          sendResponse({ status });
          return false;
        }
        case 'toggle':
          if (!hasVideo) return false;
          void runtime.toggle().then((status) => sendResponse({ status }));
          return true;
        case 'force':
          if (!hasVideo) return false;
          void runtime.forceTranslate().then((status) => sendResponse({ status }));
          return true;
        case 'test-cue':
          if (!hasVideo) return false;
          sendResponse({ ok: runtime.showTestCue(typeof msg.text === 'string' ? msg.text : 'Тестовый субтитр NVT') });
          return false;
        case 'diag':
        case 'diag-clear': {
          const run = (): void => {
            if (msg.op === 'diag-clear') {
              runtime.clearDiag();
              sendResponse({ ok: true });
            } else sendResponse({ text: runtime.diagReport(), source: location.hostname });
          };
          if (hasVideo) run();
          else if (window.top === window) setTimeout(run, 250);
          else return false;
          return true;
        }
        default:
          return false;
      }
    });
  },
});
