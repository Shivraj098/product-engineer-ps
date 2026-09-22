import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiClient } from '@tether/client-core';
import { describe, expect, it } from 'vitest';
import App from './App';

interface RouteState {
  conversationId: string;
  runId: string;
  script?: (push: (frame: string) => void) => void;
}

/**
 * A minimal, self-contained fake server: just enough of the real API surface (create,
 * send, snapshot, and one SSE stream) for App to run against, with no network involved.
 * client-core's own transport, parsing and reconnect logic are already covered by
 * packages/client-core's tests; this exercises how App wires them together.
 */
function fakeApi(state: RouteState): ApiClient {
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input), 'http://test');

    if (url.pathname === '/api/conversations' && init?.method === 'POST') {
      return Response.json({ conversationId: state.conversationId }, { status: 201 });
    }
    if (
      url.pathname === `/api/conversations/${state.conversationId}` &&
      (!init?.method || init.method === 'GET')
    ) {
      return Response.json({ conversationId: state.conversationId, turns: [] });
    }
    if (url.pathname === `/api/conversations/${state.conversationId}/messages`) {
      return Response.json(
        { messageId: 'm1', run: { id: state.runId, state: 'running', lastSeq: 0 } },
        { status: 201 },
      );
    }
    if (url.pathname === `/api/runs/${state.runId}/events`) {
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const push = (frame: string): void => controller.enqueue(encoder.encode(frame));
          state.script?.(push);
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    throw new Error(`Unhandled request in test: ${init?.method ?? 'GET'} ${url.pathname}`);
  };
  return new ApiClient({ baseUrl: '', fetch: fetchImpl });
}

const frame = (seq: number, event: object): string =>
  `id: ${seq}\ndata: ${JSON.stringify({ seq, ...event })}\n\n`;

function fakeStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
}

describe('App', () => {
  it('shows the empty state and example prompts before any message is sent', async () => {
    const api = fakeApi({ conversationId: 'c1', runId: 'r1' });
    render(<App api={api} storage={fakeStorage()} />);

    expect(
      await screen.findByText('Send a message to start a resumable reply.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('sends a message, streams the reply, and shows it completed', async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      conversationId: 'c1',
      runId: 'r1',
      script: (push) => {
        push(frame(1, { type: 'delta', text: 'Hello ' }));
        push(frame(2, { type: 'delta', text: 'there' }));
        push(frame(3, { type: 'completed' }));
      },
    });
    render(<App api={api} storage={fakeStorage()} />);

    await waitFor(() => expect(screen.getByRole('textbox')).not.toBeDisabled());
    await user.type(screen.getByRole('textbox'), 'hi');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText('hi')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Hello there')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('Completed')).toBeInTheDocument());

    // The composer is usable again once the run has finished.
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled(); // empty box again
    expect(screen.getByRole('textbox')).not.toBeDisabled();
  });

  it('shows a failed run with its partial text and the failure note', async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      conversationId: 'c1',
      runId: 'r1',
      script: (push) => {
        push(frame(1, { type: 'delta', text: 'partial ' }));
        push(frame(2, { type: 'delta', text: 'reply' }));
        push(
          frame(3, { type: 'failed', code: 'SERVER_RESTARTED', message: 'The server restarted.' }),
        );
      },
    });
    render(<App api={api} storage={fakeStorage()} />);

    await waitFor(() => expect(screen.getByRole('textbox')).not.toBeDisabled());
    await user.type(screen.getByRole('textbox'), 'hi');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(screen.getByText('partial reply')).toBeInTheDocument());
    expect(await screen.findByText('Failed')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('The server restarted.');
  });
});
