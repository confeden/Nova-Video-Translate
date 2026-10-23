import { createAudioTracksBridgeClient, createLocalAudioTracksController, installAudioTracksMain, type AudioTracksController, createCapture, createCaptionsBridgeClient, createLocalCaptionsReader, createMseBridgeClient, installCaptionsMain, installMseTapLocal, installMseTapMain, type Capture, type CaptionsReader, type MseBridgeClient } from '@nvt/core';
import { gmScriptSource, hasUnsafeWindow, pageWindow } from './gm';

/**
 * S1 (MSE tap) in a userscript. The tap must patch the PAGE's MediaSource / SourceBuffer prototypes (pure
 * pass-through wrappers, D14) and must be installed at document-start, before the player creates its buffers.
 *
 *  - 'direct':   the sandbox hands us the page realm (Tampermonkey `unsafeWindow`, @sandbox raw, or the script runs in
 *                the MAIN world). We patch through it and talk to the tap by plain function calls (no postMessage,
 *                the page cannot see the PCM traffic).
 *  - 'injected': the script runs in a separate JS world (no usable `unsafeWindow`, e.g. a Chromium user-script world).
 *                A copy of this very script (GM_info.scriptSource) is inserted as a <script> element, executes in the
 *                page world with the `__nvtPageTapOnly` flag and installs only the tap; the existing postMessage
 *                bridge connects the two halves. Blocked by a strict page CSP / Trusted Types -> mode 'none'.
 *  - 'none':     no tap; capture falls through to S2 (direct URL) / S3 (real-time tap).
 */
export type TapMode = 'direct' | 'injected' | 'none';

export const PAGE_TAP_FLAG = '__nvtPageTapOnly';

/** Entry of the injected copy (page realm): install the tap, nothing else. */
export function runPageTapOnly(): boolean {
  if (!(globalThis as unknown as Record<string, unknown>)[PAGE_TAP_FLAG]) return false;
  try {
    installMseTapMain();
  } catch {
    /* never break the page */
  }
  try {
    installCaptionsMain();
  } catch {
    /* never break the page */
  }
  try {
    installAudioTracksMain();
  } catch {
    /* never break the page */
  }
  return true;
}

function sameRealm(): boolean {
  try {
    const w = pageWindow();
    return hasUnsafeWindow() && w.Object === Object && typeof w.MediaSource === 'function' && typeof w.SourceBuffer === 'function';
  } catch {
    return false;
  }
}

/** Inserts the copy of this script into the page world. Returns false when impossible (no source, CSP, Trusted Types). */
function injectNow(src: string): boolean {
  const root = document.documentElement;
  if (!root) return false;
  const code = `window.${PAGE_TAP_FLAG}=true;
${src}`;
  const s = document.createElement('script');
  try {
    const tt = (window as unknown as { trustedTypes?: { createPolicy(n: string, o: { createScript(x: string): string }): { createScript(x: string): string } } }).trustedTypes;
    s.textContent = tt ? tt.createPolicy('nvt-tap', { createScript: (x) => x }).createScript(code) : code;
    root.appendChild(s);
    s.remove();
    return true;
  } catch {
    s.remove();
    return false;
  }
}

/** At document-start the root element may not exist yet: inject the moment it appears. */
function inject(): boolean {
  const src = gmScriptSource();
  if (!src) return false;
  if (document.documentElement) return injectNow(src);
  const mo = new MutationObserver(() => {
    if (!document.documentElement) return;
    mo.disconnect();
    injectNow(src);
  });
  mo.observe(document, { childList: true });
  return true;
}

export interface Tap {
  readonly mode: TapMode;
  /** reader of the page player's caption tracks, matching the realm the script runs in */
  captions(): CaptionsReader;
  /** reader / switcher of the page player's audio tracks (native Russian dub), matching the realm the script runs in */
  audioTracks(): AudioTracksController;
  /** createCapture bound to the tap */
  createCapture(video: HTMLMediaElement, opts?: Parameters<typeof createCapture>[1]): Promise<Capture>;
}

export function installTap(): Tap {
  const win = pageWindow();
  if (sameRealm()) {
    try {
      const local = installMseTapLocal({ target: win as unknown as Record<string, unknown> });
      return {
        mode: 'direct',
        captions: () => createLocalCaptionsReader(win as unknown as Parameters<typeof createLocalCaptionsReader>[0]),
        audioTracks: () => createLocalAudioTracksController(win as unknown as Parameters<typeof createLocalAudioTracksController>[0]),
        createCapture: (v, o) => createCapture(v, { ...o, bridge: local.client }) };
    } catch {
      /* fall through to the injected copy */
    }
  }
  const mode: TapMode = inject() ? 'injected' : 'none';
  return {
    mode,
    captions: () => createCaptionsBridgeClient(win),
    audioTracks: () => createAudioTracksBridgeClient(win),
    async createCapture(video, opts) {
      if (mode === 'none') return createCapture(video, { ...opts, strategies: opts?.strategies ?? ['direct', 'realtime'] });
      // a fresh client per attempt; bridge on the page's window so event.source matches inside a sandbox proxy
      const bridge: MseBridgeClient = createMseBridgeClient(win);
      try {
        const cap = await createCapture(video, { ...opts, bridge });
        if (cap.kind !== 'mse') {
          bridge.dispose();
          return cap;
        }
        const stop = cap.stop.bind(cap);
        return { ...cap, kind: cap.kind, start: cap.start.bind(cap), onChunk: cap.onChunk.bind(cap), stop: () => (stop(), bridge.dispose()) };
      } catch (e) {
        bridge.dispose();
        throw e;
      }
    },
  };
}
