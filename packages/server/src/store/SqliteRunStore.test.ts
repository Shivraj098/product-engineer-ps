import { InvalidTransitionError } from '@tether/protocol';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../db';
import { RunNotRunningError } from '../errors';
import { expectTetherError, seqsOf, sequentialIds, tickingClock } from '../testing/helpers';
import { RESTART_FAILURE_MESSAGE, SqliteRunStore } from './SqliteRunStore';

function setup() {
  const db = openDatabase(':memory:');
  const store = new SqliteRunStore(db, { now: tickingClock(), newId: sequentialIds() });
  const conversationId = store.createConversation();
  const start = (messageId = 'm1', content = 'hello') =>
    store.submitMessage({ conversationId, messageId, content });
  return { db, store, conversationId, start };
}

describe('submitMessage', () => {
  it('records the message and starts a running run at position 0', () => {
    const { start, conversationId } = setup();
    const { created, message, run } = start('m1', 'hello');
    expect(created).toBe(true);
    expect(message).toMatchObject({ id: 'm1', conversationId, content: 'hello' });
    expect(run).toMatchObject({ state: 'running', lastSeq: 0, userMessageId: 'm1' });
  });

  it('returns the existing run when the same message is submitted again', () => {
    const { db, start } = setup();
    const first = start('m1', 'hello');
    const again = start('m1', 'hello');
    expect(again.created).toBe(false);
    expect(again.run.id).toBe(first.run.id);
    expect(db.prepare('SELECT COUNT(*) AS n FROM runs').get()).toEqual({ n: 1 });
  });

  it('still treats a retry as a replay while its run is in progress', () => {
    const { start } = setup();
    start('m1', 'hello');
    expect(start('m1', 'hello').created).toBe(false);
  });

  it('rejects a reused message id with different content', () => {
    const { start } = setup();
    start('m1', 'hello');
    expectTetherError(() => start('m1', 'something else'), 'MESSAGE_ID_REUSED');
  });

  it('rejects a reused message id from another conversation', () => {
    const { store, start } = setup();
    start('m1', 'hello');
    const other = store.createConversation();
    expectTetherError(
      () => store.submitMessage({ conversationId: other, messageId: 'm1', content: 'hello' }),
      'MESSAGE_ID_REUSED',
    );
  });

  it('allows only one active run per conversation', () => {
    const { store, start } = setup();
    const { run } = start('m1');
    expectTetherError(() => start('m2', 'second'), 'RUN_IN_PROGRESS');

    store.completeRun(run.id);
    const next = start('m2', 'second');
    expect(next.created).toBe(true);
    expect(next.run.id).not.toBe(run.id);
  });

  it('rejects an unknown conversation', () => {
    const { store } = setup();
    expectTetherError(
      () => store.submitMessage({ conversationId: 'nope', messageId: 'm1', content: 'hi' }),
      'CONVERSATION_NOT_FOUND',
    );
  });
});

describe('appending events', () => {
  it('assigns gapless positions starting at 1 and tracks the last one on the run', () => {
    const { store, start } = setup();
    const { run } = start();
    const appended = ['a', 'b', 'c'].map((text) => store.appendDelta(run.id, text));
    expect(seqsOf(appended)).toEqual([1, 2, 3]);
    expect(store.getRun(run.id)?.lastSeq).toBe(3);
  });

  it('reads events after a cursor, in order, bounded by a limit', () => {
    const { store, start } = setup();
    const { run } = start();
    ['a', 'b', 'c', 'd', 'e'].forEach((text) => store.appendDelta(run.id, text));

    expect(seqsOf(store.readEventsAfter(run.id, 0, 100))).toEqual([1, 2, 3, 4, 5]);
    expect(seqsOf(store.readEventsAfter(run.id, 2, 100))).toEqual([3, 4, 5]);
    expect(seqsOf(store.readEventsAfter(run.id, 2, 2))).toEqual([3, 4]);
    expect(store.readEventsAfter(run.id, 5, 100)).toEqual([]);
  });

  it('a rejected append does not consume a position', () => {
    const { store, start } = setup();
    const { run } = start();
    expect(() => store.appendDelta(run.id, '')).toThrow();
    expect(store.appendDelta(run.id, 'a').seq).toBe(1);
  });

  it('rejects appends to an unknown run', () => {
    const { store } = setup();
    expectTetherError(() => store.appendDelta('nope', 'a'), 'RUN_NOT_FOUND');
  });
});

