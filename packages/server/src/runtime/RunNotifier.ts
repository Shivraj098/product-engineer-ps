/**
 * In-process "something changed for run X" signal. It carries no data: a woken reader
 * always re-reads the event log. That is what lets replay and live delivery share one path.
 */
export class RunNotifier {
  private readonly waiters = new Map<string, Set<() => void>>();

  /** Number of readers currently waiting. Exposed so tests can assert nothing leaks. */
  get waiterCount(): number {
    let count = 0;
    for (const set of this.waiters.values()) {
      count += set.size;
    }
    return count;
  }

  notify(runId: string): void {
    const set = this.waiters.get(runId);
    if (!set) {
      return;
    }
    this.waiters.delete(runId);
    for (const wake of [...set]) {
      wake();
    }
  }

  /**
   * Resolves on the next `notify(runId)`, or when `signal` aborts. The waiter is
   * registered synchronously (inside the Promise executor), so a caller that checks the
   * log and then calls this in the same tick cannot miss a notification in between.
   */
  waitForChange(runId: string, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const wake = (): void => {
        signal.removeEventListener('abort', wake);
        this.remove(runId, wake);
        resolve();
      };
      signal.addEventListener('abort', wake, { once: true });
      let set = this.waiters.get(runId);
      if (!set) {
        set = new Set();
        this.waiters.set(runId, set);
      }
      set.add(wake);
    });
  }

  private remove(runId: string, wake: () => void): void {
    const set = this.waiters.get(runId);
    if (!set) {
      return;
    }
    set.delete(wake);
    if (set.size === 0) {
      this.waiters.delete(runId);
    }
  }
}
