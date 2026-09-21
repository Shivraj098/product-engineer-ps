import { openDatabase, type Db } from './db';
import type { ResponseGenerator } from './generators/types';
import { createJsonLogger, type Logger } from './logger';
import { RunExecutor } from './runtime/RunExecutor';
import { RunNotifier } from './runtime/RunNotifier';
import { ConversationService } from './service/ConversationService';
import { SqliteRunStore } from './store/SqliteRunStore';

export interface RuntimeOptions {
  /** SQLite file path, or ':memory:'. */
  dbPath: string;
  generator: ResponseGenerator;
  logger?: Logger;
  /** How many of a run's most recent events can be replayed. 0 (default) means all. */
  replayWindow?: number;
  now?: () => Date;
}

export interface Runtime {
  db: Db;
  store: SqliteRunStore;
  notifier: RunNotifier;
  executor: RunExecutor;
  service: ConversationService;
  /** Runs that were still in progress when the previous process stopped, now failed. */
  recoveredRunIds: string[];
  close(): void;
}

/**
 * Composition root: wires the pieces together and performs restart recovery as part of
 * startup, so it cannot be forgotten by a caller.
 */
export function createRuntime(options: RuntimeOptions): Runtime {
  const logger = options.logger ?? createJsonLogger();
  const db = openDatabase(options.dbPath);
  const store = new SqliteRunStore(db, { now: options.now });
  const notifier = new RunNotifier();
  const executor = new RunExecutor({ store, notifier, generator: options.generator, logger });
  const service = new ConversationService({
    store,
    notifier,
    executor,
    replayWindow: options.replayWindow ?? 0,
  });

  const recoveredRunIds = service.recoverInterruptedRuns();
  if (recoveredRunIds.length > 0) {
    logger.warn('runs.failed_after_restart', { runIds: recoveredRunIds });
  }

  return { db, store, notifier, executor, service, recoveredRunIds, close: () => db.close() };
}
