import { createIconElement } from './icon';

export type ButtonState = 'idle' | 'loading' | 'active' | 'error';

export interface PlayerButtonOptions {
  onClick: (video: HTMLVideoElement, button: HTMLElement) => void;
  title?: string;
}

export interface PlayerButton {
  readonly el: HTMLElement;
  setState(state: ButtonState): void;
  destroy(): void;
}

const STYLE_ID = 'nvt-style';
const CSS = `
.nvt-btn{position:relative;display:inline-flex;align-items:center;justify-content:center;border:0;background:none;
 padding:0;cursor:pointer;color:#fff;opacity:.9;transition:opacity .15s,transform .15s,filter .15s}
.nvt-btn:hover{opacity:1;transform:scale(1.08)}
.nvt-btn .nvt-icon{width:28px;height:28px;pointer-events:none}
.nvt-btn.ytp-button{width:48px;height:100%}
.nvt-btn[data-state=idle] .nvt-icon{filter:saturate(.9) brightness(.92)}
.nvt-btn[data-state=active] .nvt-icon{filter:drop-shadow(0 0 5px rgba(60,230,120,.9))}
.nvt-btn[data-state=loading] .nvt-icon{animation:nvt-pulse 1s ease-in-out infinite}
.nvt-btn[data-state=error] .nvt-icon{filter:grayscale(1) brightness(.8)}
.nvt-btn[data-state=error]::after{content:"";position:absolute;right:9px;top:11px;width:7px;height:7px;border-radius:50%;background:#ff4d4d}
.nvt-btn[data-state=active]::after{content:"";position:absolute;right:9px;top:11px;width:6px;height:6px;border-radius:50%;background:#3ce678}
.nvt-btn[data-warn]:not([data-state=error])::after{content:"";position:absolute;right:9px;top:11px;width:7px;height:7px;border-radius:50%;background:#ffb020}
@keyframes nvt-pulse{0%,100%{opacity:.45;transform:scale(.92)}50%{opacity:1;transform:scale(1.05)}}
.nvt-overlay{position:absolute;right:12px;top:45%;z-index:2147483000;width:40px;height:40px;border-radius:10px;
 background:rgba(0,0,0,.55);backdrop-filter:blur(4px);opacity:0;transition:opacity .2s;cursor:grab;touch-action:none}
.nvt-overlay.nvt-drag{cursor:grabbing;transition:none;opacity:1}
.nvt-overlay.nvt-show,.nvt-overlay:hover,.nvt-overlay:has(.nvt-btn:is([data-state=active],[data-state=loading])){opacity:1}
.nvt-overlay .nvt-btn{width:100%;height:100%}
`;

function ensureStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const s = doc.createElement('style');
  s.id = STYLE_ID;
  s.textContent = CSS;
  (doc.head ?? doc.documentElement).appendChild(s);
}

function makeButton(video: HTMLVideoElement, opts: PlayerButtonOptions, ytp: boolean): HTMLButtonElement {
  const b = video.ownerDocument.createElement('button');
  b.type = 'button';
  b.className = ytp ? 'ytp-button nvt-btn' : 'nvt-btn';
  b.title = opts.title ?? 'NVT (Nova Video Translate)';
  b.setAttribute('aria-label', b.title);
  b.dataset.state = 'idle';
  b.append(createIconElement(video.ownerDocument));
  b.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    opts.onClick(video, b);
  });
  // players bind hotkeys / drag on mousedown: keep the click ours
  b.addEventListener('mousedown', (e) => e.stopPropagation());
  b.addEventListener('dblclick', (e) => e.stopPropagation());
  return b;
}

const OVERLAY_SIZE = 40;
const POS_PREFIX = 'nvt-btn-pos:';

/** the overlay's top-left corner as a fraction of the video box, remembered per site */
interface SavedPos {
  x: number;
  y: number;
}

function loadPos(): SavedPos | undefined {
  try {
    const p = JSON.parse(localStorage.getItem(POS_PREFIX + location.hostname) ?? 'null') as Partial<SavedPos> | null;
    return p && typeof p.x === 'number' && typeof p.y === 'number' ? { x: p.x, y: p.y } : undefined;
  } catch {
    return undefined; // storage blocked: the default corner is used
  }
}

function savePos(p: SavedPos): void {
  try {
    localStorage.setItem(POS_PREFIX + location.hostname, JSON.stringify(p));
  } catch {
    // storage blocked: the position just does not persist
  }
}

/** moves the overlay to (left, top) px inside `parent`, kept fully inside the box */
function placeOverlay(overlay: HTMLElement, parent: HTMLElement, left: number, top: number): void {
  const x = Math.min(Math.max(0, left), Math.max(0, parent.clientWidth - OVERLAY_SIZE));
  const y = Math.min(Math.max(0, top), Math.max(0, parent.clientHeight - OVERLAY_SIZE));
  overlay.style.left = `${x}px`;
  overlay.style.top = `${y}px`;
  overlay.style.right = 'auto';
  overlay.style.bottom = 'auto';
}

