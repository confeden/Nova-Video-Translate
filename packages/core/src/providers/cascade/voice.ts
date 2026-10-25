/** Local TTS of translated sentences + D10 fit into their slots (reuses the generic fitSegments of the Gemini provider). */
import { diag } from '../../diag';
import type { LocalTtsEngine } from '../../localtts/types';
import type { FitOptions } from '../gemini/sync';
import { normalizeLoudness, type LevelState } from './loudness';
import { layoutSequential, type LayoutOptions } from './segments';
import type { DubSegment, ProviderId } from '../types';
import { ProviderUnavailableError } from '../types';

export interface TimedText {
  start: number;
  end: number;
  src?: string;
  ru: string;
  /** confirmed class of the SOURCE speaker ('m' male, 'f' female or child); absent = unknown */
  gender?: 'm' | 'f';
}

export interface VoiceOptions {
  engine: LocalTtsEngine;
  tier: ProviderId;
  signal: AbortSignal;
  voice?: string;
  /** voice for a source speaker class (registry.voiceFor); undefined result = the engine has no such voice */
  voiceFor?: (gender: 'm' | 'f') => string | undefined;
  /** parallel synth calls (default 2) */
  concurrency?: number;
  /** wall-clock cap of ONE synth call (default 30 s); the call is aborted and a timedOut 'network' error is recorded */
  timeoutMs?: number;
  /** kept for API compatibility: the local tiers no longer use the D10 borrow/squeeze fitter */
  sync?: FitOptions;
  /** sequential layout knobs (gap, drift cap, rate cap, previous end) */
  layout?: LayoutOptions;
  /** smoothed loudness gain carried between chunks of one voice (default: one per tier+engine+voice) */
  level?: LevelState;
  /** hard end of the timeline the last sentence may borrow into (default: its own end + borrow) */
  limitEnd?: number;
}

export interface VoiceResult {
  segments: DubSegment[];
  failed: { start: number; end: number }[];
  errors: unknown[];
}

export const CASCADE_TTS_TIMEOUT_MS = 30_000;

const levels = new Map<string, LevelState>();
const levelFor = (k: string): LevelState => {
  let l = levels.get(k);
  if (!l) levels.set(k, (l = {}));
  return l;
};

interface Clip {
  samples: Int16Array;
  sampleRate: number;
  sec: number;
  f0Hz?: number;
  fb?: boolean;
}

async function synthOnce(o: VoiceOptions, text: string, targetSec: number, voice: string | undefined, srcGender?: 'm' | 'f'): Promise<Clip> {
  const ac = new AbortController();
  const onParent = (): void => ac.abort();
  o.signal.addEventListener('abort', onParent, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort();
  }, o.timeoutMs ?? CASCADE_TTS_TIMEOUT_MS);
  try {
    const r = await o.engine.synth({ text, voice, targetSec, signal: ac.signal, ...(srcGender ? { srcGender } : {}) });
    const sec = r.samples.length / r.sampleRate;
    return { samples: r.samples, sampleRate: r.sampleRate, sec, ...(r.f0Hz ? { f0Hz: r.f0Hz } : {}), ...(r.voiceFallback ? { fb: true } : {}) };
  } catch (e) {
    if (timedOut && !o.signal.aborted) throw new ProviderUnavailableError(`tts ${o.engine.id}: timeout`, o.tier, 'network', undefined, true);
    throw e;
  } finally {
    clearTimeout(timer);
    o.signal.removeEventListener('abort', onParent);
  }
}

