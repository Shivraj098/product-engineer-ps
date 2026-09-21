export interface GenerationInput {
  runId: string;
  prompt: string;
}

/**
 * The seam between the runtime and whatever produces reply text (a real model provider
 * in production, a deterministic fake here). It yields text chunks and throws on failure.
 */
export interface ResponseGenerator {
  generate(input: GenerationInput): AsyncIterable<string>;
}
