import type { RunEvent, RunSnapshot } from '@tether/protocol';

export const delta = (seq: number, text: string): RunEvent => ({ seq, type: 'delta', text });
export const completed = (seq: number): RunEvent => ({ seq, type: 'completed' });
export const failed = (seq: number): RunEvent => ({
  seq,
  type: 'failed',
  code: 'SERVER_RESTARTED',
  message: 'restarted',
});

export const frame = (event: RunEvent): string =>
  `id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`;

/** What a test can do to one open event stream. */
export interface StreamHandle {
  event(event: RunEvent): void;
  raw(text: string): void;
  /** The server closes the stream cleanly. */
  end(): void;
  /** The connection is reset mid-flight. */
  reset(): void;
}

export type EventsBehavior =
  | { kind: 'stream'; script?: (stream: StreamHandle) => void }
  | { kind: 'http-error'; status: number; body?: unknown }
  | { kind: 'network-error' };

/**
 * A scripted stand-in for the server, injected as `fetch`. Each request to the events
 * endpoint consumes the next queued behaviour (default: a network error).
 */
export class FakeTransport {
  /** The `after` cursor of every event-stream request, in order. */
  readonly eventRequests: number[] = [];
  snapshotRequests = 0;
  private readonly queue: EventsBehavior[] = [];
  private snapshot: RunSnapshot | undefined;

  enqueue(...behaviors: EventsBehavior[]): this {
    this.queue.push(...behaviors);
    return this;
  }

  setSnapshot(snapshot: RunSnapshot): void {
    this.snapshot = snapshot;
  }

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (init?.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    const url = new URL(String(input));

    if (url.pathname.endsWith('/events')) {
      this.eventRequests.push(Number(url.searchParams.get('after')));
      return this.respondToEvents(this.queue.shift() ?? { kind: 'network-error' }, init?.signal);
    }

    this.snapshotRequests += 1;
    return this.snapshot
      ? Response.json(this.snapshot)
      : Response.json({ error: { code: 'RUN_NOT_FOUND', message: 'no run' } }, { status: 404 });
  };

  private respondToEvents(behavior: EventsBehavior, signal: AbortSignal | null | undefined) {
    if (behavior.kind === 'network-error') {
      throw new TypeError('fetch failed');
    }
    if (behavior.kind === 'http-error') {
      const body = behavior.body === undefined ? 'server exploded' : JSON.stringify(behavior.body);
      return new Response(body, { status: behavior.status });
    }

    const encoder = new TextEncoder();
    const pending: Array<Uint8Array | 'end' | 'reset'> = [];
    let wakeReader: (() => void) | undefined;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let aborted = false;
    const push = (item: Uint8Array | 'end' | 'reset'): void => {
      pending.push(item);
      wakeReader?.();
    };

    // Chunks are handed out one read at a time, so anything queued before an end or a reset
    // is still delivered first, exactly as it would be on a real socket.
    const body = new ReadableStream<Uint8Array>(
      {
        start(c) {
          controller = c;
        },
        async pull(c) {
          while (pending.length === 0 && !aborted) {
            await new Promise<void>((resolve) => {
              wakeReader = resolve;
            });
          }
          const item = pending.shift();
          if (aborted || item === undefined) {
            return;
          }
          if (item === 'end') {
            c.close();
          } else if (item === 'reset') {
            c.error(new TypeError('terminated'));
          } else {
            c.enqueue(item);
          }
        },
      },
      { highWaterMark: 0 },
    );

    signal?.addEventListener(
      'abort',
      () => {
        aborted = true;
        controller.error(new DOMException('Aborted', 'AbortError'));
        wakeReader?.();
      },
      { once: true },
    );
    behavior.script?.({
      event: (event) => push(encoder.encode(frame(event))),
      raw: (text) => push(encoder.encode(text)),
      end: () => push('end'),
      reset: () => push('reset'),
    });
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }
}