import type { ResponseGenerator } from './types';

type Command =
  | { kind: 'emit'; text: string; processed: () => void }
  | { kind: 'finish' }
  | { kind: 'fail'; error: Error };

/**
 * A generator driven step by step by a test, so there are no timers or sleeps.
 * It serves a single run: `emit` a chunk, `finish` normally, or `fail`.
 */
export class ManualGenerator implements ResponseGenerator {
  private readonly queued: Command[] = [];
  private waiting: ((command: Command) => void) | undefined;

  /** Emits a chunk. Resolves once the consumer has fully processed it and asked for more. */
  emit(text: string): Promise<void> {
    return new Promise<void>((processed) => this.dispatch({ kind: 'emit', text, processed }));
  }

  finish(): void {
    this.dispatch({ kind: 'finish' });
  }

  fail(error: Error): void {
    this.dispatch({ kind: 'fail', error });
  }

  async *generate(): AsyncGenerator<string> {
    for (;;) {
      const command = await this.next();
      if (command.kind === 'finish') {
        return;
      }
      if (command.kind === 'fail') {
        throw command.error;
      }
      yield command.text;
      command.processed(); // Resumes only when the consumer calls next() again.
    }
  }

  private dispatch(command: Command): void {
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve(command);
    } else {
      this.queued.push(command);
    }
  }

  private next(): Promise<Command> {
    const command = this.queued.shift();
    if (command) {
      return Promise.resolve(command);
    }
    return new Promise<Command>((resolve) => {
      this.waiting = resolve;
    });
  }
}
