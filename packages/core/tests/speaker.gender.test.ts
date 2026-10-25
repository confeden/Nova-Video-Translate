import { describe, expect, it } from 'vitest';
import { SpeakerTracker, classifyGender, sentencePitch, spanPitch, spectralTilt, TILT_DARK_DB } from '../src/audio/speakerGender';
import { LocalTtsRegistry } from '../src/localtts/registry';
import { CALIB_TEXT, VoicePlanner, applyCalibrationRule, calibrateVoices, mapVoice, pickCalibrated, type VoiceCalibration } from '../src/localtts/voiceMap';
import type { LocalTtsEngine, LocalTtsEngineId, LocalTtsRequest } from '../src/localtts/types';
import { voiceSegments } from '../src/providers/cascade/voice';
import { diag } from '../src/diag';

/** speech-like voiced signal: harmonics with a 1/h spectrum and a 4 Hz +-4 % vibrato (a perfectly steady tone is treated as music) */
function voiced(f0: number, sec: number, rate = 16000, tiltPow = 1): Int16Array {
  const n = Math.round(sec * rate);
  const out = new Int16Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    ph += (2 * Math.PI * f0 * (1 + 0.04 * Math.sin(2 * Math.PI * 4 * t) + 0.01 * Math.sin(2 * Math.PI * 11.3 * t))) / rate;
    let s = 0;
    for (let h = 1; h <= 10; h++) s += Math.sin(h * ph) / h ** tiltPow;
    out[i] = Math.round(s * 4000);
  }
  return out;
}

describe('source speaker f0 / gender', () => {
  it('classifies 110 Hz male, 210 Hz and 300 Hz female_or_child', () => {
    for (const [f, want] of [[110, 'male'], [210, 'female_or_child'], [300, 'female_or_child']] as const) {
      const p = spanPitch(voiced(f, 2), 16000);
      expect(Math.abs(p.f0 - f) / f).toBeLessThan(0.06);
      expect(p.voicedSec).toBeGreaterThan(1.2);
      expect(classifyGender(p.f0, p.voicedSec)).toBe(want);
    }
  });
  it('155-185 Hz and less than 1 s of voiced audio are unknown', () => {
    expect(classifyGender(160, 3)).toBe('unknown');
    expect(classifyGender(178, 4)).toBe('unknown');
    expect(classifyGender(110, 0.9)).toBe('unknown');
    expect(classifyGender(0, 3)).toBe('unknown');
    expect(classifyGender(154, 1)).toBe('male');
    expect(classifyGender(186, 1)).toBe('female_or_child');
  });
  it('spectral tilt: bright vs dark synthetic voices, monotonic in the spectral slope', () => {
    const bright = spectralTilt(voiced(200, 2, 16000, 1), 16000)!;
    const dark = spectralTilt(voiced(200, 2, 16000, 2), 16000)!;
    expect(bright).toBeGreaterThan(TILT_DARK_DB);
    expect(dark).toBeLessThan(TILT_DARK_DB);
    expect(bright - dark).toBeGreaterThan(8);
    expect(spanPitch(voiced(200, 2, 16000, 2), 16000).tilt).toBeCloseTo(dark, 0);
    expect(spectralTilt(new Int16Array(16000), 16000)).toBeUndefined();
  });
  it('high pitch + dark spectrum is not female (a man with a high voice); bright is; a very high pitch always is', () => {
    expect(classifyGender(200, 3, -9.9)).toBe('female_or_child');
    expect(classifyGender(200, 3, -21)).toBe('unknown');
    expect(classifyGender(200, 3)).toBe('female_or_child'); // no tilt: f0 alone
    expect(classifyGender(250, 3, -25)).toBe('female_or_child');
    expect(classifyGender(120, 3, 5)).toBe('male'); // tilt never turns a low pitch female
  });
  it('works at 48 kHz and ignores silence around the sentence', () => {
    const rate = 48000;
    const buf = new Int16Array(rate * 3);
    buf.set(voiced(120, 1.2, rate), rate); // voiced 1.0 - 2.2 s
    const p = sentencePitch(buf, rate, 10, { start: 10.5, end: 12.8 }, [{ start: 11, end: 12.2 }]);
    expect(Math.abs(p.f0 - 120)).toBeLessThan(8);
  });
  it('rejects a steady music-like tone', () => {
    const rate = 16000;
    const tone = new Int16Array(rate * 2);
    for (let i = 0; i < tone.length; i++) tone[i] = Math.round(8000 * Math.sin((2 * Math.PI * 220 * i) / rate));
    expect(spanPitch(tone, rate).f0).toBe(0);
  });
  it('is cheap: 10 s of speech well under 150 ms', () => {
    const pcm = voiced(130, 10);
    const t0 = performance.now();
    spanPitch(pcm, 16000);
    expect(performance.now() - t0).toBeLessThan(150);
  });
  it('silence is unknown', () => {
    expect(spanPitch(new Int16Array(16000), 16000).f0).toBe(0);
  });
});

