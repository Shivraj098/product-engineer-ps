import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  TetherError,
  assertTransition,
  runEventSchema,
  type CompletedEvent,
  type DeltaEvent,
  type FailedEvent,
  type FailureCode,
  type RunEvent,
  type RunFailure,
  type RunState,
} from '@tether/protocol';
import type { Db } from '../db';
import { RunNotRunningError } from '../errors';

export const RESTART_FAILURE_MESSAGE = 'The server restarted while this reply was being generated.';

export interface RunRecord {
  id: string;
  conversationId: string;
  userMessageId: string;
  state: RunState;
  lastSeq: number;
  failure?: RunFailure;
  createdAt: string;
  updatedAt: string;
}

export interface MessageRecord {
  id: string;
  conversationId: string;
  content: string;
  createdAt: string;
}

export interface SubmitMessageInput {
  conversationId: string;
  messageId: string;
  content: string;
}

export interface SubmitMessageResult {
  /** False when this exact message had already been submitted (an idempotent replay). */
  created: boolean;
  message: MessageRecord;
  run: RunRecord;
}

/** A run plus its assembled reply text, read at a single consistent instant. */
export interface RunView {
  run: RunRecord;
  text: string;
}

export interface TurnView extends RunView {
  message: MessageRecord;
}

/** An event that has not been assigned its position yet. The store owns `seq`. */
export type EventDraft =
  Omit<DeltaEvent, 'seq'> | Omit<CompletedEvent, 'seq'> | Omit<FailedEvent, 'seq'>;

export interface StoreOptions {
  now?: () => Date;
  newId?: () => string;
}

interface RunRow {
  id: string;
  conversation_id: string;
  user_message_id: string;
  state: RunState;
  last_seq: number;
  failure_code: FailureCode | null;
  failure_message: string | null;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  content: string;
  created_at: string;
}

interface EventRow {
  seq: number;
  type: RunEvent['type'];
  payload: string;
}

const RUN_COLUMNS = `id, conversation_id, user_message_id, state, last_seq,
  failure_code, failure_message, created_at, updated_at`;

function prepareStatements(db: Db) {
  return {
    insertConversation: db.prepare<[string, string]>(
      'INSERT INTO conversations (id, created_at) VALUES (?, ?)',
    ),
    selectConversation: db.prepare<[string], { id: string }>(
      'SELECT id FROM conversations WHERE id = ?',
    ),
    selectMessage: db.prepare<[string], MessageRow>(
      'SELECT id, conversation_id, content, created_at FROM messages WHERE id = ?',
    ),
    insertMessage: db.prepare<[string, string, string, string]>(
      'INSERT INTO messages (id, conversation_id, content, created_at) VALUES (?, ?, ?, ?)',
    ),
    insertRun: db.prepare<[string, string, string, string, string]>(
      `INSERT INTO runs (id, conversation_id, user_message_id, state, last_seq, created_at, updated_at)
       VALUES (?, ?, ?, 'running', 0, ?, ?)`,
    ),
    selectRun: db.prepare<[string], RunRow>(`SELECT ${RUN_COLUMNS} FROM runs WHERE id = ?`),
    selectRunByMessage: db.prepare<[string], RunRow>(
      `SELECT ${RUN_COLUMNS} FROM runs WHERE user_message_id = ?`,
    ),
    selectRunningRun: db.prepare<[string], { id: string }>(
      "SELECT id FROM runs WHERE conversation_id = ? AND state = 'running'",
    ),
    selectRunningRunIds: db.prepare<[], { id: string }>(
      "SELECT id FROM runs WHERE state = 'running' ORDER BY rowid",
    ),
    insertEvent: db.prepare<[string, number, string, string, string]>(
      'INSERT INTO run_events (run_id, seq, type, payload, created_at) VALUES (?, ?, ?, ?, ?)',
    ),
    updateProgress: db.prepare<[number, string, string]>(
      "UPDATE runs SET last_seq = ?, updated_at = ? WHERE id = ? AND state = 'running'",
    ),
    updateCompleted: db.prepare<[number, string, string]>(
      "UPDATE runs SET state = 'completed', last_seq = ?, updated_at = ? WHERE id = ? AND state = 'running'",
    ),
    updateFailed: db.prepare<[number, string, string, string, string]>(
      `UPDATE runs SET state = 'failed', last_seq = ?, failure_code = ?, failure_message = ?, updated_at = ?
       WHERE id = ? AND state = 'running'`,
    ),
    selectEventsAfter: db.prepare<[string, number, number], EventRow>(
      'SELECT seq, type, payload FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?',
    ),
    selectDeltas: db.prepare<[string], EventRow>(
      "SELECT seq, type, payload FROM run_events WHERE run_id = ? AND type = 'delta' ORDER BY seq",
    ),
    selectTurnRows: db.prepare<[string], MessageRow & { run_id: string }>(
      `SELECT m.id, m.conversation_id, m.content, m.created_at, r.id AS run_id
       FROM messages m JOIN runs r ON r.user_message_id = m.id
       WHERE m.conversation_id = ? ORDER BY m.rowid`,
    ),
  };
}

