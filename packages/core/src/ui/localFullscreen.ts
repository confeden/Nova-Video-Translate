/**
 * Fullscreen for a video opened from disk (the browser's own media viewer). The native button fullscreens the bare <video>, and
 * then nothing but the video is rendered: the subtitle layer (its sibling) disappears. So the native fullscreen button is hidden
 * (`controlsList="nofullscreen"`) and replaced by ours (and by double click and the F key), which fullscreen the whole document:
 * the video is stretched over it and the layer stays on top. Does nothing for any other page.
 */
export function installLocalFullscreen(video: HTMLVideoElement): () => void {
  const doc = video.ownerDocument;
  if (location.protocol !== 'file:' || !doc.contentType.startsWith('video/') || video.parentElement !== doc.body) return () => undefined;
  const root = doc.documentElement;
  const st = video.style;
  const saved = { width: st.width, height: st.height, fit: st.objectFit, maxW: st.maxWidth, maxH: st.maxHeight };
  const hadList = video.getAttribute('controlslist');
  video.setAttribute('controlslist', 'nofullscreen');

  const btn = doc.createElement('button');
  const toggle = (): void => {
    if (doc.fullscreenElement) void doc.exitFullscreen().catch(() => undefined);
    else void root.requestFullscreen().catch(() => undefined);
  };
  const restore = (): void => {
    st.width = saved.width;
    st.height = saved.height;
    st.maxWidth = saved.maxW;
    st.maxHeight = saved.maxH;
    st.objectFit = saved.fit;
  };
  const fit = (): void => {
    const on = doc.fullscreenElement === root;
    if (on) {
      st.width = '100vw';
      st.height = '100vh';
      st.maxWidth = 'none';
      st.maxHeight = 'none';
      st.objectFit = 'contain';
    } else restore();
    btn.textContent = on ? '🗗' : '⛶';
    btn.title = on ? 'Выйти из полного экрана' : 'На весь экран';
  };

  btn.type = 'button';
  btn.textContent = '⛶';
  btn.title = 'На весь экран';
  btn.setAttribute('aria-label', 'На весь экран');
  btn.style.cssText =
    'position:fixed;top:12px;right:12px;width:34px;height:34px;border:0;border-radius:50%;padding:0;cursor:pointer;z-index:2147483000;' +
    'background:rgba(0,0,0,.6);color:#fff;font:18px/34px system-ui,sans-serif;text-align:center;opacity:0;pointer-events:none;transition:opacity .15s';
  btn.addEventListener('click', toggle);
  doc.body.appendChild(btn);

  let hide: ReturnType<typeof setTimeout> | undefined;
  const wake = (): void => {
    btn.style.opacity = '1';
    btn.style.pointerEvents = 'auto';
    if (hide) clearTimeout(hide);
    hide = setTimeout(() => {
      btn.style.opacity = '0';
      btn.style.pointerEvents = 'none';
    }, 2500);
  };
  const onDbl = (e: MouseEvent): void => {
    if (e.target !== video) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    toggle();
  };
  const onKey = (e: KeyboardEvent): void => {
    if ((e.key === 'f' || e.key === 'F' || e.key === 'а' || e.key === 'А') && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      toggle();
    }
  };
  doc.addEventListener('mousemove', wake, true);
  doc.addEventListener('dblclick', onDbl, true);
  doc.addEventListener('keydown', onKey, true);
  doc.addEventListener('fullscreenchange', fit);
  return () => {
    doc.removeEventListener('mousemove', wake, true);
    doc.removeEventListener('dblclick', onDbl, true);
    doc.removeEventListener('keydown', onKey, true);
    doc.removeEventListener('fullscreenchange', fit);
    if (hide) clearTimeout(hide);
    btn.remove();
    if (hadList === null) video.removeAttribute('controlslist');
    else video.setAttribute('controlslist', hadList);
    if (doc.fullscreenElement === root) void doc.exitFullscreen().catch(() => undefined);
    restore();
  };
}
