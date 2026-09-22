import { describe, expect, it, afterEach, vi } from 'vitest';
import { ManualGenerator } from '../generators/ManualGenerator';
import { buildReplyChunks } from '../generators/fakeReply';
import { seqsOf, textOf } from '../testing/helpers';
import { SseReader, startTestServer } from '../testing/httpHarness';

type TestServer = Awaited<ReturnType<typeof startTestServer>>;

let server: TestServer;

afterEach(async () => {
  await server.close();
});

const MESSAGE_ID = '3f2b8c1e-5d4a-4b8e-9c1a-7e6d5f4a3b21';

/** Starts a finished 5-chunk run (6 events: 5 deltas + completed). */
async function finishedRun() {
  const conversationId = await server.createConversation();
  const prompt = 'hello /chunks:5';
  const { body } = await server.sendMessage(conversationId, MESSAGE_ID, prompt);
  await server.runtime.executor.idle();
  return { runId: body.run.id, prompt };
}

/** Starts a run driven step by step by the test. */
async function liveRun(generator: ManualGenerator) {
  const conversationId = await server.createConversation();
  const { body } = await server.sendMessage(conversationId, MESSAGE_ID, 'hello');
  return { runId: body.run.id, generator };
}

describe('AC1: ordered stream over HTTP', () => {
  it('streams every event once, in order, then closes after the terminal event', async () => {
    server = await startTestServer();
    const { runId, prompt } = await finishedRun();

    const response = await fetch(`${server.baseUrl}/api/runs/${runId}/events`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('cache-control')).toContain('no-cache');

    const events = await new SseReader(response).readAllEvents();
    expect(seqsOf(events)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(events.at(-1)?.type).toBe('completed');
    expect(textOf(events)).toBe(buildReplyChunks(prompt, 5).join(''));
  });

  it('delivers live events as they are generated', async () => {
    const generator = new ManualGenerator();
    server = await startTestServer({ generator });
    const { runId } = await liveRun(generator);

    const reader = new SseReader(await fetch(`${server.baseUrl}/api/runs/${runId}/events`));
    await generator.emit('a ');
    expect(await reader.nextEvent()).toEqual({ seq: 1, type: 'delta', text: 'a ' });
    await generator.emit('b ');
    expect(await reader.nextEvent()).toEqual({ seq: 2, type: 'delta', text: 'b ' });

    generator.finish();
    expect(await reader.nextEvent()).toEqual({ seq: 3, type: 'completed' });
    expect(await reader.nextEvent()).toBe('closed');
  });
});

describe('AC2: resuming from a cursor', () => {
  it('replays only what comes after the "after" cursor', async () => {
    server = await startTestServer();
    const { runId } = await finishedRun();

    const response = await fetch(`${server.baseUrl}/api/runs/${runId}/events?after=3`);
    expect(seqsOf(await new SseReader(response).readAllEvents())).toEqual([4, 5, 6]);
  });

  it('understands the standard Last-Event-ID header, and "after" wins over it', async () => {
    server = await startTestServer();
    const { runId } = await finishedRun();
    const url = `${server.baseUrl}/api/runs/${runId}/events`;

    const viaHeader = await fetch(url, { headers: { 'Last-Event-ID': '3' } });
    expect(seqsOf(await new SseReader(viaHeader).readAllEvents())).toEqual([4, 5, 6]);

    const both = await fetch(`${url}?after=4`, { headers: { 'Last-Event-ID': '1' } });
    expect(seqsOf(await new SseReader(both).readAllEvents())).toEqual([5, 6]);
  });

  it('a client cut off mid-stream loses nothing after reconnecting from its cursor', async () => {
    const generator = new ManualGenerator();
    server = await startTestServer({ generator });
    const { runId } = await liveRun(generator);
    const url = `${server.baseUrl}/api/runs/${runId}/events`;

    const first = new SseReader(await fetch(url));
    await generator.emit('a ');
    await generator.emit('b ');
    const seen = [await first.nextEvent(), await first.nextEvent()];
    expect(seqsOf(seen.filter((event) => event !== 'closed'))).toEqual([1, 2]);

    // The network drops. The server keeps generating while the client is away.
    const dropped = await server.postJson('/api/dev/drop-connections');
    expect(await dropped.json()).toEqual({ dropped: 1 });
    expect(await first.nextFrame()).toBe('closed');
    await generator.emit('c ');
    await generator.emit('d ');

    // It reconnects from the last position it applied.
    const second = new SseReader(await fetch(`${url}?after=2`));
    await generator.emit('e ');
    generator.finish();
    const rest = await second.readAllEvents();

    expect(seqsOf(rest)).toEqual([3, 4, 5, 6]);
    expect(textOf(rest)).toBe('c d e ');
  });
});

describe('AC6: cursors the server cannot replay from', () => {
  it.each([
    ['a negative cursor', 'after=-1'],
    ['a non-numeric cursor', 'after=abc'],
    ['an empty cursor', 'after='],
    ['a cursor given twice', 'after=1&after=2'],
  ])('answers %s with a 400 before any stream starts', async (_label, query) => {
    server = await startTestServer();
    const { runId } = await finishedRun();

    const response = await fetch(`${server.baseUrl}/api/runs/${runId}/events?${query}`);

    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toMatchObject({ error: { code: 'INVALID_CURSOR' } });
  });

  it('answers a cursor ahead of the run with 409 and a recovery hint', async () => {
    server = await startTestServer();
    const { runId } = await finishedRun();

    const response = await fetch(`${server.baseUrl}/api/runs/${runId}/events?after=99`);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        code: 'CURSOR_AHEAD',
        message: expect.any(String),
        recovery: { action: 'RESYNC_FROM_SNAPSHOT', lastSeq: 6, oldestReplayableSeq: 1 },
      },
    });
  });

  it('answers an expired cursor with 410 and a recovery hint', async () => {
    server = await startTestServer({ replayWindow: 3 });
    const { runId } = await finishedRun();

    const response = await fetch(`${server.baseUrl}/api/runs/${runId}/events?after=1`);

    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({
      error: {
        code: 'CURSOR_EXPIRED',
        message: expect.any(String),
        recovery: { action: 'RESYNC_FROM_SNAPSHOT', lastSeq: 6, oldestReplayableSeq: 4 },
      },
    });
  });

  it('answers an unknown run with 404', async () => {
    server = await startTestServer();
    const response = await fetch(`${server.baseUrl}/api/runs/nope/events`);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: 'RUN_NOT_FOUND' } });
  });
});

describe('connection lifecycle', () => {
  it('releases everything when a client disconnects', async () => {
    const generator = new ManualGenerator();
    server = await startTestServer({ generator });
    const { runId } = await liveRun(generator);

    const reader = new SseReader(await fetch(`${server.baseUrl}/api/runs/${runId}/events`));
    await generator.emit('a ');
    await reader.nextEvent();
    expect(server.connections.size).toBe(1);
    expect(server.runtime.notifier.waiterCount).toBe(1);

    await reader.cancel();

    await vi.waitFor(() => {
      expect(server.connections.size).toBe(0);
      expect(server.runtime.notifier.waiterCount).toBe(0);
    });
  });

  it('sends heartbeat comments while a run is quiet', async () => {
    const generator = new ManualGenerator();
    server = await startTestServer({ generator, heartbeatMs: 10 });
    const { runId } = await liveRun(generator);

    const reader = new SseReader(await fetch(`${server.baseUrl}/api/runs/${runId}/events`));
    expect(await reader.nextFrame()).toEqual({ kind: 'comment', text: 'hb' });
    await reader.cancel();
  });
});
