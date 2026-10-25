import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { defineConfig } from 'wxt';
import pkg from './package.json' with { type: 'json' };

// single source of the version: apps/extension/package.json (scripts/bump-version.mjs); WXT also writes it to manifest.json
const VERSION: string = pkg.version;

// onnxruntime-web files for the offscreen local-TTS engine: copied from node_modules into the extension as ort/ (no remote code)
const ORT_FILES = ['ort.webgpu.bundle.min.mjs', 'ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm'];
function ortDistDir(): string {
  // workspace-hoisted (root node_modules) or local; the package's "exports" hide package.json, so locate by path
  for (const rel of ['./node_modules/onnxruntime-web/dist', '../../node_modules/onnxruntime-web/dist']) {
    const dir = fileURLToPath(new URL(rel, import.meta.url));
    if (existsSync(join(dir, ORT_FILES[0]!))) return dir;
  }
  throw new Error('onnxruntime-web is not installed (npm install)');
}

// onnxruntime-web glue + wasm bundled with @huggingface/transformers (its own dev build, NOT the root onnxruntime-web): copied as ort-hf/
const HF_ORT_FILES = ['ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm'];
function hfDistDir(): string {
  for (const rel of ['./node_modules/@huggingface/transformers/dist', '../../node_modules/@huggingface/transformers/dist']) {
    const dir = fileURLToPath(new URL(rel, import.meta.url));
    if (existsSync(join(dir, HF_ORT_FILES[0]!))) return dir;
  }
  throw new Error('@huggingface/transformers is not installed (npm install)');
}

export default defineConfig({
  hooks: {
    'build:publicAssets': (_wxt, files) => {
      const dir = ortDistDir();
      for (const f of ORT_FILES) files.push({ absoluteSrc: join(dir, f), relativeDest: `ort/${f}` });
      const hf = hfDistDir();
      for (const f of HF_ORT_FILES) files.push({ absoluteSrc: join(hf, f), relativeDest: `ort-hf/${f}` });
    },
  },
  // core's dist/ is extensionless ESM (fine for bundlers, not for WXT's node-side entrypoint import): use the sources
  vite: () => ({
    define: { __NVT_VERSION__: JSON.stringify(VERSION) },
    resolve: { alias: { '@nvt/core': decodeURIComponent(new URL('../../packages/core/src/index.ts', import.meta.url).pathname).replace(/^\/(?=[A-Za-z]:)/, '') } },
  }),
  manifest: {
    name: 'Nova Video Translate',
    short_name: 'NVT',
    description: 'Закадровый перевод видео на русский: голоса Яндекса и Gemini.',
    permissions: ['storage', 'alarms', 'declarativeNetRequest', 'declarativeNetRequestWithHostAccess', 'offscreen', 'unlimitedStorage'],
    // wasm-unsafe-eval: onnxruntime-web WASM (local TTS, offscreen document); no remote scripts
    content_security_policy: { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'" },
    host_permissions: [
      'https://api.browser.yandex.ru/*',
      'https://*.mds.yandex.net/*',
      'https://oauth.yandex.ru/*',
      'https://login.yandex.ru/*',
      'https://generativelanguage.googleapis.com/*',
      'https://api.groq.com/*',
      // Twitch live (capture 'hls', audio_only rendition): anonymous GQL token, usher, playlist + segment hosts (*.playlist.ttvnw.net, *.cloudfront.hls.ttvnw.net)
      'https://gql.twitch.tv/*',
      'https://usher.ttvnw.net/*',
      'https://*.ttvnw.net/*',
      'https://*.live-video.net/*',
      // local TTS model download (Supertone/supertonic-3): huggingface.co redirects to *.hf.co CDNs (xet bridge: us.aws.cdn.hf.co,
      // cas-bridge.xethub.hf.co, cdn-lfs*.hf.co / cdn-lfs*.huggingface.co); host permissions bypass CORS for these redirects
      'https://huggingface.co/*',
      'https://*.huggingface.co/*',
      'https://*.hf.co/*',
      // model mirror (public-read S3 prefix nvt-models/, core/localasr/mirror.ts): tried before huggingface.co
      'https://s3.ru1.storage.beget.cloud/*',
      // Piper phonemizer data pack (pinned npm version on jsDelivr) and GitHub-hosted model releases (Silero ONNX set)
      'https://cdn.jsdelivr.net/*',
      // Silero ONNX set on the owner's VPS (nginx, plain HTTP; kb/server.md)
      'http://212.116.115.237/*',
      'https://github.com/*',
      // update check: GET /repos/confeden/Nova-Video-Translate/releases/latest only (utils/updateCheck.ts)
      'https://api.github.com/*',
      'https://objects.githubusercontent.com/*',
      // local diagnostics sink (tools/diag-server.mjs): the background posts the page logs to it
      'http://127.0.0.1/*',
      'https://release-assets.githubusercontent.com/*',
    ],
  },
});
