import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StatusBadge } from './StatusBadge';

describe('StatusBadge', () => {
  it('shows connecting, then connected, while the run is running', () => {
    const { rerender } = render(
      <StatusBadge runStatus="running" connection={{ status: 'connecting' }} />,
    );
    expect(screen.getByText('Connecting…')).toBeInTheDocument();

    rerender(<StatusBadge runStatus="running" connection={{ status: 'connected' }} />);
    expect(screen.getByText('Connected')).toBeInTheDocument();
  });

  it('shows the attempt count while reconnecting', () => {
    render(
      <StatusBadge
        runStatus="running"
        connection={{ status: 'reconnecting', attempt: 2, maxAttempts: 8, delayMs: 400 }}
      />,
    );
    expect(screen.getByText('Reconnecting… (attempt 2/8)')).toBeInTheDocument();
  });

  it('explains why it gave up', () => {
    render(
      <StatusBadge
        runStatus="running"
        connection={{ status: 'disconnected', reason: 'retries_exhausted' }}
      />,
    );
    expect(screen.getByText(/couldn't reconnect/)).toBeInTheDocument();
  });

  it('prefers the finished run status over a stale connection state', () => {
    // The connection can still say "connected" for a moment after the terminal event
    // arrives; the run having finished is what the badge should show.
    render(<StatusBadge runStatus="completed" connection={{ status: 'connected' }} />);
    expect(screen.getByText('Completed')).toBeInTheDocument();
    expect(screen.queryByText('Connected')).not.toBeInTheDocument();
  });

  it('shows Failed for a failed run regardless of connection state', () => {
    render(<StatusBadge runStatus="failed" connection={undefined} />);
    expect(screen.getByText('Failed')).toBeInTheDocument();
  });
});
