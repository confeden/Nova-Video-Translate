/** Duration fitting math for the speed parameter. Pure. */
import { FIT_TOLERANCE, SPEED_FIRST_MAX, SPEED_MAX, SPEED_MIN } from './constants';

export const clampSpeed = (v: number, max = SPEED_MAX): number => Math.min(max, Math.max(SPEED_MIN, Number.isFinite(v) ? v : 1));

const availSpeech = (gapSec: number, targetSec: number): number => Math.max(targetSec - gapSec, targetSec * 0.25);

/**
 * speed so that speech of `naturalSec` (at speed 1) plus `gapSec` of silences takes `targetSec`.
 * The speech part is never squeezed below 25% of the target (degenerate targets).
 */
export function speedForTarget(naturalSec: number, gapSec: number, targetSec: number): number {
  if (!(naturalSec > 0) || !(targetSec > 0)) return clampSpeed(1);
  return clampSpeed(naturalSec / availSpeech(gapSec, targetSec), SPEED_FIRST_MAX);
}

/** relative miss of a result vs target (+ = too long) */
export const missFraction = (actualSec: number, targetSec: number): number => (actualSec - targetSec) / targetSec;

export const missesTarget = (actualSec: number, targetSec: number): boolean => Math.abs(missFraction(actualSec, targetSec)) > FIT_TOLERANCE;

/**
 * Speed for a second pass given the first result, or null when another pass cannot help
 * (already at the clamp in the needed direction, or the correction is negligible).
 */
export function refineSpeed(speed: number, actualSec: number, gapSec: number, targetSec: number): number | null {
  const speech = actualSec - gapSec;
  if (!(speech > 0)) return null;
  const next = clampSpeed(speed * (speech / availSpeech(gapSec, targetSec)));
  return Math.abs(next - speed) < 0.02 ? null : next;
}
