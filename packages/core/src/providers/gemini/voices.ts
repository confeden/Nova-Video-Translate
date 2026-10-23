/** Speaker-aware voice choice for Gemini TTS (prebuilt voices + gender/hysteresis rules). */

export type VoiceGender = 'male' | 'female';
export type SpeakerGender = 'male' | 'female' | 'child' | 'unknown';

/** All 30 Gemini prebuilt TTS voices with their known gender. */
export const GEMINI_VOICE_GENDER: Readonly<Record<string, VoiceGender>> = {
  Zephyr: 'female',
  Kore: 'female',
  Leda: 'female',
  Aoede: 'female',
  Callirrhoe: 'female',
  Autonoe: 'female',
  Despina: 'female',
  Erinome: 'female',
  Laomedeia: 'female',
  Achernar: 'female',
  Gacrux: 'female',
  Pulcherrima: 'female',
  Vindemiatrix: 'female',
  Sulafat: 'female',
  Puck: 'male',
  Charon: 'male',
  Fenrir: 'male',
  Orus: 'male',
  Enceladus: 'male',
  Iapetus: 'male',
  Umbriel: 'male',
  Algieba: 'male',
  Algenib: 'male',
  Rasalgethi: 'male',
  Alnilam: 'male',
  Schedar: 'male',
  Achird: 'male',
  Zubenelgenubi: 'male',
  Sadachbia: 'male',
  Sadaltager: 'male',
};

export const GEMINI_VOICE_NAMES: readonly string[] = Object.keys(GEMINI_VOICE_GENDER);

export const DEFAULT_MALE_VOICE = 'Orus';
export const DEFAULT_FEMALE_VOICE = 'Kore';

export interface VoiceMap {
  male: string;
  female: string;
  child?: string;
  /** used when nothing is known about the speaker; default = male/female default below */
  fallback?: string;
}

export const DEFAULT_VOICES: VoiceMap = { male: DEFAULT_MALE_VOICE, female: DEFAULT_FEMALE_VOICE };

/** Voice profile kind steering the TTS instruction line. */
export type ProfileKind = 'male' | 'female' | 'child';

export interface VoiceChoice {
  voice: string;
  profile: ProfileKind;
}

export interface VoiceInput {
  start: number;
  end: number;
  speaker?: string;
  gender?: SpeakerGender;
}

/** Slots shorter than this never change the voice (short interjections inherit a neighbour). */
export const MIN_VOICE_SWITCH_SEC = 1.2;

/**
 * Picks a voice per segment of one chunk.
 * - unknown gender: previous segment's voice, else the provider default (`fallback`, else male);
 * - child: configured child voice, else female;
 * - interjections (< 1.2 s) inherit the previous segment (or the next one when first);
 * - hysteresis: a gender change needs 2 consecutive agreeing segments, unless the speaker id changed.
 */