describe('SpeakerTracker hysteresis', () => {
  it('starts as male; unknown phrases keep the state; a first male phrase changes nothing', () => {
    const t = new SpeakerTracker();
    expect(t.state).toBe('male');
    expect(t.update(160, 2).state).toBe('male');
    expect(t.update(110, 0.5).state).toBe('male');
    expect(t.update(110, 2).changed).toBe(false);
  });
  it('a woman at 195 Hz needs 2 agreeing phrases (and the median): the first is still voiced male', () => {
    const t = new SpeakerTracker();
    expect(t.update(195, 3, undefined, 10).state).toBe('male');
    const u = t.update(192, 3, undefined, 14);
    expect(u.state).toBe('female_or_child');
    expect(u.changed).toBe(true);
  });
  it('a stray single phrase does not flip; unknown in between neither confirms nor breaks', () => {
    const t = new SpeakerTracker();
    t.update(110, 2, undefined, 1);
    expect(t.update(200, 2, undefined, 4).state).toBe('male'); // stray
    expect(t.update(115, 2, undefined, 7).state).toBe('male'); // breaks the pending change
    expect(t.update(200, 2, undefined, 10).state).toBe('male');
    expect(t.update(170, 2, undefined, 13).state).toBe('male'); // unknown band
    expect(t.update(200, 2, undefined, 16).state).toBe('female_or_child'); // 2nd consecutive; median agrees
  });
  it('2 agreeing votes are not enough while the 8 s median disagrees', () => {
    const t = new SpeakerTracker();
    t.update(110, 6, undefined, 1); // long male phrase dominates the window
    t.update(190, 1.2, undefined, 4);
    expect(t.update(190, 1.2, undefined, 6).state).toBe('male');
    // the male phrase has left the window: the median agrees now
    expect(t.update(190, 1.2, undefined, 12).state).toBe('female_or_child');
  });
  it('one long phrase far beyond the threshold flips at once (>= 2.5 s and margin >= 40 Hz)', () => {
    const f = (hz: number, sec: number): string => new SpeakerTracker().update(hz, sec, undefined, 5).state;
    expect(f(226, 2.6)).toBe('female_or_child');
    expect(f(226, 2.4)).toBe('male');
    expect(f(215, 4)).toBe('male'); // margin only 30
    const t2 = new SpeakerTracker();
    t2.update(225, 3, undefined, 1); // flips
    expect(t2.update(112, 3, undefined, 5).state).toBe('male'); // margin 43 back
  });
  it('a dark high-pitched voice never produces a vote', () => {
    const t = new SpeakerTracker();
    for (let k = 0; k < 5; k++) expect(t.update(195, 4, -22, k * 5).state).toBe('male');
  });
});

