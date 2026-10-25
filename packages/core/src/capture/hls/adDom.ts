/**
 * "Is the PLAYER showing an ad right now?" - read from the Twitch web player's own DOM, not from our (anonymous) HLS playlist.
 * Our anonymous token can receive stitched ads that a logged-in / subscribed player never shows, so the playlist alone must not
 * drive the visible ad state (owner feedback v0.2.38). Several independent selectors are tried; ANY visible match is evidence.
 *
 * Selectors (Twitch web player, UNVERIFIED against the live DOM - they change; every one is independent, add more here):
 *  1. [data-a-target="video-ad-label"]          the "Ad" / "Реклама" pill in the player's top-left
 *  2. [data-a-target="video-ad-countdown"]      "Ad ends in N s" counter
 *  3. [data-test-selector="ad-banner-default-text"]  the "Ads help support..." banner text
 *  4. [data-test-selector="sad-overlay"]        the streamer-ad overlay ("sad" = stitched ad)
 *  5. aria-label on a player control or badge equal to Ad / Ads / Advertisement / Реклама
 *  6. FALLBACK text scan of small nodes under [data-a-target="player-overlay-..."]/ad-ish containers: exact text
 *     "Ad" / "Реклама" / "Advertisement" (short text only, so chat or titles never match)
 */
export const AD_DOM_SELECTORS: readonly string[] = [
  '[data-a-target="video-ad-label"]',
  '[data-a-target="video-ad-countdown"]',
  '[data-test-selector="ad-banner-default-text"]',
  '[data-test-selector="sad-overlay"]',
  '[aria-label="Ad" i]',
  '[aria-label="Ads" i]',
  '[aria-label="Advertisement" i]',
  '[aria-label="Реклама" i]',
];

const FALLBACK_CONTAINERS = '[data-a-target*="ad-"], [data-test-selector*="ad-"], [class*="ad-banner" i], [class*="video-ad" i]';
const AD_WORD = /^\s*(ad|ads|advertisement|реклама)\s*$/i;

function visible(el: Element): boolean {
  const h = el as HTMLElement;
  if (h.hidden || el.getAttribute('aria-hidden') === 'true') return false;
  const style = el.getAttribute('style') ?? '';
  if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(style)) return false;
  const cv = (el as { checkVisibility?: () => boolean }).checkVisibility;
  if (typeof cv === 'function') {
    try {
      return cv.call(el);
    } catch {
      return true;
    }
  }
  return true;
}

/** the element the player lives in (ad UI is inside it), else the whole document */
function scopeOf(video: Element | undefined): ParentNode | undefined {
  const doc = video?.ownerDocument;
  if (!doc) return undefined;
  const player = video?.closest?.('[data-a-target="video-player"], .video-player, [data-test-selector="video-player"]');
  return player ?? doc;
}

/** which pieces of evidence are present right now (diagnostics) */
export function adDomEvidence(video: Element | undefined): string[] {
  const root = scopeOf(video);
  if (!root) return [];
  const found: string[] = [];
  for (const sel of AD_DOM_SELECTORS) {
    try {
      for (const el of Array.from(root.querySelectorAll(sel))) {
        if (visible(el)) {
          found.push(sel);
          break;
        }
      }
    } catch {
      /* a selector the engine rejects must not disable the others */
    }
  }
  if (found.length === 0) {
    try {
      for (const box of Array.from(root.querySelectorAll(FALLBACK_CONTAINERS)).slice(0, 12)) {
        if (!visible(box)) continue;
        const nodes = [box, ...Array.from(box.querySelectorAll('span, p, div')).slice(0, 20)];
        if (nodes.some((n) => n.children.length === 0 && AD_WORD.test(n.textContent ?? '') && visible(n))) {
          found.push('text-fallback');
          break;
        }
      }
    } catch {
      /* ignore */
    }
  }
  return found;
}

/** `() => boolean`: the player is showing an ad (cheap enough for a 500 ms poll) */
export function createDomAdProbe(video: Element | undefined): () => boolean {
  return () => {
    try {
      return adDomEvidence(video).length > 0;
    } catch {
      return false;
    }
  };
}
