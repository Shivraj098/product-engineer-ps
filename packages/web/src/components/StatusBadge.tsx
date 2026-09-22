import type { ConnectionState } from '@tether/client-core';
import type { RunStatus } from '@tether/client-core';

export interface StatusBadgeProps {
  runStatus: RunStatus;
  connection: ConnectionState | undefined;
}

interface Display {
  dot: 'live' | 'wait' | 'ok' | 'error' | 'idle';
  label: string;
}

/**
 * One glance at where a reply stands. Run status wins once the run is no longer
 * running, since "reconnecting" while completed/failed would be misleading.
 * Icon + text together, never colour alone (see the accessibility note in DESIGN.md).
 */
function describe(runStatus: RunStatus, connection: ConnectionState | undefined): Display {
  if (runStatus === 'completed') {
    return { dot: 'ok', label: 'Completed' };
  }
  if (runStatus === 'failed') {
    return { dot: 'error', label: 'Failed' };
  }
  switch (connection?.status) {
    case 'connecting':
      return { dot: 'wait', label: 'Connecting…' };
    case 'connected':
      return { dot: 'live', label: 'Connected' };
    case 'reconnecting':
      return {
        dot: 'wait',
        label: `Reconnecting… (attempt ${connection.attempt}/${connection.maxAttempts})`,
      };
    case 'disconnected':
      return {
        dot: 'error',
        label:
          connection.reason === 'offline'
            ? 'Offline'
            : connection.reason === 'retries_exhausted'
              ? "Disconnected — couldn't reconnect"
              : `Disconnected — ${connection.message ?? 'an error occurred'}`,
      };
    default:
      return { dot: 'idle', label: 'Idle' };
  }
}

export function StatusBadge({ runStatus, connection }: StatusBadgeProps) {
  const { dot, label } = describe(runStatus, connection);
  return (
    <span className={`status-badge status-badge--${dot}`}>
      <span className="status-badge__dot" aria-hidden="true" />
      {label}
    </span>
  );
}
