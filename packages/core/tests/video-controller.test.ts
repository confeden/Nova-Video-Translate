import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import { createPageRuntime, type VideoControllerHandle } from '../src/ui/videoController';
import { normalizeSettings } from '../src/settings';
import type { AudioTracksController } from '../src/nativedub';

// Media-event ordering of YouTube (emptied -> play -> loadstart within ms on SPA navigation; emptied/loadstart on setAudioTrack)

const tick = () => new Promise((r) => setTimeout(r, 5));

const RU_NATIVE: AudioTracksController = {
  list: async () => ({
    videoId: 'x',
    tracks: [
      { id: 'en-US.4', name: 'English (original)', original: true, ru: false },
      { id: 'ru.3', name: 'Russian', original: false, ru: true },
    ],
    currentId: 'ru.3',
    canSelect: true,
  }),
  select: async () => true,
};

function setup(href: string, opts: { audioTracks?: AudioTracksController } = {}) {
  const { window, document } = parseHTML('<html><head></head><body><div class="html5-video-player"><video></video></div></body></html>');
  const loc = { href, hostname: 'www.youtube.com' };
  const g = globalThis as Record<string, unknown>;
  const saved: Record<string, unknown> = {};
  const stub = (k: string, v: unknown): void => {
    saved[k] = g[k];
    Object.defineProperty(g, k, { value: v, configurable: true, writable: true });
  };
  stub('window', Object.assign(window, { top: undefined }));
  (g.window as { top: unknown }).top = g.window;
  stub('document', document);
  stub('location', loc);
  stub('getComputedStyle', () => ({ position: 'relative' }));
  stub('MutationObserver', class { observe() {} disconnect() {} });
  stub('AudioContext', class {
    state = 'running';
    destination = {};
    constructor() {
      return new Proxy(this, { get: (o, k) => (k in o ? (o as any)[k] : () => new Proxy({}, { get: () => () => {}, set: () => true })) });
    }
    resume() { return Promise.resolve(); }
  });
  const video = document.querySelector('video') as unknown as HTMLVideoElement & Record<string, unknown>;
  let paused = true;
  Object.defineProperty(video, 'paused', { get: () => paused });
  Object.defineProperty(video, 'duration', { get: () => (video as any).__dur ?? NaN });
  video.getBoundingClientRect = () => ({ width: 640, height: 360 }) as DOMRect;
  const st = normalizeSettings({ autoTranslate: 'on', preferNativeDub: true } as never);
  const rt = createPageRuntime({
    loadSettings: async () => st,
    createProviders: () => [],
    audioTracks: () => opts.audioTracks ?? RU_NATIVE,
  });
  let ctl!: VideoControllerHandle;
  rt.watch(document as unknown as Document, (c) => (ctl = c));
  const ready = tick();
  const fire = (n: string): void => void video.dispatchEvent(new (window as any).Event(n));
  return {
    ready, video, ctl: () => ctl, fire, loc,
    setPaused: (p: boolean) => (paused = p),
    setDur: (d: number) => ((video as any).__dur = d),
    restore: () => { for (const [k, v] of Object.entries(saved)) Object.defineProperty(g, k, { value: v, configurable: true, writable: true }); },
  };
}

