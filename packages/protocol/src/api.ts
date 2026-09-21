import type { FailedEvent } from './events';
import type { RunState } from './runState';

/**
 * Response shapes of the HTTP API. These are plain types (no runtime validation):
 * we validate what crosses a trust boundary inbound (request bodies, stream events),
 * and treat our own server's JSON responses as typed.
 */

export type RunFailure = Pick<FailedEvent, 'code' | 'message'>;

export interface CreateConversationResponse {
  conversationId: string;
}

export interface RunSummary {
  id: string;
  state: RunState;
  lastSeq: number;
}

export interface SendMessageResponse {
  messageId: string;
  run: RunSummary;
}

/** Everything a client needs to (re)build a run's view and resume streaming from `lastSeq`. */
export interface RunSnapshot {
  runId: string;
  conversationId: string;
  state: RunState;
  lastSeq: number;
  oldestReplayableSeq: number;
  text: string;
  failure?: RunFailure;
}

export interface ConversationTurn {
  message: { id: string; content: string; createdAt: string };
  run: RunSnapshot;
}

export interface ConversationSnapshot {
  conversationId: string;
  turns: ConversationTurn[];
}
