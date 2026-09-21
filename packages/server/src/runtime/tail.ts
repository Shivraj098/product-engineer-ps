import { isTerminalEvent, type RunEvent } from '@tether/protocol';
import type { SqliteRunStore } from '../store/SqliteRunStore';
import type { RunNotifier } from './RunNotifier';

export const TAIL_BATCH_SIZE = 200;

export interface TailDeps {
  store: SqliteRunStore;
  notifier: RunNotifier;
}

/**
 * One connection's walk through a run's event log, starting after `after`.
 *
 * There is no separate "live" channel: read what is after the cursor, yield it, and when
 * caught up wait to be notified, then read again. A "live" event is just the next row to
 * appear in the log, so every event reaches a reader through exactly one path, in `seq`
 * order, once. It ends after yielding the terminal event, or when `signal` aborts.
 */
export async function* tailRun(
  deps: TailDeps,
  runId: string,
  after: number,
  signal: AbortSignal,
): AsyncGenerator<RunEvent, void, undefined> {
  const { store, notifier } = deps;
  let sent = after;

  while (!signal.aborted) {
    const batch = store.readEventsAfter(runId, sent, TAIL_BATCH_SIZE);
    for (const event of batch) {
      yield event;
      sent = event.seq;
      if (isTerminalEvent(event)) {
        return;
      }
    }

    if (batch.length === 0) {
      const run = store.getRun(runId);
      if (!run || run.state !== 'running') {
        return; // Terminal and fully read: nothing more will ever be appended.
      }
      // No `await` between the empty read above and this registration, and the store is
      // synchronous, so an append cannot slip in between and be missed.
      await notifier.waitForChange(runId, signal);
    }
  }
}
