import { TetherError, type RunSnapshot } from '@tether/protocol';
import { describe, expect, it } from 'vitest';
import { ApiClient } from './api';
import type { BackoffPolicy } from './backoff';
import { RunStream, type RunStreamOptions, type RunStreamState } from './runStream';
import { createRunView, type ApplyOutcome } from './runReducer';
import {
  FakeTransport,
  completed,
  delta,
  failed,
  type StreamHandle,
} from './testing/fakeTransport';

function setup(options: Partial<RunStreamOptions> = {}) {
  const transport = new FakeTransport();
  const sleeps: number[] = [];
  const delivered: Array<[number, ApplyOutcome]> = [];
  const statuses: string[] = [];
  const stream = new RunStream({
    runId: 'run-1',
    api: new ApiClient({ baseUrl: 'http://test', fetch: transport.fetch }),
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    random: () => 0.5,
    stallTimeoutMs: 0,
    onEvent: (event, outcome) => delivered.push([event.seq, outcome]),
    ...options,
  });
  stream.subscribe(() => {
    const status = stream.getState().connection.status;
    if (statuses.at(-1) !== status) {
      statuses.push(status);
    }
  });
  return { transport, stream, sleeps, delivered, statuses };
}

const closed = (state: RunStreamState) => state.connection.status === 'closed';
const disconnected = (state: RunStreamState) => state.connection.status === 'disconnected';
const finishWith = (...events: Parameters<StreamHandle['event']>[0][]) => ({
  kind: 'stream' as const,
  script: (s: StreamHandle) => {
    events.forEach((event) => s.event(event));
    s.end();
  },
});
const brokenAfter = (...events: Parameters<StreamHandle['event']>[0][]) => ({
  kind: 'stream' as const,
  script: (s: StreamHandle) => {
    events.forEach((event) => s.event(event));
    s.reset();
  },
});
const silent = { kind: 'stream' as const };

describe('RunStream: a healthy connection', () => {
  it('applies events in order and closes after the terminal event', async () => {
    const { transport, stream, statuses } = setup();
    transport.enqueue(finishWith(delta(1, 'Hel'), delta(2, 'lo'), completed(3)));

    stream.start();
    const state = await stream.waitFor(closed);

    expect(state.run).toMatchObject({ status: 'completed', text: 'Hello', lastSeq: 3 });
    expect(statuses).toEqual(['connecting', 'connected', 'closed']);
    expect(transport.eventRequests).toEqual([0]);
  });

  it('ends as failed, keeping the partial text, when the server reports a failure', async () => {
    const { transport, stream } = setup();
    transport.enqueue(finishWith(delta(1, 'partial'), failed(2)));

    stream.start();
    const state = await stream.waitFor(closed);

    expect(state.run).toMatchObject({
      status: 'failed',
      text: 'partial',
      failure: { code: 'SERVER_RESTARTED' },
    });
    expect(transport.eventRequests).toEqual([0]); // no reconnect after a terminal event
  });
});

