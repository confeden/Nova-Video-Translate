import { describe, expect, it } from 'vitest';
import { KeyPool } from '../src/keypool';
import { GeminiClient } from '../src/providers/gemini/client';
import { synthesize } from '../src/providers/gemini/tts';
import { parseTranslation } from '../src/providers/gemini/translate';
import { assignVoices, GEMINI_VOICE_GENDER, GEMINI_VOICE_NAMES } from '../src/providers/gemini/voices';
import { rmsBetween, trimAndFade } from '../src/audio/tailTrim';

const SR = 24000;
/** speech-like burst: 150 Hz carrier with 4 Hz syllable modulation */
function burst(sec: number, amp = 10000): Int16Array {
  const n = Math.round(sec * SR);
  const o = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    o[i] = Math.round(amp * (0.55 + 0.45 * Math.sin(2 * Math.PI * 4 * t)) * Math.sin(2 * Math.PI * 150 * t));
  }
  return o;
}
function noise(sec: number, amp: number): Int16Array {
  const n = Math.round(sec * SR);
  const o = new Int16Array(n);
  let x = 12345;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    o[i] = Math.round(((x / 0x7fffffff) * 2 - 1) * amp);
  }
  return o;
}
const cat = (...p: Int16Array[]) => {
  const o = new Int16Array(p.reduce((a, b) => a + b.length, 0));
  let k = 0;
  for (const a of p) {
    o.set(a, k);
    k += a.length;
  }
  return o;
};

describe('trimAndFade', () => {
  it('cuts a noise tail but keeps speech and a hangover', () => {
    const sp = burst(1.0);
    const y = trimAndFade(cat(sp, noise(0.35, 700)), SR);
    expect(y.length).toBeLessThan(sp.length + 0.1 * SR);
    expect(y.length).toBeGreaterThan(sp.length * 0.98);
    expect(rmsBetween(y, SR, 0.5, 0.9)).toBeGreaterThan(rmsBetween(sp, SR, 0.5, 0.9) * 0.9);
  });
  it('never cuts interior pauses', () => {
    const x = cat(burst(0.5), new Int16Array(Math.round(0.4 * SR)), burst(0.5), noise(0.3, 600));
    const y = trimAndFade(x, SR);
    expect(y.length).toBeGreaterThan(1.4 * SR);
    expect(rmsBetween(y, SR, 0.55, 0.85)).toBeLessThan(5);
    expect(rmsBetween(y, SR, 1.0, 1.3)).toBeGreaterThan(1000);
  });
  it('fades an abruptly ended signal to zero and starts from zero', () => {
    const y = trimAndFade(burst(1.0), SR);
    expect(Math.abs(y[y.length - 1] ?? 1)).toBeLessThan(50);
    expect(Math.abs(y[0] ?? 1)).toBeLessThan(50);
    expect(y.length).toBe(SR);
  });
  it('shortens long leading silence to ~60 ms', () => {
    const y = trimAndFade(cat(new Int16Array(SR / 2), burst(0.5)), SR);
    expect(y.length / SR).toBeGreaterThan(0.55);
    expect(y.length / SR).toBeLessThan(0.65);
  });
  it('keeps short leading silence', () => {
    const y = trimAndFade(cat(new Int16Array(Math.round(0.1 * SR)), burst(0.5)), SR);
    expect(y.length / SR).toBeGreaterThan(0.59);
  });
  it('removes DC offset', () => {
    const x = burst(0.5).map((v) => v + 3000);
    const y = trimAndFade(x, SR);
    let s = 0;
    for (const v of y) s += v;
    expect(Math.abs(s / y.length)).toBeLessThan(300);
  });
  it('returns silence and very short input unchanged', () => {
    const z = new Int16Array(SR);
    expect(trimAndFade(z, SR)).toEqual(z);
    const c = new Int16Array(SR).fill(100);
    expect(trimAndFade(c, SR)).toEqual(c);
    const tiny = Int16Array.from([5, 9, -4]);
    expect(trimAndFade(tiny, SR)).toEqual(tiny);
    expect(trimAndFade(new Int16Array(0), SR).length).toBe(0);
  });
});