function payloadOf(draft: EventDraft): Record<string, unknown> {
  switch (draft.type) {
    case 'delta':
      return { text: draft.text };
    case 'completed':
      return {};
    case 'failed':
      return { code: draft.code, message: draft.message };
  }
}

function rowToEvent(row: EventRow): RunEvent {
  const payload = JSON.parse(row.payload) as Record<string, unknown>;
  return runEventSchema.parse({ ...payload, seq: row.seq, type: row.type });
}

function toRun(row: RunRow): RunRecord {
  const run: RunRecord = {
    id: row.id,
    conversationId: row.conversation_id,
    userMessageId: row.user_message_id,
    state: row.state,
    lastSeq: row.last_seq,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.failure_code !== null && row.failure_message !== null) {
    run.failure = { code: row.failure_code, message: row.failure_message };
  }
  return run;
}

function toMessage(row: MessageRow): MessageRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    content: row.content,
    createdAt: row.created_at,
  };
}

/**
 * The only component that reads or writes run history. It is the single owner of event
 * ordering: `seq` is assigned here, inside a transaction, as `last_seq + 1`.
 */
export class SqliteRunStore {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly sql: ReturnType<typeof prepareStatements>;
  private readonly submitTx: Database.Transaction<
    (input: SubmitMessageInput) => SubmitMessageResult
  >;
  private readonly appendTx: Database.Transaction<(runId: string, draft: EventDraft) => RunEvent>;
  private readonly runViewTx: Database.Transaction<(runId: string) => RunView>;
  private readonly turnsTx: Database.Transaction<(conversationId: string) => TurnView[]>;
  private readonly failInterruptedTx: Database.Transaction<() => string[]>;

  constructor(db: Db, options: StoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? randomUUID;
    this.sql = prepareStatements(db);
    this.submitTx = db.transaction((input: SubmitMessageInput) => this.submit(input));
    this.appendTx = db.transaction((runId: string, draft: EventDraft) => this.append(runId, draft));
    this.runViewTx = db.transaction((runId: string) => this.readRunView(runId));
    this.turnsTx = db.transaction((conversationId: string) => this.readTurns(conversationId));
    this.failInterruptedTx = db.transaction(() => this.failInterrupted());
  }

  createConversation(): string {
    const id = this.newId();
    this.sql.insertConversation.run(id, this.timestamp());
    return id;
  }

  /**
   * Records a user message and starts its run, atomically. Submitting the same message
   * again (same id, same content) returns the existing run instead of creating another,
   * so a client can safely retry after a lost response.
   */
  submitMessage(input: SubmitMessageInput): SubmitMessageResult {
    return this.submitTx.immediate(input);
  }

  appendDelta(runId: string, text: string): RunEvent {
    return this.appendTx.immediate(runId, { type: 'delta', text });
  }

  /** Terminal: appends `completed` and moves the run to `completed` in one transaction. */
  completeRun(runId: string): RunEvent {
    return this.appendTx.immediate(runId, { type: 'completed' });
  }

  /** Terminal: appends `failed` and moves the run to `failed` in one transaction. */
  failRun(runId: string, failure: RunFailure): RunEvent {
    return this.appendTx.immediate(runId, { type: 'failed', ...failure });
  }

  getRun(runId: string): RunRecord | undefined {
    const row = this.sql.selectRun.get(runId);
    return row ? toRun(row) : undefined;
  }

  /** Events with `seq > afterSeq`, in order. This is what replay and live delivery both read. */
  readEventsAfter(runId: string, afterSeq: number, limit: number): RunEvent[] {
    return this.sql.selectEventsAfter.all(runId, afterSeq, limit).map(rowToEvent);
  }

