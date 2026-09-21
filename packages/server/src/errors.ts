import type { RunState } from '@tether/protocol';

/** An event was appended to a run that has already reached a terminal state. */
export class RunNotRunningError extends Error {
  readonly runId: string;
  readonly state: RunState;

  constructor(runId: string, state: RunState) {
    super(`Run ${runId} is ${state}; events can only be appended while it is running.`);
    this.name = 'RunNotRunningError';
    this.runId = runId;
    this.state = state;
  }
}
