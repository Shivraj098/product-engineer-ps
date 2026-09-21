import { isTerminalEvent } from '@tether/protocol';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../db';
import { SqliteRunStore } from '../store/SqliteRunStore';
import { collect, seqsOf, sequentialIds, tickingClock } from '../testing/helpers';
import { RunNotifier } from './RunNotifier';
import { tailRun } from './tail';

function setup() {
  const store = new SqliteRunStore(openDatabase(':memory:'), {
    now: tickingClock(),
    newId: sequentialIds(),
  });
  const notifier = new RunNotifier();
  const conversationId = store.createConversation();
  const { run } = store.submitMessage({ conversationId, messageId: 'm1', content: 'hi' });
  const tail = (after: number, signal = new AbortController().signal) =>
    tailRun({ store, notifier }, run.id, after, signal);
  /** What the executor does: persist first, then announce. */
  const append = (text: string) => {
    store.appendDelta(run.id, text);
    notifier.notify(run.id);
  };
  const complete = () => {
    store.completeRun(run.id);
    notifier.notify(run.id);
  };
  return { store, notifier, run, tail, append, complete };
}

describe('tailRun', () => {
  it('delivers live events in order and ends after the terminal event', async () => {
    const { tail, append, complete } = setup();
    const collected = collect(tail(0));

    append('a');
    append('b');
    append('c');
    complete();

    const events = await collected;
    expect(seqsOf(events)).toEqual([1, 2, 3, 4]);
    expect(events.at(-1)?.type).toBe('completed');
  });

  it('replays exactly the events after a cursor', async () => {
    const { tail, append, complete } = setup();
    for (let index = 1; index <= 10; index += 1) {
      append(`w${index}`);
    }
    complete();

    expect(seqsOf(await collect(tail(4)))).toEqual([5, 6, 7, 8, 9, 10, 11]);
  });

  it('ends immediately for a finished run whose terminal event the client already has', async () => {
    const { tail, append, complete } = setup();
    append('a');
    complete();
    expect(await collect(tail(2))).toEqual([]);
  });

  it('keeps replay and live delivery in one gapless, duplicate-free sequence', async () => {
    const { tail, notifier, append, complete } = setup();
    append('a');

    const iterator = tail(0);
    const first = await iterator.next();
    expect(first.value?.seq).toBe(1);

    // Events land while the reader is between reads (it has not asked for the next one).
    append('b');
    append('c');
    append('d');

    const replayed = [await iterator.next(), await iterator.next(), await iterator.next()];
    expect(replayed.map((step) => step.value?.seq)).toEqual([2, 3, 4]);

    // Caught up: the reader now waits for live events.
    const live = iterator.next();
    expect(notifier.waiterCount).toBe(1);
    append('e');
    expect((await live).value?.seq).toBe(5);

    complete();
    const terminal = await iterator.next();
    expect(terminal.value && isTerminalEvent(terminal.value)).toBe(true);
    expect((await iterator.next()).done).toBe(true);
  });

  it('serves independent readers from their own cursors', async () => {
    const { tail, append, complete } = setup();
    const fromStart = collect(tail(0));
    const fromTwo = collect(tail(2));

    append('a');
    append('b');
    append('c');
    complete();

    expect(seqsOf(await fromStart)).toEqual([1, 2, 3, 4]);
    expect(seqsOf(await fromTwo)).toEqual([3, 4]);
  });

  it('stops and releases its waiter when the signal aborts', async () => {
    const { tail, notifier } = setup();
    const controller = new AbortController();
    const iterator = tail(0, controller.signal);

    const pending = iterator.next();
    expect(notifier.waiterCount).toBe(1);
    controller.abort();

    expect((await pending).done).toBe(true);
    expect(notifier.waiterCount).toBe(0);
  });

  it('does nothing for a signal that is already aborted', async () => {
    const { tail, append } = setup();
    append('a');
    const controller = new AbortController();
    controller.abort();
    expect(await collect(tail(0, controller.signal))).toEqual([]);
  });
});
