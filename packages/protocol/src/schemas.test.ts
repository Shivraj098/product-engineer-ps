import { describe, expect, it } from 'vitest';
import { TetherError } from './errors';
import {
  MAX_MESSAGE_LENGTH,
  parseCursor,
  resolveCursor,
  sendMessageRequestSchema,
} from './schemas';

function errorCodeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof TetherError ? error.code : 'NOT_A_TETHER_ERROR';
  }
  return undefined;
}

describe('sendMessageRequestSchema', () => {
  const messageId = '3f2b8c1e-5d4a-4b8e-9c1a-7e6d5f4a3b21';

  it('accepts a valid request and trims the content', () => {
    const parsed = sendMessageRequestSchema.parse({ messageId, content: '  hello  ' });
    expect(parsed).toEqual({ messageId, content: 'hello' });
  });

  it('accepts content of exactly the maximum length', () => {
    const content = 'a'.repeat(MAX_MESSAGE_LENGTH);
    expect(sendMessageRequestSchema.safeParse({ messageId, content }).success).toBe(true);
  });

  it.each([
    ['a non-uuid messageId', { messageId: 'not-a-uuid', content: 'hi' }],
    ['a missing messageId', { content: 'hi' }],
    ['empty content', { messageId, content: '' }],
    ['whitespace-only content', { messageId, content: '   \n\t ' }],
    ['content over the limit', { messageId, content: 'a'.repeat(MAX_MESSAGE_LENGTH + 1) }],
    ['non-string content', { messageId, content: 42 }],
  ])('rejects %s', (_label, body) => {
    expect(sendMessageRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe('parseCursor', () => {
  it('treats an absent cursor as 0', () => {
    expect(parseCursor(undefined)).toBe(0);
  });

  it.each([
    ['0', 0],
    ['7', 7],
    ['42', 42],
    ['007', 7],
  ])('parses %j as %d', (raw, expected) => {
    expect(parseCursor(raw)).toBe(expected);
  });

  it.each(['-1', '1.5', 'abc', '', ' 3', '3 ', '1e3', '0x10', '+4', '99999999999999999999'])(
    'rejects %j as INVALID_CURSOR',
    (raw) => {
      expect(errorCodeOf(() => parseCursor(raw))).toBe('INVALID_CURSOR');
    },
  );
});

describe('resolveCursor', () => {
  it('prefers the after query parameter over Last-Event-ID', () => {
    expect(resolveCursor({ after: '5', lastEventId: '9' })).toBe(5);
  });

  it('falls back to Last-Event-ID, then to 0', () => {
    expect(resolveCursor({ lastEventId: '9' })).toBe(9);
    expect(resolveCursor({})).toBe(0);
  });

  it('rejects an invalid value from either source', () => {
    expect(errorCodeOf(() => resolveCursor({ after: 'x' }))).toBe('INVALID_CURSOR');
    expect(errorCodeOf(() => resolveCursor({ lastEventId: 'x' }))).toBe('INVALID_CURSOR');
  });
});