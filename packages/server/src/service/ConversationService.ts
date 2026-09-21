import {
  TetherError,
  type ConversationSnapshot,
  type CreateConversationResponse,
  type RunEvent,
  type RunSnapshot,
  type SendMessageRequest,
  type SendMessageResponse,
} from '@tether/protocol';
import { assertCursorReplayable, oldestReplayableSeq } from '../domain/cursor';
import type { RunExecutor } from '../runtime/RunExecutor';
import type { RunNotifier } from '../runtime/RunNotifier';
import { tailRun } from '../runtime/tail';
import type { RunRecord, SqliteRunStore } from '../store/SqliteRunStore';

export interface ConversationServiceDeps {
  store: SqliteRunStore;
  notifier: RunNotifier;
  executor: RunExecutor;
  /** How many of a run's most recent events can be replayed. 0 means all of them. */
  replayWindow: number;
}

export interface SendMessageResult {
  /** False when this was an idempotent replay of an already-submitted message. */
  created: boolean;
  response: SendMessageResponse;
}

/**
 * The application layer: everything the HTTP layer needs, with all the rules in one place
 * and no knowledge of HTTP. It can be driven directly by tests.
 */
export class ConversationService {
  private readonly deps: ConversationServiceDeps;

  constructor(deps: ConversationServiceDeps) {
    this.deps = deps;
  }

  createConversation(): CreateConversationResponse {
    return { conversationId: this.deps.store.createConversation() };
  }

  /** Stores the message and starts exactly one run for it. Safe to call again on retry. */
  sendMessage(conversationId: string, request: SendMessageRequest): SendMessageResult {
    const { store, executor } = this.deps;
    const { created, message, run } = store.submitMessage({
      conversationId,
      messageId: request.messageId,
      content: request.content,
    });
    if (created) {
      void executor.start(run.id, message.content);
    }
    return {
      created,
      response: {
        messageId: message.id,
        run: { id: run.id, state: run.state, lastSeq: run.lastSeq },
      },
    };
  }

  getRunSnapshot(runId: string): RunSnapshot {
    const { run, text } = this.deps.store.getRunView(runId);
    return this.toSnapshot(run, text);
  }

  getConversationSnapshot(conversationId: string): ConversationSnapshot {
    const turns = this.deps.store.getConversationTurns(conversationId);
    return {
      conversationId,
      turns: turns.map(({ message, run, text }) => ({
        message: { id: message.id, content: message.content, createdAt: message.createdAt },
        run: this.toSnapshot(run, text),
      })),
    };
  }

  /**
   * Streams a run's events after `cursor`. The checks happen here, eagerly, so a caller
   * gets a proper error before it commits to a stream, not in the middle of one.
   */
  openEventStream(
    runId: string,
    cursor: number,
    signal: AbortSignal,
  ): AsyncGenerator<RunEvent, void, undefined> {
    const { store, notifier, replayWindow } = this.deps;
    const run = store.getRun(runId);
    if (!run) {
      throw new TetherError('RUN_NOT_FOUND', `Run ${runId} does not exist.`);
    }
    assertCursorReplayable(cursor, run.lastSeq, replayWindow);
    return tailRun({ store, notifier }, runId, cursor, signal);
  }

  /** Called once at startup. Returns the ids of the runs it had to fail. */
  recoverInterruptedRuns(): string[] {
    return this.deps.store.failInterruptedRuns();
  }

  private toSnapshot(run: RunRecord, text: string): RunSnapshot {
    return {
      runId: run.id,
      conversationId: run.conversationId,
      state: run.state,
      lastSeq: run.lastSeq,
      oldestReplayableSeq: oldestReplayableSeq(run.lastSeq, this.deps.replayWindow),
      text,
      ...(run.failure ? { failure: run.failure } : {}),
    };
  }
}
