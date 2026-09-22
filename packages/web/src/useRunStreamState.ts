import { useSyncExternalStore } from 'react';
import type { RunStream, RunStreamState } from '@tether/client-core';

const EMPTY_SUBSCRIBE = () => () => undefined;

/** Subscribes a component to a RunStream. Returns undefined while there is no active run. */
export function useRunStreamState(stream: RunStream | undefined): RunStreamState | undefined {
  return useSyncExternalStore(
    stream ? (onChange) => stream.subscribe(onChange) : EMPTY_SUBSCRIBE,
    () => stream?.getState(),
    () => stream?.getState(),
  );
}
