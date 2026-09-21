import type { SendMessageRequest } from '@tether/protocol';
import { describe, expect, it, vi } from 'vitest';
import { createRuntime } from '../container';
import { FakeGenerator } from '../generators/FakeGenerator';
import { ManualGenerator } from '../generators/ManualGenerator';
import { buildReplyChunks } from '../generators/fakeReply';
import { silentLogger } from '../logger';
import { collect, expectTetherError, seqsOf, textOf, tickingClock } from '../testing/helpers';

function request(messageId: string, content = 'hello'): SendMessageRequest {
  return { messageId, content };
}

function manualRuntime(replayWindow = 0) {
  const generator = new ManualGenerator();
  const runtime = createRuntime({
    dbPath: ':memory:',
    generator,
    logger: silentLogger,
    replayWindow,
    now: tickingClock(),
  });
  const { conversationId } = runtime.service.createConversation();
  const send = (messageId = 'm1', content = 'hello') =>
    runtime.service.sendMessage(conversationId, request(messageId, content));
  return { runtime, generator, service: runtime.service, conversationId, send };
}

describe('AC1: ordered live stream', () => {
  it('delivers each event once, in order, and reaches completed', async () => {
    const { runtime, generator, service, send } = manualRuntime();
    const { response } = send();
    const signal = new AbortController().signal;
    const collected = collect(service.openEventStream(response.run.id, 0, signal));

    await generator.emit('Hel');
    await generator.emit('lo ');
    await generator.emit('there');
    generator.finish();
    await runtime.executor.idle();

    const events = await collected;
    expect(seqsOf(events)).toEqual([1, 2, 3, 4]);
    expect(textOf(events)).toBe('Hello there');
    expect(events.at(-1)?.type).toBe('completed');
    expect(service.getRunSnapshot(response.run.id)).toMatchObject({
      state: 'completed',
      lastSeq: 4,
      text: 'Hello there',
    });
  });

  it('streams the deterministic demo reply, including its length directive', async () => {
    const runtime = createRuntime({
      dbPath: ':memory:',
      generator: new FakeGenerator(),
      logger: silentLogger,
    });
    const { conversationId } = runtime.service.createConversation();
    const prompt = 'Tell me a story /chunks:35';
    const { response } = runtime.service.sendMessage(conversationId, request('m1', prompt));

    const events = await collect(
      runtime.service.openEventStream(response.run.id, 0, new AbortController().signal),
    );

    expect(events).toHaveLength(36);
    expect(seqsOf(events)).toEqual(Array.from({ length: 36 }, (_, index) => index + 1));
    expect(textOf(events)).toBe(buildReplyChunks(prompt, 35).join(''));
    expect(events.at(-1)?.type).toBe('completed');
  });
});

