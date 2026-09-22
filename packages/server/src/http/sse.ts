import type { ServerResponse } from 'node:http';
import type { RunEvent } from '@tether/protocol';

/**
 * One SSE frame. `id` carries the event's position, so a standards-compliant client
 * (or `curl -H "Last-Event-ID: 7"`) can resume. The payload is a single JSON line:
 * JSON escapes newlines inside strings, so it can never break the framing.
 */
export function formatEventFrame(event: RunEvent): string {
  return `id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`;
}

function waitForDrainOrClose(res: ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      res.off('drain', done);
      res.off('close', done);
      resolve();
    };
    res.once('drain', done);
    res.once('close', done);
  });
}

export class SseStream {
  private readonly res: ServerResponse;

  private constructor(res: ServerResponse) {
    this.res = res;
  }

  /** Commits the response to being an event stream and sends the headers immediately. */
  static open(res: ServerResponse): SseStream {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    return new SseStream(res);
  }

  /** Writes an event, and pauses when the client cannot keep up (backpressure). */
  async send(event: RunEvent): Promise<void> {
    if (this.res.destroyed || this.res.writableEnded) {
      return;
    }
    if (!this.res.write(formatEventFrame(event))) {
      await waitForDrainOrClose(this.res);
    }
  }

  /** A comment frame: ignored by clients, but keeps the connection observably alive. */
  comment(text: string): void {
    if (!this.res.destroyed && !this.res.writableEnded) {
      this.res.write(`: ${text}\n\n`);
    }
  }
}
