import { devAudio, createCaptionsBridgeClient, createPageProviders, createPageRuntime, createRemoteCache, type CacheMessage, type CacheReply, type FullTrackProber, type VoiceReport } from '@nvt/core';
import { browser } from 'wxt/browser';
import { createSwTransport, transportFetch } from '../utils/swTransport';
import { NVT_DEVLOG } from '../utils/version';
import { startDevLog } from '../utils/devlog';
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
    let censored: ((start: number, duration: number) => boolean) | undefined;
    const runtime = createPageRuntime({
      loadSettings,
      reportVoice,
      version: NVT_VERSION,
      settingsHost: createBaseHost(),
      subtitleTransport: () => (subsTransport ??= createSwTransport()),
      hlsTransport: () => (subsTransport ??= createSwTransport()),
      cache: createRemoteCache((m: CacheMessage) => browser.runtime.sendMessage(m) as Promise<CacheReply | undefined>),
      fullTrack: () => fullTrack,
      captions: () => reader,
      // 0.3.6: a cell whose platform captions carry a bleeped word is voiced without Yandex when another tier can (engine censor skip)
      censored: (start, duration) => censored?.(start, duration) ?? false,
      createProviders(getSettings) {
        const transport = createSwTransport();
        const chain = createPageProviders({ transport, getSettings, reader, localTts: registerExtensionLocalTts(getSettings) });
        fullTrack = chain.fullTrack;
        censored = chain.censored;
        return chain.providers;
      },
    });
    // verification hook (isolated world): engine events without keys or audio
    (globalThis as unknown as { __nvt?: typeof runtime.debug }).__nvt = runtime.debug;

    onSettingsChanged((s) => runtime.applySettings(s));
    runtime.watch(document);

    // local log sink (tools/diag-server.mjs): new diagnostics go to the background every 3 s; no sink running = nothing sent
    if (NVT_DEVLOG) {
      // 0.3.9: noisy decoded dubs as 16-bit PCM for the local sink (tools/diag-server.mjs /audio), devlog only
      devAudio.dump = (name, data, sampleRate) => {
        const pcm = new Int16Array(data.length);
        for (let i = 0; i < data.length; i++) pcm[i] = Math.max(-32768, Math.min(32767, Math.round(data[i]! * 32767)));
        const bytes = new Uint8Array(pcm.buffer);
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        void browser.runtime.sendMessage({ type: 'nvt-audio-push', name, sampleRate, pcm16: btoa(bin) }).catch(() => {});
      };
      startDevLog(location.hostname, async (entries) => {
        const reply = await browser.runtime.sendMessage({ type: 'nvt-diag-push', page: location.hostname, entries });
        return reply?.ok === true;
      });
    }

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
