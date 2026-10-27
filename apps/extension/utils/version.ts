/** Injected at build time from apps/extension/package.json (see wxt.config.ts `define`). */
declare const __NVT_VERSION__: string;
/** true only in a devlog build (NVT_DEVLOG=1 wxt build): diagnostics go to the local sink; release builds send nothing */
declare const __NVT_DEVLOG__: boolean;
export const NVT_DEVLOG: boolean = typeof __NVT_DEVLOG__ !== 'undefined' && __NVT_DEVLOG__ === true;
export const NVT_VERSION: string = typeof __NVT_VERSION__ !== 'undefined' ? __NVT_VERSION__ : 'dev';
