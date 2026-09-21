import { TetherError, type ErrorCode, type RunEvent } from '@tether/protocol';
import { expect } from 'vitest';

export async function collect(stream: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

export function seqsOf(events: readonly RunEvent[]): number[] {
  return events.map((event) => event.seq);
}

export function textOf(events: readonly RunEvent[]): string {
  return events.map((event) => (event.type === 'delta' ? event.text : '')).join('');
}

/** Ids like "id-1", "id-2", ... so test failures are easy to read. */
export function sequentialIds(prefix = 'id'): () => string {
  let next = 0;
  return () => {
    next += 1;
    return `${prefix}-${next}`;
  };
}

/** A clock that advances one second per call, so timestamps are deterministic and ordered. */
export function tickingClock(): () => Date {
  let seconds = 0;
  return () => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds++));
}

export function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('Expected the function to throw, but it did not.');
}

export function expectTetherError(fn: () => unknown, code: ErrorCode): TetherError {
  const error = thrownBy(fn);
  expect(error).toBeInstanceOf(TetherError);
  expect((error as TetherError).code).toBe(code);
  return error as TetherError;
}
