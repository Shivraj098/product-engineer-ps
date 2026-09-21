import { buildReplyChunks, parseDirectives } from './fakeReply';
import type { GenerationInput, ResponseGenerator } from './types';

export interface FakeGeneratorOptions {
  /** Pause before each chunk, so a human can watch the stream and interrupt it. */
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Deterministic stand-in for a model provider. Used in tests and in the demo. */
export class FakeGenerator implements ResponseGenerator {
  private readonly delayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: FakeGeneratorOptions = {}) {
    this.delayMs = options.delayMs ?? 0;
    this.sleep = options.sleep ?? realSleep;
  }

  async *generate({ prompt }: GenerationInput): AsyncGenerator<string> {
    const { chunkCount, failAfter } = parseDirectives(prompt);
    const chunks = buildReplyChunks(prompt, chunkCount);

    for (const [index, chunk] of chunks.entries()) {
      if (failAfter !== undefined && index === failAfter) {
        throw new Error('Simulated generator failure');
      }
      if (this.delayMs > 0) {
        await this.sleep(this.delayMs);
      }
      yield chunk;
    }
  }
}
