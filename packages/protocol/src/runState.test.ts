import { describe, expect, it } from 'vitest';
import {
  InvalidTransitionError,
  RUN_STATES,
  assertTransition,
  canTransition,
  isTerminalState,
  type RunState,
} from './runState';

const allowed: Array<[RunState, RunState]> = [
  ['running', 'completed'],
  ['running', 'failed'],
];

// Every (from, to) pair that is not explicitly allowed, including self-transitions.
const rejected = RUN_STATES.flatMap((from) => RUN_STATES.map((to) => [from, to] as const)).filter(
  ([from, to]) => !allowed.some(([f, t]) => f === from && t === to),
);

describe('run state machine', () => {
  it.each(allowed)('allows %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
    expect(() => assertTransition(from, to)).not.toThrow();
  });

  it.each(rejected)('rejects %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
    expect(() => assertTransition(from, to)).toThrow(InvalidTransitionError);
  });

  it('treats exactly completed and failed as terminal', () => {
    expect(RUN_STATES.filter(isTerminalState)).toEqual(['completed', 'failed']);
  });

  it('a failed run can never become completed', () => {
    expect(canTransition('failed', 'completed')).toBe(false);
  });

  it('reports both states in the error', () => {
    try {
      assertTransition('failed', 'completed');
      expect.unreachable('assertTransition should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidTransitionError);
      const invalid = error as InvalidTransitionError;
      expect(invalid.from).toBe('failed');
      expect(invalid.to).toBe('completed');
      expect(invalid.message).toContain('failed -> completed');
    }
  });
});