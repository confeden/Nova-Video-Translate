import { dropWeakSegments } from '../../localasr/asrText';
import { vadBursts } from '../../localasr/vad';
import { resampleInt16 } from '../gemini/translate';
import type { AudioChunk } from '../types';
import type { SourceSegment } from './segments';

const norm = (w: string): string => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');

/** a phrase of 3+ words said twice inside one segment ("I'm going to go. The I'm going to go to ...") is a looping model: the first copy goes */
export function collapseRepeats(text: string): string {
  const w = text.split(/\s+/).filter(Boolean);
  const n = w.map(norm);
  for (let len = Math.min(8, Math.floor(w.length / 2)); len >= 3; len--) {
    for (let i = 0; i + 2 * len <= w.length; i++) {
      for (let j = i + len; j + len <= w.length; j++) {
        let same = true;
        for (let k = 0; k < len && same; k++) same = n[i + k] === n[j + k] && n[i + k] !== '';
        if (same) return [...w.slice(0, i), ...w.slice(j)].join(' ');
      }
    }
  }
  return text;
}

/**
 * Speech recognisers invent text over silence and music. Every ASR segment is checked against the voice activity of the audio
 * itself (a text with more words than the speech in its span can hold is dropped) and a looping phrase inside it is collapsed.
 * Fails open: when the VAD cannot run, the segments are returned unchanged.
 */
export function guardAsrSegments(segs: SourceSegment[], chunk: AudioChunk): SourceSegment[] {
  if (segs.length === 0) return segs;
  const cleaned = segs.map((s) => ({ ...s, text: collapseRepeats(s.text) }));
  try {
    const v = vadBursts(resampleInt16(chunk.pcm, chunk.sampleRate, 16000), 16000);
    const bursts = v.bursts.map((b) => ({ start: chunk.startSec + b.start, end: chunk.startSec + b.end }));
    return dropWeakSegments(cleaned, bursts);
  } catch {
    return cleaned;
  }
}
