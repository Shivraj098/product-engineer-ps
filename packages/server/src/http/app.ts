import express, { type Express, type RequestHandler } from 'express';
import type { Logger } from '../logger';
import type { ConversationService } from '../service/ConversationService';
import { ConnectionRegistry } from './connections';
import { createErrorHandler } from './errors';
import { createApiRouter } from './routes';

export interface AppOptions {
  service: ConversationService;
  logger: Logger;
  /** SSE keep-alive interval in ms. 0 disables heartbeats. */
  heartbeatMs: number;
  demoMode: boolean;
}

export interface HttpApp {
  app: Express;
  connections: ConnectionRegistry;
}

function requestLogger(logger: Logger): RequestHandler {
  return (req, res, next) => {
    const startedAt = Date.now();
    res.on('close', () => {
      logger.info('http.request', {
        method: req.method,
        path: req.originalUrl.split('?')[0],
        status: res.statusCode,
        durationMs: Date.now() - startedAt,
      });
    });
    next();
  };
}

export function createApp(options: AppOptions): HttpApp {
  const { service, logger, heartbeatMs, demoMode } = options;
  const connections = new ConnectionRegistry();

  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);
  app.use(requestLogger(logger));
  app.use(express.json({ limit: '16kb' }));
  app.use('/api', createApiRouter({ service, connections, logger, heartbeatMs, demoMode }));
  app.use(createErrorHandler(logger));

  return { app, connections };
}
