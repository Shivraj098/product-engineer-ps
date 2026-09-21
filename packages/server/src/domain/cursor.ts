import { TetherError, type CursorRecovery } from '@tether/protocol';

/**
 * The earliest `seq` a client may still replay. With no replay window (0) everything is
 * replayable. With a window of N, only the N most recent events are.
 */
export function oldestReplayableSeq(lastSeq: number, replayWindow: number): number {
  if (replayWindow <= 0) {
    return 1;
  }
  return Math.max(1, lastSeq - replayWindow + 1);
}

/**
 * Decides whether a run can be safely replayed from `cursor` (the highest seq the client
 * has applied). If not, it throws an explicit, recoverable error rather than letting the
 * client silently miss data.
 */
export function assertCursorReplayable(
  cursor: number,
  lastSeq: number,
  replayWindow: number,
): void {
  const oldest = oldestReplayableSeq(lastSeq, replayWindow);
  const recovery: CursorRecovery = {
    action: 'RESYNC_FROM_SNAPSHOT',
    lastSeq,
    oldestReplayableSeq: oldest,
  };

  if (cursor > lastSeq) {
    throw new TetherError(
      'CURSOR_AHEAD',
      `Cursor ${cursor} is ahead of this run's last event (${lastSeq}).`,
      recovery,
    );
  }
  // The client needs events cursor + 1 onwards, so the oldest usable cursor is oldest - 1.
  if (cursor < oldest - 1) {
    throw new TetherError(
      'CURSOR_EXPIRED',
      `Events after cursor ${cursor} are no longer available for replay.`,
      recovery,
    );
  }
}
