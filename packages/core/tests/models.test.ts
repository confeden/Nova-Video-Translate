import { describe, expect, it } from 'vitest';
import { pickModel } from '../src/models';

describe('pickModel', () => {
  it('returns the id matching the earliest preference', () => {
    const available = ['gemini-1.5-flash', 'gemini-2.5-pro', 'gemini-2.5-flash'];
    expect(pickModel(available, [/2\.5-pro/, /2\.5-flash/])).toBe('gemini-2.5-pro');
    expect(pickModel(available, [/nope/, /flash/])).toBe('gemini-1.5-flash');
    expect(pickModel(available, [/nope/])).toBeUndefined();
  });
});