/** Ends a sentence with punctuation so every engine prosody closes the phrase. */
export const closeSentence = (t: string): string => (/[.!?…]["')»]*$/.test(t.trim()) ? t.trim() : `${t.trim()}.`);

/**
 * Voices every sentence (time-ordered, absolute video seconds) and fits it into its slot: borrow the following silence,
 * speed up to the rate cap (1.25), and for a sentence that still overflows ask the engine once more for a faster read
 * (targetSec = the room it has). Sentences that cannot be voiced come back in `failed`; nothing is dropped silently.
 */
export async function voiceSegments(items: readonly TimedText[], o: VoiceOptions): Promise<VoiceResult> {
  const t0 = Date.now();
  const clips: (Clip | undefined)[] = new Array(items.length);
  const errors: unknown[] = [];
  let next = 0;
  let stop = false;
  const fatal = (e: unknown): boolean => e instanceof ProviderUnavailableError && (e.kind === 'quota' || e.kind === 'auth');
  // voices are fixed up front in sentence order, so a voice change can only follow a change of the source speaker class
  const picks = items.map((it) => {
    // an unclassified phrase takes the (calibrated) MALE voice: the safe default, never the high female one (v0.2.45)
    const g = it.gender ?? 'm';
    const v = o.voiceFor ? o.voiceFor(g) : undefined;
    return v ? { voice: v, gender: g } : { voice: o.voice, gender: undefined };
  });
  const worker = async (): Promise<void> => {
    while (!stop) {
      const i = next++;
      const it = items[i];
      if (!it) return;
      try {
        const slot = Math.max(0.5, it.end - it.start);
        const room = items[i + 1] ? items[i + 1]!.start - it.start - 0.15 : slot;
        clips[i] = await synthOnce(o, closeSentence(it.ru), Math.min(slot + 1.5, Math.max(slot, room)), picks[i]!.voice, picks[i]!.gender);
      } catch (e) {
        if (o.signal.aborted) throw e;
        errors.push(e);
        if (fatal(e)) stop = true;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(o.concurrency ?? 2, items.length)) }, worker));

  // loudness leveling (same smoothed gain for all segments of a voice => no jumps between sentences / chunks)
  const level = o.level ?? levelFor(`${o.tier}|${o.engine.id}|${o.voice ?? ''}`);
  const lv = { n: 0, gain: 0, pb: 0, pa: 0, ra: 0 };
  clips.forEach((c, i) => {
    if (!c || c.samples.length === 0) return;
    const r = normalizeLoudness(c.samples, level);
    clips[i] = { ...c, samples: r.samples };
    lv.n++;
    lv.gain += r.stats.gain;
    lv.pb = Math.max(lv.pb, r.stats.peakBefore);
    lv.pa = Math.max(lv.pa, r.stats.peakAfter);
    lv.ra += r.stats.rmsAfter;
  });

  // shift, never cut: ordered placement (missing clips keep their source slot as the reference but take no room)
  const voiced = items.map((it, i) => ({ it, i, c: clips[i] })).filter((x) => x.c && x.c.samples.length > 0);
  const places = layoutSequential(
    voiced.map((x) => ({ start: x.it.start, end: x.it.end, sec: x.c!.samples.length / x.c!.sampleRate })),
    o.layout,
  );
  const placeOf = new Map<number, (typeof places)[number]>();
  voiced.forEach((x, k) => placeOf.set(x.i, places[k]!));
  const maxDrift = places.reduce((m, p) => Math.max(m, p.drift), 0);

  const segments: DubSegment[] = [];
  const failed: { start: number; end: number }[] = [];
  items.forEach((it, i) => {
    const c = clips[i];
    const f = placeOf.get(i);
    if (!c || !f || c.samples.length === 0) {
      failed.push({ start: it.start, end: it.end });
      return;
    }
    segments.push({
      start: f.start,
      end: f.end,
      audio: { kind: 'pcm', sampleRate: c.sampleRate, samples: c.samples },
      src: it.src,
      text: it.ru,
      rate: f.rate,
    });
  });
  const f0s = clips.flatMap((c) => (c?.f0Hz ? [c.f0Hz] : [])).sort((a, b) => a - b);
  diag.log(`${o.tier}-tts-ok`, {
    engine: o.engine.id,
    n: items.length,
    voiced: segments.length,
    failed: failed.length,
    redo: 0,
    drift: Math.round(maxDrift * 100) / 100,
    rateMax: Math.round(places.reduce((m, p) => Math.max(m, p.rate), 1) * 100) / 100,
    gain: lv.n ? Math.round((lv.gain / lv.n) * 100) / 100 : 0,
    peak: [Math.round(lv.pb * 100) / 100, Math.round(lv.pa * 100) / 100],
    rms: lv.n ? Math.round((lv.ra / lv.n) * 1000) / 1000 : 0,
    ...(f0s.length ? { f0: f0s[f0s.length >> 1], f0Max: f0s[f0s.length - 1], f0n: f0s.length, voiceFb: clips.filter((c) => c?.fb).length } : {}),
    ttsSec: Math.round(clips.reduce((a, c) => a + (c?.sec ?? 0), 0) * 10) / 10,
    ms: Date.now() - t0,
  });
  return { segments, failed, errors };
}
