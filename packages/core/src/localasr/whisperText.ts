import { analyzeSpeech, placeSentences } from './speechPlacement';
import type { LocalAsrSegment } from './types';

/** below this RMS (0..1 float) a chunk is silence: Whisper would hallucinate caption-credit phrases on it */
export const SILENCE_RMS = 0.003;

export function rmsInt16(pcm: Int16Array): number {
  if (pcm.length === 0) return 0;
  let s = 0;
  for (let i = 0; i < pcm.length; i++) s += pcm[i]! * pcm[i]!;
  return Math.sqrt(s / pcm.length) / 32768;
}

/** RMS and peak (both 0..1) of an Int16 clip, for diagnostics */
export function pcmStats(pcm: Int16Array): { rms: number; peak: number } {
  let pk = 0;
  for (let i = 0; i < pcm.length; i++) {
    const a = Math.abs(pcm[i]!);
    if (a > pk) pk = a;
  }
  return { rms: rmsInt16(pcm), peak: pk / 32768 };
}

/** true when the pipeline output carries no text at all (empty string, no non-blank chunk) */
export function isEmptyWhisperOutput(out: WhisperPipelineOutput | undefined): boolean {
  if ((out?.text ?? '').trim()) return false;
  return !(out?.chunks ?? []).some((c) => (c.text ?? '').trim());
}

/**
 * A transcript without timestamps -> sentence segments. With the clip's `pcm` (16 kHz) the sentences are placed inside the
 * measured speech span (first onset .. last offset, boundaries snapped to silence valleys, see speechPlacement.ts); without it
 * they are spread over [0, durationSec] in proportion to their length. Either way the timing is an estimate, but the PCM
 * version cannot put a sentence before the speech starts (a dub that leads the original).
 */
export function splitPlainTranscript(text: string, durationSec: number, pcm?: Int16Array, sampleRate = 16000): LocalAsrSegment[] {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return [];
  const parts = t.split(/(?<=[.!?…])\s+/).filter(Boolean);
  if (pcm && pcm.length > 0) {
    return placeSentences(parts, durationSec, analyzeSpeech(pcm, sampleRate)).map((p) => ({ start: p.start, end: p.end, text: p.text }));
  }
  const total = parts.reduce((n, p) => n + p.length, 0) || 1;
  const out: LocalAsrSegment[] = [];
  let at = 0;
  for (const p of parts) {
    const end = at + (durationSec * p.length) / total;
    out.push({ start: at, end, text: p });
    at = end;
  }
  return out;
}

export interface WhisperPipelineOutput {
  text?: string;
  chunks?: Array<{ text?: string; timestamp?: [number | null, number | null] | null }>;
}

const BRACKETED = /^\s*[[(♪*].*[\])♪*]\s*$/;

/**
 * pipeline output (return_timestamps: true) -> LocalAsrSegments for an audio of `durationSec`: open-ended last timestamps are
 * closed at the clip end, bracketed non-speech marks ([BLANK_AUDIO], (music)) are dropped, a phrase looping 3+ times in a row
 * (a classic Whisper failure) is kept once, and a transcript without timestamps is split into sentences spread over the whole clip.
 */
export function whisperToSegments(out: WhisperPipelineOutput | undefined, durationSec: number, pcm?: Int16Array): LocalAsrSegment[] {
  const raw: LocalAsrSegment[] = [];
  const chunks = out?.chunks ?? [];
  if (chunks.length > 0) {
    for (const c of chunks) {
      const text = (c.text ?? '').replace(/\s+/g, ' ').trim();
      const s = c.timestamp?.[0];
      const e = c.timestamp?.[1];
      const start = typeof s === 'number' && Number.isFinite(s) ? Math.max(0, s) : raw.length ? raw[raw.length - 1]!.end : 0;
      const end = typeof e === 'number' && Number.isFinite(e) ? e : durationSec;
      raw.push({ start, end: Math.max(end, start), text });
    }
  } else {
    raw.push(...splitPlainTranscript(out?.text ?? '', durationSec, pcm));
  }
  const kept = raw.filter((s) => s.text && !BRACKETED.test(s.text));
  const res: LocalAsrSegment[] = [];
  let run = 0;
  for (const s of kept) {
    const prev = res[res.length - 1];
    if (prev && prev.text.toLowerCase() === s.text.toLowerCase()) {
      run++;
      if (run >= 2) {
        prev.end = Math.max(prev.end, s.end); // 3rd+ repeat: absorbed into the first
        continue;
      }
    } else run = 0;
    res.push({ ...s });
  }
  return res;
}