describe('terminal states', () => {
  it('completing appends a terminal event at the next position', () => {
    const { store, start } = setup();
    const { run } = start();
    store.appendDelta(run.id, 'a');
    const terminal = store.completeRun(run.id);
    expect(terminal).toEqual({ seq: 2, type: 'completed' });
    expect(store.getRun(run.id)).toMatchObject({ state: 'completed', lastSeq: 2 });
  });

  it('nothing can be appended after a run completes', () => {
    const { store, start } = setup();
    const { run } = start();
    store.completeRun(run.id);
    expect(() => store.appendDelta(run.id, 'late')).toThrow(RunNotRunningError);
    expect(() => store.completeRun(run.id)).toThrow(InvalidTransitionError);
    expect(() => store.failRun(run.id, { code: 'GENERATOR_ERROR', message: 'x' })).toThrow(
      InvalidTransitionError,
    );
    expect(store.readEventsAfter(run.id, 0, 100)).toHaveLength(1);
  });

  it('a failed run keeps its history and can never become completed', () => {
    const { store, start } = setup();
    const { run } = start();
    store.appendDelta(run.id, 'a');
    store.appendDelta(run.id, 'b');
    store.failRun(run.id, { code: 'GENERATOR_ERROR', message: 'boom' });

    expect(() => store.completeRun(run.id)).toThrow(InvalidTransitionError);
    expect(() => store.appendDelta(run.id, 'c')).toThrow(RunNotRunningError);

    expect(store.getRun(run.id)).toMatchObject({
      state: 'failed',
      lastSeq: 3,
      failure: { code: 'GENERATOR_ERROR', message: 'boom' },
    });
    expect(store.readEventsAfter(run.id, 0, 100).map((event) => event.type)).toEqual([
      'delta',
      'delta',
      'failed',
    ]);
  });
});

describe('database constraints (the last line of defence)', () => {
  it('refuses a duplicate position within a run', () => {
    const { db, store, start } = setup();
    const { run } = start();
    store.appendDelta(run.id, 'a');
    const insertDuplicate = () =>
      db
        .prepare(
          "INSERT INTO run_events (run_id, seq, type, payload, created_at) VALUES (?, 1, 'delta', '{}', 'x')",
        )
        .run(run.id);
    expect(insertDuplicate).toThrow(/UNIQUE|PRIMARY KEY/i);
  });

  it('refuses a second running run in the same conversation', () => {
    const { db, start, conversationId } = setup();
    start('m1');
    db.prepare(
      "INSERT INTO messages (id, conversation_id, content, created_at) VALUES ('m2', ?, 'x', 't')",
    ).run(conversationId);
    const insertSecondRun = () =>
      db
        .prepare(
          "INSERT INTO runs (id, conversation_id, user_message_id, state, created_at, updated_at) VALUES ('r2', ?, 'm2', 'running', 't', 't')",
        )
        .run(conversationId);
    expect(insertSecondRun).toThrow(/UNIQUE/i);
  });

  it('refuses a failed run that has no failure code', () => {
    const { db, start } = setup();
    const { run } = start();
    const markFailed = () =>
      db.prepare("UPDATE runs SET state = 'failed' WHERE id = ?").run(run.id);
    expect(markFailed).toThrow(/CHECK/i);
  });
});

describe('consistent reads', () => {
  it('assembles the reply text and last position from the same instant', () => {
    const { store, start } = setup();
    const { run } = start();
    ['Hello ', 'wor', 'ld'].forEach((text) => store.appendDelta(run.id, text));
    const view = store.getRunView(run.id);
    expect(view.text).toBe('Hello world');
    expect(view.run.lastSeq).toBe(3);
  });

  it('includes the failure of a failed run', () => {
    const { store, start } = setup();
    const { run } = start();
    store.failRun(run.id, { code: 'GENERATOR_ERROR', message: 'boom' });
    expect(store.getRunView(run.id).run.failure).toEqual({
      code: 'GENERATOR_ERROR',
      message: 'boom',
    });
  });

  it('lists a conversation as turns in the order they were sent', () => {
    const { store, start, conversationId } = setup();
    const first = start('m1', 'first');
    store.appendDelta(first.run.id, 'one');
    store.completeRun(first.run.id);
    const second = start('m2', 'second');
    store.appendDelta(second.run.id, 'two');

    const turns = store.getConversationTurns(conversationId);
    expect(turns.map((turn) => [turn.message.content, turn.text, turn.run.state])).toEqual([
      ['first', 'one', 'completed'],
      ['second', 'two', 'running'],
    ]);
  });

  it('rejects an unknown conversation', () => {
    const { store } = setup();
    expectTetherError(() => store.getConversationTurns('nope'), 'CONVERSATION_NOT_FOUND');
  });
});

describe('failInterruptedRuns', () => {
  it('fails every running run with an explicit terminal event and leaves finished runs alone', () => {
    const { store, start, conversationId } = setup();
    const finished = start('m1', 'done');
    store.completeRun(finished.run.id);
    const interrupted = start('m2', 'in flight');
    store.appendDelta(interrupted.run.id, 'a');
    store.appendDelta(interrupted.run.id, 'b');

    expect(store.failInterruptedRuns()).toEqual([interrupted.run.id]);

    expect(store.getRun(finished.run.id)?.state).toBe('completed');
    expect(store.getRun(interrupted.run.id)).toMatchObject({
      state: 'failed',
      lastSeq: 3,
      failure: { code: 'SERVER_RESTARTED', message: RESTART_FAILURE_MESSAGE },
    });
    expect(store.readEventsAfter(interrupted.run.id, 2, 10)).toEqual([
      { seq: 3, type: 'failed', code: 'SERVER_RESTARTED', message: RESTART_FAILURE_MESSAGE },
    ]);
    // The conversation is usable again.
    expect(store.submitMessage({ conversationId, messageId: 'm3', content: 'next' }).created).toBe(
      true,
    );
  });

  it('is idempotent', () => {
    const { store, start } = setup();
    start();
    expect(store.failInterruptedRuns()).toHaveLength(1);
    expect(store.failInterruptedRuns()).toEqual([]);
  });
});
