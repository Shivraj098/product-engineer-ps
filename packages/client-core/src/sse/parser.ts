export interface SseMessage {
  id: string | undefined;
  data: string;
}

export type SseItem = { kind: 'message'; message: SseMessage } | { kind: 'comment'; text: string };

/**
 * Incremental parser for the subset of Server-Sent Events this protocol uses:
 * `id:` and `data:` fields, blank-line frame endings, and `:` comment lines.
 * Network chunks can split a frame anywhere, so it buffers until a line is complete.
 */
export class SseParser {
  private buffer = '';
  private data: string[] = [];
  private id: string | undefined;

  /** Feeds decoded text and returns every item it completed. */
  feed(chunk: string): SseItem[] {
    this.buffer += chunk;
    const items: SseItem[] = [];
    let start = 0;
    let index = 0;

    while (index < this.buffer.length) {
      const char = this.buffer.charAt(index);
      if (char !== '\n' && char !== '\r') {
        index += 1;
        continue;
      }
      if (char === '\r' && index === this.buffer.length - 1) {
        break; // Might be the first half of "\r\n": wait for the next chunk.
      }
      const line = this.buffer.slice(start, index);
      index += char === '\r' && this.buffer.charAt(index + 1) === '\n' ? 2 : 1;
      start = index;
      this.processLine(line, items);
    }

    this.buffer = this.buffer.slice(start);
    return items;
  }

  private processLine(line: string, items: SseItem[]): void {
    if (line === '') {
      if (this.data.length > 0) {
        items.push({ kind: 'message', message: { id: this.id, data: this.data.join('\n') } });
      }
      this.data = [];
      this.id = undefined;
      return;
    }
    if (line.startsWith(':')) {
      items.push({ kind: 'comment', text: line.slice(1).trim() });
      return;
    }
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) {
      value = value.slice(1);
    }
    if (field === 'data') {
      this.data.push(value);
    } else if (field === 'id') {
      this.id = value;
    }
    // "event", "retry" and unknown fields are ignored: this protocol does not use them.
  }
}

/** Decodes a response body into SSE items, releasing the stream when done or abandoned. */
export async function* readSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseItem, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        return;
      }
      for (const item of parser.feed(decoder.decode(value, { stream: true }))) {
        yield item;
      }
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}
