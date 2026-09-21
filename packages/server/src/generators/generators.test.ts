import { describe, expect, it, vi } from 'vitest';
import { FakeGenerator } from './FakeGenerator';
import { ManualGenerator } from './ManualGenerator';
import {
  DEFAULT_CHUNK_COUNT,
  MAX_CHUNK_COUNT,
  buildReplyChunks,
  parseDirectives,
} from './fakeReply';

async function drain(stream: AsyncIterable<string>): Promise<string[]> {
  const chunks: string[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}

describe('parseDirectives', () => {
  it('uses the default length when no directive is given', () => {
    expect(parseDirectives('hello there')).toEqual({ chunkCount: DEFAULT_CHUNK_COUNT });
  });

  it('reads /chunks and /fail-after anywhere in the prompt', () => {
    expect(parseDirectives('tell me a story /chunks:40 /fail-after:8')).toEqual({
      chunkCount: 40,
      failAfter: 8,
    });
  });

  it('clamps the length to a sane range', () => {
    expect(parseDirectives('/chunks:0').chunkCount).toBe(1);
    expect(parseDirectives('/chunks:999999').chunkCount).toBe(MAX_CHUNK_COUNT);
  });

  it('ignores a failure point that would never be reached', () => {
    expect(parseDirectives('/chunks:5 /fail-after:5')).toEqual({ chunkCount: 5 });
  });

  it('only recognises directives that stand alone', () => {
    expect(parseDirectives('x/chunks:5')).toEqual({ chunkCount: DEFAULT_CHUNK_COUNT });
    expect(parseDirectives('/chunks:abc')).toEqual({ chunkCount: DEFAULT_CHUNK_COUNT });
  });
});

describe('buildReplyChunks', () => {
  it('is a pure function of the prompt and count', () => {
    expect(buildReplyChunks('hello', 30)).toEqual(buildReplyChunks('hello', 30));
  });

  it('returns exactly the requested number of non-empty chunks', () => {
    const chunks = buildReplyChunks('hello', 37);
    expect(chunks).toHaveLength(37);
    expect(chunks.every((chunk) => chunk.length > 0)).toBe(true);
  });
});

describe('FakeGenerator', () => {
  it('yields exactly the deterministic reply', async () => {
    const chunks = await drain(
      new FakeGenerator().generate({ runId: 'r', prompt: 'hi /chunks:12' }),
    );
    expect(chunks).toEqual(buildReplyChunks('hi /chunks:12', 12));
  });

  it('fails after the requested number of chunks', async () => {
    const seen: string[] = [];
    const run = async (): Promise<void> => {
      for await (const chunk of new FakeGenerator().generate({
        runId: 'r',
        prompt: 'hi /fail-after:3',
      })) {
        seen.push(chunk);
      }
    };
    await expect(run()).rejects.toThrow('Simulated generator failure');
    expect(seen).toHaveLength(3);
  });

  it('can fail before emitting anything', async () => {
    const generator = new FakeGenerator().generate({ runId: 'r', prompt: 'x /fail-after:0' });
    await expect(drain(generator)).rejects.toThrow('Simulated generator failure');
  });

  it('pauses before each chunk using the injected sleep, never real time', async () => {
    const sleep = vi.fn(() => Promise.resolve());
    const generator = new FakeGenerator({ delayMs: 25, sleep });
    await drain(generator.generate({ runId: 'r', prompt: 'x /chunks:4' }));
    expect(sleep).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledWith(25);
  });
});

describe('ManualGenerator', () => {
  it('emit resolves only after the consumer has processed the chunk', async () => {
    const generator = new ManualGenerator();
    const received: string[] = [];
    const consumer = (async () => {
      for await (const chunk of generator.generate()) {
        received.push(chunk);
      }
    })();

    await generator.emit('a');
    expect(received).toEqual(['a']);
    await generator.emit('b');
    expect(received).toEqual(['a', 'b']);

    generator.finish();
    await consumer;
  });

  it('delivers commands issued before anyone is consuming, in order', async () => {
    const generator = new ManualGenerator();
    const first = generator.emit('x');
    const second = generator.emit('y');
    generator.finish();

    expect(await drain(generator.generate())).toEqual(['x', 'y']);
    await Promise.all([first, second]);
  });

  it('throws the given error to the consumer', async () => {
    const generator = new ManualGenerator();
    void generator.emit('a');
    generator.fail(new Error('boom'));
    await expect(drain(generator.generate())).rejects.toThrow('boom');
  });
});
