import { describe, expect, it } from 'vitest';
import { KeyPool } from '../src/keypool';

describe('KeyPool', () => {
  it('skips exhausted keys until the cooldown passes', () => {
    let now = 0;
    const pool = new KeyPool(['a', 'b'], { now: () => now });
    expect(pool.current()).toBe('a');
    pool.markExhausted('a', 1000);
    expect(pool.current()).toBe('b');
    now = 1000;
    expect(pool.current()).toBe('b');
    pool.markExhausted('b');
    expect(pool.current()).toBe('a');
  });

  it('fires onAllExhausted when every key is unavailable', () => {
    let fired = 0;
    const pool = new KeyPool(['only'], { onAllExhausted: () => fired++ });
    pool.markExhausted('only');
    expect(pool.current()).toBeUndefined();
    expect(fired).toBe(1);
  });
});
