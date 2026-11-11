import { diag } from '@nvt/core';
import { NVT_DEVLOG, NVT_VERSION } from './version';
import { browser } from 'wxt/browser';

export function startPageDevLog(page: string): void {
  startDevLog(page, async (entries) => {
    const r = await browser.runtime.sendMessage({ type: 'nvt-diag-push', page, entries });
    return r?.ok === true;
  });
}

/** Keep unsent events until the local sink acknowledges the batch. */
export function startDevLog(page: string, send: (entries: ReturnType<typeof diag.drainUnsent>) => Promise<boolean>): void {
  if (!NVT_DEVLOG) return;
  globalThis.addEventListener('error', (e: ErrorEvent) => diag.log('runtime-error', { message: e.message, source: e.filename, line: e.lineno }));
  globalThis.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => diag.log('runtime-rejection', { message: String(e.reason?.message ?? e.reason) }));
  let pending: ReturnType<typeof diag.drainUnsent> = [];
  let busy = false;
  let offline = false;
  diag.log('devlog-start', { page, version: NVT_VERSION });
  const flush = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    try {
      pending.push(...diag.drainUnsent());
      if (pending.length > 5000) {
        const dropped = pending.length - 5000;
        pending.splice(0, dropped);
        diag.log('devlog-overflow', { dropped });
      }
      if (!pending.length) return;
      const ok = await send(pending);
      if (ok) {
        pending = [];
        if (offline) diag.log('devlog-online');
        offline = false;
      } else if (!offline) {
        offline = true;
        diag.log('devlog-offline', { retained: pending.length });
      }
    } catch (e) {
      if (!offline) diag.log('devlog-offline', { reason: e instanceof Error ? e.message : 'send failed' });
      offline = true;
    } finally { busy = false; }
  };
  setInterval(() => void flush(), 3000);
  void flush();
}
