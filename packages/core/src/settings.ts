import { isWhisperModelId } from './localasr/whisperModels';
import { LOCAL_TTS_ENGINES, hasVoice, isLocalTtsEngineId, type LocalTtsChoice } from './localtts/catalog';
import type { ProviderId } from './providers/types';
import { normalizeSubStyle } from './ui/subtitleStyle';
import { DEFAULT_SETTINGS, type Settings } from './types';

const IDS: ProviderId[] = ['yandex-live', 'yandex', 'groq', 'local', 'gemini'];
/** the voice-source defaults before D30 (what a user who never touched the list has stored) */
const LEGACY_ORDER: ProviderId[] = ['yandex-live', 'yandex', 'gemini'];
/** the D30 default (Groq before the on-device tier): an untouched profile moves to the Chrome-AI-first default, Groq stays the fallback */
const GROQ_FIRST_ORDER: ProviderId[] = ['yandex-live', 'yandex', 'groq', 'local', 'gemini'];

/**
 * Stored order -> current order. Unknown ids are dropped; ids missing from the stored list are inserted before 'gemini'
 * (D30: Gemini stays last) in the default sequence, or appended when Gemini is absent.
 */
export function migrateVoiceOrder(stored: unknown): ProviderId[] {
  const order = Array.isArray(stored) ? [...new Set((stored as unknown[]).filter((x): x is ProviderId => IDS.includes(x as ProviderId)))] : [];
  for (const id of DEFAULT_SETTINGS.voiceOrder) {
    if (order.includes(id)) continue;
    const g = order.indexOf('gemini');
    if (g >= 0 && id !== 'gemini') order.splice(g, 0, id);
    else order.push(id);
  }
  return order;
}

