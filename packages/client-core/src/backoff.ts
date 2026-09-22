export interface BackoffPolicy {
  baseMs: number;
  capMs: number;
  /** Consecutive failed attempts allowed before giving up. */
  maxAttempts: number;
}

export const DEFAULT_BACKOFF: BackoffPolicy = { baseMs: 500, capMs: 8000, maxAttempts: 8 };

/**
 * Exponential backoff with full jitter: a random delay between 0 and min(cap, base * 2^(n-1)).
 * Jitter stops many clients that dropped together from reconnecting in lockstep.
 * `attempt` starts at 1. `random` returns a number in [0, 1) and is injectable for tests.
 */
export function backoffDelay(
  attempt: number,
  policy: BackoffPolicy = DEFAULT_BACKOFF,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(policy.capMs, policy.baseMs * 2 ** (attempt - 1));
  return Math.floor(random() * ceiling);
}
