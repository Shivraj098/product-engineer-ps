import { z } from 'zod';

export const ERROR_CODES = [
  'VALIDATION_ERROR',
  'INVALID_CURSOR',
  'CONVERSATION_NOT_FOUND',
  'RUN_NOT_FOUND',
  'RUN_IN_PROGRESS',
  'MESSAGE_ID_REUSED',
  'CURSOR_AHEAD',
  'CURSOR_EXPIRED',
  'INTERNAL',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** This is a single source of truth for the mapping of error codes to HTTP status codes. The server uses this to set the response status, and the client uses it to determine how to handle the error. */
export const HTTP_STATUS_BY_ERROR_CODE: Readonly<Record<ErrorCode, number>> = {
  VALIDATION_ERROR: 400,
  INVALID_CURSOR: 400,
  CONVERSATION_NOT_FOUND: 404,
  RUN_NOT_FOUND: 404,
  RUN_IN_PROGRESS: 409,
  MESSAGE_ID_REUSED: 409,
  CURSOR_AHEAD: 409,
  CURSOR_EXPIRED: 410,
  INTERNAL: 500,
};

/** Tells a client how to recover when its cursor cannot be replayed from. */
export const cursorRecoverySchema = z.object({
  action: z.literal('RESYNC_FROM_SNAPSHOT'),
  lastSeq: z.number().int().min(0),
  oldestReplayableSeq: z.number().int().min(1),
});
export type CursorRecovery = z.infer<typeof cursorRecoverySchema>;

export const apiErrorBodySchema = z.object({
  error: z.object({
    code: z.enum(ERROR_CODES),
    message: z.string(),
    recovery: cursorRecoverySchema.optional(),
  }),
});
export type ApiErrorBody = z.infer<typeof apiErrorBodySchema>;

/** The one error type shared by server (throws it) and client (rebuilds it from a response). */
export class TetherError extends Error {
  readonly code: ErrorCode;
  readonly recovery?: CursorRecovery;

  constructor(code: ErrorCode, message: string, recovery?: CursorRecovery) {
    super(message);
    this.name = 'TetherError';
    this.code = code;
    if (recovery !== undefined) {
      this.recovery = recovery;
    }
  }

  get status(): number {
    return HTTP_STATUS_BY_ERROR_CODE[this.code];
  }

  toBody(): ApiErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.recovery !== undefined ? { recovery: this.recovery } : {}),
      },
    };
  }
}

/** Rebuilds a typed error from an untrusted JSON response body, or returns undefined. */
export function parseApiError(json: unknown): TetherError | undefined {
  const parsed = apiErrorBodySchema.safeParse(json);
  if (!parsed.success) {
    return undefined;
  }
  const { code, message, recovery } = parsed.data.error;
  return new TetherError(code, message, recovery);
}