import type { SubtitleCue } from '../providers/types';
import { dropRepeatedHead, normalizeCues } from './cues';

function asObject(input: string | unknown): unknown {
  if (typeof input !== 'string') return input;
  try {
    return JSON.parse(input);
  } catch {
    return undefined;
  }
}

/** YouTube `fmt=json3` timedtext: { events: [{ tStartMs, dDurationMs, segs: [{ utf8 }] }] }. */
export function parseJson3(input: string | unknown): SubtitleCue[] {
  const events = (asObject(input) as { events?: unknown } | undefined)?.events;
  if (!Array.isArray(events)) return [];
  type Ev = { tStartMs?: number; dDurationMs?: number; segs?: { utf8?: string }[] };
  const list = (events as Ev[]).filter((e) => typeof e.tStartMs === 'number' && Array.isArray(e.segs) && e.segs.length > 0);
  const raw: SubtitleCue[] = [];
  let prevText = '';
  for (let i = 0; i < list.length; i++) {
    const e = list[i]!;
    const full = e.segs!.map((s) => s.utf8 ?? '').join('').replace(/\n/g, ' ');
    if (!full.trim()) continue;
    // rolling lines repeat the previous line's tail: keep only the new words so a phrase is not doubled
    const text = dropRepeatedHead(prevText, full);
    prevText = full;
    if (!text) continue;
    const start = e.tStartMs! / 1000;
    let end = start + (e.dDurationMs ?? 0) / 1000;
    // auto-generated tracks overlap rolling lines: end a cue where the next one starts
    const next = list[i + 1];
    if (next && next.tStartMs! / 1000 < end) end = Math.max(start + 0.4, next.tStartMs! / 1000);
    raw.push({ start, end, text });
  }
  return normalizeCues(raw);
}

/** Yandex subtitle JSON (VOT: { subtitles: [{ text, startMs, durationMs, speakerId, tokens }] }). */
export function parseYandexSubtitles(input: string | unknown): SubtitleCue[] {
  const o = asObject(input);
  const list = Array.isArray(o) ? o : (o as { subtitles?: unknown } | undefined)?.subtitles;
  if (!Array.isArray(list)) return [];
  const raw: SubtitleCue[] = [];
  for (const it of list as { text?: string; startMs?: number; durationMs?: number }[]) {
    if (typeof it?.text !== 'string' || typeof it.startMs !== 'number') continue;
    const start = it.startMs / 1000;
    raw.push({ start, end: start + Math.max(0.4, (it.durationMs ?? 0) / 1000), text: it.text });
  }
  return normalizeCues(raw);
}
