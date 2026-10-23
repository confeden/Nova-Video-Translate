/** Injected at build time from apps/extension/package.json (see wxt.config.ts `define`). */
declare const __NVT_VERSION__: string;
export const NVT_VERSION: string = typeof __NVT_VERSION__ !== 'undefined' ? __NVT_VERSION__ : 'dev';