/** drag with the left mouse button; the spot is saved for this site when the drag ends */
function makeDraggable(overlay: HTMLElement, parent: HTMLElement): void {
  const doc = overlay.ownerDocument;
  let justDragged = false;
  // a drag ends with a click on the button: swallow it so the drop does not also start translation
  overlay.addEventListener(
    'click',
    (e) => {
      if (!justDragged) return;
      e.stopPropagation();
      e.preventDefault();
    },
    true,
  );
  overlay.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const start = { x: e.clientX, y: e.clientY };
    const frame = parent.getBoundingClientRect();
    const box = overlay.getBoundingClientRect();
    const origin = { left: box.left - frame.left, top: box.top - frame.top };
    let moved = false;
    const onMove = (ev: PointerEvent): void => {
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      if (!moved && Math.hypot(dx, dy) < 4) return; // a small jitter is still a click
      moved = true;
      overlay.classList.add('nvt-drag');
      placeOverlay(overlay, parent, origin.left + dx, origin.top + dy);
    };
    const onUp = (): void => {
      doc.removeEventListener('pointermove', onMove);
      doc.removeEventListener('pointerup', onUp);
      doc.removeEventListener('pointercancel', onUp);
      overlay.classList.remove('nvt-drag');
      if (!moved) return;
      justDragged = true;
      setTimeout(() => (justDragged = false), 0);
      savePos({
        x: (parseFloat(overlay.style.left) || 0) / (parent.clientWidth || 1),
        y: (parseFloat(overlay.style.top) || 0) / (parent.clientHeight || 1),
      });
    };
    doc.addEventListener('pointermove', onMove);
    doc.addEventListener('pointerup', onUp);
    doc.addEventListener('pointercancel', onUp);
  });
}

/** YouTube-like players: first child of the right control group (leftmost of the right-hand buttons). */
function findControlsHost(video: HTMLVideoElement): HTMLElement | null {
  const player = video.closest<HTMLElement>('.html5-video-player');
  if (!player) return null;
  return player.querySelector<HTMLElement>('.ytp-right-controls');
}

// Sibling extensions that also prepend into the same container (NVS: Nova Video Saver). We sit right after
// them and never re-order once placed, so two observers can never fight over the first slot.
const SIBLING_IDS = ['nova-download-btn'];

/**
 * Mounts the NVT button for one <video>. On YouTube it sits left of the right-hand player controls (next to
 * other extensions' buttons); elsewhere it is a hover overlay at the video's top-left corner.
 * A MutationObserver re-inserts it when the player re-renders (YouTube SPA navigation, ad breaks, etc.).
 */
export function mountPlayerButton(video: HTMLVideoElement, opts: PlayerButtonOptions): PlayerButton {
  const doc = video.ownerDocument;
  ensureStyle(doc);
  let state: ButtonState = 'idle';
  let btn: HTMLButtonElement | null = null;
  let overlay: HTMLElement | null = null;
  let destroyed = false;

  const place = (): void => {
    if (destroyed) return;
    const host = findControlsHost(video);
    if (host) {
      overlay?.remove();
      overlay = null;
      if (!btn || btn.parentElement !== host) {
        btn ??= makeButton(video, opts, true);
        btn.dataset.state = state;
        const sibling = SIBLING_IDS.map((id) => host.querySelector<HTMLElement>(`#${id}`)).find(Boolean);
        if (sibling) sibling.after(btn);
        else host.prepend(btn);
      }
      return;
    }
    const parent = video.parentElement;
    if (!parent) return;
    if (!overlay || overlay.parentElement !== parent) {
      if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
      overlay?.remove();
      overlay = doc.createElement('div');
      overlay.className = 'nvt-overlay';
      btn = makeButton(video, opts, false);
      btn.dataset.state = state;
      overlay.appendChild(btn);
      parent.appendChild(overlay);
      const saved = loadPos();
      if (saved && parent.clientWidth > 0) placeOverlay(overlay, parent, saved.x * parent.clientWidth, saved.y * parent.clientHeight);
      makeDraggable(overlay, parent);
      const show = (): void => overlay?.classList.add('nvt-show');
      const hide = (): void => overlay?.classList.remove('nvt-show');
      parent.addEventListener('mouseenter', show);
      parent.addEventListener('mouseleave', hide);
    }
  };

  place();
  const root = video.closest('.html5-video-player') ?? video.parentElement ?? doc.body;
  const mo = new MutationObserver(() => place());
  mo.observe(root, { childList: true, subtree: true });

  return {
    get el() {
      return (btn ?? overlay) as HTMLElement;
    },
    setState(next) {
      state = next;
      if (btn) btn.dataset.state = next;
    },
    destroy() {
      destroyed = true;
      mo.disconnect();
      btn?.remove();
      overlay?.remove();
    },
  };
}

/** Calls `onVideo` for every <video> now in the page and for those added later (SPA sites). Returns a stopper. */
export function watchVideos(doc: Document, onVideo: (v: HTMLVideoElement) => void): () => void {
  const seen = new WeakSet<HTMLVideoElement>();
  const scan = (): void => {
    doc.querySelectorAll('video').forEach((v) => {
      if (!seen.has(v)) {
        seen.add(v);
        onVideo(v);
      }
    });
  };
  scan();
  const mo = new MutationObserver(scan);
  mo.observe(doc.documentElement, { childList: true, subtree: true });
  return () => mo.disconnect();
}
