import { describe, expect, it } from 'vitest';
import { stateText, voiceLine } from '../src/ui/status';

describe('status block texts (owner decision: no problem details in the UI)', () => {
  it('the starting line never carries a slow-start complaint', () => {
    expect(stateText('starting', 'wait')).toBe('Подготовка перевода…');
    expect(stateText('starting', 'switch')).not.toContain('медленно');
  });
  it('the progress hint of the first fragment and the voice line stay', () => {
    expect(stateText('starting', undefined, { etaSec: 12, source: 'Яндекс' })).toContain('первый фрагмент через ~12 с (Яндекс)');
    expect(voiceLine('Яндекс — обычные')).toBe('Озвучка: Яндекс — обычные');
  });
});
