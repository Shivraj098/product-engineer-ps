import { describe, expect, it } from 'vitest';
import { formatEventFrame } from './sse';

describe('SSE framing', () => {
  it('puts the position in the frame id and the event on one JSON line', () => {
    const frame = formatEventFrame({ seq: 7, type: 'delta', text: 'line one\nline two' });
    expect(frame).toBe('id: 7\ndata: {"seq":7,"type":"delta","text":"line one\\nline two"}\n\n');
    expect(frame.split('\n\n')).toHaveLength(2); // one frame: text newlines cannot break it
  });
});
