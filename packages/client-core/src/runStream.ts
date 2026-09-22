import { TetherError, runEventSchema, type RunEvent } from '@tether/protocol';
import { TransportError, type ApiClient } from './api';
import { DEFAULT_BACKOFF, backoffDelay, type BackoffPolicy } from './backoff';
import {
  applyRunEvent,
  createRunView,
  viewFromSnapshot,
  type ApplyOutcome,
  type RunView,
} from './runReducer';
import { readSseStream } from './sse/parser';

export type DisconnectReason = 'offline' | 'retries_exhausted' | 'fatal_error';

export type ConnectionState =
  | { status: 'idle' }
  | { status: 'connecting' }
  | { status: 'connected' }
  | { status: 'reconnecting'; attempt: number; maxAttempts: number; delayMs: number }
  | { status: 'disconnected'; reason: DisconnectReason; message?: string }
  | { status: 'closed' };

export interface RunStreamState {
  connection: ConnectionState;
  run: RunView;
  /** How many times a dropped connection was re-established. */
  reconnects: number;
}

export interface RunStreamOptions {
  runId: string;
  api: ApiClient;
  /** Start from known state (for example a snapshot after a page reload). */
  initial?: RunView;
  backoff?: BackoffPolicy;
  /** Reconnect if nothing (not even a heartbeat) arrives for this long. 0 disables. */
  stallTimeoutMs?: number;
  /** Must resolve after `ms`, or as soon as `signal` aborts. Injectable so tests never wait. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
  /** Called for every event the server delivered, with what the reducer did with it. */
  onEvent?: (event: RunEvent, outcome: ApplyOutcome) => void;
}

type AttemptResult =
  | { kind: 'finished' }
  | { kind: 'stopped' }
  | { kind: 'offline' }
  | { kind: 'resync' }
  | { kind: 'dropped'; progress: boolean }
  | { kind: 'fatal'; message: string };

const DEFAULT_STALL_TIMEOUT_MS = 3_000;
const MAX_CONSECUTIVE_RESYNCS = 3;

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