export function assignVoices(segs: VoiceInput[], voices: Partial<VoiceMap> = {}): VoiceChoice[] {
  const map: VoiceMap = { ...DEFAULT_VOICES, ...stripUndefined(voices) };
  const kindOf = (g: SpeakerGender | undefined): ProfileKind | undefined =>
    g === 'male' || g === 'female' ? g : g === 'child' ? (map.child ? 'child' : 'female') : undefined;
  const toChoice = (k: ProfileKind): VoiceChoice => ({ voice: k === 'child' ? (map.child ?? map.female) : map[k], profile: k });

  const kinds = segs.map((s) => kindOf(s.gender));
  const out: VoiceChoice[] = [];
  let cur: ProfileKind | undefined;
  let prevSpeaker: string | undefined;
  const fallbackChoice = (): VoiceChoice => {
    if (map.fallback !== undefined) {
      const g = GEMINI_VOICE_GENDER[map.fallback];
      return { voice: map.fallback, profile: g ?? 'male' };
    }
    return toChoice('male');
  };

  for (let i = 0; i < segs.length; i++) {
    const s = segs[i] as VoiceInput;
    const k = kinds[i];
    const short = s.end - s.start < MIN_VOICE_SWITCH_SEC;
    const speakerChanged = !!s.speaker && !!prevSpeaker && s.speaker !== prevSpeaker;
    if (s.speaker) prevSpeaker = s.speaker;

    if (cur === undefined) {
      // first segment of the chunk: take it (or the first informative neighbour for interjections)
      let first = k;
      if (first === undefined || short) first = kinds.slice(i).find((x) => x !== undefined) ?? k;
      if (first === undefined) {
        out.push(fallbackChoice());
        continue;
      }
      cur = first;
    } else if (k !== undefined && k !== cur && !short) {
      const next = kinds[i + 1];
      if (speakerChanged || next === k) cur = k;
    }
    out.push(toChoice(cur));
  }
  return out;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

// ---------------------------------------------------------------------------------------------------------------
// Automatic voice choice (D20): gender from the translate step + pitch class from the ORIGINAL speech (f0), sticky
// per video through a caller-persistable `VoiceMemory`.
// ---------------------------------------------------------------------------------------------------------------

export type PitchClass = 'low' | 'mid' | 'high';

/**
 * Voices per gender and pitch class, first entry preferred. Ordered by MEASURED median f0 (gemini-3.1-flash-tts-preview,
 * one Russian sentence per voice, research verification 2026-10-21; Orus/Kore averaged over 3-4 calls):
 * - male: Charon 128, Alnilam 139, Puck 139, Orus 159, Fenrir 199 Hz (Fenrir is in the female f0 range: last resort);
 * - female: Gacrux 151, Sulafat 185, Leda 185, Kore 187, Zephyr 206, Despina 205 Hz.
 * Voices that were not measured keep their Google descriptor position (Algenib gravelly, Iapetus clear).
 */
export const VOICE_TABLE: Readonly<Record<VoiceGender, Readonly<Record<PitchClass, readonly string[]>>>> = {
  male: { low: ['Charon', 'Alnilam', 'Algenib'], mid: ['Orus', 'Puck', 'Iapetus'], high: ['Fenrir', 'Puck'] },
  female: { low: ['Gacrux', 'Sulafat'], mid: ['Kore', 'Leda', 'Sulafat'], high: ['Zephyr', 'Despina'] },
};

/**
 * D27 (temporary, owner-approved): while Gemini is only the bridge until Yandex is ready, EVERY segment is voiced by this one
 * plain male voice and the gender / f0 / pitch-class detection and voice-consistency logic is skipped (single translate +
 * TTS, fastest path). Set GEMINI_FIXED_VOICE to false to bring the automatic choice (D20) back; it returns later as an improvement.
 */
export const GEMINI_FIXED_VOICE = true;
export const GEMINI_FIXED_VOICE_NAME: string = VOICE_TABLE.male.mid[0]!;

/** f0 boundaries in Hz: [low|mid, mid|high]. Typical adult male 85-155 Hz, female 165-255 Hz. */
export const PITCH_BOUNDS: Readonly<Record<VoiceGender, readonly [number, number]>> = {
  male: [105, 135],
  female: [180, 225],
};
/** A class is kept while f0 stays within this many Hz beyond its boundary. */
export const PITCH_HYSTERESIS_HZ = 8;
/** Two f0 measurements within this log-ratio (~22%) are the same speaker. */
const SAME_SPEAKER_LOG = 0.2;
const MAX_CENTROIDS = 4;
const CHILD_VOICE = 'Leda';

export function classifyPitch(gender: VoiceGender, f0: number, prev?: PitchClass): PitchClass {
  const [a, b] = PITCH_BOUNDS[gender];
  const h = PITCH_HYSTERESIS_HZ;
  if (prev === 'low' && f0 < a + h) return 'low';
  if (prev === 'high' && f0 > b - h) return 'high';
  if (prev === 'mid' && f0 >= a - h && f0 <= b + h) return 'mid';
  return f0 < a ? 'low' : f0 > b ? 'high' : 'mid';
}

export interface PitchCentroid {
  gender: VoiceGender;
  /** running mean f0, Hz */
  f0: number;
  n: number;
  cls: PitchClass;
  voice: string;
}

/**
 * Per-video sticky voice state. Plain JSON: the caller may persist it (e.g. next to the video's cache entries) and
 * pass it back through GeminiProviderOptions.voiceMemory. Mutated in place by the provider.
 */
export interface VoiceMemory {
  centroids: PitchCentroid[];
  /** gender of the most recent confident segment; resolves leading 'unknown' speakers of the next chunk */
  lastGender?: VoiceGender;
}

export function newVoiceMemory(): VoiceMemory {
  return { centroids: [] };
}

function pickFromTable(gender: VoiceGender, cls: PitchClass, memory: VoiceMemory, self?: PitchCentroid): string {
  const list = VOICE_TABLE[gender][cls];
  const used = new Set(memory.centroids.filter((c) => c !== self && c.gender === gender).map((c) => c.voice));
  return list.find((v) => !used.has(v)) ?? list[0]!;
}

/**
 * Voice for one speaker. `f0` = 0 means unknown (too little voiced audio): the most-measured centroid of that gender
 * is reused, else the mid-class default.
 */
export function resolveSpeakerVoice(
  memory: VoiceMemory,
  gender: VoiceGender,
  f0: number,
): { voice: string; cls: PitchClass; f0: number; fresh: boolean } {
  const mine = memory.centroids.filter((c) => c.gender === gender);
  memory.lastGender = gender;
  if (!(f0 > 0)) {
    const known = [...mine].sort((a, b) => b.n - a.n)[0];
    if (known) return { voice: known.voice, cls: known.cls, f0: known.f0, fresh: false };
    const cls: PitchClass = 'mid';
    const c: PitchCentroid = { gender, f0: 0, n: 0, cls, voice: pickFromTable(gender, cls, memory) };
    memory.centroids.push(c);
    return { voice: c.voice, cls, f0: 0, fresh: true };
  }
  let near: PitchCentroid | undefined;
  let bestD = Infinity;
  for (const c of mine) {
    if (c.f0 <= 0) continue;
    const d = Math.abs(Math.log(f0 / c.f0));
    if (d < bestD) (bestD = d), (near = c);
  }
  if (near && bestD <= SAME_SPEAKER_LOG) {
    near.f0 = (near.f0 * Math.min(near.n, 5) + f0) / (Math.min(near.n, 5) + 1);
    near.n++;
    const cls = classifyPitch(gender, near.f0, near.cls);
    if (cls !== near.cls) {
      near.cls = cls;
      near.voice = pickFromTable(gender, cls, memory, near);
    }
    return { voice: near.voice, cls: near.cls, f0: near.f0, fresh: false };
  }
  // a placeholder centroid (created while f0 was unknown) adopts the first real measurement
  const placeholder = mine.find((c) => c.f0 <= 0);
  if (placeholder) {
    placeholder.f0 = f0;
    placeholder.n = 1;
    placeholder.cls = classifyPitch(gender, f0);
    placeholder.voice = pickFromTable(gender, placeholder.cls, memory, placeholder);
    return { voice: placeholder.voice, cls: placeholder.cls, f0, fresh: true };
  }
  if (near && mine.length >= MAX_CENTROIDS) {
    near.n++;
    return { voice: near.voice, cls: near.cls, f0: near.f0, fresh: false };
  }
  const cls = classifyPitch(gender, f0);
  const c: PitchCentroid = { gender, f0, n: 1, cls, voice: '' };
  c.voice = pickFromTable(gender, cls, memory, c);
  memory.centroids.push(c);
  return { voice: c.voice, cls, f0, fresh: true };
}

export interface AutoVoiceResult extends VoiceChoice {
  /** measured f0 of this segment's speaker, Hz (0 = unknown) */
  f0: number;
  cls?: PitchClass;
}

/**
 * Automatic per-segment voices for one chunk. `f0Of(indexes)` measures the original speech of those segments
 * (Hz, 0 = unknown). `override` (internal / tests) bypasses pitch analysis and uses assignVoices with that map.
 */
export function chooseVoices(
  segs: VoiceInput[],
  f0Of: (indexes: number[]) => number,
  memory: VoiceMemory,
  override?: Partial<VoiceMap>,
): AutoVoiceResult[] {
  if (override && Object.values(override).some((v) => v !== undefined)) {
    return assignVoices(segs, override).map((c) => ({ ...c, f0: 0 }));
  }
  // leading speakers of unknown gender inherit the previous chunk's gender (consistency across chunks)
  const prepared = segs.map((s) => ({ ...s }));
  if (memory.lastGender) {
    for (const s of prepared) {
      if (s.gender === 'male' || s.gender === 'female' || s.gender === 'child') break;
      s.gender = memory.lastGender;
    }
  }
  const base = assignVoices(prepared);
  const groups = new Map<string, number[]>();
  base.forEach((c, i) => {
    const key = `${segs[i]?.speaker ?? ''}|${c.profile}`;
    const g = groups.get(key);
    if (g) g.push(i);
    else groups.set(key, [i]);
  });
  const out: AutoVoiceResult[] = new Array(segs.length);
  for (const [key, idx] of groups) {
    const profile = key.slice(key.lastIndexOf('|') + 1) as ProfileKind;
    if (profile === 'child') {
      for (const i of idx) out[i] = { voice: CHILD_VOICE, profile, f0: 0 };
      continue;
    }
    const f0 = f0Of(idx);
    const r = resolveSpeakerVoice(memory, profile, f0);
    for (const i of idx) out[i] = { voice: r.voice, profile, f0: r.f0, cls: r.cls };
  }
  return out;
}
