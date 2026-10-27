import { describe, expect, it } from 'vitest';
import {
  anchorTicker,
  buildWordTimeline,
  layerPositionAt,
  stepTicker,
  TICKER_MIN_EM_S,
  type TickerMotion,
} from '../src/ui/subtitleOverlay';
import type { SubtitleCue } from '../src/providers/types';

/** speech with a pause between phrases and a fast burst: the case that used to jerk */
const cues: SubtitleCue[] = [
  { start: 0, end: 2, text: 'один два три четыре' },
  { start: 4, end: 4.5, text: 'пять' },
  { start: 4.5, end: 7, text: 'шесть семь восемь девять десять одиннадцать' },
  { start: 9, end: 9.3, text: 'двенадцать' },
];
const words = buildWordTimeline(cues, 'translation');

/** runs the layer at 60 fps over the timeline, following the audio clock exactly */
function run(seconds = 12, dt = 1 / 60): { m: TickerMotion; t: number }[] {
  let m: TickerMotion = { pos: 0, vel: 0 };
  const out = [{ m, t: 0 }];
  for (let i = 1; i <= seconds * 60; i++) {
    const t = i * dt;
    m = stepTicker(m, words, t, dt);
    out.push({ m, t });
  }
  return out;
}

describe('stepTicker: smooth scrolling layer', () => {
  const frames = run();

  it('never moves backwards', () => {
    for (let i = 1; i < frames.length; i++) {
      expect(frames[i]!.m.pos).toBeGreaterThanOrEqual(frames[i - 1]!.m.pos - 1e-9);
    }
  });

  it('speed changes gradually: no per-frame speed jumps at word or pause boundaries', () => {
    // a jump of more than 0.5 em/s in one frame would be visible as a jerk
    for (let i = 1; i < frames.length; i++) {
      expect(Math.abs(frames[i]!.m.vel - frames[i - 1]!.m.vel)).toBeLessThan(0.5);
    }
  });

  it('keeps flowing through pauses instead of stopping', () => {
    // the pause between 2.0 s and 4.0 s must never drop to a standstill
    for (const f of frames.filter((x) => x.t > 2.5 && x.t < 3.9)) {
      expect(f.m.vel).toBeGreaterThan(TICKER_MIN_EM_S * 0.5);
    }
  });

  it('stays close to the audio position (no runaway lead or lag)', () => {
    for (const f of frames.filter((x) => x.t > 1)) {
      const target = layerPositionAt(words, f.t);
      // about 0.3 s of speech: the smoothed speed trails the audio by this much
      expect(Math.abs(f.m.pos - target)).toBeLessThan(5);
    }
  });

  it('does nothing without text or with no time step', () => {
    const m = { pos: 3, vel: 1 };
    expect(stepTicker(m, [], 1, 1 / 60)).toEqual(m);
    expect(stepTicker(m, words, 1, 0)).toEqual(m);
  });
});

describe('anchorTicker: cues landing while the layer runs', () => {
  const before = buildWordTimeline(cues, 'translation');
  const earlier: SubtitleCue[] = [{ start: -6, end: -1, text: 'ранее вставленная фраза' }];
  const after = buildWordTimeline([...earlier, ...cues], 'translation');

  it('a cue inserted before the playhead does not move the words on screen', () => {
    const t = 3;
    const m = { pos: layerPositionAt(before, t), vel: 1.5 };
    const a = anchorTicker(m, before, after, t);
    // the playhead word keeps its place relative to the layer: the screen offset is unchanged
    expect(a.pos - layerPositionAt(after, t)).toBeCloseTo(m.pos - layerPositionAt(before, t), 6);
    expect(a.vel).toBe(m.vel);
  });

  it('a rebuild with the same cues changes nothing', () => {
    const m = { pos: 4, vel: 0 };
    expect(anchorTicker(m, before, buildWordTimeline(cues, 'translation'), 3)).toEqual(m);
  });

  it('no words on either side leaves the motion as it was', () => {
    const m = { pos: 4, vel: 0 };
    expect(anchorTicker(m, [], before, 3)).toEqual(m);
  });
});

describe('stepTicker: dense speech is followed without saturating', () => {
  // six words a second, about 3.4 em each: faster than the old 12 em/s cap allowed
  const dense: SubtitleCue[] = [{ start: 0, end: 10, text: Array.from({ length: 60 }, () => 'слово').join(' ') }];
  const denseWords = buildWordTimeline(dense, 'original');

  it('the layer keeps up with the audio (no growing lag, no speed saturation)', () => {
    let m: TickerMotion = { pos: 0, vel: 0 };
    let worst = 0;
    for (let i = 1; i <= 9 * 60; i++) {
      const t = i / 60;
      m = stepTicker(m, denseWords, t, 1 / 60);
      if (t > 2) worst = Math.max(worst, Math.abs(m.pos - layerPositionAt(denseWords, t)));
    }
    expect(worst).toBeLessThan(2);
  });
});
