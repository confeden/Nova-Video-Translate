import type { AudioChunk, ChunkResult, DubSegment } from '../providers/types';

/** Silence is only a candidate: the local recognizer must find actual speech there. */
export function needsGapFill(chunk: AudioChunk, result: ChunkResult): boolean {
  if (result.sourceLang?.startsWith('ru')) return false;
  if (result.failedSegments?.length) return true;
  let end = chunk.startSec;
  for (const s of [...result.segments].sort((a, b) => a.start - b.start)) {
    if (s.start - end >= 0.8) return true;
    end = Math.max(end, s.end);
  }
  return chunk.startSec + chunk.durationSec - end >= 0.8;
}

/** Keep whole sentences only; cutting encoded audio or replaying overlapping speech is unsafe. */
export function uncoveredSpeech(existing: DubSegment[], candidates: DubSegment[]): DubSegment[] {
  const accepted: DubSegment[] = [];
  for (const s of candidates) {
    if (!(s.end > s.start)) continue;
    if ([...existing, ...accepted].some((x) => Math.min(x.end, s.end) - Math.max(x.start, s.start) > 0.12)) continue;
    accepted.push(s);
  }
  return accepted;
}
