import { afterEach, describe, expect, it } from 'vitest';
import { ManualGenerator } from '../generators/ManualGenerator';
import { buildReplyChunks } from '../generators/fakeReply';
import { startTestServer } from '../testing/httpHarness';

type TestServer = Awaited<ReturnType<typeof startTestServer>>;

let server: TestServer;

afterEach(async () => {
  await server.close();
});

const MESSAGE_ID = '3f2b8c1e-5d4a-4b8e-9c1a-7e6d5f4a3b21';
const OTHER_MESSAGE_ID = '9a1c2d3e-4f5a-4b6c-8d7e-0f1a2b3c4d5e';

describe('health and conversations', () => {
  it('reports it is alive', async () => {
    server = await startTestServer();
    const response = await fetch(`${server.baseUrl}/api/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('creates a conversation', async () => {
    server = await startTestServer();
    const response = await server.postJson('/api/conversations');
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ conversationId: expect.any(String) });
  });
});

describe('sending a message', () => {
  it('starts a run and answers immediately, before the reply is generated', async () => {
    server = await startTestServer({ generator: new ManualGenerator() });
    const conversationId = await server.createConversation();

    const { response, body } = await server.sendMessage(conversationId, MESSAGE_ID, 'hello');

    expect(response.status).toBe(201);
    expect(body).toEqual({
      messageId: MESSAGE_ID,
      run: { id: expect.any(String), state: 'running', lastSeq: 0 },
    });
  });

  it('is idempotent: the same message again returns 200 and the same run', async () => {
    server = await startTestServer({ generator: new ManualGenerator() });
    const conversationId = await server.createConversation();

    const first = await server.sendMessage(conversationId, MESSAGE_ID, 'hello');
    const retry = await server.sendMessage(conversationId, MESSAGE_ID, 'hello');

    expect(first.response.status).toBe(201);
    expect(retry.response.status).toBe(200);
    expect(retry.body.run.id).toBe(first.body.run.id);
  });

  it('rejects a reused message id with different content', async () => {
    server = await startTestServer({ generator: new ManualGenerator() });
    const conversationId = await server.createConversation();
    await server.sendMessage(conversationId, MESSAGE_ID, 'hello');

    const { response, body } = await server.sendMessage(conversationId, MESSAGE_ID, 'different');

    expect(response.status).toBe(409);
    expect(body).toMatchObject({ error: { code: 'MESSAGE_ID_REUSED' } });
  });

  it('rejects a second message while a reply is still being generated', async () => {
    server = await startTestServer({ generator: new ManualGenerator() });
    const conversationId = await server.createConversation();
    await server.sendMessage(conversationId, MESSAGE_ID, 'hello');

    const { response, body } = await server.sendMessage(conversationId, OTHER_MESSAGE_ID, 'again');

    expect(response.status).toBe(409);
    expect(body).toMatchObject({ error: { code: 'RUN_IN_PROGRESS' } });
  });

  it('rejects an unknown conversation', async () => {
    server = await startTestServer();
    const { response, body } = await server.sendMessage('nope', MESSAGE_ID, 'hello');
    expect(response.status).toBe(404);
    expect(body).toMatchObject({ error: { code: 'CONVERSATION_NOT_FOUND' } });
  });
});

describe('request validation', () => {
  it.each([
    ['a messageId that is not a UUID', { messageId: 'abc', content: 'hi' }, 'messageId'],
    ['empty content', { messageId: MESSAGE_ID, content: '   ' }, 'content'],
    ['content over the limit', { messageId: MESSAGE_ID, content: 'a'.repeat(2001) }, 'content'],
    ['a missing body', undefined, 'messageId'],
  ])('rejects %s with a 400 that says what is wrong', async (_label, body, hint) => {
    server = await startTestServer();
    const conversationId = await server.createConversation();

    const response = await server.postJson(`/api/conversations/${conversationId}/messages`, body);

    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: { code: string; message: string } };
    expect(payload.error.code).toBe('VALIDATION_ERROR');
    expect(payload.error.message).toContain(hint);
  });

  it('rejects malformed JSON', async () => {
    server = await startTestServer();
    const conversationId = await server.createConversation();
    const response = await fetch(`${server.baseUrl}/api/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"messageId": ',
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });

  it('rejects an oversized body', async () => {
    server = await startTestServer();
    const conversationId = await server.createConversation();
    const response = await server.postJson(`/api/conversations/${conversationId}/messages`, {
      messageId: MESSAGE_ID,
      content: 'a'.repeat(20_000),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: 'VALIDATION_ERROR', message: 'Request body is too large.' },
    });
  });
});

describe('snapshots', () => {
  it('returns the finished run with its assembled text', async () => {
    server = await startTestServer();
    const conversationId = await server.createConversation();
    const prompt = 'hello /chunks:5';
    const { body } = await server.sendMessage(conversationId, MESSAGE_ID, prompt);
    await server.runtime.executor.idle();

    const response = await fetch(`${server.baseUrl}/api/runs/${body.run.id}`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      runId: body.run.id,
      conversationId,
      state: 'completed',
      lastSeq: 6,
      oldestReplayableSeq: 1,
      text: buildReplyChunks(prompt, 5).join(''),
    });
  });

  it('returns the whole conversation for a client that reloads', async () => {
    server = await startTestServer();
    const conversationId = await server.createConversation();
    await server.sendMessage(conversationId, MESSAGE_ID, 'hello /chunks:3');
    await server.runtime.executor.idle();

    const response = await fetch(`${server.baseUrl}/api/conversations/${conversationId}`);
    const snapshot = (await response.json()) as {
      turns: Array<{ message: { content: string }; run: { state: string } }>;
    };

    expect(response.status).toBe(200);
    expect(snapshot.turns.map((turn) => [turn.message.content, turn.run.state])).toEqual([
      ['hello /chunks:3', 'completed'],
    ]);
  });

  it('answers 404 with a typed error for unknown ids', async () => {
    server = await startTestServer();
    const run = await fetch(`${server.baseUrl}/api/runs/nope`);
    const conversation = await fetch(`${server.baseUrl}/api/conversations/nope`);

    expect(run.status).toBe(404);
    expect(await run.json()).toMatchObject({ error: { code: 'RUN_NOT_FOUND' } });
    expect(conversation.status).toBe(404);
    expect(await conversation.json()).toMatchObject({ error: { code: 'CONVERSATION_NOT_FOUND' } });
  });
});

describe('demo endpoint', () => {
  it('drops open streams when demo mode is on', async () => {
    server = await startTestServer({ demoMode: true });
    const response = await server.postJson('/api/dev/drop-connections');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ dropped: 0 });
  });

  it('does not exist when demo mode is off', async () => {
    server = await startTestServer({ demoMode: false });
    const response = await server.postJson('/api/dev/drop-connections');
    expect(response.status).toBe(404);
  });
});
