import { defineConfig } from 'vite';
import pkg from './package.json' with { type: 'json' };
import monkey from 'vite-plugin-monkey';

// single source of the version: apps/userscript/package.json (scripts/bump-version.mjs)
const VERSION: string = pkg.version;

export default defineConfig({
  define: { __NVT_VERSION__: JSON.stringify(VERSION) },
  build: { minify: false },
  plugins: [
    monkey({
      entry: 'src/main.ts',
      userscript: {
        name: 'Nova Video Translate (NVT)',
        namespace: 'nvt',
        version: VERSION,
        description: 'Живой закадровый перевод видео на русский (Яндекс / Gemini), оригинал приглушается',
        match: ['*://*/*'],
        'run-at': 'document-start',
        grant: ['GM_xmlhttpRequest', 'GM_getValue', 'GM_setValue', 'GM_registerMenuCommand', 'GM_addValueChangeListener', 'GM_info', 'unsafeWindow'],
        // Only these hosts are ever contacted from the script. Nothing else is needed (no '*').
        connect: ['api.browser.yandex.ru', 'mds.yandex.net', 'generativelanguage.googleapis.com', 'api.groq.com', 'oauth.yandex.ru', 'login.yandex.ru', 'api.github.com', 'gql.twitch.tv', 'usher.ttvnw.net', '*.ttvnw.net', '*.live-video.net'],
      },
    }),
  ],
});