describe('VideoController media events', () => {
  let env: ReturnType<typeof setup>;
  afterEach(() => env?.restore());
  beforeEach(() => vi.useRealTimers());

  it('SPA navigation: emptied -> play -> loadstart keeps the NEW video session (loadstart does not kill it)', async () => {
    env = setup('https://www.youtube.com/watch?v=AAAAAAAAAAA');
    await env.ready;
    env.setPaused(false);
    env.fire('play');
    await tick();
    await tick();
    const a = env.ctl() as any;
    expect(a.active).toBe(true);
    const engineA = a.engine;

    // navigation: href changes first, then the three events
    env.loc.href = 'https://www.youtube.com/watch?v=BBBBBBBBBBB';
    env.fire('emptied');
    expect(engineA.state).toBe('stopped');
    env.fire('play');
    await tick();
    await tick();
    const engineB = a.engine;
    expect(engineB).not.toBe(engineA);
    expect(a.active).toBe(true);
    env.fire('loadstart');
    await tick();
    await tick();
    expect(a.engine).toBe(engineB);
    expect(engineB.state).not.toBe('stopped');
    expect(a.active).toBe(true);
  });

  it('navigation where the reset arrives on loadstart only (href changed, no emptied, no new play): the new video is started anyway', async () => {
    env = setup('https://www.youtube.com/watch?v=AAAAAAAAAAA');
    await env.ready;
    env.setPaused(false);
    env.fire('play');
    await tick();
    await tick();
    const a = env.ctl() as any;
    const engineA = a.engine;
    env.loc.href = 'https://www.youtube.com/watch?v=BBBBBBBBBBB';
    env.fire('loadstart');
    expect(engineA.state).toBe('stopped');
    env.fire('loadedmetadata');
    await tick();
    await tick();
    expect(a.engine).not.toBe(engineA);
    expect(a.active).toBe(true);
  });

  it('a media reload of the SAME video (setAudioTrack, stream refresh) keeps the running session', async () => {
    env = setup('https://www.youtube.com/watch?v=AAAAAAAAAAA');
    await env.ready;
    env.setPaused(false);
    env.fire('play');
    await tick();
    await tick();
    const a = env.ctl() as any;
    const eng = a.engine;
    env.fire('emptied');
    env.fire('loadstart');
    env.fire('loadedmetadata');
    await tick();
    await tick();
    expect(a.engine).toBe(eng);
    expect(eng.state).not.toBe('stopped');
    expect(a.active).toBe(true);
  });

  it('warnings and errors never create a banner over the video; problem text stays out of the tooltip and the status block', async () => {
    env = setup('https://www.youtube.com/watch?v=CCCCCCCCCCC');
    await env.ready;
    const c = env.ctl() as any;
    const before = document.querySelectorAll('.html5-video-player *').length;
    c.onWarning({ kind: 'provider-failed', providerId: 'yandex-live', message: 'x' });
    c.onWarning({ kind: 'dub-late', message: 'x' });
    c.onWarning({ kind: 'auth-required', providerId: 'gemini', message: 'x' }); // Gemini is not the only source: not user-fixable
    c.onState('error');
    expect(document.querySelector('.nvt-toast')).toBeNull();
    expect(document.querySelectorAll('.html5-video-player *').length).toBe(before);
    expect(c.btn.el.dataset.warn).toBeUndefined(); // transient problems: no dot
    expect(c.btn.el.title).not.toContain('⚠');
    expect(c.btn.el.title).not.toContain('недоступен');
    expect(c.btn.el.title).not.toContain('опозданием');
    expect(c.status().warnings.length).toBeGreaterThan(0); // full details kept for the diagnostics report
  });

  it('only user-fixable problems light the amber dot (no source at all), with no warning text in the tooltip', async () => {
    env = setup('https://www.youtube.com/watch?v=CCCCCCCCCCC');
    await env.ready;
    const c = env.ctl() as any;
    c.onWarning({ kind: 'no-provider', message: 'x' });
    expect(c.btn.el.dataset.warn).toBe('1');
    expect(c.btn.el.title).not.toContain('Нет доступного источника');
    expect(c.btn.el.title).not.toContain('⚠');
    c.onVoice('gemini'); // a source voices after all: the dot goes
    expect(c.btn.el.dataset.warn).toBeUndefined();
  });

  it('a user stop survives a same-video reload (no auto restart)', async () => {
    env = setup('https://www.youtube.com/watch?v=AAAAAAAAAAA');
    await env.ready;
    env.setPaused(false);
    env.fire('play');
    await tick();
    await tick();
    const a = env.ctl() as any;
    a.stop(true);
    env.fire('emptied');
    env.fire('play');
    await tick();
    await tick();
    expect(a.active).toBe(false);
  });

  it('same key but another duration (ad / different clip in the element) resets the session', async () => {
    env = setup('https://www.youtube.com/watch?v=AAAAAAAAAAA');
    await env.ready;
    env.setPaused(false);
    env.setDur(600);
    env.fire('play');
    await tick();
    await tick();
    const a = env.ctl() as any;
    const eng = a.engine;
    env.fire('loadedmetadata');
    expect(eng.state).not.toBe('stopped');
    env.setDur(15); // an ad
    env.fire('loadedmetadata');
    expect(eng.state).toBe('stopped');
  });
});
