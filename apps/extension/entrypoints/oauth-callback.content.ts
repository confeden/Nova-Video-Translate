import { parseOAuthCallback } from '@nvt/core';
import { browser } from 'wxt/browser';

/** Runs on https://oauth.yandex.ru/verification_code: hands the authorization code to the background (D12). */
export default defineContentScript({
  matches: ['https://oauth.yandex.ru/verification_code*'],
  runAt: 'document_idle',
  main() {
    // same source as VOT (location.search: code + state)
    const cb = parseOAuthCallback(location.search, location.hash);
    if (!cb) return;
    void browser.runtime.sendMessage({ type: 'nvt-oauth-code', code: cb.code, state: cb.state }).catch(() => {});
  },
});
