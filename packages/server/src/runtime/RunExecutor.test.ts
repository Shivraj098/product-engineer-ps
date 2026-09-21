import { InvalidTransitionError } from '@tether/protocol';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../db';
import { ManualGenerator } from '../generators/ManualGenerator';
import type { LogFields, Logger } from '../logger';
import { SqliteRunStore } from '../store/SqliteRunStore';
import { seqsOf, sequentialIds, textOf, tickingClock } from '../testing/helpers';
import { GENERATOR_FAILURE_MESSAGE, RunExecutor } from './RunExecutor';
import { RunNotifier } from './RunNotifier';

interface LogEntry {
  level: string;
  message: string;
  fields: LogFields | undefined;
}

function setup() {
  const store = new SqliteRunStore(openDatabase(':memory:'), {
    now: tickingClock(),
    newId: sequentialIds(),
  });
  const notifier = new RunNotifier();
  const generator = new ManualGenerator();
  const logs: LogEntry[] = [];
  const logger: Logger = {
    info: (message, fields) => logs.push({ level: 'info', message, fields }),
    warn: (message, fields) => logs.push({ level: 'warn', message, fields }),
    error: (message, fields) => logs.push({ level: 'error', message, fields }),
  };
  const executor = new RunExecutor({ store, notifier, generator, logger });
  const conversationId = store.createConversation();
  const { run } = store.submitMessage({ conversationId, messageId: 'm1', content: 'hi' });
  const execution = executor.start(run.id, 'hi');
  const events = () => store.readEventsAfter(run.id, 0, 1000);
  return { store, notifier, generator, executor, logs, run, execution, events };
}

describe('RunExecutor', () => {
  it('persists each chunk in order and completes the run exactly once', async () => {
    const { generator, execution, run, store, events } = setup();

    await generator.emit('Hello ');
    await generator.emit('world');
    generator.finish();
    await execution;

    expect(seqsOf(events())).toEqual([1, 2, 3]);
    expect(events().at(-1)?.type).toBe('completed');
    expect(textOf(events())).toBe('Hello world');
    expect(store.getRun(run.id)?.state).toBe('completed');
  });

  it('makes every persisted chunk visible before announcing the next', async () => {
    const { generator, events, execution } = setup();
    await generator.emit('a');
    expect(seqsOf(events())).toEqual([1]);
    await generator.emit('b');
    expect(seqsOf(events())).toEqual([1, 2]);
    generator.finish();
    await execution;
  });

  it('fails the run when the generator fails after partial output, and it can never complete later', async () => {
    const { generator, execution, run, store, events } = setup();

    await generator.emit('a');
    await generator.emit('b');
    await generator.emit('c');
    generator.fail(new Error('upstream exploded: api key sk-secret'));
    await execution;

    expect(store.getRun(run.id)).toMatchObject({
      state: 'failed',
      lastSeq: 4,
      failure: { code: 'GENERATOR_ERROR', message: GENERATOR_FAILURE_MESSAGE },
    });
    expect(events().map((event) => event.type)).toEqual(['delta', 'delta', 'delta', 'failed']);

    expect(() => store.completeRun(run.id)).toThrow(InvalidTransitionError);
    expect(events()).toHaveLength(4);
    expect(store.getRun(run.id)?.state).toBe('failed');
  });

  it('keeps the real cause in the log and out of what clients can see', async () => {
    const { generator, execution, events, logs } = setup();
    generator.fail(new Error('upstream exploded: api key sk-secret'));
    await execution;

    const failed = events().at(-1);
    expect(JSON.stringify(failed)).not.toContain('sk-secret');
    const errorLog = logs.find((entry) => entry.message === 'run.generator_failed');
    expect(errorLog?.fields?.error).toContain('sk-secret');
  });

  it('fails cleanly when the generator throws before emitting anything', async () => {
    const { generator, execution, events } = setup();
    generator.fail(new Error('boom'));
    await execution;
    expect(events()).toEqual([
      { seq: 1, type: 'failed', code: 'GENERATOR_ERROR', message: GENERATOR_FAILURE_MESSAGE },
    ]);
  });

  it('skips empty chunks instead of failing the run', async () => {
    const { generator, execution, events } = setup();
    await generator.emit('');
    await generator.emit('a');
    generator.finish();
    await execution;
    expect(seqsOf(events())).toEqual([1, 2]);
    expect(textOf(events())).toBe('a');
  });

  it('wakes waiting readers when the run reaches a terminal state', async () => {
    const { generator, execution, notifier, run } = setup();
    const controller = new AbortController();
    let woke = false;
    const waiting = notifier.waitForChange(run.id, controller.signal).then(() => {
      woke = true;
    });

    generator.finish();
    await execution;
    await waiting;
    expect(woke).toBe(true);
  });

  it('idle resolves once every started run has finished', async () => {
    const { generator, executor } = setup();
    generator.finish();
    await executor.idle();
    await expect(executor.idle()).resolves.toBeUndefined();
  });
});
