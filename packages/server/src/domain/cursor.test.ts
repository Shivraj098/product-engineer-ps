import { describe, expect, it } from 'vitest';
import { expectTetherError } from '../testing/helpers';
import { assertCursorReplayable, oldestReplayableSeq } from './cursor';

describe('oldestReplayableSeq', () => {
  it('is 1 when there is no replay window', () => {
    expect(oldestReplayableSeq(500, 0)).toBe(1);
  });

  it.each([
    [0, 1],
    [30, 1],
    [50, 1],
    [51, 2],
    [120, 71],
  ])('with a window of 50 and lastSeq %d it is %d', (lastSeq, expected) => {
    expect(oldestReplayableSeq(lastSeq, 50)).toBe(expected);
  });
});

describe('assertCursorReplayable', () => {
  it.each([
    ['a brand new run', 0, 0, 0],
    ['the very start of a run', 0, 12, 0],
    ['exactly the last event (nothing missed)', 12, 12, 0],
    ['the oldest cursor that still has every later event', 70, 120, 50],
  ])('accepts %s', (_label, cursor, lastSeq, window) => {
    expect(() => assertCursorReplayable(cursor, lastSeq, window)).not.toThrow();
  });

  it('rejects a cursor ahead of the run, with a recovery hint', () => {
    const error = expectTetherError(() => assertCursorReplayable(13, 12, 0), 'CURSOR_AHEAD');
    expect(error.recovery).toEqual({
      action: 'RESYNC_FROM_SNAPSHOT',
      lastSeq: 12,
      oldestReplayableSeq: 1,
    });
  });

  it('rejects a cursor older than the replay window, with a recovery hint', () => {
    const error = expectTetherError(() => assertCursorReplayable(69, 120, 50), 'CURSOR_EXPIRED');
    expect(error.recovery).toEqual({
      action: 'RESYNC_FROM_SNAPSHOT',
      lastSeq: 120,
      oldestReplayableSeq: 71,
    });
  });
});
