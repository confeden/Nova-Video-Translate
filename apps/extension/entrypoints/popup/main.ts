import { mountSettingsPanel } from '@nvt/core';
import { browser } from 'wxt/browser';
import { createTabHost } from '../../utils/panelHost';
import { VOICE_STATUS_KEY, YANDEX_AUTH_KEY, YANDEX_LOGIN_ERROR_KEY } from '../../utils/settings';

const panel = mountSettingsPanel(document.getElementById('app')!, createTabHost());
// the login completes in another tab: reflect it when storage changes
browser.storage.onChanged.addListener((c, area) => {
  if (area === 'local' && (YANDEX_AUTH_KEY in c || YANDEX_LOGIN_ERROR_KEY in c || VOICE_STATUS_KEY in c)) void panel.refresh();
});
