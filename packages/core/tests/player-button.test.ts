import { afterEach, describe, expect, it } from 'vitest';
import { parseHTML } from 'linkedom';
import { mountPlayerButton, type PlayerButton } from '../src/ui/playerButton';
import { buttonTitle } from '../src/ui/videoController';

// linkedom has no MutationObserver / layout: observers are captured and fired by hand
const g = globalThis as Record<string, unknown>;
const saved: Record<string, unknown> = {};
let observers: Array<() => void> = [];
function stub(k: string, v: unknown): void {
  if (!(k in saved)) saved[k] = g[k];
  Object.defineProperty(g, k, { value: v, configurable: true, writable: true });
}
const fire = (): void => observers.forEach((f) => f());

const TW = (extra = '', group = '<div class="player-controls__right-control-group">%EXTRA%<button id="clip">clip</button><button id="gear">gear</button></div>') =>
  `<html><head></head><body><div class="video-player"><div class="video-player__container"><video></video><div class="player-controls">${group.replace('%EXTRA%', extra)}</div></div></div></body></html>`;

function env(html: string, display = 'block') {
  const { document } = parseHTML(html);
  observers = [];
  stub('getComputedStyle', () => ({ position: 'relative', display }));
  stub('localStorage', { getItem: () => null, setItem: () => {} });
  stub('MutationObserver', class { constructor(cb: () => void) { observers.push(cb); } observe() {} disconnect() {} });
  const video = document.querySelector('video') as unknown as HTMLVideoElement;
  return { document, video };
}
const NVS = '<button id="nova-download-btn">nvs</button>';
const ids = (d: Document, sel: string): string[] => [...d.querySelectorAll(sel + ' > *')].map((e) => e.id || e.className);
const count = (d: Document): number => d.querySelectorAll('.nvt-btn').length;

let btn: PlayerButton | undefined;
afterEach(() => {
  btn?.destroy();
  btn = undefined;
  for (const [k, v] of Object.entries(saved)) Object.defineProperty(g, k, { value: v, configurable: true, writable: true });
});

describe('Twitch button placement', () => {
  it('sits right after NVS, before Clip / gear', () => {
    const { document, video } = env(TW(NVS));
    btn = mountPlayerButton(video, { onClick: () => {} });
    expect(ids(document as unknown as Document, '.player-controls__right-control-group')).toEqual(['nova-download-btn', 'nvt-btn nvt-tw', 'clip', 'gear']);
  });

  it('without NVS takes the first slot of the right group', () => {
    const { document, video } = env(TW());
    btn = mountPlayerButton(video, { onClick: () => {} });
    expect(ids(document as unknown as Document, '.player-controls__right-control-group')).toEqual(['nvt-btn nvt-tw', 'clip', 'gear']);
  });

  it('NVS appearing later (landing after us): moves right of it once, then never re-orders', () => {
    const { document, video } = env(TW());
    btn = mountPlayerButton(video, { onClick: () => {} });
    const d = document as unknown as Document;
    const sel = '.player-controls__right-control-group';
    expect(ids(d, sel)).toEqual(['nvt-btn nvt-tw', 'clip', 'gear']);
    d.getElementById('gear')!.insertAdjacentHTML('afterend', NVS); // NVS lands at the far end
    fire();
    expect(ids(d, sel)).toEqual(['clip', 'gear', 'nova-download-btn', 'nvt-btn nvt-tw']);
    // later reshuffles of the neighbours do not drag the button around
    d.querySelector(sel)!.append(d.getElementById('clip')!); // neighbours reshuffle; NVT stays right after NVS
    fire();
    expect(ids(d, sel)).toEqual(['gear', 'nova-download-btn', 'nvt-btn nvt-tw', 'clip']);
    expect(count(d)).toBe(1);
  });

  it('re-inserts after React drops it and never duplicates', () => {
    const { document, video } = env(TW(NVS));
    btn = mountPlayerButton(video, { onClick: () => {} });
    document.querySelector('.nvt-btn')!.remove();
    fire();
    fire();
    expect(count(document as unknown as Document)).toBe(1);
    expect(ids(document as unknown as Document, '.player-controls__right-control-group').slice(0, 2)).toEqual(['nova-download-btn', 'nvt-btn nvt-tw']);
    // a stray copy (older instance) is removed
    const dup = document.createElement('button');
    dup.className = 'nvt-btn nvt-tw';
    document.querySelector('.player-controls__right-control-group')!.append(dup);
    fire();
    expect(count(document as unknown as Document)).toBe(1);
  });

  it('control group hidden / missing: falls back to the overlay in the player, and returns when the group is back', () => {
    const { document, video } = env(TW('', ''));
    btn = mountPlayerButton(video, { onClick: () => {} });
    const d = document as unknown as Document;
    expect(d.querySelectorAll('.video-player > .nvt-overlay.nvt-tw-fb .nvt-btn').length).toBe(1);
    document.querySelector('.player-controls')!.innerHTML = '<div class="player-controls__right-control-group"><button id="clip"></button></div>';
    fire();
    expect(d.querySelectorAll('.nvt-overlay').length).toBe(0);
    expect(count(d)).toBe(1);
    expect(ids(d, '.player-controls__right-control-group')[0]).toBe('nvt-btn nvt-tw');
  });
});

describe('tooltip text follows the real click behaviour', () => {
  it('settings: state text + open-settings hint, never "stop/off"', () => {
    for (const k of ['idle', 'loading', 'active', 'error', 'native', 'empty', 'ru']) {
      const t = buttonTitle(k, 'settings');
      expect(t).toContain('настройки');
      expect(t).not.toMatch(/остановить|выключить|повторить/);
    }
  });
  it('toggle: keeps the stop / off / retry hints', () => {
    expect(buttonTitle('active', 'toggle')).toContain('выключить');
    expect(buttonTitle('loading', 'toggle')).toContain('остановить');
    expect(buttonTitle('error', 'toggle')).toContain('повторить');
    expect(buttonTitle('idle', 'toggle')).toBe('NVT — перевести');
  });
});
