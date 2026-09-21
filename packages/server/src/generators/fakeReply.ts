export const DEFAULT_CHUNK_COUNT = 30;
export const MAX_CHUNK_COUNT = 500;

export interface Directives {
  chunkCount: number;
  /** Fail after emitting this many chunks. Ignored when it is not below `chunkCount`. */
  failAfter?: number;
}

const WORDS = [
  'resilient',
  'streams',
  'keep',
  'their',
  'place',
  'when',
  'a',
  'connection',
  'drops',
  'and',
  'every',
  'event',
  'has',
  'exactly',
  'one',
  'position',
  'so',
  'the',
  'reader',
  'can',
  'resume',
  'without',
  'guessing',
  'or',
  'repeating',
] as const;

function readNumberDirective(prompt: string, name: string): number | undefined {
  const match = new RegExp(`(?:^|\\s)/${name}:(\\d+)(?=\\s|$)`).exec(prompt);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

/**
 * The demo generator is steered from the message itself:
 *   /chunks:N      reply length in chunks (default 30, clamped to 1..500)
 *   /fail-after:N  throw after N chunks have been emitted
 */
export function parseDirectives(prompt: string): Directives {
  const requested = readNumberDirective(prompt, 'chunks') ?? DEFAULT_CHUNK_COUNT;
  const chunkCount = Math.min(MAX_CHUNK_COUNT, Math.max(1, requested));
  const failAfter = readNumberDirective(prompt, 'fail-after');
  return failAfter === undefined || failAfter >= chunkCount
    ? { chunkCount }
    : { chunkCount, failAfter };
}

/** FNV-1a: a tiny, stable string hash, so the same prompt always yields the same reply. */
function hash(text: string): number {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value;
}

/** A pure function of (prompt, count): the expected reply in tests and in the benchmark. */
export function buildReplyChunks(prompt: string, count: number): string[] {
  const offset = hash(prompt) % WORDS.length;
  return Array.from({ length: count }, (_, index) => `${WORDS[(offset + index) % WORDS.length]} `);
}