function parseEvent(data: string): RunEvent | undefined {
  try {
    const parsed = runEventSchema.safeParse(JSON.parse(data));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function sameConnection(a: ConnectionState, b: ConnectionState): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Keeps one run's view correct across drops. It owns the cursor (through the reducer state),
 * reconnects with bounded, jittered backoff, resyncs from a snapshot when the server cannot
 * replay from the cursor, and never trusts the transport: every event goes through the reducer.
 * A RunStream is single-use: after `stop()`, create a new one.
 */
export class RunStream {
  private readonly runId: string;
  private readonly api: ApiClient;
  private readonly policy: BackoffPolicy;
  private readonly stallTimeoutMs: number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly random: () => number;
  private readonly onEvent: ((event: RunEvent, outcome: ApplyOutcome) => void) | undefined;

  private state: RunStreamState;
  private readonly listeners = new Set<() => void>();
  private readonly lifecycle = new AbortController();
  private attemptController: AbortController | undefined;
  private wake: AbortController | undefined;
  private running = false;
  private offline = false;
  private everConnected = false;

  constructor(options: RunStreamOptions) {
    this.runId = options.runId;
    this.api = options.api;
    this.policy = options.backoff ?? DEFAULT_BACKOFF;
    this.stallTimeoutMs = options.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
    this.onEvent = options.onEvent;
    this.state = {
      connection: { status: 'idle' },
      run: options.initial ?? createRunView(options.runId),
      reconnects: 0,
    };
  }

  getState(): RunStreamState {
    return this.state;
  }

  /** Compatible with React's useSyncExternalStore: `getState` only changes identity on change. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  waitFor(predicate: (state: RunStreamState) => boolean): Promise<RunStreamState> {
    return new Promise((resolve) => {
      let unsubscribe: () => void = () => undefined;
      const check = (): void => {
        if (predicate(this.state)) {
          unsubscribe();
          resolve(this.state);
        }
      };
      unsubscribe = this.subscribe(check);
      check();
    });
  }

  start(): void {
    if (this.running || this.lifecycle.signal.aborted) {
      return;
    }
    this.running = true;
    this.loop().catch((error: unknown) => {
      this.end({
        status: 'disconnected',
        reason: 'fatal_error',
        message: error instanceof Error ? error.message : 'Unexpected error',
      });
    });
  }

  stop(): void {
    this.lifecycle.abort();
    this.attemptController?.abort();
    this.wake?.abort();
    this.setConnection({ status: 'idle' });
  }

  /** Simulates losing the network: cut the connection and stay down until `goOnline`. */
  goOffline(): void {
    this.offline = true;
    this.attemptController?.abort();
    this.wake?.abort();
  }

  goOnline(): void {
    this.offline = false;
    this.wake?.abort();
    this.start();
  }

  /** Skips any backoff wait, or starts over after the client gave up. */
  retryNow(): void {
    this.offline = false;
    this.wake?.abort();
    this.start();
  }

  private async loop(): Promise<void> {
    let failures = 0;
    let resyncs = 0;

    while (!this.lifecycle.signal.aborted) {
      if (this.state.run.status !== 'running') {
        return this.end({ status: 'closed' });
      }
      if (this.offline) {
        this.setConnection({ status: 'disconnected', reason: 'offline' });
        await this.pause();
        failures = 0;
        continue;
      }
      if (this.state.connection.status !== 'reconnecting') {
        this.setConnection({ status: 'connecting' });
      }

      const result = await this.attempt();
      switch (result.kind) {
        case 'finished':
          return this.end({ status: 'closed' });
        case 'stopped':
          return this.end();
        case 'offline':
          continue;
        case 'fatal':
          return this.end({
            status: 'disconnected',
            reason: 'fatal_error',
            message: result.message,
          });
        case 'resync':
          resyncs += 1;
          if (resyncs > MAX_CONSECUTIVE_RESYNCS) {
            return this.end({
              status: 'disconnected',
              reason: 'fatal_error',
              message: 'The server keeps rejecting the cursor even after a resync.',
            });
          }
          continue;
        case 'dropped': {
          if (result.progress) {
            resyncs = 0;
          }
          failures = result.progress ? 1 : failures + 1;
          if (failures > this.policy.maxAttempts) {
            return this.end({
              status: 'disconnected',
              reason: 'retries_exhausted',
              message: `Gave up after ${this.policy.maxAttempts} attempts.`,
            });
          }
          const delayMs = backoffDelay(failures, this.policy, this.random);
          this.setConnection({
            status: 'reconnecting',
            attempt: failures,
            maxAttempts: this.policy.maxAttempts,
            delayMs,
          });
          this.wake = new AbortController();
          await this.sleep(delayMs, this.wake.signal);
        }
      }
    }
    this.end();
  }

  /** The loop is over. `running` is cleared BEFORE the final state is published, so a listener can restart at once. */
  private end(connection?: ConnectionState): void {
    this.running = false;
    if (connection) {
      this.setConnection(connection);
    }
  }

  /** One connection: open the stream after the cursor and apply events until it ends. */
  private async attempt(): Promise<AttemptResult> {
    const controller = new AbortController();
    this.attemptController = controller;
    let stalled = false;
    let progress = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const armWatchdog = (): void => {
      if (this.stallTimeoutMs <= 0) {
        return;
      }
      clearTimeout(timer);
      timer = setTimeout(() => {
        stalled = true;
        controller.abort();
      }, this.stallTimeoutMs);
    };

    try {
      const body = await this.api.openEvents(this.runId, this.state.run.lastSeq, controller.signal);
      this.markConnected();
      armWatchdog();

      for await (const item of readSseStream(body)) {
        armWatchdog();
        if (item.kind === 'comment') {
          progress = true; // A heartbeat proves the connection is healthy.
          continue;
        }
        const event = parseEvent(item.message.data);
        if (!event) {
          controller.abort();
          return { kind: 'dropped', progress: false };
        }
        const outcome = this.apply(event);
        if (outcome === 'gap') {
          controller.abort(); // Something was skipped: reconnect from the cursor.
          return { kind: 'dropped', progress: false };
        }
        if (outcome === 'applied') {
          progress = true;
        }
        if (this.state.run.status !== 'running') {
          return { kind: 'finished' };
        }
      }
      return { kind: 'dropped', progress };
    } catch (error) {
      return await this.classify(error, stalled, progress);
    } finally {
      clearTimeout(timer);
      this.attemptController = undefined;
    }
  }

  private async classify(
    error: unknown,
    stalled: boolean,
    progress: boolean,
  ): Promise<AttemptResult> {
    if (this.lifecycle.signal.aborted) {
      return { kind: 'stopped' };
    }
    if (this.offline) {
      return { kind: 'offline' };
    }
    if (stalled) {
      return { kind: 'dropped', progress: false };
    }
    if (error instanceof TetherError) {
      if (error.code === 'CURSOR_AHEAD' || error.code === 'CURSOR_EXPIRED') {
        return this.resync();
      }
      if (error.code === 'INTERNAL') {
        return { kind: 'dropped', progress };
      }
      return { kind: 'fatal', message: `${error.code}: ${error.message}` };
    }
    if (error instanceof TransportError && error.kind === 'http') {
      const clientError = error.status !== undefined && error.status < 500;
      return clientError
        ? { kind: 'fatal', message: error.message }
        : { kind: 'dropped', progress };
    }
    return { kind: 'dropped', progress }; // Network failure or a stream that broke mid-flight.
  }

  /** The server cannot replay from our cursor: take its snapshot and continue from there. */
  private async resync(): Promise<AttemptResult> {
    try {
      const snapshot = await this.api.getRunSnapshot(this.runId, this.lifecycle.signal);
      this.state = { ...this.state, run: viewFromSnapshot(snapshot, this.state.run.stats) };
      this.notify();
      return { kind: 'resync' };
    } catch (error) {
      if (this.lifecycle.signal.aborted) {
        return { kind: 'stopped' };
      }
      if (error instanceof TetherError) {
        return { kind: 'fatal', message: `${error.code}: ${error.message}` };
      }
      return { kind: 'dropped', progress: false };
    }
  }

  private apply(event: RunEvent): ApplyOutcome {
    const { view, outcome } = applyRunEvent(this.state.run, event);
    this.state = { ...this.state, run: view };
    this.notify();
    this.onEvent?.(event, outcome);
    return outcome;
  }

  private markConnected(): void {
    const reconnects = this.everConnected ? this.state.reconnects + 1 : 0;
    this.everConnected = true;
    this.state = { ...this.state, reconnects };
    this.setConnection({ status: 'connected' });
  }

  private setConnection(connection: ConnectionState): void {
    if (this.lifecycle.signal.aborted && connection.status !== 'idle') {
      return;
    }
    if (sameConnection(this.state.connection, connection)) {
      return;
    }
    this.state = { ...this.state, connection };
    this.notify();
  }

  private pause(): Promise<void> {
    return new Promise((resolve) => {
      this.wake = new AbortController();
      this.wake.signal.addEventListener('abort', () => resolve(), { once: true });
    });
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}
