export const RUN_STATES = ['running', 'completed', 'failed'] as const;
export type RunState = (typeof RUN_STATES)[number];
export type TerminalRunState = Exclude<RunState, 'running'>;

/**
 * The only legal state changes for a run. A state with no outgoing transitions
 * is terminal: once a run reaches it, it never changes again.
 * Only explicitely defined transitions are allowed. For example, a run cannot transition from
 * `completed` to `running`.
 * `running` is the only state that can transition to `completed` or `failed`.
 * completed and failed are terminal states, and cannot transition to any other state.
 */
const ALLOWED_TRANSITIONS: Readonly<Record<RunState, readonly RunState[]>> = {
  running: ['completed', 'failed'],
  completed: [],
  failed: [],
};

export function canTransition(from: RunState, to: RunState): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function isTerminalState(state: RunState): state is TerminalRunState {
  return ALLOWED_TRANSITIONS[state].length === 0;
}

export class InvalidTransitionError extends Error {
  readonly from: RunState;
  readonly to: RunState;

  constructor(from: RunState, to: RunState) {
    super(`Invalid run state transition: ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
    this.from = from;
    this.to = to;
  }
}

export function assertTransition(from: RunState, to: RunState): void {
  if (!canTransition(from, to)) {
    throw new InvalidTransitionError(from, to);
  }
}