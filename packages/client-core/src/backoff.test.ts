import { describe, expect, it } from 'vitest';
import { DEFAULT_BACKOFF, backoffDelay } from './backoff';

const policy = { baseMs: 100, capMs: 1000, maxAttempts: 8 };

describe('backoffDelay', () => {
  it('grows exponentially up to the cap', () => {
    const nearlyMax = () => 0.999;
    expect([1, 2, 3, 4, 5, 6].map((attempt) => backoffDelay(attempt, policy, nearlyMax))).toEqual([
      99, 199, 399, 799, 999, 999,
    ]);
  });

  it('is random between zero and the ceiling (full jitter)', () => {
    expect(backoffDelay(3, policy, () => 0)).toBe(0);
    expect(backoffDelay(3, policy, () => 0.5)).toBe(200);
  });

  it('never exceeds the cap however many attempts have failed', () => {
    for (let attempt = 1; attempt <= 50; attempt += 1) {
      expect(backoffDelay(attempt, policy, () => 0.999999)).toBeLessThan(policy.capMs);
    }
  });

  it('has a sensible default: half a second up to eight seconds, eight attempts', () => {
    expect(DEFAULT_BACKOFF).toEqual({ baseMs: 500, capMs: 8000, maxAttempts: 8 });
  });
});