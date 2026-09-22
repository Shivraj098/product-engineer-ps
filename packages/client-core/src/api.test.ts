import { TetherError } from '@tether/protocol';
import { describe, expect, it, vi } from 'vitest';
import { ApiClient, TransportError } from './api';

const json = (body: unknown, status = 200) => Response.json(body, { status });

describe('ApiClient', () => {
  it('posts a message as JSON and returns the parsed response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ messageId: 'm', run: { id: 'r' } }, 201));
    const api = new ApiClient({ baseUrl: 'http://host/', fetch: fetchMock });

    const result = await api.sendMessage('c1', { messageId: 'm', content: 'hi' });

    expect(result).toEqual({ messageId: 'm', run: { id: 'r' } });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://host/api/conversations/c1/messages');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ messageId: 'm', content: 'hi' }));
  });

  it('turns an API error body into a typed TetherError', async () => {
    const body = new TetherError('RUN_IN_PROGRESS', 'busy').toBody();
    const api = new ApiClient({ baseUrl: 'http://h', fetch: async () => json(body, 409) });

    const error = await api.sendMessage('c', { messageId: 'm', content: 'x' }).catch((e) => e);

    expect(error).toBeInstanceOf(TetherError);
    expect(error.code).toBe('RUN_IN_PROGRESS');
  });

  it('reports a non-API failure as an http TransportError with its status', async () => {
    const api = new ApiClient({
      baseUrl: 'http://h',
      fetch: async () => new Response('bad gateway', { status: 502 }),
    });
    const error = await api.getRunSnapshot('r').catch((e) => e);
    expect(error).toBeInstanceOf(TransportError);
    expect(error).toMatchObject({ kind: 'http', status: 502 });
  });

  it('reports a failed fetch as a network TransportError', async () => {
    const api = new ApiClient({
      baseUrl: 'http://h',
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
    });
    const error = await api.createConversation().catch((e) => e);
    expect(error).toMatchObject({ name: 'TransportError', kind: 'network' });
  });

  it('lets our own cancellation through untouched', async () => {
    const controller = new AbortController();
    const abort = new DOMException('Aborted', 'AbortError');
    const api = new ApiClient({
      baseUrl: 'http://h',
      fetch: async () => {
        controller.abort();
        throw abort;
      },
    });
    await expect(api.openEvents('r', 3, controller.signal)).rejects.toBe(abort);
  });

  it('opens the event stream after the given cursor', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('data: x\n\n'));
    const api = new ApiClient({ baseUrl: 'http://h', fetch: fetchMock });

    const body = await api.openEvents('run-9', 7, new AbortController().signal);

    expect(body).toBeInstanceOf(ReadableStream);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://h/api/runs/run-9/events?after=7');
  });
});
