import { defineConfig } from 'vite';
import pkg from './package.json' with { type: 'json' };
import monkey from 'vite-plugin-monkey';
import { RUNTIME_RESOURCES } from './src/runtimeResources.ts';

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
        description: 'Закадровый перевод видео на русский: Яндекс, Groq и локальные модели; субтитры и умное приглушение',
        match: ['*://*/*', 'file:///*'],
        'run-at': 'document-start',
        // Preserve native import() for pinned GM resources; bundling it would pull in a SystemJS loader.
        require: [`data:application/javascript,${encodeURIComponent('var NVT_importModule = (url) => import(url);')}`],
        grant: ['GM_xmlhttpRequest', 'GM_getValue', 'GM_setValue', 'GM_deleteValue', 'GM_getResourceText', 'GM_registerMenuCommand', 'GM_addValueChangeListener', 'GM_info', 'unsafeWindow'],
        resource: RUNTIME_RESOURCES,
        updateURL: 'https://github.com/confeden/Nova-Video-Translate/releases/latest/download/Nova_Video_Translate.user.js',
        downloadURL: 'https://github.com/confeden/Nova-Video-Translate/releases/latest/download/Nova_Video_Translate.user.js',
        // Only these hosts are ever contacted from the script. Nothing else is needed (no '*').
        connect: ['api.browser.yandex.ru', 'mds.yandex.net', 'generativelanguage.googleapis.com', 'api.groq.com', 'oauth.yandex.ru', 'login.yandex.ru', 'api.github.com', 'gql.twitch.tv', 'usher.ttvnw.net', '*.ttvnw.net', '*.live-video.net', 'huggingface.co', 'hf.co', 's3.ru1.storage.beget.cloud', 'cdn.jsdelivr.net', 'github.com', 'githubusercontent.com', '212.116.115.237'],
      },
    }),
  ],
});
