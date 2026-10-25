import { describe, expect, it } from 'vitest';
import { parseHTML } from 'linkedom';
import { adDomEvidence, createDomAdProbe } from '../src/capture/hls/adDom';

function page(inner: string): { video: Element; doc: Document } {
  const { document } = parseHTML(`<html><body><div data-a-target="video-player" class="video-player"><video id="v"></video>${inner}</div><div id="chat">Ad</div></body></html>`);
  return { video: document.getElementById('v')!, doc: document as unknown as Document };
}

describe('player ad DOM evidence', () => {
  it('no ad UI: no evidence (chat text "Ad" outside the player is ignored)', () => {
    const { video } = page('<div data-a-target="player-controls"><button aria-label="Play">x</button></div>');
    expect(adDomEvidence(video)).toEqual([]);
    expect(createDomAdProbe(video)()).toBe(false);
  });

  it('each independent selector is enough', () => {
    for (const html of [
      '<span data-a-target="video-ad-label">Реклама</span>',
      '<span data-a-target="video-ad-countdown">12</span>',
      '<p data-test-selector="ad-banner-default-text">Ads help</p>',
      '<div data-test-selector="sad-overlay"></div>',
      '<div aria-label="Ad"></div>',
      '<div aria-label="Реклама"></div>',
    ]) {
      const { video } = page(html);
      expect(createDomAdProbe(video)(), html).toBe(true);
    }
  });

  it('fallback: exact "Ad" / "Реклама" text inside an ad-ish container', () => {
    const { video } = page('<div class="player-video-ad-box"><span>Реклама</span></div>');
    expect(adDomEvidence(video)).toEqual(['text-fallback']);
    const none = page('<div class="player-video-ad-box"><span>Advertise with us here</span></div>');
    expect(adDomEvidence(none.video)).toEqual([]);
  });

  it('hidden elements do not count', () => {
    const { video } = page('<span data-a-target="video-ad-label" style="display: none">Ad</span><span data-a-target="video-ad-countdown" hidden>3</span>');
    expect(createDomAdProbe(video)()).toBe(false);
  });

  it('an element without a document never throws', () => {
    expect(createDomAdProbe(undefined)()).toBe(false);
    expect(createDomAdProbe({} as Element)()).toBe(false);
  });
});
