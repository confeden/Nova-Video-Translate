/**
 * Stable chunk grid. Capture strategies deliver audio windows that start wherever playback started; the result
 * cache needs the SAME cell boundaries on every viewing, so the Rechunker re-cuts the incoming audio into cells
 * aligned to `[k*chunkSec, (k+1)*chunkSec)` of the video timeline.
 *
 * A cell that is complete is emitted as soon as its last sample arrives. A cell that can never become complete
 * (capture started mid-cell, the stream ended, a hole that is not filled in time) is emitted with `partial: true`
 * (startSec/durationSec = the part actually covered) and is never cached downstream.
 *
 * Mid-stream cells are HELD while pieces are missing (players such as YouTube deliver audio segments out of order and
 * in pieces; every partial cell costs a full provider request for little audio): a cell is flushed as partial only
 * when it is the cell the capture started in (its head can never arrive), or nothing touched it for `timeoutMs`
 * (default 8 s), or on flush() (end of stream). Neighbouring partials that meet at a cell boundary are coalesced into
 * one request.
 */
import type { AudioChunk } from '../providers/types';

export interface RechunkerOptions {
  chunkSec: number;
  emit(c: AudioChunk): void;
  /** a pending cell nobody touched for this long is flushed as partial (default 8000 ms) */
  timeoutMs?: number;
  /**
   * Called with the grid start (s) of a pending cell that has been quiet for `timeoutMs`: true = keep holding it
   * (the engine says the cell is still far enough ahead for the missing piece to arrive in time), up to `maxHoldMs`.
   */
  hold?(cellStartSec: number): boolean;
  /** upper bound for `hold` (default 60 s) */
  maxHoldMs?: number;
  /** partial pieces shorter than this are dropped (not worth a request; default 0.5 s) */
  minPartialSec?: number;
  now?: () => number;
  /** timer factory (inject for tests); returns a canceller */
  schedule?: (fn: () => void, ms: number) => () => void;
}

interface Cell {
  index: number;
  buf: Int16Array;
  /** merged covered sample ranges [from, to), sorted */
  cov: Array<[number, number]>;
  sampleRate: number;
  touched: number;
}

/** total hole length inside a cell that still counts as complete */
const MAX_HOLE_SEC = 0.3;

const defaultSchedule = (fn: () => void, ms: number): (() => void) => {
  const t = setTimeout(fn, ms);
  return () => clearTimeout(t);
};

export class Rechunker {
  private readonly cells = new Map<number, Cell>();
  private readonly closed = new Set<number>();
  private cancel?: () => void;
  /** grid index of the cell the capture started in (head of that cell never arrives); NaN = unknown yet */
  private startCell = NaN;
  private firstPushed = NaN;
  private readonly timeoutMs: number;
  private readonly minPartialSec: number;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => () => void;

  constructor(private readonly opts: RechunkerOptions) {
    this.timeoutMs = opts.timeoutMs ?? 8000;
    this.minPartialSec = opts.minPartialSec ?? 0.5;
    this.now = opts.now ?? Date.now;
    this.schedule = opts.schedule ?? defaultSchedule;
  }

  get pending(): number {
    return this.cells.size;
  }

  push(c: AudioChunk): void {
    const cs = this.opts.chunkSec;
    const sr = c.sampleRate;
    const t0 = c.startSec;
    // coverage follows the declared timeline; the pcm is copied as far as it goes (the rest stays silent)
    const t1 = t0 + c.durationSec;
    if (!(t1 > t0)) return;
    const first = Math.floor(t0 / cs + 1e-9);
    if (Number.isNaN(this.firstPushed)) this.firstPushed = first;
    const last = Math.ceil(t1 / cs - 1e-9) - 1;
    const cellN = Math.round(cs * sr);
    const touched = this.now();
    for (let k = first; k <= last; k++) {
      if (this.closed.has(k)) continue;
      const cellStart = k * cs;
      let cell = this.cells.get(k);
      if (cell && cell.sampleRate !== sr) {
        // sample rate changed mid-cell (should not happen): start the cell over
        this.cells.delete(k);
        cell = undefined;
      }
      const from = Math.max(0, Math.round((t0 - cellStart) * sr));
      const to = Math.min(cellN, Math.round((t1 - cellStart) * sr));
      if (to <= from) continue;
      if (!cell) {
        cell = { index: k, buf: new Int16Array(cellN), cov: [], sampleRate: sr, touched };
        this.cells.set(k, cell);
      }
      cell.touched = touched;
      // source sample for cell sample `from`
      const srcOff = Math.round((cellStart + from / sr - t0) * sr);
      const lo = Math.max(0, srcOff);
      const hi = Math.min(c.pcm.length, srcOff + (to - from));
      if (hi > lo) cell.buf.set(c.pcm.subarray(lo, hi), from + (lo - srcOff));
      addRange(cell.cov, from, to);
      this.settle(cell);
    }
    this.arm();
  }

