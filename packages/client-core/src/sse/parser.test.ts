import { describe, expect, it } from 'vitest';
import { SseParser, readSseStream, type SseItem } from './parser';

const messages = (items: SseItem[]) =>
  items.flatMap((item) => (item.kind === 'message' ? [item.message] : []));

const STREAM = 'id: 1\ndata: {"a":1}\n\n: hb\n\nid: 2\ndata: {"b":"two"}\n\n';
const EXPECTED = [
  { id: '1', data: '{"a":1}' },
  { id: '2', data: '{"b":"two"}' },
];

describe('SseParser', () => {
  it('parses frames and comments', () => {
    const items = new SseParser().feed(STREAM);
    expect(messages(items)).toEqual(EXPECTED);
    expect(items.filter((item) => item.kind === 'comment')).toEqual([
      { kind: 'comment', text: 'hb' },
    ]);
  });

  it('gives the same result however the network splits the bytes', () => {
    for (let split = 0; split <= STREAM.length; split += 1) {
      const parser = new SseParser();
      const items = [...parser.feed(STREAM.slice(0, split)), ...parser.feed(STREAM.slice(split))];
      expect(messages(items), `split at ${split}`).toEqual(EXPECTED);
    }
  });

  it('waits for the rest of an incomplete frame', () => {
    const parser = new SseParser();
    expect(parser.feed('id: 1\ndata: {"a"')).toEqual([]);
    expect(messages(parser.feed(':1}\n\n'))).toEqual([{ id: '1', data: '{"a":1}' }]);
  });

  it.each([
    ['CRLF', 'data: x\r\n\r\n'],
    ['bare CR', 'data: x\r\r: end\n'],
    ['LF', 'data: x\n\n'],
  ])('accepts %s line endings', (_label, text) => {
    expect(messages(new SseParser().feed(text))).toEqual([{ id: undefined, data: 'x' }]);
  });

  it('handles a CRLF split between the CR and the LF', () => {
    const parser = new SseParser();
    const first = parser.feed('data: x\r\n\r');
    const second = parser.feed('\n');
    expect(messages([...first, ...second])).toEqual([{ id: undefined, data: 'x' }]);
  });

  it('joins multi-line data with newlines and strips only one leading space', () => {
    const items = new SseParser().feed('data: one\ndata:  two\n\n');
    expect(messages(items)).toEqual([{ id: undefined, data: 'one\n two' }]);
  });

  it('ignores fields it does not use, and frames without data', () => {
    const items = new SseParser().feed('event: ping\nretry: 10\n\nid: 5\n\ndata: ok\n\n');
    expect(messages(items)).toEqual([{ id: undefined, data: 'ok' }]);
  });
});

describe('readSseStream', () => {
  const streamOf = (...chunks: Uint8Array[]) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        chunks.forEach((chunk) => controller.enqueue(chunk));
        controller.close();
      },
    });

  const collect = async (body: ReadableStream<Uint8Array>) => {
    const items: SseItem[] = [];
    for await (const item of readSseStream(body)) {
      items.push(item);
    }
    return items;
  };

  it('decodes a multi-byte character split across chunks', async () => {
    const bytes = new TextEncoder().encode('data: 5€\n\n');
    const euro = bytes.indexOf(0xe2);
    const items = await collect(streamOf(bytes.slice(0, euro + 1), bytes.slice(euro + 1)));
    expect(messages(items)).toEqual([{ id: undefined, data: '5€' }]);
  });

  it('propagates a stream that breaks mid-flight', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: a\n\n'));
        controller.error(new TypeError('terminated'));
      },
    });
    await expect(collect(body)).rejects.toThrow('terminated');
  });
});
