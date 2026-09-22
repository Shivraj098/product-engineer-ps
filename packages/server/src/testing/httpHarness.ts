import type { AddressInfo } from 'node:net';
import { runEventSchema, type RunEvent } from '@tether/protocol';
import { createRuntime } from '../container';
import { FakeGenerator } from '../generators/FakeGenerator';
import type { ResponseGenerator } from '../generators/types';
import { createApp } from '../http/app';
import { silentLogger } from '../logger';

export interface TestServerOptions {
  generator?: ResponseGenerator;
  replayWindow?: number;
  heartbeatMs?: number;
  demoMode?: boolean;
}

/** Starts the real HTTP app on an ephemeral port, backed by an in-memory database. */
export async function startTestServer(options: TestServerOptions = {}) {
  const runtime = createRuntime({
    dbPath: ':memory:',
    generator: options.generator ?? new FakeGenerator(),
    logger: silentLogger,
    replayWindow: options.replayWindow ?? 0,
  });
  const { app, connections } = createApp({
    service: runtime.service,
    logger: silentLogger,
    heartbeatMs: options.heartbeatMs ?? 0,
    demoMode: options.demoMode ?? true,
  });

  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const postJson = (path: string, body?: unknown): Promise<Response> =>
    fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const createConversation = async (): Promise<string> => {
    const response = await postJson('/api/conversations');
    return ((await response.json()) as { conversationId: string }).conversationId;
  };

  const sendMessage = async (conversationId: string, messageId: string, content: string) => {
    const response = await postJson(`/api/conversations/${conversationId}/messages`, {
      messageId,
      content,
    });
    return { response, body: (await response.json()) as { run: { id: string } } };
  };

  return {
    baseUrl,
    runtime,
    connections,
    postJson,
    createConversation,
    sendMessage,
    async close(): Promise<void> {
      connections.dropAll();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      runtime.close();
    },
  };
}

export type SseFrame = { kind: 'event'; event: RunEvent } | { kind: 'comment'; text: string };

/** A minimal, test-only reader for the server's SSE frames. */
export class SseReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private buffer = '';

  constructor(response: Response) {
    if (!response.body) {
      throw new Error('Response has no body to stream.');
    }
    this.reader = response.body.getReader();
  }

  /** The next frame, or 'closed' when the stream ended or the connection was cut. */
  async nextFrame(): Promise<SseFrame | 'closed'> {
    for (;;) {
      const end = this.buffer.indexOf('\n\n');
      if (end >= 0) {
        const raw = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 2);
        return this.parseFrame(raw);
      }
      try {
        const { value, done } = await this.reader.read();
        if (done) {
          return 'closed';
        }
        this.buffer += this.decoder.decode(value, { stream: true });
      } catch {
        return 'closed';
      }
    }
  }

  /** The next event, skipping heartbeat comments. */
  async nextEvent(): Promise<RunEvent | 'closed'> {
    for (;;) {
      const frame = await this.nextFrame();
      if (frame === 'closed') {
        return 'closed';
      }
      if (frame.kind === 'event') {
        return frame.event;
      }
    }
  }

  async readAllEvents(): Promise<RunEvent[]> {
    const events: RunEvent[] = [];
    for (;;) {
      const next = await this.nextEvent();
      if (next === 'closed') {
        return events;
      }
      events.push(next);
    }
  }

  async cancel(): Promise<void> {
    await this.reader.cancel().catch(() => undefined);
  }

  private parseFrame(raw: string): SseFrame {
    if (raw.startsWith(':')) {
      return { kind: 'comment', text: raw.slice(1).trim() };
    }
    const data = raw
      .split('\n')
      .find((line) => line.startsWith('data: '))
      ?.slice('data: '.length);
    if (data === undefined) {
      throw new Error(`SSE frame without data: ${JSON.stringify(raw)}`);
    }
    return { kind: 'event', event: runEventSchema.parse(JSON.parse(data)) };
  }
}