  /** Flush every pending cell untouched for >= timeoutMs as partial. Public for deterministic tests. */
  flushStale(nowMs = this.now()): void {
    const maxHold = this.opts.maxHoldMs ?? 60_000;
    this.emitPartials(
      [...this.cells.values()].filter((c) => {
        const age = nowMs - c.touched;
        if (age < this.timeoutMs) return false;
        return !(age < maxHold && this.opts.hold?.(c.index * this.opts.chunkSec));
      }),
    );
    this.arm();
  }

  /** Flush everything pending as partial (end of stream). */
  flush(): void {
    this.emitPartials([...this.cells.values()]);
    this.disarm();
  }

  /** Forget pending cells without emitting (new capture run after a seek). `startSec` = where the new run starts. */
  reset(startSec?: number): void {
    this.cells.clear();
    this.closed.clear();
    this.disarm();
    this.firstPushed = NaN;
    this.startCell = startSec === undefined ? NaN : Math.floor(startSec / this.opts.chunkSec + 1e-9);
  }

  dispose(): void {
    this.reset();
  }

  // ---- internals ----

  private settle(cell: Cell): void {
    const n = cell.buf.length;
    const tol = Math.round(0.02 * cell.sampleRate);
    const cov = cell.cov;
    const head = cov[0]![0];
    const tail = cov[cov.length - 1]![1];
    // tiny holes between decoded segments (timestamp rounding) are not missing audio: they stay silent
    let gaps = 0;
    for (let i = 1; i < cov.length; i++) gaps += cov[i]![0] - cov[i - 1]![1];
    if (head <= tol && tail >= n - tol && gaps <= Math.round(MAX_HOLE_SEC * cell.sampleRate)) {
      this.cells.delete(cell.index);
      this.closed.add(cell.index);
      this.opts.emit({
        startSec: cell.index * this.opts.chunkSec,
        durationSec: this.opts.chunkSec,
        sampleRate: cell.sampleRate,
        pcm: cell.buf,
      });
      return;
    }
    // data already runs to the end of the cell but its beginning was never seen. In the cell the capture started in
    // that beginning never comes: emit now. Anywhere else it is a piece that has not been delivered yet: hold.
    if (tail >= n - tol && head > tol && this.isStartCell(cell.index)) this.emitPartial(cell);
  }

  private isStartCell(index: number): boolean {
    return index === this.startCell || index === this.firstPushed;
  }

  private emitPartial(cell: Cell): void {
    this.emitPartials([cell]);
  }

  /** emit the given pending cells as partial, coalescing a tail-partial with the head-partial of the next cell */
  private emitPartials(list: Cell[]): void {
    list.sort((p, q) => p.index - q.index);
    const done = new Set<number>();
    for (const cell of list) {
      if (done.has(cell.index) || !this.cells.has(cell.index)) continue;
      const sr = cell.sampleRate;
      const n = cell.buf.length;
      const tol = Math.round(0.02 * sr);
      const cov = cell.cov;
      this.cells.delete(cell.index);
      this.closed.add(cell.index);
      if (cov.length === 0) continue;
      const a = cov[0]![0];
      let b = cov[cov.length - 1]![1];
      let pcm = cell.buf.slice(a, b);
      const next = this.cells.get(cell.index + 1);
      if (next && next.sampleRate === sr && b >= n - tol && list.includes(next) && next.cov.length > 0 && next.cov[0]![0] <= tol && n - a + next.cov[next.cov.length - 1]![1] <= n) {
        // contiguous across the boundary and still within one cell length: one request for both pieces
        this.cells.delete(next.index);
        this.closed.add(next.index);
        done.add(next.index);
        const nb = next.cov[next.cov.length - 1]![1];
        const merged = new Int16Array(pcm.length + nb);
        merged.set(pcm, 0);
        merged.set(next.buf.subarray(0, nb), pcm.length);
        pcm = merged;
        b = n + nb;
      }
      if ((b - a) / sr < this.minPartialSec) continue;
      this.opts.emit({
        startSec: cell.index * this.opts.chunkSec + a / sr,
        durationSec: (b - a) / sr,
        sampleRate: sr,
        pcm,
        partial: true,
      });
    }
  }

  private arm(): void {
    this.disarm();
    if (this.cells.size === 0) return;
    this.cancel = this.schedule(() => {
      this.cancel = undefined;
      this.flushStale();
    }, this.timeoutMs);
  }

  private disarm(): void {
    this.cancel?.();
    this.cancel = undefined;
  }
}

function addRange(cov: Array<[number, number]>, from: number, to: number): void {
  cov.push([from, to]);
  cov.sort((p, q) => p[0] - q[0]);
  let w = 0;
  for (let i = 1; i < cov.length; i++) {
    const cur = cov[w]!;
    const nxt = cov[i]!;
    if (nxt[0] <= cur[1]) cur[1] = Math.max(cur[1], nxt[1]);
    else cov[++w] = nxt;
  }
  cov.length = w + 1;
}
