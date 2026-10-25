/**
 * Source language for the local tier. Priority: (1) the user's sourceLang setting (not 'auto'); (2) the broadcaster language
 * of the Twitch channel (page hint, fetched once per channel); (3) Whisper's own detection, trusted after two consistent
 * answers in a row and cached for the session. Dependency-free apart from lang/names.
 */
import { normLang } from '../lang/names';

/** per-page hint registry: channel login -> language of the broadcast ('' = looked up, nothing usable) */
const hints = new Map<string, string>();
let lastResolved: string | undefined;

export function setBroadcasterLang(channel: string, lang: string | undefined): void {
  hints.set(channel.toLowerCase(), lang ?? '');
}
export function getBroadcasterLang(channel: string | undefined): string | undefined {
  return (channel && hints.get(channel.toLowerCase())) || undefined;
}
export function hasBroadcasterLookup(channel: string): boolean {
  return hints.has(channel.toLowerCase());
}
/** the language the engine / the local tier resolved last (read by the panel's translator-pair row) */
export function setResolvedSourceLang(lang: string | undefined): void {
  if (lang) lastResolved = lang;
}
export function getResolvedSourceLang(): string | undefined {
  return lastResolved;
}
export function resetLangHints(): void {
  hints.clear();
  lastResolved = undefined;
}

/** Twitch 'broadcastSettings.language' ("DA", "ZH_HANS", "OTHER", "ASL") -> ISO 639-1, undefined when not a spoken language */
export function twitchLangToIso(v: string | null | undefined): string | undefined {
  const u = (v ?? '').trim().toUpperCase();
  if (!u || u === 'OTHER' || u === 'ASL' || u === 'UND') return undefined;
  return normLang(u.replace('_', '-'));
}

export type LangSource = 'setting' | 'twitch' | 'engine' | 'detected' | 'none';

export interface ResolveInput {
  /** settings.sourceLang */
  setting?: string;
  /** broadcaster language of the current channel */
  broadcaster?: string;
  /** the language the engine passed in (language gate / previous result) */
  engine?: string;
}

/** consistent detections needed before a detected language is trusted */
export const DETECT_CONFIRM = 2;

export class SourceLangResolver {
  private pinned?: string;
  private streakLang?: string;
  private streak = 0;
  /** the last detection we handed back to the engine: when the engine echoes it, it is NOT an independent source */
  private lastDetected?: string;

  resolve(i: ResolveInput): { lang?: string; source: LangSource } {
    const set = normLang(i.setting);
    if (i.setting && i.setting !== 'auto' && set) return { lang: set, source: 'setting' };
    const tw = normLang(i.broadcaster);
    if (tw) return { lang: tw, source: 'twitch' };
    const eng = normLang(i.engine);
    if (eng && !(eng === this.lastDetected && eng !== this.pinned)) return { lang: eng, source: 'engine' };
    if (this.pinned) return { lang: this.pinned, source: 'detected' };
    return { source: 'none' };
  }

  /** feed a detection (only when no language was passed to the engine); returns the language to report for THIS chunk */
  observe(detected: string | undefined): string | undefined {
    const d = normLang(detected);
    if (!d) return undefined;
    this.lastDetected = d;
    if (d === this.streakLang) this.streak++;
    else {
      this.streakLang = d;
      this.streak = 1;
    }
    if (this.streak >= DETECT_CONFIRM) this.pinned = d;
    return d;
  }

  get confirmed(): string | undefined {
    return this.pinned;
  }

  reset(): void {
    this.pinned = this.streakLang = this.lastDetected = undefined;
    this.streak = 0;
  }
}
