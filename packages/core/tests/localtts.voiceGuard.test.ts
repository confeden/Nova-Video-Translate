import { describe, expect, it } from 'vitest';
import { LocalTtsRegistry } from '../src/localtts/registry';
import { CHILD_F0_MALE_HZ, VoiceGuard, measureVoicedF0 } from '../src/localtts/voiceGuard';
import type { LocalTtsEngine, LocalTtsResult } from '../src/localtts/types';

const RATE = 24000;
/** vowel-like voiced signal: harmonics of f0 with a decaying spectrum */
function voiced(f0: number, sec: number): Int16Array {
  const n = Math.round(sec * RATE);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let h = 1; h <= 8; h++) s += Math.sin((2 * Math.PI * f0 * h * i) / RATE) / h;
    out[i] = Math.round(s * 5000);
  }
  return out;
}
const res = (f0: number, sec: number): LocalTtsResult => ({ sampleRate: RATE, samples: voiced(f0, sec), durationSec: sec });

function fakeEngine(f0ByVoice: Record<string, number>, calls: string[] = []): LocalTtsEngine {
  return {
    id: 'supertonic-webgpu',
    isAvailable: async () => true,
    voices: async () => Object.keys(f0ByVoice),
    synth: async (req) => {
      calls.push(req.voice ?? 'M1');
      return res(f0ByVoice[req.voice ?? 'M1'] ?? 120, 1.5);
    },
  };
}
async function synthVia(pref: string | undefined, f0: Record<string, number>, n = 1, text = 'privet') {
  const reg = new LocalTtsRegistry();
  const calls: string[] = [];
  reg.register(fakeEngine(f0, calls));
  reg.setPreference(() => ({ engine: 'auto', voice: pref ?? '' }));
  const e = (await reg.pick())!;
  const out: LocalTtsResult[] = [];
  for (let i = 0; i < n; i++) out.push(await e.synth({ text, voice: undefined }));
  return { out, calls, reg };
}

describe('measureVoicedF0', () => {
  it('reads 110 Hz and 240 Hz', () => {
    const a = measureVoicedF0(voiced(110, 1.2), RATE);
    const b = measureVoicedF0(voiced(240, 1.2), RATE);
    expect(Math.abs(a.f0 - 110)).toBeLessThan(6);
    expect(Math.abs(b.f0 - 240)).toBeLessThan(10);
    expect(a.voicedSec).toBeGreaterThan(1);
    expect(110).toBeLessThan(CHILD_F0_MALE_HZ);
  });
});

describe('child-voice guard', () => {
  it('keeps a male voice at 110 Hz', async () => {
    const { out, calls } = await synthVia(undefined, { M1: 110, F1: 220 });
    expect(calls).toEqual(['M1']);
    expect(out[0]!.voiceFallback).toBeUndefined();
    expect(out[0]!.f0Hz).toBeGreaterThan(100);
  });
  it('falls back to F1 for a 240 Hz take of M1', async () => {
    const { out, calls } = await synthVia(undefined, { M1: 240, F1: 220 });
    expect(calls).toEqual(['M1', 'F1']);
    expect(out[0]!.voiceFallback).toBe(true);
  });
  it('uses the female voice the user picked', async () => {
    const { calls } = await synthVia('F3', { M1: 240, F3: 220 });
    expect(calls).toEqual(['F3']); // explicit female: never measured, never switched
  });
  it('an explicit male voice is checked and falls back to the default female', async () => {
    const { calls } = await synthVia('M2', { M2: 240, F1: 220 });
    expect(calls).toEqual(['M2', 'F1']);
  });
  it('does not judge a take with less than 0.6 s of voiced audio', async () => {
    const g = new VoiceGuard();
    const synth = async (): Promise<LocalTtsResult> => res(240, 0.5);
    const r = await g.run({ voice: 'M1', isMale: true, femaleVoice: 'F1', chars: 5, synth });
    expect(r.voiceFallback).toBeUndefined();
  });
  it('no longer locks: every childlike take is judged on its own', async () => {
    const { calls } = await synthVia(undefined, { M1: 240, F1: 220 }, 4);
    expect(calls).toEqual(['M1', 'F1', 'M1', 'F1', 'M1', 'F1', 'M1', 'F1']);
  });
  it('keeps the take when the female voice fails', async () => {
    const g = new VoiceGuard();
    const synth = async (v: string): Promise<LocalTtsResult> => {
      if (v === 'F1') throw new Error('no voice');
      return res(240, 1.5);
    };
    const r = await g.run({ voice: 'M1', isMale: true, femaleVoice: 'F1', chars: 5, synth });
    expect(r.voiceFallback).toBeUndefined();
    expect(r.samples.length).toBeGreaterThan(0);
  });
});
