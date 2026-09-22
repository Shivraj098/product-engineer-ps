import { TetherError } from '@tether/protocol';
import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import type { Logger } from '../logger';

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Errors raised by Express's JSON body parser (malformed JSON, body too large, ...). */
function isBodyParserError(error: unknown): error is { type: string; status: number } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'type' in error &&
    typeof error.type === 'string' &&
    'status' in error &&
    typeof error.status === 'number' &&
    error.status >= 400 &&
    error.status < 500
  );
}

/** Maps anything thrown while handling a request onto the shared, typed error contract. */
export function toTetherError(error: unknown): TetherError {
  if (error instanceof TetherError) {
    return error;
  }
  if (error instanceof ZodError) {
    const problems = error.issues
      .map((issue) =>
        issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message,
      )
      .join('; ');
    return new TetherError('VALIDATION_ERROR', `Invalid request: ${problems}`);
  }
  if (isBodyParserError(error)) {
    const message =
      error.type === 'entity.too.large'
        ? 'Request body is too large.'
        : 'Request body could not be read as JSON.';
    return new TetherError('VALIDATION_ERROR', message);
  }
  return new TetherError('INTERNAL', 'Something went wrong on our side.');
}

export function createErrorHandler(logger: Logger): ErrorRequestHandler {
  return (error, req, res, _next) => {
    const tetherError = toTetherError(error);
    const path = req.originalUrl.split('?')[0];

    if (tetherError.code === 'INTERNAL') {
      // The client gets a generic message; the real cause stays in the log.
      logger.error('http.unhandled_error', { path, error: describeError(error) });
    }
    if (res.headersSent) {
      // Too late for a JSON error (a stream is already open): just cut the connection.
      res.destroy();
      return;
    }
    res.status(tetherError.status).json(tetherError.toBody());
  };
}