describe('voice mapping by source gender', () => {
  it('never mixes genders, per engine', () => {
    const engines: LocalTtsEngineId[] = ['supertonic-webgpu', 'supertonic-wasm', 'silero-cpu', 'piper-wasm'];
    for (const id of engines) {
      expect(mapVoice(id, 'm')).toMatch(id.startsWith('supertonic') ? /^M\d$/ : id === 'silero-cpu' ? /^eugene$/ : /^(dmitri|denis|ruslan)$/);
      expect(mapVoice(id, 'f')).toMatch(id.startsWith('supertonic') ? /^F\d$/ : id === 'silero-cpu' ? /^xenia$/ : /^irina$/);
    }
    expect(mapVoice('helper-omnivoice', 'm')).toBeUndefined();
  });
  it('explicit user voice is used for its own gender; the other gender takes the calibrated / default one', () => {
    expect(mapVoice('supertonic-webgpu', 'f', { userVoice: 'F3' })).toBe('F3');
    expect(mapVoice('supertonic-webgpu', 'm', { userVoice: 'F3' })).toBe('M3'); // measured prior, not the high default
    expect(mapVoice('supertonic-webgpu', 'm', { userVoice: 'F3', calibrated: { male: 'M4' } })).toBe('M4');
    expect(mapVoice('supertonic-webgpu', 'm', { userVoice: 'M2', calibrated: { male: 'M4' } })).toBe('M2');
    expect(mapVoice('supertonic-webgpu', 'f', { userVoice: 'M2', calibrated: { female: 'F1' } })).toBe('F1');
    expect(mapVoice('supertonic-webgpu', 'm', { calibrated: { male: 'F2' } })).toBe('M3'); // a wrong-gender calibration is ignored
  });
});

const f0Table: Record<string, number> = { M1: 135, M2: 128, M3: 104, M4: 120, M5: 140, F1: 210, F2: 220, F3: 205, F4: 230, F5: 215 };
function fakeEngine(calls: LocalTtsRequest[] = [], id: LocalTtsEngineId = 'supertonic-webgpu'): LocalTtsEngine {
  return {
    id,
    isAvailable: async () => true,
    voices: async () => Object.keys(f0Table),
    synth: async (req) => {
      calls.push(req);
      return { sampleRate: 24000, samples: voiced(f0Table[req.voice ?? 'M1'] ?? 130, 1.5, 24000), durationSec: 1.5 };
    },
  };
}

describe('voice calibration', () => {
  it('picks the male voice closest to 105 Hz inside 85-130 and the female closest to 170 Hz inside 150-200 (not the extremes)', () => {
    // v0.2.44 report: M2 90 (very deep) and F1 185 / F2 242 / F4 227 (childlike) were the old choices
    const f0 = { M1: 133, M2: 90, M3: 100, M4: 122, M5: 92, F1: 185, F2: 242, F3: 174, F4: 227, F5: 163 };
    const p = pickCalibrated('supertonic-webgpu', f0);
    expect([p.male, p.female, p.maleRule, p.femaleRule]).toEqual(['M3', 'F3', 'range', 'range']);
    // nothing in range => the closest overall
    const q = pickCalibrated('supertonic-webgpu', { M1: 140, M2: 150, F1: 210, F2: 240 });
    expect([q.male, q.female, q.maleRule, q.femaleRule]).toEqual(['M1', 'F1', 'nearest', 'nearest']);
    expect(pickCalibrated('supertonic-webgpu', {}).male).toBeUndefined();
  });
  it('a calibration cached by v0.2.44 (male M2, female F1) is re-picked by the new rule and logs voice-calib', () => {
    diag.clear();
    const old: VoiceCalibration = { key: 'k', male: 'M2', female: 'F1', f0: { M1: 133, M2: 90, M3: 100, M4: 122, M5: 92, F1: 185, F2: 242, F3: 174, F4: 227, F5: 163 } };
    const c = applyCalibrationRule('supertonic-webgpu', old);
    expect([c.male, c.female]).toEqual(['M3', 'F3']);
    const e = diag.entries().find((x) => x.ev === 'voice-calib')!;
    expect(e.data).toMatchObject({ male: 'M3', maleF0: 100, female: 'F3', femaleF0: 174 });
  });
  it('calibrateVoices measures every voice and applies the rule', async () => {
    const calls: LocalTtsRequest[] = [];
    const c = await calibrateVoices(fakeEngine(calls), 'k');
    expect(c.male).toBe('M3');
    expect(c.female).toBe('F3'); // all fake female voices are > 200 Hz: nearest to 170 is F3 (205)
    expect(c.f0.M3).toBeLessThan(c.f0.M1!);
    expect(calls).toHaveLength(10);
    expect(calls.every((r) => r.text === CALIB_TEXT)).toBe(true);
  });
  it('registry calibrates once, caches in the store and then serves the calibrated voice', async () => {
    const calls: LocalTtsRequest[] = [];
    const mem = new Map<string, VoiceCalibration>();
    const reg = new LocalTtsRegistry();
    reg.register(fakeEngine(calls));
    reg.setCalibrationStore({ get: async (k) => mem.get(k), set: async (k, v) => void mem.set(k, v) });
    expect(reg.voiceFor('supertonic-webgpu', 'm')).toBe('M3'); // prior before the calibration lands
    await reg.calibrate('supertonic-webgpu');
    await reg.calibrate('supertonic-webgpu');
    expect(calls).toHaveLength(10);
    expect([...mem.keys()][0]).toMatch(/^supertonic-webgpu@/);
    expect(reg.voiceFor('supertonic-webgpu', 'm')).toBe('M3');
    // a fresh registry (new session) reads the cache and does not synthesize again
    const reg2 = new LocalTtsRegistry();
    const calls2: LocalTtsRequest[] = [];
    reg2.register(fakeEngine(calls2));
    reg2.setCalibrationStore({ get: async (k) => mem.get(k), set: async (k, v) => void mem.set(k, v) });
    await reg2.calibrate('supertonic-webgpu');
    expect(calls2).toHaveLength(0);
    expect(reg2.voiceFor('supertonic-webgpu', 'm')).toBe('M3');
  });
  it('an explicit user male voice beats the calibrated one', async () => {
    const reg = new LocalTtsRegistry();
    reg.register(fakeEngine());
    reg.setPreference(() => ({ engine: 'auto', voice: '', voiceMale: 'M2', voiceFemale: 'auto' }));
    await reg.calibrate('supertonic-webgpu');
    expect(reg.voiceFor('supertonic-webgpu', 'm')).toBe('M2');
    expect(reg.voiceFor('supertonic-webgpu', 'f')).toBe('F3');
    reg.setPreference(() => ({ engine: 'auto', voice: '', voiceMale: 'auto', voiceFemale: 'F5' }));
    expect(reg.voiceFor('supertonic-webgpu', 'f')).toBe('F5');
    expect(reg.voiceFor('supertonic-webgpu', 'm')).toBe('M3');
  });
});

