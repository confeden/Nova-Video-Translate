/** Minimal typings for the Tampermonkey APIs NVT uses (granted in vite.config.ts). Resolved as sandbox globals at call time. */

export interface GmXhrResponse {
  status: number;
  statusText?: string;
  responseHeaders?: string;
  response: ArrayBuffer | Blob | string | null;
  finalUrl?: string;
}
export interface GmXhrHandle {
  abort(): void;
}
export interface GmXhrDetails {
  method: string;
  url: string;
  headers?: Record<string, string>;
  data?: Uint8Array | string;
  responseType?: 'arraybuffer' | 'blob' | 'text';
  /** no cookies (== fetch credentials: 'omit') */
  anonymous?: boolean;
  timeout?: number;
  onload?: (r: GmXhrResponse) => void;
  onerror?: (e: { error?: string; statusText?: string }) => void;
  ontimeout?: () => void;
  onabort?: () => void;
}
export type GmXhr = (d: GmXhrDetails) => GmXhrHandle | void;

declare const GM_xmlhttpRequest: GmXhr;
declare const GM_getValue: (key: string, def?: unknown) => unknown;
declare const GM_setValue: (key: string, value: unknown) => void;
declare const GM_registerMenuCommand: (caption: string, fn: () => void) => unknown;
declare const GM_addValueChangeListener: (
  key: string,
  fn: (name: string, oldValue: unknown, newValue: unknown, remote: boolean) => void,
) => unknown;
declare const GM_info: { scriptSource?: string } | undefined;
declare const unsafeWindow: (Window & typeof globalThis) | undefined;

export const gmXhr = (d: GmXhrDetails): GmXhrHandle | void => GM_xmlhttpRequest(d);
export const gmGet = (key: string): unknown => GM_getValue(key);
export const gmSet = (key: string, value: unknown): void => GM_setValue(key, value);
export const gmMenu = (caption: string, fn: () => void): void => void GM_registerMenuCommand(caption, fn);
export const gmOnChange = (key: string, fn: (newValue: unknown, remote: boolean) => void): void =>
  void GM_addValueChangeListener(key, (_n, _o, nv, remote) => fn(nv, remote));
export const gmScriptSource = (): string | undefined => (typeof GM_info !== 'undefined' ? GM_info?.scriptSource : undefined);

/** The page's own window when the sandbox exposes it (Tampermonkey `unsafeWindow`), else the script's window. */
export const pageWindow = (): Window & typeof globalThis =>
  (typeof unsafeWindow !== 'undefined' && unsafeWindow) || (window as Window & typeof globalThis);
export const hasUnsafeWindow = (): boolean => typeof unsafeWindow !== 'undefined' && !!unsafeWindow;
