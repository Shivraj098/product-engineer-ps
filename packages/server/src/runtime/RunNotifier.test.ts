import { describe, expect, it } from 'vitest';
import { RunNotifier } from './RunNotifier';

describe('RunNotifier', () => {
  it('wakes a waiter on notify', async () => {
    const notifier = new RunNotifier();
    let woke = false;
    const waiting = notifier.waitForChange('r1', new AbortController().signal).then(() => {
      woke = true;
    });

    expect(notifier.waiterCount).toBe(1);
    await Promise.resolve();
    expect(woke).toBe(false);

    notifier.notify('r1');
    await waiting;
    expect(woke).toBe(true);
    expect(notifier.waiterCount).toBe(0);
  });

  it('wakes every waiter of that run, and only that run', async () => {
    const notifier = new RunNotifier();
    const signal = new AbortController().signal;
    const woken: string[] = [];
    const a1 = notifier.waitForChange('a', signal).then(() => woken.push('a1'));
    const a2 = notifier.waitForChange('a', signal).then(() => woken.push('a2'));
    const b = notifier.waitForChange('b', signal).then(() => woken.push('b'));

    notifier.notify('a');
    await Promise.all([a1, a2]);
    expect(woken.sort()).toEqual(['a1', 'a2']);
    expect(notifier.waiterCount).toBe(1);

    notifier.notify('b');
    await b;
    expect(notifier.waiterCount).toBe(0);
  });

  it('resolves and cleans up when the signal aborts', async () => {
    const notifier = new RunNotifier();
    const controller = new AbortController();
    const waiting = notifier.waitForChange('r1', controller.signal);
    expect(notifier.waiterCount).toBe(1);

    controller.abort();
    await waiting;
    expect(notifier.waiterCount).toBe(0);
  });

  it('does not register a waiter for a signal that is already aborted', async () => {
    const notifier = new RunNotifier();
    const controller = new AbortController();
    controller.abort();
    await notifier.waitForChange('r1', controller.signal);
    expect(notifier.waiterCount).toBe(0);
  });

  it('ignores a notify with nobody waiting', () => {
    expect(() => new RunNotifier().notify('r1')).not.toThrow();
  });
});
