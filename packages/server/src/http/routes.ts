import { TetherError, resolveCursor, sendMessageRequestSchema } from '@tether/protocol';
import { Router } from 'express';
import type { Logger } from '../logger';
import type { ConversationService } from '../service/ConversationService';
import type { ConnectionRegistry } from './connections';
import { SseStream } from './sse';

export interface ApiDeps {
  service: ConversationService;
  connections: ConnectionRegistry;
  logger: Logger;
  /** SSE keep-alive interval in ms. 0 disables heartbeats. */
  heartbeatMs: number;
  /** Enables demo-only endpoints. */
  demoMode: boolean;
}

/** A query parameter that may be given at most once (repeats arrive as an array). */
function singleQueryValue(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === 'string') {
    return value;
  }
  throw new TetherError('INVALID_CURSOR', 'The "after" parameter may be given at most once.');
}

/**
 * The HTTP surface. Handlers only translate between HTTP and the service: parse and
 * validate input, call one service method, shape the response. Rules live in the service.
 */
export function createApiRouter(deps: ApiDeps): Router {
  const { service, connections, logger, heartbeatMs, demoMode } = deps;
  const router = Router();

  router.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  router.post('/conversations', (_req, res) => {
    res.status(201).json(service.createConversation());
  });

  router.get('/conversations/:conversationId', (req, res) => {
    res.json(service.getConversationSnapshot(req.params.conversationId));
  });

  router.post('/conversations/:conversationId/messages', (req, res) => {
    const body = sendMessageRequestSchema.parse(req.body);
    const { created, response } = service.sendMessage(req.params.conversationId, body);
    res.status(created ? 201 : 200).json(response);
  });

  router.get('/runs/:runId', (req, res) => {
    res.json(service.getRunSnapshot(req.params.runId));
  });

  router.get('/runs/:runId/events', async (req, res) => {
    const controller = new AbortController();
    res.on('close', () => controller.abort());

    // Everything that can fail with a proper error happens BEFORE we commit to a stream.
    const cursor = resolveCursor({
      after: singleQueryValue(req.query.after),
      lastEventId: req.header('last-event-id'),
    });
    const events = service.openEventStream(req.params.runId, cursor, controller.signal);

    const stream = SseStream.open(res);
    connections.add(res);
    const heartbeat =
      heartbeatMs > 0 ? setInterval(() => stream.comment('hb'), heartbeatMs) : undefined;
    logger.info('sse.opened', { runId: req.params.runId, cursor });

    try {
      for await (const event of events) {
        await stream.send(event);
      }
    } catch (error) {
      logger.error('sse.stream_failed', {
        runId: req.params.runId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (heartbeat !== undefined) {
        clearInterval(heartbeat);
      }
      connections.delete(res);
      res.end();
    }
  });

  if (demoMode) {
    router.post('/dev/drop-connections', (_req, res) => {
      res.json({ dropped: connections.dropAll() });
    });
  }

  return router;
}