describe('RunStream: recovering from a dropped connection', () => {
  it('reconnects from its cursor and never repeats or loses text', async () => {
    const { transport, stream, sleeps, statuses } = setup();
    transport.enqueue(
      brokenAfter(delta(1, 'a'), delta(2, 'b')),
      finishWith(delta(3, 'c'), delta(4, 'd'), completed(5)),
    );

    stream.start();
    const state = await stream.waitFor(closed);

    expect(state.run).toMatchObject({ status: 'completed', text: 'abcd', lastSeq: 5 });
    expect(transport.eventRequests).toEqual([0, 2]);
    expect(state.reconnects).toBe(1);
    expect(statuses).toEqual(['connecting', 'connected', 'reconnecting', 'connected', 'closed']);
    expect(sleeps).toEqual([250]); // attempt 1: jitter 0.5 * 500ms
  });

  it('ignores events the server sends again after a reconnect', async () => {
    const { transport, stream, delivered } = setup();
    transport.enqueue(
      finishWith(delta(1, 'a'), delta(2, 'b'), delta(3, 'c')), // ends with no terminal event
      finishWith(delta(2, 'b'), delta(3, 'c'), delta(4, 'd'), completed(5)),
    );

    stream.start();
    const state = await stream.waitFor(closed);

    expect(state.run.text).toBe('abcd');
    expect(state.run.stats.duplicatesIgnored).toBe(2);
    expect(delivered.filter(([, outcome]) => outcome === 'duplicate')).toEqual([
      [2, 'duplicate'],
      [3, 'duplicate'],
    ]);
  });

  it('detects a gap, drops the connection and reconnects from its cursor', async () => {
    const { transport, stream } = setup();
    transport.enqueue(
      {
        kind: 'stream',
        script: (s) => [delta(1, 'a'), delta(2, 'b'), delta(4, 'd')].forEach(s.event),
      },
      finishWith(delta(3, 'c'), delta(4, 'd'), completed(5)),
    );

    stream.start();
    const state = await stream.waitFor(closed);

    expect(state.run).toMatchObject({ text: 'abcd', lastSeq: 5 });
    expect(state.run.stats.gapsDetected).toBe(1);
    expect(transport.eventRequests).toEqual([0, 2]);
  });

  it('treats a malformed event as a broken connection', async () => {
    const { transport, stream } = setup();
    transport.enqueue(
      { kind: 'stream', script: (s) => s.raw('id: 1\ndata: {not json}\n\n') },
      finishWith(delta(1, 'a'), completed(2)),
    );

    stream.start();
    const state = await stream.waitFor(closed);

    expect(state.run.text).toBe('a');
    expect(transport.eventRequests).toEqual([0, 0]);
  });

  it('reconnects when the connection goes silent (stall watchdog)', async () => {
    const { transport, stream } = setup({ stallTimeoutMs: 30 });
    transport.enqueue(silent, finishWith(delta(1, 'a'), completed(2)));

    stream.start();
    const state = await stream.waitFor(closed);

    expect(state.run.text).toBe('a');
    expect(transport.eventRequests).toEqual([0, 0]);
  });

  it('retries a server error (5xx)', async () => {
    const { transport, stream, sleeps } = setup();
    transport.enqueue({ kind: 'http-error', status: 500 }, finishWith(completed(1)));

    stream.start();
    await stream.waitFor(closed);

    expect(transport.eventRequests).toEqual([0, 0]);
    expect(sleeps).toHaveLength(1);
  });
});

