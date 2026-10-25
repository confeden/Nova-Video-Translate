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
.nvt-btn[data-state=loading] .nvt-icon{animation:nvt-pulse 1s ease-in-out infinite}
.nvt-btn[data-state=error] .nvt-icon{filter:grayscale(1) brightness(.8)}
.nvt-btn[data-state=error]::after{content:"";position:absolute;right:9px;top:11px;width:7px;height:7px;border-radius:50%;background:#ff4d4d}
.nvt-btn[data-state=active]::after{content:"";position:absolute;right:9px;top:11px;width:6px;height:6px;border-radius:50%;background:#3ce678}
.nvt-btn[data-warn]:not([data-state=error])::after{content:"";position:absolute;right:9px;top:11px;width:7px;height:7px;border-radius:50%;background:#ffb020}
@keyframes nvt-pulse{0%,100%{opacity:.45;transform:scale(.92)}50%{opacity:1;transform:scale(1.05)}}
.nvt-overlay{position:absolute;right:12px;top:45%;z-index:2147483000;width:40px;height:40px;border-radius:10px;
 background:rgba(0,0,0,.55);backdrop-filter:blur(4px);opacity:0;transition:opacity .2s;cursor:grab;touch-action:none}
.nvt-overlay.nvt-drag{cursor:grabbing;transition:none;opacity:1}
.nvt-overlay.nvt-show,.nvt-overlay:hover,.nvt-overlay:not(.nvt-tw-fb):has(.nvt-btn:is([data-state=active],[data-state=loading])){opacity:1}
.nvt-overlay .nvt-btn{width:100%;height:100%}
.nvt-overlay.nvt-tw-fb{top:12px;right:12px}
.nvt-btn.nvt-tw{width:30px;height:30px;margin:0 2px;flex:none;border-radius:.4rem;opacity:1;transition:background-color .1s}
.nvt-btn.nvt-tw:hover{transform:none;background:rgba(255,255,255,.2)}
.nvt-btn.nvt-tw .nvt-icon{width:22px;height:22px}
.nvt-btn.nvt-tw[data-state=error]::after,.nvt-btn.nvt-tw[data-state=active]::after,.nvt-btn.nvt-tw[data-warn]:not([data-state=error])::after{right:2px;top:2px}
`;

function ensureStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const s = doc.createElement('style');
  s.id = STYLE_ID;
  s.textContent = CSS;
  (doc.head ?? doc.documentElement).appendChild(s);
}

type ButtonKind = 'yt' | 'tw' | 'overlay';
/** which <video> a mounted .nvt-btn belongs to (de-dupe of stale / duplicate buttons after player re-mounts) */
const OWNERS = new WeakMap<Element, HTMLVideoElement>();

function makeButton(video: HTMLVideoElement, opts: PlayerButtonOptions, kind: ButtonKind): HTMLButtonElement {
  const b = video.ownerDocument.createElement('button');
  b.type = 'button';
  b.className = kind === 'yt' ? 'ytp-button nvt-btn' : kind === 'tw' ? 'nvt-btn nvt-tw' : 'nvt-btn';
  OWNERS.set(b, video);
  b.title = opts.title ?? 'NVT';
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

/** YouTube: the player root and its right control group (leftmost of the right-hand buttons is the first child). */
function findControlsHost(video: HTMLVideoElement): { root: HTMLElement; host: HTMLElement | null } | null {
  const player = video.closest<HTMLElement>('.html5-video-player');
  if (!player) return null;
  return { root: player, host: player.querySelector<HTMLElement>('.ytp-right-controls') };
}

/** Twitch: the player root and its right control group (null while React has not rendered it / narrow layouts drop it). */
function findTwitch(video: HTMLVideoElement): { root: HTMLElement; host: HTMLElement | null } | null {
  const root = video.closest<HTMLElement>('.video-player') ?? video.closest<HTMLElement>('[data-a-target="video-player"], .video-player__container');
  if (!root) return null;
  return { root, host: root.querySelector<HTMLElement>('.player-controls__right-control-group') };
}

/** a control group that exists but is display:none / has no boxes (narrow Twitch layouts) cannot hold the button */
function usable(host: HTMLElement | null): host is HTMLElement {
  if (!host || !host.isConnected) return false;
  try {
    if (getComputedStyle(host).display === 'none') return false;
    const rects = host.getClientRects?.();
    if (rects && rects.length === 0) return false;
  } catch {
    // no layout engine: assume usable
  }
  return true;
}

// Sibling extensions that also prepend into the same container (NVS: Nova Video Saver). We sit right after
// them and never re-order once placed, so two observers can never fight over the first slot.
const SIBLING_IDS = ['nova-download-btn'];

const HIDE_AFTER_MS = 3000;

/**
 * Mounts the NVT button for one <video>. YouTube and Twitch: inside the right-hand control group, right after
 * other extensions' buttons (NVS); elsewhere (or while the control group is missing / hidden) a hover overlay.
 * Observers re-insert it when the player re-renders (SPA navigation, ad breaks, React re-renders, resize).
 */
export function mountPlayerButton(video: HTMLVideoElement, opts: PlayerButtonOptions): PlayerButton {
  const doc = video.ownerDocument;
  ensureStyle(doc);
  let state: ButtonState = 'idle';
  let btn: HTMLButtonElement | null = null;
  let btnKind: ButtonKind | null = null;
  let overlay: HTMLElement | null = null;
  let overlayFb = false;
  let overlayCleanup: (() => void) | null = null;
  let anchored = false; // placed right after the sibling extension's button: never moved again
  let destroyed = false;

  const dropOverlay = (): void => {
    overlayCleanup?.();
    overlayCleanup = null;
    overlay?.remove();
    overlay = null;
  };

  const ensureBtn = (kind: ButtonKind): HTMLButtonElement => {
    if (!btn || btnKind !== kind) {
      btn?.remove();
      btn = makeButton(video, opts, kind);
      btnKind = kind;
    }
    btn.dataset.state = state;
    return btn;
  };

  /** removes buttons / overlays that are not ours and belong to this video or to videos that left the DOM */
  const dedupe = (scope: ParentNode): void => {
    scope.querySelectorAll<HTMLElement>('.nvt-btn').forEach((el) => {
      if (el === btn) return;
      const owner = OWNERS.get(el);
      if (owner && owner !== video && owner.isConnected) return;
      const wrap = el.parentElement;
      el.remove();
      if (wrap?.classList.contains('nvt-overlay') && wrap !== overlay) wrap.remove();
    });
  };

  const findSibling = (scope: ParentNode): HTMLElement | undefined => {
    for (const id of SIBLING_IDS) {
      const el = scope.querySelector<HTMLElement>(`#${id}`) ?? doc.getElementById(id);
      if (el) return el;
    }
    return undefined;
  };

  const placeInline = (kind: 'yt' | 'tw', root: HTMLElement, host: HTMLElement): void => {
    dropOverlay();
    dedupe(root);
    const b = ensureBtn(kind);
    const sib = findSibling(kind === 'yt' ? host : root);
    if (sib && !anchored) {
      // NVS exists (or appeared later): sit right after it, once
      if (!(b.isConnected && b.previousElementSibling === sib)) sib.after(b);
      anchored = true;
      return;
    }
    if (b.isConnected && (b.parentElement === host || (sib && b.previousElementSibling === sib))) return; // never re-order
    if (sib) sib.after(b);
    else host.prepend(b);
  };

  const placeInOverlay = (parent: HTMLElement, fallback: boolean): void => {
    if (overlay && overlay.parentElement === parent && overlayFb === fallback && btn && btn.parentElement === overlay) return;
    dropOverlay();
    dedupe(parent);
    if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
    const ov = doc.createElement('div');
    ov.className = fallback ? 'nvt-overlay nvt-tw-fb' : 'nvt-overlay';
    overlay = ov;
    overlayFb = fallback;
    ov.appendChild(ensureBtn('overlay'));
    parent.appendChild(ov);
    if (fallback) {
      // Twitch rhythm: controls appear on mouse move and fade after ~3 s of stillness / when the mouse leaves
      let timer: ReturnType<typeof setTimeout> | undefined;
      const show = (): void => {
        ov.classList.add('nvt-show');
        clearTimeout(timer);
        timer = setTimeout(() => ov.classList.remove('nvt-show'), HIDE_AFTER_MS);
      };
      const hide = (): void => {
        clearTimeout(timer);
        ov.classList.remove('nvt-show');
      };
      parent.addEventListener('mousemove', show);
      parent.addEventListener('mouseenter', show);
      parent.addEventListener('mouseleave', hide);
      overlayCleanup = () => {
        clearTimeout(timer);
        parent.removeEventListener('mousemove', show);
        parent.removeEventListener('mouseenter', show);
        parent.removeEventListener('mouseleave', hide);
      };
      return;
    }
    const saved = loadPos();
    if (saved && parent.clientWidth > 0) placeOverlay(ov, parent, saved.x * parent.clientWidth, saved.y * parent.clientHeight);
    makeDraggable(ov, parent);
    const show = (): void => ov.classList.add('nvt-show');
    const hide = (): void => ov.classList.remove('nvt-show');
    parent.addEventListener('mouseenter', show);
    parent.addEventListener('mouseleave', hide);
    overlayCleanup = () => {
      parent.removeEventListener('mouseenter', show);
      parent.removeEventListener('mouseleave', hide);
    };
  };

  const place = (): void => {
    if (destroyed) return;
    const yt = findControlsHost(video);
    if (yt?.host) return placeInline('yt', yt.root, yt.host);
    const tw = yt ? null : findTwitch(video);
    if (tw) {
      if (usable(tw.host)) return placeInline('tw', tw.root, tw.host);
      return placeInOverlay(tw.root, true); // control group missing / hidden: never leave the page without a button
    }
    const parent = video.parentElement;
    if (parent) placeInOverlay(parent, false);
  };

  const rootOf = (): Element => findControlsHost(video)?.root ?? findTwitch(video)?.root ?? video.parentElement ?? doc.body;
  place();
  let root = rootOf();
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => place()) : undefined;
  const mo = new MutationObserver(() => {
    if (destroyed) return;
    if (!root.isConnected) {
      // the whole player was re-mounted: follow the video to its new container
      const next = rootOf();
      if (next !== root) {
        root = next;
        mo.disconnect();
        mo.observe(root, { childList: true, subtree: true });
        ro?.disconnect();
        ro?.observe(root);
      }
    }
    place();
  });
  mo.observe(root, { childList: true, subtree: true });
  // narrow / theater / fullscreen layouts hide or re-create the control group without necessarily mutating our subtree
  ro?.observe(root);
  const onFs = (): void => place();
  doc.addEventListener('fullscreenchange', onFs);

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
      ro?.disconnect();
      doc.removeEventListener('fullscreenchange', onFs);
      dropOverlay();
      btn?.remove();
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
