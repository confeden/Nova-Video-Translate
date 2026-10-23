import { installAudioTracksMain, installCaptionsMain, installMseTapMain } from '@nvt/core';

/**
 * MAIN-world half of the MSE audio tap (S1). Pure pass-through wrappers (D14): the page, and other extensions that
 * patch MediaSource / SourceBuffer, see unchanged behaviour. Decoding stays idle until the isolated world asks.
 */
export default defineContentScript({
  matches: ['<all_urls>'],
  world: 'MAIN',
  runAt: 'document_start',
  allFrames: true,
  main() {
    try {
      installMseTapMain();
    } catch {
      /* never break the page */
    }
    try {
      // read-only reader of the player's caption tracks (subtitle source S2); patches nothing
      installCaptionsMain();
    } catch {
      /* never break the page */
    }
    try {
      // read/switch of the player's audio tracks (native Russian dub, D28); patches nothing
      installAudioTracksMain();
    } catch {
      /* never break the page */
    }
  },
});
