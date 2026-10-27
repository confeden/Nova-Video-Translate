import { diag } from '../diag';
import type { SubtitleCue } from '../providers/types';
import { mergeCuesToPhrases } from './subtitlePhrases';
import {
  DEFAULT_SUB_STYLE,
  SUB_BG_TRANSP_MAX,
  SUB_COLORS,
  SUB_FONTS,
  SUB_SIZE_MAX,
  SUB_SIZE_MIN,
  SUB_TEXT_TRANSP_MAX,
  SUB_TRANSP_STEP,
  SUB_WEIGHTS,
  hexAlpha,
  normalizeSubStyle,
  type SubStyle,
} from './subtitleStyle';

/** The subtitle layer sits UNDER YouTube's control bar (z-index 59 there): the scrubber and the buttons draw over the text. */
export const SUBS_CSS = `
.nvt-subs{position:absolute;left:10%;right:10%;width:80%;z-index:40;text-align:center;pointer-events:none;
 font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-weight:500;line-height:1.25;color:#fff}
.nvt-subs span{display:inline-block;max-width:100%;padding:.08em .4em;border-radius:.25em;background:var(--nvt-bg,rgba(0,0,0,.55));
 box-decoration-break:clone;-webkit-box-decoration-break:clone;border:1px solid currentColor;
 max-height:2.7em;overflow:hidden;white-space:pre-line;overflow-wrap:anywhere;vertical-align:bottom;pointer-events:auto}
.nvt-subs.nvt-noframe span{border-color:transparent}
.nvt-subs .nvt-lw{display:inline;padding:0;border:0;background:none;max-height:none;overflow:visible;white-space:pre-wrap}
.nvt-subs .nvt-cur{text-shadow:0 0 1px var(--nvt-neon),0 0 2px var(--nvt-neon);background:var(--nvt-neon-soft);border-radius:.2em;box-decoration-break:clone;-webkit-box-decoration-break:clone}
.nvt-subs .nvt-canvas{position:absolute;left:0;top:0;width:100%;height:100%;display:block}
.nvt-subs.nvt-ticker{left:0;right:0;width:100%;overflow:hidden;min-height:1.7em;padding:.08em 0;border-radius:.25em;
 background:var(--nvt-bg,rgba(0,0,0,.55));border:1px solid currentColor;text-align:left}
.nvt-subs.nvt-ticker.nvt-noframe{border-color:transparent}
.nvt-subs .nvt-track{position:absolute;left:0;top:0;width:100%;height:100%;will-change:transform}
.nvt-subs .nvt-w{position:absolute;top:50%;transform:translateY(-50%);line-height:1.25;white-space:nowrap;padding:0;border:0;background:none;max-height:none;overflow:visible}
.nvt-subs .nvt-mark{position:absolute;top:0;bottom:0;left:50%;width:2px;margin-left:-1px;pointer-events:none}
.nvt-gear{position:absolute;width:28px;height:28px;border:0;border-radius:50%;padding:0;margin:0;cursor:pointer;
 z-index:2147483001;background:rgba(0,0,0,.6);color:#fff;font:16px/28px system-ui,sans-serif;text-align:center;
 opacity:0;pointer-events:none;transition:opacity .15s}
.nvt-gear.nvt-on{opacity:1;pointer-events:auto}
.nvt-subs-panel{position:absolute;z-index:2147483002;display:none;flex-direction:column;gap:7px;width:250px;padding:10px 12px;
 border-radius:8px;background:rgba(18,18,18,.94);color:#fff;font:12px/1.3 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
 box-shadow:0 4px 16px rgba(0,0,0,.45);pointer-events:auto;box-sizing:border-box}
.nvt-subs-panel.nvt-open{display:flex}
.nvt-subs-panel label{display:flex;justify-content:space-between;align-items:center;gap:8px}
.nvt-subs-panel select,.nvt-subs-panel input[type=range]{width:130px;margin:0;font:inherit;color:#fff;background:#222;border:1px solid #444;border-radius:4px}
.nvt-subs-panel input[type=checkbox]{margin:0}
.nvt-subs-panel .nvt-sws{display:flex;gap:6px}
.nvt-subs-panel .nvt-sw{width:18px;height:18px;border-radius:50%;padding:0;border:2px solid transparent;cursor:pointer}
.nvt-subs-panel .nvt-sw[aria-pressed=true]{border-color:#fff}
.nvt-subs-panel .nvt-head{display:flex;justify-content:space-between;align-items:center;font-weight:600}
.nvt-subs-panel .nvt-x{background:none;border:0;color:#fff;cursor:pointer;font:inherit;padding:0 2px}
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

/** Average glyph advance in em: the layer lays words out by their length (no DOM measuring, so the timeline is global). */
export const TICKER_CHAR_EM = 0.56;
/** the scrolling layer keeps this many seconds of words around the playhead in the DOM */
export const TICKER_WINDOW_SEC = 30;
/** the layer's speed follows the audio's average speed over a window centred on now (s): no speed jumps at word boundaries */
export const TICKER_VEL_WINDOW_SEC = 1.2;
/** the layer's speed changes gradually, with this time constant (s): it never jerks */
export const TICKER_VEL_TAU_SEC = 0.5;
/** extra speed (em/s) per em the layer lags behind the audio: a gentle pull, never a snap */
export const TICKER_PULL_PER_SEC = 4;
/** a neon word stays lit this long (s) after its end, so no word is ever dark between two words */
export const NEON_HOLD_SEC = 0.12;
/** the layer always flows forward: at least this speed (em/s), never faster than the max, and never more than the lead
 *  ahead of the audio. Words still come in from the right, so a pause is a slower flow, not a stop. */
export const TICKER_MIN_EM_S = 0.8;
/** the cap sits well above dense speech (about 10-13 em/s for fast English): a lower cap made the layer saturate, lag and jerk */
export const TICKER_MAX_EM_S = 60;
export const TICKER_MAX_LEAD_EM = 3;
/** the translation is shown in the layer while it covers this many seconds ahead; below that the original text is shown */
export const TICKER_FALLBACK_SEC = 8;
export const TICKER_RESUME_SEC = 15;

export interface SubtitleOverlay {
  /** which text to show (applies live, re-renders the current cue) */
  setLang(lang: 'original' | 'translation'): void;
  /** the look of the line (size, font, colour, frame, transparency, lines, scrolling layer, neon word); applies live */
  setStyle(style: SubStyle): void;
  /** replace the cue list */
  setCues(cues: readonly SubtitleCue[]): void;
  /** show `text` for `ms` regardless of settings / media time (debug hook) */
  showTest(text: string, ms?: number): void;
  /** master switch: false hides everything except an active test cue */
  setEnabled(on: boolean): void;
  destroy(): void;
}

/** one spoken word on the timeline: when it is said (media time) and where it sits on the scrolling layer (em) */
export interface TimedWord {
  text: string;
  t0: number;
  t1: number;
  x0: number;
  x1: number;
}

/**
 * The timeline of the subtitle text: each phrase's words share the phrase's own time (in proportion to their length), and
 * the layer position is the running sum of word widths. Fast speech moves the layer fast; a pause (no words) holds it still.
 * Pure, unit-tested.
 */
export function buildWordTimeline(cues: readonly SubtitleCue[], lang: 'original' | 'translation'): TimedWord[] {
  const out: TimedWord[] = [];
  let x = 0;
  for (const c of cues) {
    const words = cueDisplayText(c, lang).trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;
    const dur = Math.max(0.05, c.end - c.start);
    const total = words.reduce((a, w) => a + w.length + 1, 0);
    let t = c.start;
    for (const w of words) {
      const span = (dur * (w.length + 1)) / total;
      const x1 = x + (w.length + 1) * TICKER_CHAR_EM;
      out.push({ text: w, t0: t, t1: t + span, x0: x, x1 });
      t += span;
      x = x1;
    }
  }
  return out;
}

/** index of the last word whose start is <= t (-1 before the first) */
export function lastWordAt(words: readonly TimedWord[], t: number): number {
  let lo = 0;
  let hi = words.length - 1;
  let k = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (words[m]!.t0 <= t) {
      k = m;
      lo = m + 1;
    } else hi = m - 1;
  }
  return k;
}

/** the word being said at t (with a short hold after its end), or -1 */
export function currentWord(words: readonly TimedWord[], t: number): number {
  const k = lastWordAt(words, t);
  if (k < 0) return -1;
  return t <= words[k]!.t1 + NEON_HOLD_SEC ? k : -1;
}

/** layer position (em) at media time t: linear inside a word, flat during pauses */
export function layerPositionAt(words: readonly TimedWord[], t: number): number {
  if (words.length === 0) return 0;
  const k = lastWordAt(words, t);
  if (k < 0) return words[0]!.x0;
  const w = words[k]!;
  if (t >= w.t1) return w.x1;
  const f = (t - w.t0) / Math.max(1e-6, w.t1 - w.t0);
  return w.x0 + (w.x1 - w.x0) * f;
}

/** the scrolling layer's own motion: position (em) and speed (em/s) */
export interface TickerMotion {
  pos: number;
  vel: number;
}

/**
 * One frame of the scrolling layer's motion. The wanted speed is the audio's average speed over the last second or so plus a
 * gentle pull to the audio position; the actual speed eases toward it. Nothing jumps at word boundaries, and a pause slows the
 * flow down instead of stopping it. Pure, unit-tested.
 */
export function stepTicker(m: TickerMotion, words: readonly TimedWord[], t: number, dt: number): TickerMotion {
  if (words.length === 0 || dt <= 0) return m;
  const xEnd = words[words.length - 1]!.x1;
  const target = layerPositionAt(words, t);
  // centred window: the timeline is known ahead, so the speed starts to fall before a pause, not after it
  const half = TICKER_VEL_WINDOW_SEC / 2;
  const avg = (layerPositionAt(words, t + half) - layerPositionAt(words, t - half)) / TICKER_VEL_WINDOW_SEC;
  let want = avg + TICKER_PULL_PER_SEC * (target - m.pos);
  // a small lead over the audio keeps the flow going; a bigger one holds until the audio catches up
  want = m.pos < target + TICKER_MAX_LEAD_EM ? Math.max(want, TICKER_MIN_EM_S) : Math.max(0, want);
  want = Math.min(TICKER_MAX_EM_S, want);
  if (m.pos >= xEnd) want = 0;
  const vel = m.vel + (want - m.vel) * (1 - Math.exp(-dt / TICKER_VEL_TAU_SEC));
  return { pos: Math.min(xEnd, m.pos + vel * dt), vel };
}

/**
 * The same text rebuilt with more cues: word positions count from the first cue, so a cue that lands before the playhead
 * moves every later word by its width. Moving the layer by the same change at the playhead keeps the words on screen still.
 * Pure, unit-tested.
 */
export function anchorTicker(m: TickerMotion, before: readonly TimedWord[], after: readonly TimedWord[], t: number): TickerMotion {
  if (before.length === 0 || after.length === 0) return m;
  return { pos: m.pos + layerPositionAt(after, t) - layerPositionAt(before, t), vel: m.vel };
}

const STOP_EVENTS = ['pointerdown', 'mousedown', 'mouseup', 'click', 'dblclick', 'keydown', 'wheel'] as const;
const stop = (e: Event): void => e.stopPropagation();

/**
 * Subtitle layer over the player. Line mode: phrases of 1-3 lines; with the neon option (original text shown) the word being
 * said is lit. Scrolling-layer mode ("Бегущая строка"): one unbroken line across the whole player; words appear as they are
 * said and the layer moves with the original audio (word timing), easing its speed. Hovering shows a settings button; its
 * panel reports the style through `onStyleChange` (the caller persists it).
 */
export function createSubtitleOverlay(
  video: HTMLVideoElement,
  getHost: () => HTMLElement | null,
  onStyleChange?: (style: SubStyle) => void,
  onLangChange?: (lang: 'original' | 'translation') => void,
): SubtitleOverlay {
  const doc = video.ownerDocument;
  let cueList: SubtitleCue[] = [];
  let enabled = false;
  let lang: 'original' | 'translation' = 'original';
  let style: SubStyle = { ...DEFAULT_SUB_STYLE };
  let el: HTMLElement | undefined;
  let textEl: HTMLElement | undefined;
  let track: HTMLElement | undefined;
  let gearEl: HTMLButtonElement | undefined;
  let panelEl: HTMLElement | undefined;
  let panelOpen = false;
  const ctl: {
    size?: HTMLInputElement;
    font?: HTMLSelectElement;
    weight?: HTMLSelectElement;
    align?: HTMLSelectElement;
    lines?: HTMLSelectElement;
    lang?: HTMLSelectElement;
    ticker?: HTMLInputElement;
    highlight?: HTMLInputElement;
    frame?: HTMLInputElement;
    textTransparency?: HTMLInputElement;
    bgTransparency?: HTMLInputElement;
    swatches: HTMLButtonElement[];
  } = { swatches: [] };
  let test: { text: string; until: number } | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let ro: ResizeObserver | undefined;
  let shown = '';
  let shownKey: unknown = null;
  /** media-clock estimate between media events (rAF runs it smoothly while playing) */
  /** the media clock the layer follows: advanced every frame, corrected gently toward the player's currentTime */
  let estT = 0;
  let rafId = 0;
  let lastFrame = 0;
  /** timeline of the current text (rebuilt when cues or language change) */
  /** the timeline in use (translation, or the original while the translation does not yet cover the playhead) */
  let words: TimedWord[] = [];
  let wordsT: TimedWord[] = [];
  let wordsO: TimedWord[] = [];
  let tlKey = '';
  let srcMode: 't' | 'o' = 't';
  /** scrolling layer: the word spans in the DOM, their window start and the layer's eased position (em) */
  let canvas: HTMLCanvasElement | undefined;
  let ctx2d: CanvasRenderingContext2D | null = null;
  let winKey = '';
  let tick: TickerMotion | null = null;
  let lastSampleMs = 0;
  let litIdx = -1;
  const EVENTS = ['timeupdate', 'seeked', 'seeking', 'pause', 'play', 'ratechange', 'loadedmetadata'] as const;

  const alphaOf = (): number => 1 - style.textTransparency / 100;
  const bgAlpha = (): number => 1 - style.bgTransparency / 100;
  const neonOn = (): boolean => style.highlight && lang === 'original';

  /** positions the line inside the VIDEO's box; the scrolling layer covers the whole player width */
  const layout = (host: HTMLElement): void => {
    if (!el) return;
    const hr = host.getBoundingClientRect();
    const vr = video.getBoundingClientRect();
    if (vr.width === 0 || vr.height === 0) return;
    const m = subtitleMetrics(vr.width, vr.height);
    const st = el.style;
    st.fontSize = `${Math.round(m.fontPx * (style.size / 100) * 10) / 10}px`;
    st.right = 'auto';
    if (style.ticker) {
      st.left = '0px';
      st.width = `${Math.round(hr.width)}px`;
    } else {
      st.left = `${Math.round(vr.left - hr.left - host.clientLeft + vr.width * 0.10)}px`;
      st.width = `${Math.round(vr.width * 0.80)}px`;
    }
    st.bottom = `${Math.round(hr.bottom - vr.bottom - host.clientTop + m.bottomPx)}px`;
    // the gear and its panel sit at the top-right corner of the video
    const top = Math.round(vr.top - hr.top - host.clientTop + 8);
    const right = Math.round(hr.right - vr.right + 8);
    if (gearEl) {
      gearEl.style.top = `${top}px`;
      gearEl.style.right = `${right}px`;
    }
    if (panelEl) {
      panelEl.style.top = `${top + 36}px`;
      panelEl.style.right = `${right}px`;
    }
  };

  const setHot = (on: boolean): void => {
    gearEl?.classList.toggle('nvt-on', on || panelOpen);
  };

  const applyStyle = (): void => {
    if (!el) return;
    const f = SUB_FONTS[style.font] ?? SUB_FONTS[0]!;
    el.classList.toggle('nvt-ticker', style.ticker);
    el.classList.toggle('nvt-noframe', !style.frame);
    el.style.textAlign = style.align;
    el.style.fontFamily = f.css;
    el.style.fontWeight = String(style.weight);
    // text transparency: the text, the frame and the highlight; the background has its own alpha (CSS variable)
    el.style.color = hexAlpha(style.color, alphaOf());
    el.style.setProperty('--nvt-bg', `rgba(0,0,0,${bgAlpha()})`);
    el.style.setProperty('--nvt-neon', hexAlpha(style.color, 0.9));
    el.style.setProperty('--nvt-neon-soft', hexAlpha(style.color, 0.18));
    winKey = '';
    syncPanel();
    const host = el.parentElement;
    if (host) layout(host);
  };

  /** a plain line element */
  const buildLine = (text: string): HTMLElement => {
    const span = doc.createElement('span');
    span.textContent = text;
    if (!style.ticker) span.style.maxHeight = `${style.lines * 1.25 + 0.2}em`;
    span.addEventListener('pointerenter', () => setHot(true));
    span.addEventListener('pointerleave', () => setHot(false));
    return span;
  };

  const ensureEl = (): boolean => {
    const host = getHost();
    if (!host) return false;
    if (el && el.parentElement === host) return true;
    el?.remove();
    ro?.disconnect();
    el = doc.createElement('div');
    el.className = 'nvt-subs';
    el.setAttribute('aria-live', 'off');
    track = undefined;
    textEl = undefined;
    canvas = undefined;
    ctx2d = null;
    winKey = '';
    host.appendChild(el);
    applyStyle();
    layout(host);
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => layout(host));
      ro.observe(host);
      ro.observe(video);
    }
    return true;
  };

  const ensureGear = (host: HTMLElement): void => {
    if (gearEl && gearEl.parentElement === host) return;
    gearEl?.remove();
    gearEl = doc.createElement('button');
    gearEl.type = 'button';
    gearEl.className = 'nvt-gear';
    gearEl.textContent = '⚙';
    gearEl.title = 'Настройки субтитров';
    gearEl.setAttribute('aria-label', 'Настройки субтитров');
    for (const ev of STOP_EVENTS) gearEl.addEventListener(ev, stop);
    gearEl.addEventListener('pointerenter', () => setHot(true));
    gearEl.addEventListener('pointerleave', () => setHot(false));
    gearEl.addEventListener('click', () => openPanel(!panelOpen));
    host.appendChild(gearEl);
    setHot(false);
  };

  /** the style panel: controls write `style` through update(); syncPanel() reads it back */
  const update = (patch: Partial<SubStyle>): void => {
    style = normalizeSubStyle({ ...style, ...patch });
    applyStyle();
    render(true);
    onStyleChange?.(style);
  };

  const syncPanel = (): void => {
    if (!panelEl) return;
    if (ctl.size) ctl.size.value = String(style.size);
    if (ctl.font) ctl.font.value = String(style.font);
    if (ctl.weight) ctl.weight.value = String(style.weight);
    if (ctl.align) ctl.align.value = style.align;
    if (ctl.lang) ctl.lang.value = lang;
    if (ctl.lines) {
      ctl.lines.value = String(style.lines);
      ctl.lines.disabled = style.ticker;
    }
    if (ctl.ticker) ctl.ticker.checked = style.ticker;
    if (ctl.highlight) ctl.highlight.checked = style.highlight;
    if (ctl.frame) ctl.frame.checked = style.frame;
    if (ctl.textTransparency) ctl.textTransparency.value = String(style.textTransparency);
    if (ctl.bgTransparency) ctl.bgTransparency.value = String(style.bgTransparency);
    for (const b of ctl.swatches) b.setAttribute('aria-pressed', String(b.dataset.hex === style.color));
  };

  const field = (label: string, input: HTMLElement): HTMLElement => {
    const row = doc.createElement('label');
    const t = doc.createElement('span');
    t.textContent = label;
    row.append(t, input);
    return row;
  };
  const select = (options: Array<[string, string]>, onPick: (v: string) => void): HTMLSelectElement => {
    const s = doc.createElement('select');
    for (const [value, label] of options) {
      const o = doc.createElement('option');
      o.value = value;
      o.textContent = label;
      s.append(o);
    }
    s.addEventListener('change', () => onPick(s.value));
    return s;
  };
  const checkbox = (onPick: (v: boolean) => void): HTMLInputElement => {
    const c = doc.createElement('input');
    c.type = 'checkbox';
    c.addEventListener('change', () => onPick(c.checked));
    return c;
  };
  const transpSlider = (max: number, key: 'textTransparency' | 'bgTransparency'): HTMLInputElement => {
    const r = doc.createElement('input');
    r.type = 'range';
    r.min = '0';
    r.max = String(max);
    r.step = String(SUB_TRANSP_STEP);
    r.addEventListener('input', () => update({ [key]: Number(r.value) }));
    return r;
  };

  /** the panel's language choice: applies at once; the caller saves it (the same setting as in the settings panel) */
  const setLangFromPanel = (l: 'original' | 'translation'): void => {
    if (l === lang) return;
    lang = l;
    render(true);
    onLangChange?.(l);
  };

  const ensurePanel = (host: HTMLElement): void => {
    if (panelEl && panelEl.parentElement === host) return;
    panelEl?.remove();
    panelEl = doc.createElement('div');
    panelEl.className = 'nvt-subs-panel';
    for (const ev of STOP_EVENTS) panelEl.addEventListener(ev, stop);

    const head = doc.createElement('div');
    head.className = 'nvt-head';
    head.textContent = 'Субтитры';
    const close = doc.createElement('button');
    close.type = 'button';
    close.className = 'nvt-x';
    close.textContent = '✕';
    close.title = 'Закрыть';
    close.addEventListener('click', () => openPanel(false));
    head.append(close);

    ctl.size = doc.createElement('input');
    ctl.size.type = 'range';
    ctl.size.min = String(SUB_SIZE_MIN);
    ctl.size.max = String(SUB_SIZE_MAX);
    ctl.size.step = '10';
    ctl.size.addEventListener('input', () => update({ size: Number(ctl.size!.value) }));

    ctl.textTransparency = transpSlider(SUB_TEXT_TRANSP_MAX, 'textTransparency');
    ctl.bgTransparency = transpSlider(SUB_BG_TRANSP_MAX, 'bgTransparency');

    ctl.font = select(SUB_FONTS.map((f, i): [string, string] => [String(i), f.label]), (v) => update({ font: Number(v) }));
    ctl.weight = select(
      SUB_WEIGHTS.map((w): [string, string] => [String(w), w === 400 ? 'обычный' : w === 500 ? 'средний' : w === 700 ? 'жирный' : 'очень жирный']),
      (v) => update({ weight: Number(v) as SubStyle['weight'] }),
    );
    const sws = doc.createElement('div');
    sws.className = 'nvt-sws';
    ctl.swatches = SUB_COLORS.map((c) => {
      const b = doc.createElement('button');
      b.type = 'button';
      b.className = 'nvt-sw';
      b.dataset.hex = c.hex;
      b.title = c.label;
      b.style.background = c.hex;
      b.addEventListener('click', () => update({ color: c.hex }));
      sws.append(b);
      return b;
    });
    ctl.align = select([['left', 'слева'], ['center', 'по центру'], ['right', 'справа']], (v) => update({ align: v as SubStyle['align'] }));
    ctl.lines = select([['1', '1 строка'], ['2', '2 строки'], ['3', '3 строки']], (v) => update({ lines: Number(v) as SubStyle['lines'] }));
    ctl.lang = select([['original', 'оригинал'], ['translation', 'русский']], (v) => setLangFromPanel(v === 'translation' ? 'translation' : 'original'));
    ctl.ticker = checkbox((v) => update({ ticker: v }));
    ctl.highlight = checkbox((v) => update({ highlight: v }));
    ctl.frame = checkbox((v) => update({ frame: v }));

    panelEl.append(
      head,
      field('Язык субтитров', ctl.lang),
      field('Размер', ctl.size),
      field('Прозрачность текста', ctl.textTransparency),
      field('Прозрачность фона', ctl.bgTransparency),
      field('Шрифт', ctl.font),
      field('Жирность', ctl.weight),
      field('Цвет', sws),
      field('Рамка', ctl.frame),
      field('Выравнивание', ctl.align),
      field('Строк', ctl.lines),
      field('Бегущая строка', ctl.ticker),
      field('Неон звучащего слова', ctl.highlight),
    );
    host.appendChild(panelEl);
    syncPanel();
    layout(host);
  };

  const openPanel = (on: boolean): void => {
    const host = getHost();
    if (!host) return;
    ensureGear(host);
    ensurePanel(host);
    panelOpen = on;
    panelEl!.classList.toggle('nvt-open', on);
    setHot(false);
    if (on) syncPanel();
  };

  const activeCue = (t: number): SubtitleCue | undefined => cueList.find((c) => t >= c.start && t < c.end);
  const activeKey = (): unknown => {
    if (test && Date.now() < test.until) return test;
    return enabled ? (activeCue(video.currentTime) ?? null) : null;
  };

  /** media time, interpolated between media events so the layer moves every frame */
  const mediaNow = (): number => {
    if (video.paused || video.seeking) return video.currentTime;
    return estT;
  };
  /** one frame: advance the clock by the real time elapsed, pull it 8% toward the player's time (snap on seeks/stalls) */
  const advanceClock = (dt: number): void => {
    if (video.paused || video.seeking) {
      estT = video.currentTime;
      return;
    }
    estT += dt * (video.playbackRate || 1);
    const err = video.currentTime - estT;
    estT = Math.abs(err) > 0.5 ? video.currentTime : estT + err * 0.02;
  };

  /**
   * Chooses the timeline. The layer shows the translation while it covers the next seconds; until then (start of the video,
   * or the translation falling behind) it shows the original text, which is available at once. Hysteresis keeps it from
   * flapping; a switch re-anchors the layer (one step, not a jerk).
   */
  const ensureWords = (t: number): void => {
    const key = `${cueList.length}|${cueList[0]?.start ?? 0}|${cueList[cueList.length - 1]?.end ?? 0}`;
    if (key !== tlKey) {
      tlKey = key;
      wordsT = buildWordTimeline(cueList, 'translation');
      wordsO = buildWordTimeline(cueList, 'original');
    }
    const transEnd = wordsT.length ? wordsT[wordsT.length - 1]!.t1 : -Infinity;
    const prevSrc = srcMode;
    if (lang === 'original') srcMode = 'o';
    else if (srcMode === 't' && transEnd < t + TICKER_FALLBACK_SEC) srcMode = 'o';
    else if (srcMode === 'o' && transEnd >= t + TICKER_RESUME_SEC) srcMode = 't';
    const next = srcMode === 'o' ? wordsO : wordsT;
    // the same text rebuilt (cues landed) keeps the words on screen where they are; a switch of text glides or snaps in drawTicker
    if (next !== words && tick && srcMode === prevSrc) {
      const before = tick.pos;
      tick = anchorTicker(tick, words, next, t);
      diag.log('ticker-anchor', { src: srcMode, shiftEm: Math.round((tick.pos - before) * 100) / 100, words: next.length, cues: cueList.length });
    } else if (next !== words) diag.log('ticker-src', { src: srcMode, words: next.length, cues: cueList.length });
    words = next;
  };

  /** line mode with the neon word: one span per word of the phrase */
  const buildNeonLine = (cue: SubtitleCue): void => {
    if (!el) return;
    const box = buildLine('');
    box.replaceChildren();
    let k = lastWordAt(words, cue.start) + 1;
    while (k < words.length && words[k]!.t0 < cue.end) {
      const s = doc.createElement('span');
      s.className = 'nvt-lw';
      s.dataset.k = String(k);
      s.textContent = words[k]!.text + ' ';
      box.append(s);
      k++;
    }
    textEl = box;
    el.replaceChildren(box);
    litIdx = -1;
  };

  /** lights the neon word (in the line or in the layer) */
  const setLit = (k: number): void => {
    if (k === litIdx) return;
    const prev = litIdx;
    litIdx = k;
    if (!textEl) return;
    if (prev >= 0) textEl.querySelector(`[data-k="${prev}"]`)?.classList.remove('nvt-cur');
    if (k >= 0) textEl.querySelector(`[data-k="${k}"]`)?.classList.add('nvt-cur');
  };

  /** the strip's canvas (created once per box) */
  const ensureCanvas = (): void => {
    if (!el || (canvas && canvas.parentElement === el)) return;
    canvas = doc.createElement('canvas');
    canvas.className = 'nvt-canvas';
    el.replaceChildren(canvas);
    ctx2d = canvas.getContext('2d');
  };

  /**
   * One frame of the scrolling layer, drawn in full on a canvas: every visible word at its place, the playhead at the
   * centre, the word being said lit with a soft neon tint. A full redraw per frame has no per-word layout or repaint
   * work, so the motion is the frame rate and nothing else.
   */
  const drawTicker = (t: number, dt: number): void => {
    if (!el) return;
    ensureCanvas();
    if (!canvas || !ctx2d) return;
    const w = el.clientWidth;
    const h = el.clientHeight;
    if (w === 0 || h === 0) return;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const pw = Math.round(w * dpr);
    const ph = Math.round(h * dpr);
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
    const fontPx = parseFloat(getComputedStyle(el).fontSize) || 16;
    // a seek or a long silence (a jump far beyond half the width) moves the layer at once; anything smaller glides
    const gap = tick === null ? 0 : layerPositionAt(words, t) - tick.pos;
    if (tick === null || Math.abs(gap) * fontPx > w * 0.5) {
      if (tick !== null) diag.log('ticker-snap', { gapEm: Math.round(gap * 10) / 10, t: Math.round(t * 10) / 10 });
      tick = { pos: layerPositionAt(words, t), vel: 0 };
    } else tick = stepTicker(tick, words, t, dt);
    const shownX = tick.pos;
    // sample of the layer's motion about twice a second: lag behind the audio (em), speed (em/s), frame step (s)
    const nowMs = performance.now();
    if (dt > 0 && nowMs - lastSampleMs >= 500) {
      lastSampleMs = nowMs;
      diag.log('ticker-tick', {
        t: Math.round(t * 10) / 10,
        lagEm: Math.round((layerPositionAt(words, t) - shownX) * 100) / 100,
        velEm: Math.round(tick.vel * 100) / 100,
        dtMs: Math.round(dt * 1000),
        src: srcMode,
      });
    }

    const c = ctx2d;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);
    const f = SUB_FONTS[style.font] ?? SUB_FONTS[0]!;
    c.font = `${style.weight} ${fontPx}px ${f.css}`;
    c.textBaseline = 'middle';
    c.textAlign = 'left';
    const cy = h / 2;
    const cur = currentWord(words, t);
    const from = Math.max(0, lastWordAt(words, t - TICKER_WINDOW_SEC));
    const to = Math.min(words.length, lastWordAt(words, t + TICKER_WINDOW_SEC) + 1);
    for (let i = from; i < to; i++) {
      const wd = words[i]!;
      const sx = w / 2 + (wd.x0 - shownX) * fontPx;
      if (sx > w || sx < -(wd.x1 - wd.x0) * fontPx) continue;
      // a word fades in over the last 30% of the strip, so an early batch enters one word after another
      const a = Math.max(0, Math.min(1, (w - sx) / (w * 0.3)));
      if (a <= 0) continue;
      c.globalAlpha = a;
      if (i === cur) {
        const tw = c.measureText(wd.text).width;
        c.shadowBlur = 0;
        c.fillStyle = hexAlpha(style.color, 0.18 * alphaOf());
        c.fillRect(sx - 2, cy - fontPx * 0.62, tw + 4, fontPx * 1.24);
        c.shadowColor = hexAlpha(style.color, 0.9);
        c.shadowBlur = 4;
      } else c.shadowBlur = 0;
      c.fillStyle = hexAlpha(style.color, alphaOf());
      c.fillText(wd.text, sx, cy);
    }
    c.globalAlpha = 1;
    c.shadowBlur = 0;
  };

  const draw = (dt: number): void => {
    const t = mediaNow();
    ensureWords(t);
    if (style.ticker) {
      drawTicker(t, dt);
    } else if (neonOn()) setLit(currentWord(words, t));
  };

  const loopWanted = (): boolean => enabled && !test && (style.ticker || neonOn()) && !video.paused;
  const frame = (now: number): void => {
    rafId = 0;
    if (!loopWanted()) return;
    const dt = lastFrame ? Math.min(0.1, (now - lastFrame) / 1000) : 1 / 60;
    lastFrame = now;
    advanceClock(dt);
    draw(dt);
    rafId = requestAnimationFrame(frame);
  };
  const startLoop = (): void => {
    if (!rafId && loopWanted()) {
      lastFrame = 0;
      rafId = requestAnimationFrame(frame);
    }
  };
  const stopLoop = (): void => {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
  };

  const render = (force = false): void => {
    if (test && Date.now() >= test.until) test = undefined;
    shownKey = activeKey();
    if (!test && enabled && style.ticker) {
      if (!ensureEl() || !el) return;
      // the running loop is kept: restarting it on every timeupdate would hand the next frame a fake 1/60 s step
      el.style.display = '';
      ensureWords(mediaNow());
      draw(0);
      startLoop();
      shown = '';
      return;
    }
    stopLoop();
    const cue = test ? undefined : enabled ? activeCue(video.currentTime) : undefined;
    const want = test ? test.text : cue ? cueDisplayText(cue, lang) : '';
    if (!want) {
      if (el) el.style.display = 'none';
      shown = '';
      return;
    }
    if (!ensureEl() || !el) return;
    if (force || want !== shown || textEl?.parentElement !== el) {
      if (!test && cue && neonOn()) {
        ensureWords(mediaNow());
        buildNeonLine(cue);
      } else {
        textEl = buildLine(want);
        el.replaceChildren(textEl);
        litIdx = -1;
      }
      shown = want;
    }
    el.style.display = '';
    const host = el.parentElement;
    if (host) layout(host);
    if (!test && cue && neonOn()) {
      setLit(currentWord(words, video.currentTime));
      startLoop();
    }
  };

  const onEvent = (): void => {
    if (video.paused || video.seeking || Math.abs(video.currentTime - estT) > 0.5) estT = video.currentTime;
    render();
  };
  for (const e of EVENTS) video.addEventListener(e, onEvent);
  // light timer: a cue that ends (or starts) between media events is caught here; re-render only on a cue change
  timer = setInterval(() => {
    if (activeKey() !== shownKey) render();
  }, 250);

  return {
    setLang(l) {
      if (l === lang) return;
      lang = l;
      render(true);
    },
    setStyle(s) {
      const next = normalizeSubStyle(s);
      if (JSON.stringify(next) === JSON.stringify(style)) return; // same look (settings re-pushed): keep the current line and layer
      style = next;
      applyStyle();
      render(true);
    },
    setCues(cues) {
      // fragments of 1-2 words are joined into phrases (sentence or up to 8 s); the words keep their timing
      cueList = mergeCuesToPhrases(cues);
      tlKey = '';
      winKey = '';
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
      stopLoop();
      for (const e of EVENTS) video.removeEventListener(e, onEvent);
      if (timer) clearInterval(timer);
      ro?.disconnect();
      el?.remove();
      el = undefined;
      track = undefined;
      gearEl?.remove();
      gearEl = undefined;
      panelEl?.remove();
      panelEl = undefined;
    },
  };
}