describe('voices', () => {
  it('table has 30 voices, 14 female', () => {
    expect(GEMINI_VOICE_NAMES).toHaveLength(30);
    expect(Object.values(GEMINI_VOICE_GENDER).filter((g) => g === 'female').length).toBe(14);
  });
  const seg = (gender: string, speaker = 'S1', dur = 3) => ({ start: 0, end: dur, gender: gender as 'male', speaker });
  it('maps genders with defaults', () => {
    expect(assignVoices([seg('male'), seg('female', 'S2')]).map((c) => c.voice)).toEqual(['Orus', 'Kore']);
  });
  it('unknown reuses the previous voice, first unknown uses the default', () => {
    expect(assignVoices([seg('unknown')]).map((c) => c.voice)).toEqual(['Orus']);
    expect(assignVoices([seg('female'), seg('unknown')]).map((c) => c.voice)).toEqual(['Kore', 'Kore']);
    expect(assignVoices([seg('unknown')], { fallback: 'Puck' })[0]?.voice).toBe('Puck');
  });
  it('child uses child voice if configured, else female', () => {
    expect(assignVoices([seg('child')])[0]?.voice).toBe('Kore');
    expect(assignVoices([seg('child')], { child: 'Leda' })[0]?.voice).toBe('Leda');
  });
  it('short interjections inherit the neighbour', () => {
    const r = assignVoices([seg('male'), seg('female', 'S2', 0.8), seg('male')]);
    expect(r.map((c) => c.voice)).toEqual(['Orus', 'Orus', 'Orus']);
  });
  it('hysteresis: lone flip on the same speaker is ignored, two agreeing switch', () => {
    expect(assignVoices([seg('male'), seg('female'), seg('male')]).map((c) => c.voice)).toEqual(['Orus', 'Orus', 'Orus']);
    expect(assignVoices([seg('male'), seg('female'), seg('female')]).map((c) => c.voice)).toEqual(['Orus', 'Kore', 'Kore']);
  });
  it('speaker change switches immediately', () => {
    expect(assignVoices([seg('male', 'S1'), seg('female', 'S2')]).map((c) => c.voice)).toEqual(['Orus', 'Kore']);
  });
  it('parseTranslation: missing speaker/gender => unknown, odd case normalised', () => {
    const r = parseTranslation(
      JSON.stringify({
        source_lang: 'en',
        segments: [
          { start: 0, end: 3, src: 'a', ru: 'б' },
          { start: 3, end: 6, src: 'c', ru: 'г', speaker: 'S2', gender: 'Female' },
          { start: 6, end: 9, src: 'c', ru: 'г', gender: 'robot' },
        ],
      }),
      10,
    );
    expect(r.segments.map((s) => [s.speaker, s.gender])).toEqual([
      ['', 'unknown'],
      ['S2', 'female'],
      ['', 'unknown'],
    ]);
  });
});

describe('tts request and guard', () => {
  const b64 = (pcm: Int16Array) => {
    let s = '';
    for (const b of new Uint8Array(pcm.buffer)) s += String.fromCharCode(b);
    return btoa(s);
  };
  const resp = (pcm: Int16Array) =>
    new Response(
      JSON.stringify({
        candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;rate=24000', data: b64(pcm) } }] } }],
      }),
      { status: 200 },
    );
  it('request text is exactly the segment text; voice/temperature/seed set', async () => {
    const bodies: any[] = [];
    const c = new GeminiClient({
      keys: new KeyPool(['k']),
      fetch: async (_u: string, init?: RequestInit) => (bodies.push(JSON.parse(init!.body as string)), resp(burst(0.5))),
    });
    await synthesize(c, 'm', 'Привет, мир.', { voice: 'Orus' });
    expect(bodies[0].contents).toEqual([{ parts: [{ text: 'Привет, мир.' }] }]);
    expect(bodies[0].generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe('Orus');
    expect(bodies[0].generationConfig.temperature).toBe(0.2);
    expect(bodies[0].generationConfig.seed).toBe(1);
  });
  it('trims the tail before measuring seconds', async () => {
    const c = new GeminiClient({ keys: new KeyPool(['k']), fetch: async () => resp(cat(burst(0.7), noise(0.35, 500))) });
    const r = await synthesize(c, 'm', 'Привет, мир.');
    expect(r.seconds).toBeLessThan(0.85);
    expect(r.seconds).toBeGreaterThan(0.68);
  });
  it('guard: too-long first clip is retried once with the same text and the shorter one kept', async () => {
    const bodies: any[] = [];
    let n = 0;
    const c = new GeminiClient({
      keys: new KeyPool(['k']),
      fetch: async (_u: string, init?: RequestInit) => (bodies.push(JSON.parse(init!.body as string)), resp(burst(n++ === 0 ? 9 : 1.0))),
    });
    const r = await synthesize(c, 'm', 'Привет, мир.');
    expect(bodies).toHaveLength(2);
    expect(bodies[1].contents).toEqual(bodies[0].contents);
    expect(bodies[1].generationConfig.seed).toBe(2);
    expect(r.seconds).toBeCloseTo(1.0, 1);
    expect(r.suspicious).toBeUndefined();
  });
  it('guard: still too long => flagged suspicious, shorter result kept, no third call', async () => {
    let n = 0;
    const c = new GeminiClient({ keys: new KeyPool(['k']), fetch: async () => resp(burst(n++ === 0 ? 9 : 7)) });
    const r = await synthesize(c, 'm', 'Привет.');
    expect(n).toBe(2);
    expect(r.suspicious).toBe(true);
    expect(r.seconds).toBeCloseTo(7, 0);
  });
});
