import { describe, expect, it } from 'vitest';
import {
  PIPER_COMMON_FILES,
  PIPER_DEFAULT_VOICE,
  PIPER_REVISION,
  PIPER_SPEED_MAX,
  PIPER_SPEED_MIN,
  PIPER_VOICES,
  assemblePiperPcm,
  chunkForPiper,
  clampPiperSpeed,
  normalizePiperText,
  parsePiperPhonemes,
  piperFirstPassSpeed,
  piperNeedsCorrection,
  piperPhonemesToIds,
  piperVoiceFiles,
  refinePiperSpeed,
  splitSentencesPiper,
} from '../src/localtts/piper';

describe('piper constants', () => {
  it('has four voices, default dmitri, russian labels', () => {
    expect(PIPER_VOICES.map((v) => v.id)).toEqual(['dmitri', 'denis', 'ruslan', 'irina']);
    expect(PIPER_VOICES.some((v) => v.id === PIPER_DEFAULT_VOICE)).toBe(true);
    for (const v of PIPER_VOICES) expect(v.label).toMatch(/\((муж|жен)\.\)/);
  });
  it('voice files are pinned (revision in url, sha256 hex, sizes)', () => {
    for (const v of PIPER_VOICES) {
      const files = piperVoiceFiles(v.id) as Array<{ path: string; size: number; sha256?: string; url?: string }>;
      expect(files.map((f) => f.path.endsWith('.onnx') || f.path.endsWith('.onnx.json'))).toEqual([true, true]);
      for (const f of files) {
        expect(f.url).toContain(PIPER_REVISION);
        expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(f.size).toBeGreaterThan(1000);
      }
    }
    expect(() => piperVoiceFiles('nobody')).toThrow();
  });
  it('common data pack is pinned to an exact version', () => {
    const f = PIPER_COMMON_FILES[0] as { url?: string; sha256?: string; size: number };
    expect(f.url).toMatch(/@\d+\.\d+\.\d+\//);
    expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(f.size).toBeGreaterThan(5_000_000);
  });
});

describe('normalizePiperText', () => {
  it('cleans symbols, emoji, dashes and adds a final stop', () => {
    expect(normalizePiperText('  Привет  мир 😀 ')).toBe('Привет мир.');
    expect(normalizePiperText('Это — тест')).toBe('Это, тест.');
    expect(normalizePiperText('Он сказал «да»')).toBe('Он сказал "да".');
    expect(normalizePiperText('Что?!')).toBe('Что?');
  });
  it('unspeakable input becomes empty', () => {
    expect(normalizePiperText('')).toBe('');
    expect(normalizePiperText('   \n ')).toBe('');
    expect(normalizePiperText('... --- 😀')).toBe('');
  });
});

describe('chunkForPiper', () => {
  it('empty -> no chunks', () => {
    expect(chunkForPiper('')).toEqual([]);
    expect(chunkForPiper(' . ')).toEqual([]);
  });
  it('one sentence per chunk; abbreviations do not split', () => {
    expect(chunkForPiper('Привет, мир.')).toEqual(['Привет, мир.']);
    expect(chunkForPiper('Привет, мир. Как дела?')).toEqual(['Привет, мир.', 'Как дела?']);
    expect(splitSentencesPiper('Это стоит 5 т. руб. в год. Дорого.')).toEqual(['Это стоит 5 т. руб. в год.', 'Дорого.']);
  });
  it('respects the limit and keeps every word (8 sentences, 8 chunks)', () => {
    const sentence = 'Батарея хранит энергию, а двигатель превращает её в движение, поэтому машина едет';
    const text = Array.from({ length: 8 }, () => `${sentence}.`).join(' ');
    const chunks = chunkForPiper(text, 200);
    expect(chunks.length).toBe(8);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(201);
    expect(chunks.join(' ').replace(/[.,]/g, '').split(/\s+/).length).toBe(text.replace(/[.,]/g, '').split(/\s+/).length);
  });
  it('breaks one long sentence at commas, every chunk ends with punctuation', () => {
    const long = Array.from({ length: 30 }, (_, i) => `слово${i} слово`).join(', ');
    const chunks = chunkForPiper(long, 120);
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(121);
      expect(c).toMatch(/[.!?]$/);
    }
  });
  it('a word longer than the limit is cut hard', () => {
    const chunks = chunkForPiper('а'.repeat(450), 200);
    expect(chunks.length).toBe(3);
  });
});

