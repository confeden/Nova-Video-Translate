import { describe, expect, it } from 'vitest';
import { Rechunker } from '../src/capture/rechunk';
import type { AudioChunk } from '../src/providers/types';

const SR = 100; // tiny sample rate keeps the arrays small; the logic is rate-independent

function run(startSec: number, durSec: number): AudioChunk {
  const pcm = new Int16Array(Math.round(durSec * SR));
  // sample value = its absolute position in 1/100 s => lets tests verify content placement
  for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(startSec * SR) + i;
  return { startSec, durationSec: durSec, sampleRate: SR, pcm };
}

function make(chunkSec = 15, timeoutMs = 4000) {
  const out: AudioChunk[] = [];
  let t = 0;
  const r = new Rechunker({ chunkSec, emit: (c) => out.push(c), timeoutMs, now: () => t, schedule: () => () => {} });
  return { r, out, tick: (ms: number) => ((t += ms), r.flushStale()) };
}

/** feed a run [from, to) in windows of `win` seconds */
function feed(r: Rechunker, from: number, to: number, win: number): void {
  for (let s = from; s < to - 1e-9; s += win) r.push(run(s, Math.min(win, to - s)));
}

describe('Rechunker', () => {
  it('aligns arbitrary windows to the fixed grid', () => {
    const { r, out } = make();
    feed(r, 0, 60, 20);
    expect(out.map((c) => [c.startSec, c.durationSec, !!c.partial])).toEqual([
      [0, 15, false],
      [15, 15, false],
      [30, 15, false],
      [45, 15, false],
    ]);
    expect(out[1]!.pcm).toHaveLength(15 * SR);
    expect(out[1]!.pcm[0]).toBe(15 * SR); // content is on the right place
    expect(out[1]!.pcm[15 * SR - 1]).toBe(30 * SR - 1);
  });

  it('start mid-cell: the first cell is partial, the rest are complete, the tail is partial after the timeout', () => {
    const { r, out, tick } = make();
    feed(r, 7, 52, 10);
    expect(out.map((c) => [c.startSec, c.durationSec, !!c.partial])).toEqual([
      [7, 8, true],
      [15, 15, false],
      [30, 15, false],
    ]);
    tick(5000);
    expect(out.at(-1)).toMatchObject({ startSec: 45, durationSec: 7, partial: true });
  });

  it('two sessions starting at different offsets produce identical complete cells', () => {
    const s1 = make();
    const s2 = make();
    feed(s1.r, 3.3, 95, 7);
    feed(s2.r, 41.1, 95, 11);
    const full = (o: AudioChunk[]) => o.filter((c) => !c.partial).map((c) => c.startSec + '+' + c.durationSec);
    const f2 = full(s2.out);
    expect(f2.length).toBeGreaterThan(2);
    for (const c of f2) expect(full(s1.out)).toContain(c);
    expect(full(s2.out)[0]).toBe('45+15');
    // sample content of the shared cells is identical
    const byStart = (o: AudioChunk[], s: number) => o.find((c) => c.startSec === s && !c.partial)!;
    expect(Array.from(byStart(s1.out, 60).pcm.subarray(0, 50))).toEqual(Array.from(byStart(s2.out, 60).pcm.subarray(0, 50)));
  });

  it('end of stream: incomplete tail is flushed partial after the timeout, never complete', () => {
    const { r, out, tick } = make();
    feed(r, 0, 40, 10);
    expect(out.map((c) => c.startSec)).toEqual([0, 15]);
    tick(1000);
    expect(out).toHaveLength(2);
    tick(4000);
    expect(out).toHaveLength(3);
    expect(out[2]).toMatchObject({ startSec: 30, durationSec: 10, partial: true });
    expect(out[2]!.pcm).toHaveLength(10 * SR);
  });

  it('flush() emits pending cells as partial; reset() drops them', () => {
    const a = make();
    feed(a.r, 0, 20, 10);
    a.r.flush();
    expect(a.out.at(-1)).toMatchObject({ startSec: 15, durationSec: 5, partial: true });
    const b = make();
    feed(b.r, 0, 20, 10);
    b.r.reset();
    b.r.flush();
    expect(b.out).toHaveLength(1); // only cell 0
  });

  it('tolerates duplicates and out-of-order windows (first emission wins)', () => {
    const { r, out } = make();
    r.push(run(15, 15));
    r.push(run(0, 15));
    r.push(run(0, 15));
    r.push(run(15, 15));
    expect(out.map((c) => c.startSec)).toEqual([15, 0]);
  });

  it('drops partial pieces shorter than minPartialSec', () => {
    const { r, out } = make();
    r.push(run(14.7, 0.3 + 15)); // 0.3 s of cell 0 + all of cell 1
    expect(out.map((c) => [c.startSec, !!c.partial])).toEqual([[15, false]]);
  });

  it('coverage follows the declared timeline even when pcm is shorter (silent remainder)', () => {
    const { r, out } = make();
    r.push({ startSec: 0, durationSec: 15, sampleRate: SR, pcm: new Int16Array(8) });
    expect(out).toHaveLength(1);
    expect(out[0]!.pcm).toHaveLength(15 * SR);
  });

  describe('mid-stream hold (out-of-order delivery)', () => {
    it('a later piece arriving first does not make a partial cell: the cell is held until the missing head arrives', () => {
      const { r, out } = make();
      r.reset(0);
      feed(r, 0, 30, 15); // cells 0 and 15 complete
      r.push(run(40, 5)); // tail of cell 30..45 [10,15) first, head missing
      expect(out.map((c) => c.startSec)).toEqual([0, 15]);
      expect(r.pending).toBe(1);
      r.push(run(30, 10)); // head arrives
      expect(out.map((c) => [c.startSec, c.durationSec, !!c.partial])).toEqual([[0, 15, false], [15, 15, false], [30, 15, false]]);
    });

    it('a hole in the middle waits for the missing piece; only a quiet timeout flushes it as partial', () => {
      const { r, out, tick } = make(15, 8000);
      r.reset(0);
      feed(r, 0, 15, 15);
      r.push(run(15, 5));
      r.push(run(25, 5)); // 20..25 missing
      tick(5000);
      expect(out).toHaveLength(1);
      r.push(run(20, 5)); // touched again: the quiet timer restarts, and the cell is now complete
      expect(out.map((c) => !!c.partial)).toEqual([false, false]);
    });

    it('quiet timeout (8 s default) flushes a held cell as partial', () => {
      const { r, out, tick } = make(15, 8000);
      r.reset(0);
      r.push(run(0, 15));
      r.push(run(50, 5)); // cell 45..60 [5,10)
      tick(7000);
      expect(out).toHaveLength(1);
      tick(2000);
      expect(out.map((c) => [c.startSec, c.durationSec, !!c.partial])).toEqual([[0, 15, false], [50, 5, true]]);
    });

    it('the cell the capture started in is emitted at once (its head can never arrive)', () => {
      const { r, out } = make();
      r.reset(1000);
      r.push(run(1000, 5)); // 990..1005 -> [10, 15)
      expect(out.map((c) => [c.startSec, c.durationSec, !!c.partial])).toEqual([[1000, 5, true]]);
    });

    it('coalesces a tail partial with the head partial of the next cell into one request', () => {
      const { r, out, tick } = make(15, 8000);
      r.reset(0);
      r.push(run(0, 15));
      r.push(run(40, 10)); // cell 30: tail [10,15) + cell 45: head [0,5): contiguous across the boundary
      tick(9000);
      const partials = out.filter((c) => c.partial);
      expect(partials).toHaveLength(1);
      expect(partials[0]!.startSec).toBeCloseTo(40);
      expect(partials[0]!.durationSec).toBeCloseTo(10);
      expect(partials[0]!.pcm).toHaveLength(10 * SR);
      expect(partials[0]!.pcm[0]).toBe(40 * SR);
      expect(partials[0]!.pcm[10 * SR - 1]).toBe(50 * SR - 1);
    });

    it('flush() (end of stream) emits held cells as partial at once', () => {
      const { r, out } = make();
      r.reset(0);
      r.push(run(20, 5));
      expect(out).toHaveLength(0);
      r.flush();
      expect(out.map((c) => !!c.partial)).toEqual([true]);
    });

    it('hold(): a quiet cell that is still far ahead keeps waiting; once it is not, it flushes as partial', () => {
      const out: AudioChunk[] = [];
      let t = 0;
      let far = true;
      const r = new Rechunker({ chunkSec: 15, emit: (c) => out.push(c), timeoutMs: 8000, now: () => t, schedule: () => () => {}, hold: () => far });
      r.reset(0);
      r.push(run(0, 15));
      r.push(run(50, 5));
      t += 20_000;
      r.flushStale();
      expect(out).toHaveLength(1);
      far = false;
      r.flushStale();
      expect(out.map((c) => !!c.partial)).toEqual([false, true]);
    });

    it('never coalesces beyond one cell length', () => {
      const { r, out, tick } = make(15, 8000);
      r.reset(0);
      r.push(run(0, 15));
      r.push(run(32, 13)); // cell 30: [2,15) + cell 45: whole head [0,10) => 23 s > 15: two requests
      r.push(run(45, 10));
      tick(9000);
      expect(out.filter((c) => c.partial).every((c) => c.durationSec <= 15)).toBe(true);
    });

    it('tiny holes (<= 0.3 s) between segments do not keep a cell partial', () => {
      const { r, out } = make();
      r.reset(0);
      r.push(run(0, 7));
      r.push(run(7.1, 7.9)); // 0.1 s hole
      expect(out.map((c) => [c.startSec, c.durationSec, !!c.partial])).toEqual([[0, 15, false]]);
    });
  });
});
