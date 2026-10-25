import type { SubtitleCue } from '../providers/types';
import { CueIndex } from './cueIndex';

export const SUBS_CSS = `
.nvt-subs{position:absolute;left:10%;right:10%;width:80%;z-index:2147482999;text-align:center;pointer-events:none;
 font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-weight:500;line-height:1.25;color:#fff}
.nvt-subs span{display:inline-block;max-width:100%;padding:.08em .4em;border-radius:.25em;background:rgba(0,0,0,.55);
 box-decoration-break:clone;-webkit-box-decoration-break:clone;
 max-height:2.7em;overflow:hidden;white-space:pre-line;overflow-wrap:anywhere;vertical-align:bottom}
`;

/** Sizing rules derived from the player box (pure, unit-tested). */
export function subtitleMetrics(playerW: number, playerH: number): { fontPx: number; bottomPx: number } {
  // clamp(14px, 1.6vw, 22px) with the player width standing in for the viewport width
  const fontPx = Math.round(Math.min(22, Math.max(14, playerW * 0.016)));
  // close to the bottom edge of the frame (may sit under YouTube's control bar)
  const bottomPx = Math.round(playerH * 0.035);
  return { fontPx, bottomPx };
}

/** Text of a cue for the chosen language; falls back to the translation when no original is known. */
export function cueDisplayText(cue: SubtitleCue | undefined, lang: 'original' | 'translation'): string {
  if (!cue) return '';
  return lang === 'original' && cue.src ? cue.src : cue.text;
}

export interface SubtitleOverlay {
  /** which text to show (applies live, re-renders the current cue) */
  setLang(lang: 'original' | 'translation'): void;
  /** replace the cue list (sorted copy is kept) */
  setCues(cues: readonly SubtitleCue[]): void;
  /** show `text` for `ms` regardless of settings / media time (debug hook) */
  showTest(text: string, ms?: number): void;
  /** master switch: false hides everything except an active test cue */
  setEnabled(on: boolean): void;
  destroy(): void;
}

/**
 * Subtitle line inside the player container (so fullscreen shows it), pointer-events:none, <=2 lines, font scaled
 * with the player. Follows `video.currentTime` (media time => playback rate / seek / pause are naturally respected):
 * re-rendered on video events and by a light 150 ms timer, so a cue disappears when it ends.
 */
export function createSubtitleOverlay(video: HTMLVideoElement, getHost: () => HTMLElement | null): SubtitleOverlay {
  let index = new CueIndex([]);
  let enabled = false;
  let lang: 'original' | 'translation' = 'original';
  let el: HTMLElement | undefined;
  let textEl: HTMLElement | undefined;
  let test: { text: string; until: number } | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let ro: ResizeObserver | undefined;
  let shown = '';
  /** identity of what is on screen: the active cue object (or the test cue); the timer re-renders only when it changes */
  let shownKey: unknown = null;
  const EVENTS = ['timeupdate', 'seeked', 'seeking', 'pause', 'play', 'ratechange', 'loadedmetadata'] as const;

  /** positions the line inside the VIDEO's box (the container may be much larger than the video, e.g. <body>) */
  const layout = (host: HTMLElement): void => {
    if (!el) return;
    const hr = host.getBoundingClientRect();
    const vr = video.getBoundingClientRect();
    if (vr.width === 0 || vr.height === 0) return;
    const m = subtitleMetrics(vr.width, vr.height);
    const st = el.style;
    st.fontSize = `${m.fontPx}px`;
    st.right = 'auto';
    st.left = `${Math.round(vr.left - hr.left - host.clientLeft + vr.width * 0.10)}px`;
    st.width = `${Math.round(vr.width * 0.80)}px`;
    st.bottom = `${Math.round(hr.bottom - vr.bottom - host.clientTop + m.bottomPx)}px`;
  };

  const ensureEl = (): boolean => {
    const host = getHost();
    if (!host) return false;
    if (el && el.parentElement === host) return true;
    el?.remove();
    ro?.disconnect();
    el = video.ownerDocument.createElement('div');
    el.className = 'nvt-subs';
    el.setAttribute('aria-live', 'off');
    textEl = video.ownerDocument.createElement('span');
    el.append(textEl);
    host.appendChild(el);
    layout(host);
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => layout(host));
      ro.observe(host);
      ro.observe(video);
    }
    return true;
  };

  /** the cue that should be visible right now (object identity), null when nothing is */
  const activeKey = (): unknown => {
    if (test && Date.now() < test.until) return test;
    return enabled ? (index.at(video.currentTime) ?? null) : null;
  };

  const render = (): void => {
    const now = Date.now();
    if (test && now >= test.until) test = undefined;
    shownKey = activeKey();
    const want = test ? test.text : enabled ? cueDisplayText(index.at(video.currentTime), lang) : '';
    if (!want) {
      if (el) el.style.display = 'none';
      shown = '';
      return;
    }
    if (!ensureEl() || !el || !textEl) return;
    if (want !== shown) {
      textEl.textContent = want;
      shown = want;
    }
    el.style.display = '';
    const host = el.parentElement;
    if (host) layout(host); // the video may have moved / scrolled inside a larger container
  };

  const onEvent = (): void => render();
  for (const e of EVENTS) video.addEventListener(e, onEvent);
  // light timer: a cue that ends (or starts) between media events is caught here; re-render only on a cue change
  timer = setInterval(() => {
    if (activeKey() !== shownKey) render();
  }, 250);

  return {
    setLang(l) {
      if (l === lang) return;
      lang = l;
      render();
    },
    setCues(cues) {
      index = new CueIndex(cues);
      render();
    },
    showTest(text, ms = 6000) {
      test = { text, until: Date.now() + ms };
      render();
    },
    setEnabled(on) {
      enabled = on;
      render();
    },
    destroy() {
      for (const e of EVENTS) video.removeEventListener(e, onEvent);
      if (timer) clearInterval(timer);
      ro?.disconnect();
      el?.remove();
      el = undefined;
    },
  };
}
