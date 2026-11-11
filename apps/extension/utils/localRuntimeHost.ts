/** Platform boundary shared by extension offscreen and userscript local-model runtimes. */
export interface LocalRuntimeHost {
  runtime: {
    id: string;
    sendMessage(message: unknown): Promise<unknown>;
    onMessage: {
      addListener(listener: (message: unknown, sender: unknown, sendResponse: (reply: unknown) => void) => boolean): void;
    };
    /** Absolute base URLs for /ort/, /ort-hf/, /piper/ and the local-model sentinel. */
    getURL(path: string): string;
    getManifest(): { version: string };
    getContexts?(filter: { contextTypes: string[] }): Promise<unknown[]>;
  };
  storage: {
    local: {
      get(keys: string | string[]): Promise<Record<string, unknown>>;
      set(values: Record<string, unknown>): Promise<void>;
      remove(keys: string | string[]): Promise<void>;
    };
  };
  offscreen?: {
    createDocument(options: { url: string; reasons: string[]; justification: string }): Promise<void>;
    closeDocument(): Promise<void>;
  };
  /** Model downloads only; userscripts inject their privileged GM transport. */
  fetch?: typeof fetch;
  loadTransformers?: () => Promise<typeof import('@huggingface/transformers')>;
  loadOrt?: () => Promise<typeof import('onnxruntime-web')>;
  /** Userscripts load the phonemizer in their sandbox rather than the page's script realm. */
  loadPiper?: () => Promise<unknown>;
}

let host: LocalRuntimeHost | undefined;

export function configureLocalRuntimeHost(value: LocalRuntimeHost): void {
  if (host) throw new Error('local runtime host already configured');
  host = value;
}

export function localRuntimeHost(): LocalRuntimeHost {
  if (!host) throw new Error('local runtime host is not configured');
  return host;
}

/** Serializes OPFS/Cache mutations across tabs of the same origin; queued downloads remain cancellable. */
export function withLocalModelFiles<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  if (typeof navigator === 'undefined' || !navigator.locks) return run();
  return navigator.locks.request('nvt-local-model-files', { signal }, run);
}