const num = (v: unknown, def: number, lo: number, hi: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def;
const str = (v: unknown, def = ''): string => (typeof v === 'string' ? v : def);

/** Merges stored data over the defaults and repairs anything malformed. Unknown / retired fields (old voice options, D20) are dropped. */
/** Lower-case hostname without a leading 'www.' (exact-domain match key for the per-site auto-translate exclusion). */
export function normHost(h: unknown): string {
  return typeof h === 'string' ? h.trim().toLowerCase().replace(/^www\./, '') : '';
}

/** True when auto-translate is switched off for the current page's domain (other sites are unaffected). */
export function isAutoExcluded(s: Pick<Settings, 'autoTranslateExcluded'> | undefined, host?: string): boolean {
  const h = normHost(host ?? (typeof location !== 'undefined' ? location.hostname : ''));
  return !!h && !!s?.autoTranslateExcluded?.includes(h);
}

export function normalizeSettings(raw: unknown): Settings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const storedOrder = Array.isArray(r.voiceOrder) ? (r.voiceOrder as unknown[]).filter((x): x is ProviderId => IDS.includes(x as ProviderId)) : [];
  const voiceOrder = GROQ_FIRST_ORDER.length === storedOrder.length && GROQ_FIRST_ORDER.every((id, i) => storedOrder[i] === id) ? [...DEFAULT_SETTINGS.voiceOrder] : migrateVoiceOrder(r.voiceOrder);
  const en = (r.voiceEnabled && typeof r.voiceEnabled === 'object' ? r.voiceEnabled : {}) as Record<string, unknown>;
  const voiceEnabled: Partial<Record<ProviderId, boolean>> = { ...DEFAULT_SETTINGS.voiceEnabled };
  // a pre-D30 profile (neither new id stored): Gemini used to be on by default
  const legacy = storedOrder.length > 0 && !storedOrder.includes('groq') && !storedOrder.includes('local');
  if (legacy) voiceEnabled.gemini = true;
  for (const id of IDS) if (typeof en[id] === 'boolean') voiceEnabled[id] = en[id] as boolean;
  // ...and a profile that still holds the old untouched defaults (old order, all three on) moves to the new defaults: Gemini off
  if (legacy && storedOrder.length === LEGACY_ORDER.length && LEGACY_ORDER.every((id, i) => storedOrder[i] === id) && LEGACY_ORDER.every((id) => en[id] !== false)) {
    voiceEnabled.gemini = false;
  }
  const gm = (r.geminiModels && typeof r.geminiModels === 'object' ? r.geminiModels : {}) as Record<string, unknown>;
  const gq = (r.groqModels && typeof r.groqModels === 'object' ? r.groqModels : {}) as Record<string, unknown>;
  const ltEngine: LocalTtsChoice = isLocalTtsEngineId(r.localTtsEngine) ? r.localTtsEngine : 'auto';
  const ltVoiceRaw = str(r.localTtsVoice).trim();
  // a voice must belong to the chosen engine; with 'auto' any plausible voice id is kept (it applies to whichever engine is picked)
  const ltVoice = /^[\w.-]{1,40}$/.test(ltVoiceRaw) && (ltEngine === 'auto' || hasVoice(ltEngine, ltVoiceRaw)) ? ltVoiceRaw : '';
  // per-gender voices (v0.2.45): 'auto' = calibrated; a stored single localTtsVoice migrates into the slot of its gender
  const voiceGender = (v: string): 'm' | 'f' | undefined => LOCAL_TTS_ENGINES.flatMap((e) => e.voices).find((x) => x.id === v)?.gender;
  const slot = (raw: unknown, want: 'm' | 'f'): string => {
    const v = str(raw).trim();
    if (!/^[\w.-]{1,40}$/.test(v) || v === 'auto') return 'auto';
    if (ltEngine !== 'auto' && !hasVoice(ltEngine, v)) return 'auto';
    const g = voiceGender(v);
    return g === want ? v : 'auto';
  };
  const noSlots = r.localTtsVoiceMale === undefined && r.localTtsVoiceFemale === undefined;
  const legacyG = voiceGender(ltVoice);
  const ltMale = slot(noSlots && legacyG === 'm' ? ltVoice : r.localTtsVoiceMale, 'm');
  const ltFemale = slot(noSlots && legacyG === 'f' ? ltVoice : r.localTtsVoiceFemale, 'f');
  return {
    targetLang: 'ru',
    originalVolume: num(r.originalVolume, DEFAULT_SETTINGS.originalVolume, 0, 1),
    translationVolume: num(r.translationVolume, DEFAULT_SETTINGS.translationVolume, 0, 1),
    subtitles: r.subtitles === 'on' ? 'on' : 'off',
    subtitleLang: r.subtitleLang === 'translation' ? 'translation' : 'original',
    subStyle: normalizeSubStyle(r.subStyle),
    voiceOrder,
    voiceEnabled,
    geminiKeys: Array.isArray(r.geminiKeys) ? [...new Set((r.geminiKeys as unknown[]).filter((k): k is string => typeof k === 'string').map((k) => k.trim()).filter(Boolean))] : [],
    geminiModels: { translate: str(gm.translate), tts: str(gm.tts), live: str(gm.live) },
    groqModels: { asr: str(gq.asr).trim(), chat: str(gq.chat).trim() },
    groqApiKey: str(r.groqApiKey).trim(),
    autoTranslate: r.autoTranslate === 'off' ? 'off' : r.autoTranslate === 'on' ? 'on' : DEFAULT_SETTINGS.autoTranslate,
    autoTranslateExcluded: Array.isArray(r.autoTranslateExcluded) ? [...new Set((r.autoTranslateExcluded as unknown[]).filter((k): k is string => typeof k === 'string').map(normHost).filter(Boolean))] : [],
    clickAction: r.clickAction === 'toggle' ? 'toggle' : 'settings',
    prerollPause: r.prerollPause === 'on' ? 'on' : 'off',
    liveDelaySec: Math.round(num(r.liveDelaySec, DEFAULT_SETTINGS.liveDelaySec, -1, 60)),
    liveMode: r.liveMode === 'quality' ? 'quality' : 'fast',
    liveAsr: r.liveAsr === 'local' || r.liveAsr === 'groq' ? r.liveAsr : 'auto',
    dubLagSec: num(r.dubLagSec, DEFAULT_SETTINGS.dubLagSec, 0, 6),
    skipRussian: r.skipRussian === 'off' ? 'off' : 'on',
    preferNativeDub: typeof r.preferNativeDub === 'boolean' ? r.preferNativeDub : DEFAULT_SETTINGS.preferNativeDub,
    holdCellsToEnd: typeof r.holdCellsToEnd === 'boolean' ? r.holdCellsToEnd : DEFAULT_SETTINGS.holdCellsToEnd,
    sourceLang: typeof r.sourceLang === 'string' && /^[a-z]{2,3}$/i.test(r.sourceLang.trim()) ? r.sourceLang.trim().toLowerCase() : 'auto',
    chunkSec: num(r.chunkSec, DEFAULT_SETTINGS.chunkSec, 5, 60),
    cacheEnabled: typeof r.cacheEnabled === 'boolean' ? r.cacheEnabled : DEFAULT_SETTINGS.cacheEnabled,
    cacheDays: Math.round(num(r.cacheDays, DEFAULT_SETTINGS.cacheDays, 1, 30)),
    cacheMaxMB: Math.round(num(r.cacheMaxMB, DEFAULT_SETTINGS.cacheMaxMB, 10, 5000)),
    localTtsEngine: ltEngine,
    localTtsVoice: ltVoice,
    localTtsVoiceMale: ltMale,
    localTtsVoiceFemale: ltFemale,
    localAsrModel: isWhisperModelId(r.localAsrModel) ? r.localAsrModel : 'auto',
    cacheProviders: Array.isArray(r.cacheProviders)
      ? [...new Set([...(r.cacheProviders as unknown[]).filter((x): x is ProviderId => IDS.includes(x as ProviderId)), ...(legacy ? (['groq', 'local'] as ProviderId[]) : [])])]
      : [...DEFAULT_SETTINGS.cacheProviders],
  };
}