describe('RunStream: bounded retries', () => {
  const policy: BackoffPolicy = { baseMs: 100, capMs: 400, maxAttempts: 4 };

  it('gives up after the configured attempts, with growing, capped delays', async () => {
    const { transport, stream, sleeps } = setup({ backoff: policy, random: () => 0.999 });

    stream.start(); // every request fails: the fake's default behaviour
    const state = await stream.waitFor(disconnected);

    expect(state.connection).toMatchObject({ status: 'disconnected', reason: 'retries_exhausted' });
    expect(sleeps).toEqual([99, 199, 399, 399]);
    expect(transport.eventRequests).toHaveLength(5); // the first try plus four retries
    expect(state.run.status).toBe('running'); // gave up, but the run is not pretended finished
  });

  it('starts counting again once a connection makes progress', async () => {
    const { transport, stream } = setup({ backoff: { ...policy, maxAttempts: 2 } });
    transport.enqueue(
      { kind: 'network-error' }, // attempt 1 (cursor 0): fails, failure count -> 1
      brokenAfter(delta(1, 'a')), // attempt 2 (cursor 0): makes progress, failure count resets to 1
      { kind: 'network-error' }, // attempt 3 (cursor 1): fails, failure count -> 2 (not over the limit yet)
      { kind: 'network-error' }, // attempt 4 (cursor 1): fails, failure count -> 3 (over the limit: stop)
    );

    stream.start();
    await stream.waitFor(disconnected);

    // Without the reset, attempt 3 alone would have been the one that exhausted a 2-attempt budget.
    expect(transport.eventRequests).toEqual([0, 0, 1, 1]);
  });

  it('starts over when the user retries manually after it gave up', async () => {
    const { transport, stream } = setup({ backoff: { ...policy, maxAttempts: 1 } });
    stream.start();
    await stream.waitFor(disconnected);
    expect(transport.eventRequests).toHaveLength(2);

    transport.enqueue(finishWith(delta(1, 'a'), completed(2)));
    stream.retryNow();
    const state = await stream.waitFor(closed);

    expect(state.run.text).toBe('a');
    expect(transport.eventRequests).toHaveLength(3);
  });

  it('does not retry an error retrying cannot fix', async () => {
    const { transport, stream, sleeps } = setup();
    const notFound = new TetherError('RUN_NOT_FOUND', 'no such run').toBody();
    transport.enqueue({ kind: 'http-error', status: 404, body: notFound });

    stream.start();
    const state = await stream.waitFor(disconnected);

    expect(state.connection).toMatchObject({ reason: 'fatal_error' });
    expect(JSON.stringify(state.connection)).toContain('RUN_NOT_FOUND');
    expect(transport.eventRequests).toEqual([0]);
    expect(sleeps).toEqual([]);
  });
});

describe('RunStream: going offline on purpose', () => {
  it('stays down while offline and resumes from its cursor when back online', async () => {
    const { transport, stream } = setup();
    transport.enqueue(
      { kind: 'stream', script: (s) => s.event(delta(1, 'a')) },
      finishWith(delta(2, 'b'), completed(3)),
    );

    stream.start();
    await stream.waitFor((state) => state.run.lastSeq >= 1);
    stream.goOffline();
    const offline = await stream.waitFor(disconnected);
    expect(offline.connection).toMatchObject({ reason: 'offline' });
    expect(transport.eventRequests).toEqual([0]); // nothing is attempted while offline

    stream.goOnline();
    const state = await stream.waitFor(closed);

    expect(state.run.text).toBe('ab');
    expect(transport.eventRequests).toEqual([0, 1]);
  });

  it('stop() cancels the open connection and never reconnects', async () => {
    const { transport, stream } = setup();
    transport.enqueue(silent);

    stream.start();
    await stream.waitFor((state) => state.connection.status === 'connected');
    stream.stop();
    await Promise.resolve();

    expect(stream.getState().connection.status).toBe('idle');
    expect(transport.eventRequests).toEqual([0]);
  });
});

describe('AC6: a cursor the server cannot replay from', () => {
  it('resyncs from the snapshot without counting it as a failure, then continues', async () => {
    const snapshot: RunSnapshot = {
      runId: 'run-1',
      conversationId: 'c',
      state: 'running',
      lastSeq: 12,
      oldestReplayableSeq: 8,
      text: 'twelve chunks so far',
    };
    const expired = new TetherError('CURSOR_EXPIRED', 'too old', {
      action: 'RESYNC_FROM_SNAPSHOT',
      lastSeq: 12,
      oldestReplayableSeq: 8,
    }).toBody();
    const { transport, stream, sleeps } = setup({
      initial: { ...createRunView('run-1'), text: 'ab', lastSeq: 2 },
    });
    transport.setSnapshot(snapshot);
    transport.enqueue(
      { kind: 'http-error', status: 410, body: expired },
      finishWith(delta(13, '!'), completed(14)),
    );

    stream.start();
    const state = await stream.waitFor(closed);

    expect(transport.eventRequests).toEqual([2, 12]);
    expect(transport.snapshotRequests).toBe(1);
    expect(state.run).toMatchObject({
      status: 'completed',
      text: 'twelve chunks so far!',
      lastSeq: 14,
    });
    expect(sleeps).toEqual([]);
  });
});
