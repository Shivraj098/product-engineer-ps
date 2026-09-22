import { TetherError } from '@tether/protocol';
import { TransportError } from '@tether/client-core';

/** A short, human message for anything the API layer can throw. */
export function describeError(error: unknown): string {
  if (error instanceof TetherError) {
    return error.message;
  }
  if (error instanceof TransportError) {
    return error.kind === 'network'
      ? "Can't reach the server. Check your connection and try again."
      : `The server had a problem (${error.status ?? 'unknown status'}).`;
  }
  return 'Something went wrong.';
}
