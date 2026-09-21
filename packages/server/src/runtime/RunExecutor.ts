import type { Logger } from '../logger';
import type { ResponseGenerator } from '../generators/types';
import type { SqliteRunStore } from '../store/SqliteRunStore';
import type { RunNotifier } from './RunNotifier';

export const GENERATOR_FAILURE_MESSAGE = 'The reply generator failed.';

export interface RunExecutorDeps {
  store: SqliteRunStore;
  notifier: RunNotifier;
  generator: ResponseGenerator;
  logger: Logger;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Drives a generator and records what it produces. Every chunk is persisted first and
 * only then announced, so anything a reader can see is already durable. A run always ends
 * in exactly one terminal state: completed, or failed if anything at all goes wrong.
 */
export class RunExecutor {
  private readonly deps: RunExecutorDeps;
  private readonly inFlight = new Set<Promise<void>>();

  constructor(deps: RunExecutorDeps) {
    this.deps = deps;
  }

  /** Starts a run in the background. The returned promise never rejects. */
  start(runId: string, prompt: string): Promise<void> {
    const execution = this.execute(runId, prompt).finally(() => {
      this.inFlight.delete(execution);
    });
    this.inFlight.add(execution);
    return execution;
  }

  /** Resolves when every run started so far has reached a terminal state. */
  async idle(): Promise<void> {
    await Promise.all([...this.inFlight]);
  }

  private async execute(runId: string, prompt: string): Promise<void> {
    const { store, notifier, generator, logger } = this.deps;
    logger.info('run.started', { runId });
    try {
      for await (const chunk of generator.generate({ runId, prompt })) {
        if (chunk.length === 0) {
          continue; // A delta must carry text; empty chunks carry no information.
        }
        store.appendDelta(runId, chunk);
        notifier.notify(runId);
      }
      store.completeRun(runId);
      logger.info('run.completed', { runId });
    } catch (error) {
      this.failRun(runId, error);
    } finally {
      notifier.notify(runId);
    }
  }

  private failRun(runId: string, error: unknown): void {
    const { store, logger } = this.deps;
    // The client only ever sees a fixed message; the real cause goes to the log.
    logger.error('run.generator_failed', { runId, error: describeError(error) });
    try {
      store.failRun(runId, { code: 'GENERATOR_ERROR', message: GENERATOR_FAILURE_MESSAGE });
    } catch (secondary) {
      // The run is already terminal (or gone). A terminal state can never be overwritten.
      logger.warn('run.fail_rejected', { runId, error: describeError(secondary) });
    }
  }
}
