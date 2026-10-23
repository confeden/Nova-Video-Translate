import type { SubtitleCue } from '../providers/types';

/**
 * Time lookup over subtitle cues. Cues are sorted by start; `at(t)` finds the last cue with start <= t by binary
 * search and, because cues may overlap (a long cue spanning a short one), walks back only while some earlier cue
 * can still be running (prefix maximum of `end`). Among overlapping cues the one that started last wins.
 */
export class CueIndex {
  private readonly cues: SubtitleCue[];
  /** maxEnd[i] = max end over cues[0..i] */
  private readonly maxEnd: number[];

  constructor(cues: readonly SubtitleCue[]) {
    this.cues = cues.filter((c) => Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start && c.text.trim()).sort((a, b) => a.start - b.start || a.end - b.end);
    this.maxEnd = [];
    let m = -Infinity;
    for (const c of this.cues) {
      m = Math.max(m, c.end);
      this.maxEnd.push(m);
    }
  }

  get size(): number {
    return this.cues.length;
  }

  /** the cue showing at media time `t` (start <= t < end), if any */
  at(t: number): SubtitleCue | undefined {
    let lo = 0;
    let hi = this.cues.length - 1;
    let idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.cues[mid]!.start <= t) {
        idx = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    for (let i = idx; i >= 0 && this.maxEnd[i]! > t; i--) {
      if (this.cues[i]!.end > t) return this.cues[i];
    }
    return undefined;
  }
}
