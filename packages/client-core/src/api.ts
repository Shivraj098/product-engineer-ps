import {
  parseApiError,
  type ConversationSnapshot,
  type CreateConversationResponse,
  type RunSnapshot,
  type SendMessageRequest,
  type SendMessageResponse,
} from '@tether/protocol';

/** The request never produced a usable answer: no network, or a non-API HTTP failure. */
export class TransportError extends Error {
  readonly kind: 'network' | 'http';
  readonly status: number | undefined;

  constructor(kind: 'network' | 'http', message: string, status?: number) {
    super(message);
    this.name = 'TransportError';
    this.kind = kind;
    this.status = status;
  }
}

export interface ApiClientOptions {
  baseUrl: string;
  fetch?: typeof fetch;
}

/** Thin typed wrapper over the HTTP API. Failures are TetherError (API said no) or TransportError. */
export class ApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  createConversation(): Promise<CreateConversationResponse> {
    return this.json('POST', '/api/conversations');
  }

  sendMessage(conversationId: string, request: SendMessageRequest): Promise<SendMessageResponse> {
    return this.json('POST', `/api/conversations/${conversationId}/messages`, request);
  }

  getRunSnapshot(runId: string, signal?: AbortSignal): Promise<RunSnapshot> {
    return this.json('GET', `/api/runs/${runId}`, undefined, signal);
  }

  getConversationSnapshot(conversationId: string): Promise<ConversationSnapshot> {
    return this.json('GET', `/api/conversations/${conversationId}`);
  }

  /** Opens the event stream after `cursor`. Resolves only for a 200 response with a body. */
  async openEvents(
    runId: string,
    cursor: number,
    signal: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>> {
    const response = await this.request('GET', `/api/runs/${runId}/events?after=${cursor}`, {
      signal,
      headers: { Accept: 'text/event-stream' },
    });
    if (!response.body) {
      throw new TransportError('http', 'The event stream response had no body.', response.status);
    }
    return response.body;
  }

  private async json<T>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await this.request(method, path, {
      ...(signal ? { signal } : {}),
      ...(body === undefined
        ? {}
        : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
    return (await response.json()) as T;
  }

  /** Performs the request and turns every non-2xx answer into a typed error. */
  private async request(method: string, path: string, init: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, method });
    } catch (error) {
      if (init.signal?.aborted) {
        throw error; // Our own cancellation, not a network failure.
      }
      throw new TransportError('network', error instanceof Error ? error.message : 'Network error');
    }
    if (response.ok) {
      return response;
    }
    const apiError = parseApiError(await response.json().catch(() => undefined));
    if (apiError) {
      throw apiError;
    }
    throw new TransportError('http', `HTTP ${response.status}`, response.status);
  }
}
