import type { RunEvent, RunFailure, RunSnapshot } from '@tether/protocol';

export type RunStatus = 'running' | 'completed' | 'failed';

export interface RunStats {
  applied: number;
  duplicatesIgnored: number;
  gapsDetected: number;
  afterTerminalIgnored: number;
}

/** Everything the client knows about one run. `lastSeq` IS the resume cursor. */
export interface RunView {
  runId: string;
  status: RunStatus;
  text: string;
  lastSeq: number;
  failure?: RunFailure;
  stats: RunStats;
}

export type ApplyOutcome = 'applied' | 'duplicate' | 'gap' | 'after-terminal';

const EMPTY_STATS: RunStats = {
  applied: 0,
  duplicatesIgnored: 0,
  gapsDetected: 0,
  afterTerminalIgnored: 0,
};

export function createRunView(runId: string): RunView {
  return { runId, status: 'running', text: '', lastSeq: 0, stats: { ...EMPTY_STATS } };
}

/** Rebuilds a view from a server snapshot (reload, or recovery from a stale cursor). */
export function viewFromSnapshot(snapshot: RunSnapshot, stats: RunStats = EMPTY_STATS): RunView {
  return {
    runId: snapshot.runId,
    status: snapshot.state,
    text: snapshot.text,
    lastSeq: snapshot.lastSeq,
    ...(snapshot.failure ? { failure: snapshot.failure } : {}),
    stats: { ...stats },
  };
}

/**
 * The client-side guarantee: an event is applied only if it is exactly the next one.
 * Older events are duplicates, newer ones mean something was skipped. Either way the
 * view is left untouched, so text can never be repeated or silently lost.
 */
export function applyRunEvent(
  view: RunView,
  event: RunEvent,
): { view: RunView; outcome: ApplyOutcome } {
  const reject = (outcome: ApplyOutcome, stat: keyof RunStats) => ({
    view: { ...view, stats: { ...view.stats, [stat]: view.stats[stat] + 1 } },
    outcome,
  });

  if (view.status !== 'running' && event.seq > view.lastSeq) {
    return reject('after-terminal', 'afterTerminalIgnored');
  }
  if (event.seq <= view.lastSeq) {
    return reject('duplicate', 'duplicatesIgnored');
  }
  if (event.seq !== view.lastSeq + 1) {
    return reject('gap', 'gapsDetected');
  }

  const next: RunView = {
    ...view,
    lastSeq: event.seq,
    stats: { ...view.stats, applied: view.stats.applied + 1 },
  };
  switch (event.type) {
    case 'delta':
      next.text = view.text + event.text;
      break;
    case 'completed':
      next.status = 'completed';
      break;
    case 'failed':
      next.status = 'failed';
      next.failure = { code: event.code, message: event.message };
      break;
  }
  return { view: next, outcome: 'applied' };
}