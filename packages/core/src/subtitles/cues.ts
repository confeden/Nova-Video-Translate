import type { SubtitleCue } from '../providers/types';

const MIN_DUR = 0.2;

/** Drops junk, enforces end > start, sorts. */
export function normalizeCues(cues: readonly SubtitleCue[]): SubtitleCue[] {
  const out: SubtitleCue[] = [];
  for (const c of cues) {
    const text = (c.text ?? '').replace(/\s+/g, ' ').trim();
    if (!text || !Number.isFinite(c.start) || !Number.isFinite(c.end)) continue;
    const start = Math.max(0, c.start);
    const end = c.end > start ? c.end : start + MIN_DUR;
    const cue: SubtitleCue = { start, end, text };
    if (c.src) cue.src = c.src;
    out.push(cue);
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end);
}

/** Same layer: removes duplicates (same text, start within `tol` s), e.g. a sentence reported by two overlapping chunks. */
export function dedupeCues(cues: readonly SubtitleCue[], tol = 0.6): SubtitleCue[] {
  const sorted = normalizeCues(cues);
  const out: SubtitleCue[] = [];
  for (const c of sorted) {
    let dup = false;
    for (let i = out.length - 1; i >= 0 && c.start - out[i]!.start <= tol; i--) {
      if (out[i]!.text === c.text) {
        dup = true;
        break;
      }
    }
    if (!dup) out.push(c);
  }
  return out;
}

function overlap(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

/**
 * Layers in priority order (earlier wins). A cue of a lower layer is dropped when more than half of its duration is
 * already covered by a kept cue of a higher layer (same speech reported by two sources). Result sorted by start.
 */
export function mergeCues(layers: readonly (readonly SubtitleCue[])[]): SubtitleCue[] {
  let kept: SubtitleCue[] = [];
  for (const layer of layers) {
    const cur = dedupeCues(layer);
    if (kept.length === 0) {
      kept = cur;
      continue;
    }
    const higher = kept; // sorted by start
    const maxEnd: number[] = [];
    let m = -Infinity;
    for (const h of higher) maxEnd.push((m = Math.max(m, h.end)));
    const add: SubtitleCue[] = [];
    for (const c of cur) {
      // first higher cue that can still be running at c.start (prefix max of end is non-decreasing)
      let lo = 0;
      let hi = higher.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (maxEnd[mid]! > c.start) hi = mid;
        else lo = mid + 1;
      }
      let covered = 0;
      for (let i = lo; i < higher.length && higher[i]!.start < c.end; i++) covered += overlap(c.start, c.end, higher[i]!.start, higher[i]!.end);
      if (covered <= 0.5 * (c.end - c.start)) add.push(c);
    }
    kept = [...higher, ...add].sort((a, b) => a.start - b.start || a.end - b.end);
  }
  return kept;
}

/** Fraction (0..1) of [from, to) covered by the cues. */
export function coverage(cues: readonly SubtitleCue[], from: number, to: number): number {
  if (to <= from) return 0;
  const spans = cues
    .filter((c) => c.end > from && c.start < to)
    .map((c) => [Math.max(from, c.start), Math.min(to, c.end)] as const)
    .sort((a, b) => a[0] - b[0]);
  let sum = 0;
  let curEnd = from;
  for (const [s, e] of spans) {
    const s2 = Math.max(s, curEnd);
    if (e > s2) {
      sum += e - s2;
      curEnd = e;
    }
  }
  return sum / (to - from);
}

/** Splits `text` into sentences (cheap, language-agnostic). */
export function splitSentences(text: string): string[] {
  const parts = text.replace(/\s+/g, ' ').trim().match(/[^.!?…。！？]+[.!?…。！？]*\s*/g) ?? [];
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** Spreads sentences over [start, end) proportionally to their length (a transcript without timestamps). */
export function spreadSentences(sentences: readonly string[], start: number, end: number): { start: number; end: number; text: string }[] {
  const total = sentences.reduce((a, s) => a + s.length, 0);
  if (total === 0 || end <= start) return [];
  const out: { start: number; end: number; text: string }[] = [];
  let t = start;
  for (const s of sentences) {
    const d = ((end - start) * s.length) / total;
    out.push({ start: t, end: t + d, text: s });
    t += d;
  }
  return out;
}
