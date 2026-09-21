import { describe, expect, it } from 'vitest';
import { isTerminalEvent, runEventSchema, type RunEvent } from './events';

const delta: RunEvent = { seq: 1, type: 'delta', text: 'hello ' };
const completed: RunEvent = { seq: 2, type: 'completed' };
const failed: RunEvent = { seq: 3, type: 'failed', code: 'SERVER_RESTARTED', message: 'restart' };

describe('runEventSchema', () => {
  it.each([delta, completed, failed])('accepts a valid %j', (event) => {
    expect(runEventSchema.parse(event)).toEqual(event);
  });

  it.each([
    ['seq of zero', { seq: 0, type: 'delta', text: 'x' }],
    ['negative seq', { seq: -1, type: 'delta', text: 'x' }],
    ['fractional seq', { seq: 1.5, type: 'delta', text: 'x' }],
    ['string seq', { seq: '1', type: 'delta', text: 'x' }],
    ['missing seq', { type: 'delta', text: 'x' }],
    ['empty delta text', { seq: 1, type: 'delta', text: '' }],
    ['unknown type', { seq: 1, type: 'started' }],
    ['unknown failure code', { seq: 1, type: 'failed', code: 'BOOM', message: 'm' }],
    ['failed without message', { seq: 1, type: 'failed', code: 'GENERATOR_ERROR' }],
  ])('rejects %s', (_label, event) => {
    expect(runEventSchema.safeParse(event).success).toBe(false);
  });
});

describe('isTerminalEvent', () => {
  it('is true only for completed and failed events', () => {
    expect(isTerminalEvent(delta)).toBe(false);
    expect(isTerminalEvent(completed)).toBe(true);
    expect(isTerminalEvent(failed)).toBe(true);
  });
});
