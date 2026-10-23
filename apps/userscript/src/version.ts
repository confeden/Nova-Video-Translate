/** Injected at build time from apps/userscript/package.json (see vite.config.ts `define`). */
declare const __NVT_VERSION__: string;
export const NVT_VERSION: string = typeof __NVT_VERSION__ !== 'undefined' ? __NVT_VERSION__ : 'dev';