describe('voice switching and synthesis', () => {
  it('changes voice only with the speaker class and logs voice-switch', () => {
    diag.clear();
    const p = new VoicePlanner();
    const seq = (['m', 'm', 'f', 'f', 'm'] as const).map((g) => p.voiceFor('supertonic-webgpu', g, {}));
    expect(seq).toEqual(['M3', 'M3', 'F3', 'F3', 'M3']);
    const sw = diag.entries().filter((e) => e.ev === 'voice-switch');
    expect(sw).toHaveLength(2);
    expect(sw[0]!.data).toMatchObject({ from: 'M3', to: 'F3', why: 'gender:m>f' });
  });
  it('voiceSegments sends the mapped voice + srcGender; an unclassified phrase takes the male voice (never the female default)', async () => {
    const calls: LocalTtsRequest[] = [];
    const reg = new LocalTtsRegistry();
    const eng = fakeEngine(calls);
    reg.register(eng);
    const items = [
      { start: 0, end: 3, ru: 'Привет, друзья.', gender: 'm' as const },
      { start: 3, end: 6, ru: 'Добрый день.', gender: 'f' as const },
      { start: 6, end: 9, ru: 'Без пола.' },
    ];
    await voiceSegments(items, { engine: eng, tier: 'local', signal: new AbortController().signal, concurrency: 1, voiceFor: (g) => reg.voiceFor(eng.id, g) });
    expect(calls.map((c) => [c.voice, c.srcGender])).toEqual([
      ['M3', 'm'],
      ['F3', 'f'],
      ['M3', 'm'],
    ]);
  });
  it('registry wrapper skips the child guard for a source-gendered take', async () => {
    const calls: LocalTtsRequest[] = [];
    const reg = new LocalTtsRegistry();
    f0Table.M1 = 240; // would trip the old guard
    try {
      reg.register(fakeEngine(calls));
      const e = (await reg.pick())!;
      const r = await e.synth({ text: 'x', voice: 'M1', srcGender: 'm' });
      expect(r.voiceFallback).toBeUndefined();
      expect(calls.map((c) => c.voice)).toEqual(['M1']);
      expect(r.f0Hz).toBeGreaterThan(200); // measured for the diag only
    } finally {
      f0Table.M1 = 135;
    }
  });
});
