import { describe, expect, it } from 'vitest';
import { dropLeadingWords, overlapWords, stripNonSpeech } from '../src/localasr/asrText';
import { asrUpgradeState } from '../src/ui/localAsrSection';
import { cachedDtypes, type LasrState } from '../src/localasr/whisperProtocol';
import { WHISPER_MODELS, pickWhisperModel } from '../src/localasr/whisperModels';

describe('stripNonSpeech', () => {
  it('drops tags and music, keeps speech and profanity', () => {
    expect(stripNonSpeech('[query]')).toBe('');
    expect(stripNonSpeech('(dramatic music)')).toBe('');
    expect(stripNonSpeech('♪ ♪')).toBe('');
    expect(stripNonSpeech('Okay [laughs] so this is fucking insane (music)')).toBe('Okay so this is fucking insane');
    expect(stripNonSpeech('*sighs* Just a minute.')).toBe('Just a minute.');
    expect(stripNonSpeech('Just a minute.')).toBe('Just a minute.');
  });
});

describe('overlap de-duplication', () => {
  it('finds the repeated words at the border', () => {
    expect(overlapWords('and then he said that we should go', 'We should go home now')).toBe(3);
    expect(overlapWords('hello there', 'completely different text')).toBe(0);
    expect(overlapWords('one two', 'two three')).toBe(0); // a single word is not enough
  });
  it('is conservative: repeated words, short whole-text matches and long runs are not dropped', () => {
    expect(overlapWords('well okay okay', 'okay okay so what')).toBe(0); // a repeated word may be real speech
    expect(overlapWords('and then he said no no', 'no no no way')).toBe(0);
    expect(overlapWords('i think so', 'think so')).toBe(0); // the whole new text is 2 words: keep
    expect(overlapWords('i think so', 'think so maybe')).toBe(2);
    expect(overlapWords('a b c d e f g h i j k l', 'c d e f g h i j k l m')).toBe(0); // 10 words cannot fit 1.5 s of overlap
    expect(overlapWords('so the plan is simple', 'The plan is simple, really')).toBe(4);
    expect(dropLeadingWords([{ text: 'okay okay so' }], 0)).toEqual([{ text: 'okay okay so' }]);
  });
  it('drops leading words across segments', () => {
    const segs = [{ text: 'we should' }, { text: 'go home' }];
    expect(dropLeadingWords(segs, 3)).toEqual([{ text: 'home' }]);
    expect(dropLeadingWords(segs, 0)).toEqual(segs);
  });
});

const base = WHISPER_MODELS.find((m) => m.id === 'onnx-community/whisper-base.en')!;
const st = (p: Partial<LasrState>): LasrState => ({ model: 'ready', loaded: 1, total: 1, updatedAt: 0, rev: base.revision, ...p } as LasrState);
describe('GPU upgrade state', () => {
  const env = { gpu: true, f16: true };
  it('offers gpu-mixed for a q8/CPU model when caps say gpu+f16', () => {
    expect(asrUpgradeState(base, st({ device: 'wasm', dtype: 'q8' }), env)?.kind).toBe('offer');
    expect(asrUpgradeState(base, st({ device: 'wasm', dtype: 'q8' }), { gpu: true, f16: false })).toBeNull();
    expect(asrUpgradeState(base, st({ device: 'webgpu', dtype: 'gpu-mixed' }), env)).toBeNull();
  });
  it('shows the real failure and does not re-offer when gpu-mixed is cached', () => {
    const s = st({ device: 'wasm', dtype: 'q8', files: { q8: true, 'gpu-mixed': true }, upgradeError: 'no adapter' });
    expect(asrUpgradeState(base, s, env)).toMatchObject({ kind: 'failed', error: 'no adapter' });
  });
  it('tracks cached dtypes per state', () => {
    expect(cachedDtypes(st({ device: 'wasm', dtype: 'q8' }))).toEqual(['q8']);
    expect(cachedDtypes(st({ device: 'webgpu', dtype: 'fp16', files: { q8: true, fp16: true } }))).toEqual(['fp16', 'q8']);
    expect(cachedDtypes(st({ device: 'webgpu', dtype: 'gpu-mixed', files: { q8: true, 'gpu-mixed': true, fp16: true } }))).toEqual(['gpu-mixed', 'fp16', 'q8']);
  });
  it('after a failed legacy fp16 attempt the gpu-mixed upgrade is still offered (with the old error)', () => {
    const s = st({ device: 'wasm', dtype: 'q8', files: { q8: true, fp16: true }, upgradeError: 'ORT error code 26624112' });
    expect(asrUpgradeState(base, s, env)).toMatchObject({ kind: 'offer', bytes: base.bytes['gpu-mixed'] });
  });
});

describe('auto pick prefers small.en only on the GPU', () => {
  const ready = new Set(['onnx-community/whisper-base.en', 'onnx-community/whisper-small.en']);
  it('', () => {
    expect(pickWhisperModel('auto', 'en', ready)).toBe('onnx-community/whisper-base.en');
    expect(pickWhisperModel('auto', 'en', ready, new Set(['onnx-community/whisper-small.en']))).toBe('onnx-community/whisper-small.en');
    expect(pickWhisperModel('auto', 'en', ready, new Set(['onnx-community/whisper-base.en']))).toBe('onnx-community/whisper-base.en');
  });
});
