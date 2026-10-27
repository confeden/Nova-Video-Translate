/**
 * Diagnostics ring buffer shared by every module. The owner copies `diag.report()` from the settings panel and
 * sends it to the developer, so entries must NEVER contain API keys, OAuth tokens, cookies or full URLs with
 * query strings. Keep data small and primitive.
 */
export interface DiagEntry {
  /** ms since the first entry of this page session */
  t: number;
  ev: string;
  data?: Record<string, unknown>;
}

const MAX = 1500;
/** the start of the page session is pinned: the first HEAD_MAX events (within HEAD_MS) are never evicted by the ring */
const HEAD_MAX = 400;
const HEAD_MS = 60_000;
const head: DiagEntry[] = [];
let headOpen = true;
const entries: DiagEntry[] = [];
/** entries already handed to drainUnsent(): kept by identity, so the ring can still evict them */
const sent = new WeakSet<DiagEntry>();
let t0 = 0;
const SECRET = /(key|token|authorization|secret|password|cookie|code_verifier)/i;

function clean(data?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!data) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (SECRET.test(k)) {
      out[k] = '[hidden]';
    } else if (typeof v === 'string') {
      out[k] = v.length > 200 ? `${v.slice(0, 200)}…` : v.replace(/([?&#][^\s]*)/g, '[query]');
    } else if (typeof v === 'number' || typeof v === 'boolean' || v == null) {
      out[k] = typeof v === 'number' ? Math.round(v * 1000) / 1000 : v;
    } else {
      try {
        const s = JSON.stringify(v);
        out[k] = s.length > 300 ? `${s.slice(0, 300)}…` : JSON.parse(s);
      } catch {
        out[k] = String(v).slice(0, 100);
      }
    }
  }
  return out;
}

export const diag = {
  log(ev: string, data?: Record<string, unknown>): void {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (!t0) t0 = now;
    const e = { t: Math.round(now - t0), ev, data: clean(data) };
    if (headOpen && head.length < HEAD_MAX && e.t <= HEAD_MS) {
      head.push(e);
      return;
    }
    headOpen = false;
    entries.push(e);
    if (entries.length > MAX) entries.shift();
  },
  entries(): readonly DiagEntry[] {
    return head.length === 0 ? entries : entries.length === 0 ? head : [...head, ...entries];
  },
  /** entries not handed out before (for the local log sink); each entry is returned once */
  drainUnsent(): DiagEntry[] {
    const fresh = [...head, ...entries].filter((e) => !sent.has(e));
    for (const e of fresh) sent.add(e);
    return fresh;
  },
  clear(): void {
    entries.length = 0;
    head.length = 0;
    headOpen = true;
    t0 = 0;
  },
  /** plain text for copy/paste; first line carries the context passed in `header`; the pinned session start comes before the ring tail */
  report(header?: Record<string, unknown>): string {
    const hdr = header ? `# ${JSON.stringify(clean(header))}\n` : '';
    const line = (e: DiagEntry): string => `${String(e.t).padStart(7)} ${e.ev}${e.data ? ` ${JSON.stringify(e.data)}` : ''}`;
    const parts = [head.map(line).join('\n')];
    if (head.length > 0 && entries.length >= MAX) parts.push(`        ... (events between ${head.at(-1)!.t} ms and ${entries[0]!.t} ms were dropped) ...`);
    parts.push(entries.map(line).join('\n'));
    return hdr + parts.filter((x) => x.length > 0).join('\n');
  },
};

// verification hook (CDP / console): the content-script world exposes the shared log
try {
  (globalThis as unknown as { __nvtDiag?: typeof diag }).__nvtDiag = diag;
} catch {
  /* frozen global: ignore */
}

/** devlog builds only: a decoded dub is handed to the local sink as audio (set by the content script; absent = nothing) */
export const devAudio: { dump?: (name: string, data: Float32Array, sampleRate: number) => void } = {};
