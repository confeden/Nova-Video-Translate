import { IdbCache, LiveGemini, createPageRuntime, type PageRuntime, createYandexProviders, startCacheMaintenance, transportFetch, type DubProvider, type FullTrackProber, type VoiceReport } from '@nvt/core';
import { gmGet, gmMenu, gmSet } from './gm';
import { createGmTransport } from './gmTransport';
import { isOauthCallback, oauthCallback } from './oauth';
import { createSettingsHost } from './panelHost';
import { NVT_VERSION } from './version';
import { VOICE_STATUS_KEY, loadSettings, onSettingsChanged } from './storage';
import { installTap, runPageTapOnly } from './tap';

function main(): void {
  // copy of this script injected into the page world: install the MSE tap and nothing else
  if (runPageTapOnly()) return;

  const transport = createGmTransport();

  // https://oauth.yandex.ru/verification_code?code=...&state=...  (D12)
  if (isOauthCallback()) {
    void oauthCallback(transport)
      .then((ok) => {
        if (ok) setTimeout(() => window.close(), 400);
      })
      .catch((e) => console.error('NVT: OAuth exchange failed', e instanceof Error ? e.message : 'error'));
    return;
  }

  // The tap must be in place before the page creates its SourceBuffers: install it right now (document-start).
  const tap = installTap();

  // Result cache: IndexedDB of the PAGE origin (a userscript has no origin of its own), i.e. one cache per site.
  const cache = new IdbCache();
  startCacheMaintenance(cache);

  const settingsHost = createSettingsHost(transport, cache);
  let runtime: PageRuntime | undefined;
  let fullTrack: FullTrackProber | undefined;
  let menuRegistered = false;
  const registerMenu = (): void => {
    if (menuRegistered) return;
    menuRegistered = true;
    gmMenu('Настройки NVT', () => runtime?.openPanel());
  };
  if (window.top === window) registerMenu();

  const boot = (): void => {
    runtime = createPageRuntime({
      loadSettings: async () => loadSettings(),
      settingsHost,
      version: NVT_VERSION,
      cache,
      subtitleTransport: () => transport,
      captions: () => tap.captions(),
      audioTracks: () => tap.audioTracks(),
      reportVoice(r: VoiceReport) {
        const st = (gmGet(VOICE_STATUS_KEY) ?? {}) as { live?: VoiceReport; voiced?: VoiceReport };
        if (r.outcome === 'ok') st.voiced = r;
        if (r.providerId === 'yandex-live') st.live = r;
        gmSet(VOICE_STATUS_KEY, st);
      },
      fullTrack: () => fullTrack,
      createProviders(getSettings) {
        const y = createYandexProviders(transport, { getToken: () => getSettings().yandexToken });
        fullTrack = y.fullTrack;
        return [y.yandexLive, y.yandex, new LiveGemini(getSettings, transportFetch(transport))] satisfies DubProvider[];
      },
      createCapture: (v, o) => tap.createCapture(v, o),
    });
    // verification hook (userscript sandbox global, not exposed to the page): engine events without keys or audio
    (globalThis as unknown as { __nvt?: unknown }).__nvt = { ...runtime.debug, tap: tap.mode };
    const rt = runtime;
    onSettingsChanged((s) => rt.applySettings(s), () => rt.refreshPanel());
    // a player living in an iframe still gets its own settings menu entry
    rt.watch(document, () => registerMenu());
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
}

try {
  main();
} catch (e) {
  console.error('NVT userscript failed to start', e);
}
