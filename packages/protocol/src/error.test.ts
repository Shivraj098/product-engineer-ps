import { describe, expect, it } from 'vitest';
import {
  ERROR_CODES,
  HTTP_STATUS_BY_ERROR_CODE,
  TetherError,
  parseApiError,
  type CursorRecovery,
} from './errors';

const recovery: CursorRecovery = {
  action: 'RESYNC_FROM_SNAPSHOT',
  lastSeq: 120,
  oldestReplayableSeq: 71,
};

describe('HTTP status mapping', () => {
  it('maps every error code to a 4xx or 5xx status', () => {
    for (const code of ERROR_CODES) {
      const status = HTTP_STATUS_BY_ERROR_CODE[code];
      expect(status, code).toBeGreaterThanOrEqual(400);
      expect(status, code).toBeLessThan(600);
    }
  });

  it('uses distinct statuses for the recoverable cursor errors', () => {
    expect(new TetherError('INVALID_CURSOR', 'm').status).toBe(400);
    expect(new TetherError('CURSOR_AHEAD', 'm').status).toBe(409);
    expect(new TetherError('CURSOR_EXPIRED', 'm').status).toBe(410);
  });
});

describe('TetherError', () => {
  it('serialises without a recovery hint when none is given', () => {
    const body = new TetherError('RUN_NOT_FOUND', 'no such run').toBody();
    expect(body).toStrictEqual({ error: { code: 'RUN_NOT_FOUND', message: 'no such run' } });
  });

  it('serialises the recovery hint for cursor errors', () => {
    const body = new TetherError('CURSOR_EXPIRED', 'too old', recovery).toBody();
    expect(body.error.recovery).toEqual(recovery);
  });

  it('round-trips through parseApiError', () => {
    const original = new TetherError('CURSOR_EXPIRED', 'too old', recovery);
    const rebuilt = parseApiError(JSON.parse(JSON.stringify(original.toBody())));
    expect(rebuilt).toBeInstanceOf(TetherError);
    expect(rebuilt?.code).toBe('CURSOR_EXPIRED');
    expect(rebuilt?.recovery).toEqual(recovery);
  });

  it.each([
    ['null', null],
    ['a string', 'oops'],
    ['an unknown code', { error: { code: 'NOPE', message: 'x' } }],
    ['a missing message', { error: { code: 'INTERNAL' } }],
    ['a malformed recovery hint', { error: { code: 'CURSOR_AHEAD', message: 'x', recovery: {} } }],
  ])('parseApiError returns undefined for %s', (_label, json) => {
    expect(parseApiError(json)).toBeUndefined();
  });
});