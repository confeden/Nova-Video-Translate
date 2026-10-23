/** D10 sync policy as a pure function. Segment starts never move; times are in seconds. */

export interface SyncInput {
  start: number;
  end: number;
  ttsSeconds: number;
  text: string;
}

export interface FitOptions {
  /** max playback speed-up, default 1.25 */
  maxRate?: number;
  /** silence kept before the next segment, default 0.05 */
  minGap?: number;
  /** max seconds borrowed from following silence, default 1.5 */
  maxBorrow?: number;
  /** true: overflow asks for text re-shortening; false: asks for video slow-down, default true */
  allowReshorten?: boolean;
  /** hard end of the chunk / timeline (last segment cannot borrow past it), default Infinity */
  limitEnd?: number;
  /** video playback rate suggested when needsVideoSlowdown, default 0.9 */
  slowdownRate?: number;
}

export interface FitResult {
  start: number;
  /** slot end = max(original end, start + playback duration) */
  end: number;
  /** playback-rate hint, >= 1 */
  rate: number;
  /** seconds borrowed from following silence */
  borrowed: number;
  /** playback runs past the available room even at maxRate (overlaps the next segment) */
  overflow: number;
  needsReshorten: boolean;
  needsVideoSlowdown: boolean;
  videoRate?: number;
}

const EPS = 1e-9;

/** Order: (1) borrow following silence, (2) speed up to maxRate, (3) flag. Never drops a segment. */
export function fitSegments(segments: SyncInput[], opts: FitOptions = {}): FitResult[] {
  const maxRate = opts.maxRate ?? 1.25;
  const minGap = opts.minGap ?? 0.05;
  const maxBorrow = opts.maxBorrow ?? 1.5;
  const allowReshorten = opts.allowReshorten ?? true;
  const limitEnd = opts.limitEnd ?? Number.POSITIVE_INFINITY;
  const slowdownRate = opts.slowdownRate ?? 0.9;

  return segments.map((seg, i) => {
    const slot = Math.max(0, seg.end - seg.start);
    const nextStart = segments[i + 1]?.start ?? limitEnd;
    const room = Math.max(0, nextStart - minGap - seg.end); // silence after the slot
    const wanted = Math.max(0, seg.ttsSeconds - slot);
    const borrowed = Math.min(wanted, maxBorrow, room);
    const eff = slot + borrowed;

    let rate = 1;
    let needsReshorten = false;
    let needsVideoSlowdown = false;
    if (seg.ttsSeconds > eff + EPS) {
      const need = eff > EPS ? seg.ttsSeconds / eff : Number.POSITIVE_INFINITY;
      if (need <= maxRate + EPS) {
        rate = Math.max(1, need);
      } else {
        rate = maxRate;
        if (allowReshorten) needsReshorten = true;
        else needsVideoSlowdown = true;
      }
    }
    const playDur = seg.ttsSeconds / rate;
    const overflow = Math.max(0, playDur - eff);
    const result: FitResult = {
      start: seg.start,
      end: Math.max(seg.end, seg.start + playDur),
      rate,
      borrowed,
      overflow: overflow < 1e-6 ? 0 : overflow,
      needsReshorten,
      needsVideoSlowdown,
    };
    if (needsVideoSlowdown) result.videoRate = slowdownRate;
    return result;
  });
}