describe('piperPhonemesToIds', () => {
  const map = { _: [0], '^': [1], $: [2], ' ': [3], a: [14], b: [15], '.': [10] };
  it('BOS PAD (phoneme PAD)* EOS; unknown phonemes dropped', () => {
    expect(piperPhonemesToIds(['a', 'b', 'q', '.'], map)).toEqual([1, 0, 14, 0, 15, 0, 10, 0, 2]);
    expect(piperPhonemesToIds([], map)).toEqual([1, 0, 2]);
  });
  it('supports multi-id entries', () => {
    expect(piperPhonemesToIds(['a'], { ...map, a: [14, 99] })).toEqual([1, 0, 14, 99, 0, 2]);
  });
});

describe('parsePiperPhonemes', () => {
  it('joins phonemes of json lines, ignores noise', () => {
    const l1 = JSON.stringify({ phoneme_ids: [1], phonemes: ['p', 'r'], text: 'x' });
    const l2 = JSON.stringify({ phonemes: ['i'] });
    expect(parsePiperPhonemes(['some log', l1, '', l2])).toEqual(['p', 'r', 'i']);
    expect(parsePiperPhonemes([])).toEqual([]);
  });
});

describe('speed fitting', () => {
  it('no target -> natural, never corrected', () => {
    expect(piperFirstPassSpeed(100, 2, undefined)).toBe(1);
    expect(piperNeedsCorrection(50, undefined, 1)).toBe(false);
  });
  it('first pass is clamped to 0.8..1.6', () => {
    expect(piperFirstPassSpeed(1000, 1, 1)).toBe(PIPER_SPEED_MAX);
    expect(piperFirstPassSpeed(10, 1, 100)).toBe(PIPER_SPEED_MIN);
    expect(piperFirstPassSpeed(100, 1, 0.1)).toBe(PIPER_SPEED_MAX);
  });
  it('correction only outside tolerance and when the clamp leaves room', () => {
    expect(piperNeedsCorrection(10.5, 10, 1)).toBe(false);
    expect(piperNeedsCorrection(12, 10, 1.2)).toBe(true);
    expect(piperNeedsCorrection(12, 10, PIPER_SPEED_MAX)).toBe(false);
    expect(piperNeedsCorrection(8, 10, PIPER_SPEED_MIN)).toBe(false);
  });
  it('refine scales speed by the miss and clamps', () => {
    expect(refinePiperSpeed(1, 12, 1, 10)).toBeCloseTo(1.2, 5);
    expect(refinePiperSpeed(1.5, 30, 1, 10)).toBe(PIPER_SPEED_MAX);
    expect(clampPiperSpeed(0.1)).toBe(PIPER_SPEED_MIN);
  });
});

describe('assemblePiperPcm', () => {
  it('inserts gaps, normalises over the whole request and keeps exact length', () => {
    const a = new Float32Array(100).fill(0.5);
    const b = new Float32Array(50).fill(0.25);
    const out = assemblePiperPcm([a, b], 1000, 0.2);
    expect(out.length).toBe(100 + 200 + 50);
    expect(out[0]).toBe(Math.round(32767 * 0.97));
    expect(out[100]).toBe(0);
    expect(out[320]).toBe(Math.round(0.25 * ((32767 * 0.97) / 0.5)));
  });
  it('single chunk has no gap; empty list -> empty', () => {
    expect(assemblePiperPcm([new Float32Array(10)], 22050).length).toBe(10);
    expect(assemblePiperPcm([], 22050).length).toBe(0);
  });
  it('silence is not amplified to noise (peak floor 0.01)', () => {
    const out = assemblePiperPcm([new Float32Array(4).fill(0.001)], 22050);
    expect(Math.abs(out[0]!)).toBeLessThan(5000);
  });
});
