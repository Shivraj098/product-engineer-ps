import { loadConfig } from './config';
import { createRuntime } from './container';
import { FakeGenerator } from './generators/FakeGenerator';
import { createApp } from './http/app';
import { createJsonLogger } from './logger';

const config = loadConfig();
const logger = createJsonLogger();

const runtime = createRuntime({
  dbPath: config.dbPath,
  generator: new FakeGenerator({ delayMs: config.tokenDelayMs }),
  logger,
  replayWindow: config.replayWindow,
});

const { app, connections } = createApp({
  service: runtime.service,
  logger,
  heartbeatMs: config.heartbeatMs,
  demoMode: config.demoMode,
});

const server = app.listen(config.port, () => {
  logger.info('server.listening', {
    port: config.port,
    dbPath: config.dbPath,
    demoMode: config.demoMode,
    replayWindow: config.replayWindow,
  });
});

server.on('error', (error) => {
  logger.error('server.failed_to_start', { error: error.message });
  process.exit(1);
});

let shuttingDown = false;

/**
 * Stops accepting work and cuts open streams. Any run still in progress is left as
 * "running" on purpose: the next startup fails it explicitly (SERVER_RESTARTED), which is
 * the same path a crash would take, so there is only one restart behaviour to reason about.
 */
function shutdown(signal: string): void {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logger.info('server.shutting_down', { signal, openStreams: connections.size });

  connections.dropAll();
  server.close(() => {
    runtime.close();
    logger.info('server.stopped');
    process.exit(0);
  });
  server.closeAllConnections();
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
