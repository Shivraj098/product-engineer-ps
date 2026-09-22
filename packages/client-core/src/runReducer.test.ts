import type { RunSnapshot } from '@tether/protocol';
import { describe, expect, it } from 'vitest';
import { applyRunEvent, createRunView, viewFromSnapshot, type RunView } from './runReducer';
import { completed, delta, failed } from './testing/fakeTransport';

function applyAll(view: RunView, ...events: Parameters<typeof applyRunEvent>[1][]) {
  return events.reduce(
    (state, event) => {
      const result = applyRunEvent(state.view, event);
      return { view: result.view, outcomes: [...state.outcomes, result.outcome] };
    },
    { view, outcomes: [] as string[] },
  );
}

describe('applyRunEvent', () => {
  it('applies consecutive events in order and assembles the text', () => {
    const { view, outcomes } = applyAll(
      createRunView('r'),
      delta(1, 'Hel'),
      delta(2, 'lo'),
      completed(3),
    );
    expect(outcomes).toEqual(['applied', 'applied', 'applied']);
    expect(view).toMatchObject({ status: 'completed', text: 'Hello', lastSeq: 3 });
    expect(view.stats.applied).toBe(3);
  });

  it('ignores an event it already applied, leaving the text untouched', () => {
    const { view, outcomes } = applyAll(
      createRunView('r'),
      delta(1, 'a'),
      delta(2, 'b'),
      delta(2, 'b'),
      delta(1, 'a'),
    );
    expect(outcomes).toEqual(['applied', 'applied', 'duplicate', 'duplicate']);
    expect(view).toMatchObject({ text: 'ab', lastSeq: 2 });
    expect(view.stats.duplicatesIgnored).toBe(2);
  });

  it('refuses to skip ahead: a gap changes nothing and is counted', () => {
    const { view, outcomes } = applyAll(createRunView('r'), delta(1, 'a'), delta(3, 'c'));
    expect(outcomes).toEqual(['applied', 'gap']);
    expect(view).toMatchObject({ text: 'a', lastSeq: 1 });
    expect(view.stats.gapsDetected).toBe(1);
  });

  it('records the failure of a failed run', () => {
    const { view } = applyAll(createRunView('r'), delta(1, 'a'), failed(2));
    expect(view).toMatchObject({
      status: 'failed',
      text: 'a',
      failure: { code: 'SERVER_RESTARTED', message: 'restarted' },
    });
  });

  it('never applies anything after a terminal event', () => {
    const { view, outcomes } = applyAll(createRunView('r'), completed(1), delta(2, 'late'));
    expect(outcomes).toEqual(['applied', 'after-terminal']);
    expect(view).toMatchObject({ status: 'completed', text: '', lastSeq: 1 });
    expect(view.stats.afterTerminalIgnored).toBe(1);
  });

  it('does not mutate the view it was given', () => {
    const before = createRunView('r');
    const snapshot = structuredClone(before);
    applyRunEvent(before, delta(1, 'a'));
    expect(before).toEqual(snapshot);
  });
});

describe('viewFromSnapshot', () => {
  const snapshot: RunSnapshot = {
    runId: 'r',
    conversationId: 'c',
    state: 'failed',
    lastSeq: 7,
    oldestReplayableSeq: 3,
    text: 'partial',
    failure: { code: 'GENERATOR_ERROR', message: 'boom' },
  };

  it('adopts the server state, including its cursor and failure', () => {
    expect(viewFromSnapshot(snapshot)).toMatchObject({
      runId: 'r',
      status: 'failed',
      text: 'partial',
      lastSeq: 7,
      failure: { code: 'GENERATOR_ERROR', message: 'boom' },
    });
  });

  it('keeps the counters it is given', () => {
    const stats = { applied: 4, duplicatesIgnored: 1, gapsDetected: 0, afterTerminalIgnored: 0 };
    expect(viewFromSnapshot(snapshot, stats).stats).toEqual(stats);
  });
});