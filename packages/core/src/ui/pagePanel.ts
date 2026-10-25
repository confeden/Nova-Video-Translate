/**
 * Floating settings panel for the page (replaces the old userscript modal and the options tab for in-player use).
 * Lives in a closed Shadow DOM so site CSS and hotkeys cannot touch it. It is attached to the fullscreen element while
 * a video is fullscreen (nothing else is rendered then) and to <body> otherwise, so the player's overflow:hidden
 * never clips it. Closes on outside click and Esc.
 */
import { mountSettingsPanel, type SettingsPanelHandle, type SettingsPanelHost } from './settingsPanel';

const CSS = `
:host{all:initial}
.pop{position:fixed;z-index:2147483647;box-sizing:border-box;width:460px;max-width:calc(100vw - 16px);overflow:auto;overscroll-behavior:contain;
 border-radius:12px;box-shadow:0 10px 40px rgba(0,0,0,.55);background:#181a1c;color:#f1f1f1;border:1px solid #2b2f33;color-scheme:dark;
 font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.x{position:absolute;top:6px;right:8px;border:0;background:none;color:inherit;font-size:22px;line-height:1;cursor:pointer;opacity:.6;z-index:2}
.x:hover{opacity:1}
`;

export interface PagePanelHandle {
  close(): void;
  refresh(): void;
  readonly isOpen: boolean;
}

export interface OpenPagePanelOptions {
  host: SettingsPanelHost;
  /** the NVT button: the panel opens next to it, and a click on it does not count as an outside click */
  anchor?: HTMLElement | null;
  onClose?: () => void;
}

export function openPagePanel(opts: OpenPagePanelOptions): PagePanelHandle {
  const doc = (opts.anchor?.ownerDocument ?? document) as Document;
  const el = doc.createElement('div');
  // events must not reach the site: a click bubbling to the player toggles play/pause, keys trigger hotkeys
  for (const t of ['keydown', 'keyup', 'keypress', 'click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'wheel', 'contextmenu', 'touchstart'])
    el.addEventListener(t, (e) => e.stopPropagation());
  const root = el.attachShadow({ mode: 'closed' });
  const style = doc.createElement('style');
  style.textContent = CSS;
  const pop = doc.createElement('div');
  pop.className = 'pop';
  const x = doc.createElement('button');
  x.className = 'x';
  x.type = 'button';
  x.textContent = '×';
  x.title = 'Закрыть';
  const content = doc.createElement('div');
  pop.append(x, content);
  root.append(style, pop);

  let open = true;
  let panel: SettingsPanelHandle | undefined;

  const attach = (): void => {
    const parent = (doc.fullscreenElement as HTMLElement | null) ?? doc.body ?? doc.documentElement;
    if (el.parentNode !== parent) parent.appendChild(el);
  };

  const place = (): void => {
    const vw = doc.documentElement.clientWidth || window.innerWidth;
    const vh = doc.documentElement.clientHeight || window.innerHeight;
    const margin = 8;
    const width = Math.min(460, vw - 2 * margin);
    pop.style.width = `${width}px`;
    const a = opts.anchor?.isConnected ? opts.anchor.getBoundingClientRect() : null;
    pop.style.top = pop.style.bottom = pop.style.left = pop.style.right = '';
    // the panel may cover the whole window (it is not clipped by the small player): height is bounded by the viewport only
    pop.style.maxHeight = `${vh - margin * 2}px`;
    if (!a || (a.width === 0 && a.height === 0)) {
      pop.style.left = `${Math.max(margin, (vw - width) / 2)}px`;
      pop.style.top = `${margin}px`;
      return;
    }
    const left = Math.min(Math.max(margin, a.right - width), vw - width - margin);
    pop.style.left = `${left}px`;
    // above the button when it fits there, else below it; always kept inside the window
    const h = Math.min(pop.offsetHeight || vh, vh - margin * 2);
    const above = a.top - margin - h;
    const top = above >= margin ? above : a.bottom + margin + h <= vh - margin ? a.bottom + margin : vh - margin - h;
    pop.style.top = `${Math.max(margin, top)}px`;
  };

  const close = (): void => {
    if (!open) return;
    open = false;
    panel?.destroy();
    el.remove();
    doc.removeEventListener('keydown', onKey, true);
    doc.removeEventListener('pointerdown', onOutside, true);
    doc.removeEventListener('fullscreenchange', onFs);
    window.removeEventListener('resize', place);
    ro?.disconnect();
    opts.onClose?.();
  };
  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  }
  function onOutside(e: Event): void {
    const path = e.composedPath();
    if (path.includes(el)) return;
    if (opts.anchor && path.includes(opts.anchor)) return; // the button handles its own toggle
    close();
  }
  function onFs(): void {
    attach();
    place();
  }
  x.addEventListener('click', close);

  attach();
  place();
  doc.addEventListener('keydown', onKey, true);
  doc.addEventListener('pointerdown', onOutside, true);
  doc.addEventListener('fullscreenchange', onFs);
  window.addEventListener('resize', place);
  panel = mountSettingsPanel(content, opts.host);
  // the content renders and grows after the first placement: re-place on every size change so the panel never hangs off the window
  let ro: ResizeObserver | undefined;
  if (typeof ResizeObserver !== 'undefined') {
    let lastH = 0;
    ro = new ResizeObserver(() => {
      const h = pop.offsetHeight;
      if (h !== lastH) {
        lastH = h;
        place();
      }
    });
    ro.observe(content);
  }

  return {
    close,
    refresh: () => void panel?.refresh(),
    get isOpen() {
      return open;
    },
  };
}