describe('sending messages', () => {
  it('is idempotent: a retry returns the same run and starts no second generation', async () => {
    const { generator, send } = manualRuntime();
    const spy = vi.spyOn(generator, 'generate');

    const first = send('m1');
    const retry = send('m1');

    expect(first.created).toBe(true);
    expect(retry.created).toBe(false);
    expect(retry.response.run.id).toBe(first.response.run.id);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('refuses a new message while a reply is still being generated', () => {
    const { send } = manualRuntime();
    send('m1');
    expectTetherError(() => send('m2', 'second'), 'RUN_IN_PROGRESS');
  });
});

describe('AC2: missed-event recovery', () => {
  it('a client that dropped receives every event after its cursor, exactly once', async () => {
    const { runtime, generator, service, send } = manualRuntime();
    const { response } = send();
    const runId = response.run.id;

    await generator.emit('a ');
    await generator.emit('b ');
    await generator.emit('c ');

    // Client A reads three events, then its connection drops.
    const dropped = new AbortController();
    const firstConnection = service.openEventStream(runId, 0, dropped.signal);
    const received = [
      (await firstConnection.next()).value,
      (await firstConnection.next()).value,
      (await firstConnection.next()).value,
    ];
    dropped.abort();
    await firstConnection.return(undefined);
    const cursor = received.at(-1)?.seq ?? 0;
    expect(cursor).toBe(3);

    // The run keeps going while the client is away.
    await generator.emit('d ');
    await generator.emit('e ');

    // It reconnects from its cursor and stays connected until the end.
    const reconnected = collect(
      service.openEventStream(runId, cursor, new AbortController().signal),
    );
    await generator.emit('f ');
    generator.finish();
    await runtime.executor.idle();

    const afterReconnect = await reconnected;
    expect(seqsOf(afterReconnect)).toEqual([4, 5, 6, 7]);

    const everything =
      textOf(received.flatMap((event) => (event ? [event] : []))) + textOf(afterReconnect);
    expect(everything).toBe('a b c d e f ');
    expect(service.getRunSnapshot(runId).text).toBe(everything);
  });
});

describe('AC5: generation failure', () => {
  it('fails the run, keeps its history inspectable, and it never becomes completed', async () => {
    const { runtime, generator, service, send } = manualRuntime();
    const { response } = send();
    const runId = response.run.id;

    await generator.emit('partial ');
    await generator.emit('reply ');
    generator.fail(new Error('provider down'));
    await runtime.executor.idle();

    const snapshot = service.getRunSnapshot(runId);
    expect(snapshot).toMatchObject({ state: 'failed', text: 'partial reply ', lastSeq: 3 });
    expect(snapshot.failure?.code).toBe('GENERATOR_ERROR');

    const events = await collect(service.openEventStream(runId, 0, new AbortController().signal));
    expect(events.map((event) => event.type)).toEqual(['delta', 'delta', 'failed']);
    expect(() => runtime.store.completeRun(runId)).toThrow();
    expect(service.getRunSnapshot(runId).state).toBe('failed');
  });
});

describe('AC6: unknown or stale cursors', () => {
  it('rejects an unknown run before any stream starts', () => {
    const { service } = manualRuntime();
    expectTetherError(
      () => service.openEventStream('nope', 0, new AbortController().signal),
      'RUN_NOT_FOUND',
    );
  });

  it('rejects a cursor ahead of the run, with a recovery hint', async () => {
    const { generator, service, send } = manualRuntime();
    const { response } = send();
    await generator.emit('a');

    const error = expectTetherError(
      () => service.openEventStream(response.run.id, 5, new AbortController().signal),
      'CURSOR_AHEAD',
    );
    expect(error.recovery).toEqual({
      action: 'RESYNC_FROM_SNAPSHOT',
      lastSeq: 1,
      oldestReplayableSeq: 1,
    });
  });

  it('rejects a cursor older than the replay window, and the client recovers via the snapshot', async () => {
    const { runtime, generator, service, send } = manualRuntime(5);
    const { response } = send();
    const runId = response.run.id;
    for (let index = 1; index <= 12; index += 1) {
      await generator.emit(`w${index} `);
    }

    const error = expectTetherError(
      () => service.openEventStream(runId, 2, new AbortController().signal),
      'CURSOR_EXPIRED',
    );
    expect(error.recovery).toEqual({
      action: 'RESYNC_FROM_SNAPSHOT',
      lastSeq: 12,
      oldestReplayableSeq: 8,
    });

    // Recovery: take the snapshot, then resume from its position.
    const snapshot = service.getRunSnapshot(runId);
    expect(snapshot).toMatchObject({ lastSeq: 12, oldestReplayableSeq: 8 });
    const resumed = collect(
      service.openEventStream(runId, snapshot.lastSeq, new AbortController().signal),
    );
    await generator.emit('tail ');
    generator.finish();
    await runtime.executor.idle();

    const rest = await resumed;
    expect(seqsOf(rest)).toEqual([13, 14]);
    expect(snapshot.text + textOf(rest)).toBe(service.getRunSnapshot(runId).text);
  });

  it('still allows the oldest cursor that has every later event', async () => {
    const { generator, service, send } = manualRuntime(5);
    const { response } = send();
    for (let index = 1; index <= 12; index += 1) {
      await generator.emit(`w${index} `);
    }
    expect(() =>
      service.openEventStream(response.run.id, 7, new AbortController().signal),
    ).not.toThrow();
  });
});

describe('snapshots', () => {
  it('rebuilds a whole conversation, turn by turn, for a client that reloads', async () => {
    const { runtime, generator, service, conversationId, send } = manualRuntime();
    send('m1', 'first');
    await generator.emit('one ');
    generator.finish();
    await runtime.executor.idle();

    send('m2', 'second');
    await generator.emit('two ');

    const snapshot = service.getConversationSnapshot(conversationId);
    expect(
      snapshot.turns.map((turn) => [turn.message.content, turn.run.text, turn.run.state]),
    ).toEqual([
      ['first', 'one ', 'completed'],
      ['second', 'two ', 'running'],
    ]);
  });

  it('rejects an unknown conversation', () => {
    const { service } = manualRuntime();
    expectTetherError(() => service.getConversationSnapshot('nope'), 'CONVERSATION_NOT_FOUND');
  });
});