/** Hosts where only the local tier chain is used (D29/D30: cloud tiers are not requested there). */
const LOCAL_ONLY_HOSTS = ['twitch.tv'];

/** True when `host` is `domain` or a subdomain of it (`www.` ignored). */
function hostIs(host: string, domain: string): boolean {
  return host === domain || host.endsWith('.' + domain);
}

/** Per-site voiceEnabled override, or undefined when the host has none. Twitch: local tier only. */
export function siteVoiceOverride(host: unknown): Partial<Record<ProviderId, boolean>> | undefined {
  const h = normHost(host);
  if (!h || !LOCAL_ONLY_HOSTS.some((d) => hostIs(h, d))) return undefined;
  return { 'yandex-live': false, yandex: false, groq: false, gemini: false, local: true };
}

/** Per-video override for a LIVE stream on any site: Yandex does not translate live streams, cloud tiers are not requested; local tier only. */
export function liveVideoVoiceOverride(hasLocal = true): Partial<Record<ProviderId, boolean>> {
  // no local provider on this host (userscript): the cloud tiers are the only ones there are, so they stay as the user set them
  if (!hasLocal) return {};
  return { 'yandex-live': false, yandex: false, groq: false, gemini: false, local: true };
}

/** Settings as the engine must see them on this host / video (voiceEnabled replaced by the site override, or the live-video one). */
export function withSiteOverride(s: Settings, host: unknown, liveVideo = false, hasLocal = true): Settings {
  // experimental 'quality' live mode: a LIVE video is not restricted to the local tier (also on Twitch); Yandex tiers as the user set them
  if (liveVideo && s.liveMode === 'quality') return liveQualitySettings(s);
  const o = siteVoiceOverride(host) ?? (liveVideo ? liveVideoVoiceOverride(hasLocal) : undefined);
  return o ? { ...s, voiceEnabled: { ...s.voiceEnabled, ...o } } : s;
}

/** the tier chain of a live video in 'quality' mode: yandex-live > yandex > local (the safety net is always on); Groq / Gemini off */
export const LIVE_QUALITY_ORDER: ProviderId[] = ['yandex-live', 'yandex', 'local'];
export function liveQualitySettings(s: Settings): Settings {
  const en = s.voiceEnabled;
  return {
    ...s,
    voiceOrder: [...LIVE_QUALITY_ORDER, ...s.voiceOrder.filter((id) => !LIVE_QUALITY_ORDER.includes(id))],
    voiceEnabled: { ...en, 'yandex-live': en['yandex-live'] !== false, yandex: en.yandex !== false, local: true, groq: false, gemini: false },
  };
}
