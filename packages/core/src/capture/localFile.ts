/**
 * A video opened from disk (file:// page) cannot be fetched by a content script. The user picks the same file once (a click
 * on the player button is the gesture the file dialog needs); `fileFetch` then answers Range requests from the Blob, so the
 * direct-URL capture (whole-file decode or the progressive mp4 audio table) works unchanged. Browser-only (Blob / Response).
 */

/** a stand-in https URL for the picked file (probeDirect accepts http(s) only; the fetch below never leaves the page) */
export const localFileUrl = (name: string): string => `https://nvt-local.invalid/${encodeURIComponent(name)}`;

export function fileFetch(file: Blob): typeof fetch {
  return (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const size = file.size;
    const h = new Headers(init?.headers);
    const m = /bytes=(\d+)-(\d*)/.exec(h.get('range') ?? '');
    if (!m) return new Response(file, { status: 200, headers: { 'content-length': String(size), 'accept-ranges': 'bytes' } });
    const a = Math.min(Number(m[1]), Math.max(0, size - 1));
    const b = Math.min(m[2] ? Number(m[2]) : size - 1, size - 1);
    return new Response(file.slice(a, b + 1), { status: 206, headers: { 'content-range': `bytes ${a}-${b}/${size}`, 'content-length': String(b - a + 1), 'accept-ranges': 'bytes' } });
  }) as typeof fetch;
}

/** opens the file dialog (call straight from a click); resolves undefined when the user cancels */
export function pickLocalFile(doc: Document = document): Promise<File | undefined> {
  return new Promise((resolve) => {
    const input = doc.createElement('input');
    input.type = 'file';
    input.accept = 'video/*,audio/*,.mkv,.mp4,.webm,.mp3';
    input.style.display = 'none';
    input.addEventListener('change', () => resolve(input.files?.[0]), { once: true });
    input.addEventListener('cancel', () => resolve(undefined), { once: true });
    doc.documentElement.appendChild(input);
    input.click();
    // the element has no other owner: drop it once the dialog is settled
    const drop = (): void => input.remove();
    input.addEventListener('change', drop, { once: true });
    input.addEventListener('cancel', drop, { once: true });
  });
}

/**
 * Range reads of a file:// URL through the extension's service worker (`read`, with "Allow access to file URLs" on). Chrome answers
 * file reads with 200 and no content-range / content-length, so the total size is found once by probing 1-byte ranges and every
 * answer is rebuilt as a proper 206 for the direct-URL capture. The page's own file:// URL stays out of probeDirect's http(s) check
 * through the stand-in URL of `localFileUrl`.
 */
export function swFileFetch(read: (url: string, init?: RequestInit) => Promise<Response>, realUrl: string): typeof fetch {
  let sizeP: Promise<number> | undefined;
  const probe = async (n: number): Promise<boolean> => {
    // Chrome fails a range that starts past the end; 2 bytes because a 1-byte range at the very end is the last one that exists
    try {
      const r = await read(realUrl, { headers: { Range: `bytes=${n}-${n + 1}` } });
      return r.ok && (await r.arrayBuffer()).byteLength > 0;
    } catch {
      return false;
    }
  };
  const sizeOf = (): Promise<number> =>
    (sizeP ??= (async () => {
      let lo = 0; // a byte that exists
      let hi = 1 << 20; // first offset assumed past the end
      while (await probe(hi)) {
        lo = hi;
        hi *= 2;
        if (hi > 2 ** 40) throw new Error('file size not found');
      }
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (await probe(mid)) lo = mid;
        else hi = mid;
      }
      return hi;
    })());
  return (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const size = await sizeOf();
    const m = /bytes=(\d+)-(\d*)/.exec(new Headers(init?.headers).get('range') ?? '');
    const a = m ? Math.min(Number(m[1]), Math.max(0, size - 1)) : 0;
    const b = m ? Math.min(m[2] ? Number(m[2]) : size - 1, size - 1) : size - 1;
    const res = await read(realUrl, { headers: { Range: `bytes=${a}-${b}` }, signal: init?.signal ?? undefined });
    if (!res.ok) return res;
    const bytes = new Uint8Array(await res.arrayBuffer());
    return new Response(bytes, { status: 206, headers: { 'content-range': `bytes ${a}-${b}/${size}`, 'content-length': String(bytes.length), 'accept-ranges': 'bytes' } });
  }) as typeof fetch;
}