  getRunView(runId: string): RunView {
    return this.runViewTx(runId);
  }

  getConversationTurns(conversationId: string): TurnView[] {
    return this.turnsTx(conversationId);
  }

  /**
   * Restart recovery: a run still marked `running` when the process starts has lost its
   * generator. Each one is failed with an explicit terminal event so history stays correct.
   */
  failInterruptedRuns(): string[] {
    return this.failInterruptedTx.immediate();
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private requireRun(runId: string): RunRow {
    const row = this.sql.selectRun.get(runId);
    if (!row) {
      throw new TetherError('RUN_NOT_FOUND', `Run ${runId} does not exist.`);
    }
    return row;
  }

  private submit(input: SubmitMessageInput): SubmitMessageResult {
    const { conversationId, messageId, content } = input;
    if (!this.sql.selectConversation.get(conversationId)) {
      throw new TetherError(
        'CONVERSATION_NOT_FOUND',
        `Conversation ${conversationId} does not exist.`,
      );
    }

    const existing = this.sql.selectMessage.get(messageId);
    if (existing) {
      if (existing.conversation_id !== conversationId || existing.content !== content) {
        throw new TetherError(
          'MESSAGE_ID_REUSED',
          'This messageId was already used for a different message.',
        );
      }
      const run = this.sql.selectRunByMessage.get(messageId);
      if (!run) {
        throw new Error(`Invariant violated: message ${messageId} has no run.`);
      }
      return { created: false, message: toMessage(existing), run: toRun(run) };
    }

    if (this.sql.selectRunningRun.get(conversationId)) {
      throw new TetherError(
        'RUN_IN_PROGRESS',
        'A reply is still being generated for this conversation.',
      );
    }

    const timestamp = this.timestamp();
    const runId = this.newId();
    this.sql.insertMessage.run(messageId, conversationId, content, timestamp);
    this.sql.insertRun.run(runId, conversationId, messageId, timestamp, timestamp);

    return {
      created: true,
      message: { id: messageId, conversationId, content, createdAt: timestamp },
      run: toRun(this.requireRun(runId)),
    };
  }

  private append(runId: string, draft: EventDraft): RunEvent {
    const run = this.requireRun(runId);
    if (draft.type === 'delta') {
      if (run.state !== 'running') {
        throw new RunNotRunningError(runId, run.state);
      }
    } else {
      assertTransition(run.state, draft.type);
    }

    const seq = run.last_seq + 1;
    // Validates the draft (for example, rejects an empty delta) before anything is written.
    const event = runEventSchema.parse({ ...draft, seq });
    const timestamp = this.timestamp();
    this.sql.insertEvent.run(runId, seq, event.type, JSON.stringify(payloadOf(draft)), timestamp);

    const result =
      event.type === 'delta'
        ? this.sql.updateProgress.run(seq, timestamp, runId)
        : event.type === 'completed'
          ? this.sql.updateCompleted.run(seq, timestamp, runId)
          : this.sql.updateFailed.run(seq, event.code, event.message, timestamp, runId);
    if (result.changes !== 1) {
      throw new Error(
        `Invariant violated: run ${runId} was not running when its state was updated.`,
      );
    }
    return event;
  }

  private assembleText(runId: string): string {
    return this.sql.selectDeltas
      .all(runId)
      .map(rowToEvent)
      .map((event) => (event.type === 'delta' ? event.text : ''))
      .join('');
  }

  private readRunView(runId: string): RunView {
    return { run: toRun(this.requireRun(runId)), text: this.assembleText(runId) };
  }

  private readTurns(conversationId: string): TurnView[] {
    if (!this.sql.selectConversation.get(conversationId)) {
      throw new TetherError(
        'CONVERSATION_NOT_FOUND',
        `Conversation ${conversationId} does not exist.`,
      );
    }
    return this.sql.selectTurnRows.all(conversationId).map((row) => ({
      message: toMessage(row),
      ...this.readRunView(row.run_id),
    }));
  }

  private failInterrupted(): string[] {
    const runIds = this.sql.selectRunningRunIds.all().map((row) => row.id);
    for (const runId of runIds) {
      this.append(runId, {
        type: 'failed',
        code: 'SERVER_RESTARTED',
        message: RESTART_FAILURE_MESSAGE,
      });
    }
    return runIds;
  }
}
