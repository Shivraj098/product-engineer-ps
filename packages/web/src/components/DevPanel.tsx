export interface DevPanelProps {
  open: boolean;
  onToggle: () => void;
  online: boolean;
  onGoOffline: () => void;
  onGoOnline: () => void;
  onDropConnections: () => void;
  onReconnectNow: () => void;
  onFillPrompt: (prompt: string) => void;
  lastSeq: number | undefined;
  stats:
    | {
        applied: number;
        duplicatesIgnored: number;
        gapsDetected: number;
        afterTerminalIgnored: number;
      }
    | undefined;
  reconnects: number | undefined;
}

/**
 * Demo-only controls, for showing the recovery behaviour on camera: simulate the client
 * going offline, sever the server's connections outright, or steer the fake generator via
 * its documented directives. Real chat needs none of this.
 */
export function DevPanel(props: DevPanelProps) {
  const {
    open,
    onToggle,
    online,
    onGoOffline,
    onGoOnline,
    onDropConnections,
    onReconnectNow,
    onFillPrompt,
    lastSeq,
    stats,
    reconnects,
  } = props;

  return (
    <div className="dev-panel">
      <button type="button" className="dev-panel__toggle" onClick={onToggle} aria-expanded={open}>
        {open ? 'Hide' : 'Show'} dev panel
      </button>
      {open && (
        <div className="dev-panel__body">
          <div className="dev-panel__group">
            <span className="dev-panel__label">Connection</span>
            {online ? (
              <button type="button" onClick={onGoOffline}>
                Go offline
              </button>
            ) : (
              <button type="button" onClick={onGoOnline}>
                Go online
              </button>
            )}
            <button type="button" onClick={onDropConnections}>
              Drop server connections
            </button>
            <button type="button" onClick={onReconnectNow}>
              Reconnect now
            </button>
          </div>
          <div className="dev-panel__group">
            <span className="dev-panel__label">Try a prompt</span>
            <button type="button" onClick={() => onFillPrompt('Tell me a long story /chunks:80')}>
              Long reply
            </button>
            <button
              type="button"
              onClick={() => onFillPrompt('Explain something /chunks:20 /fail-after:10')}
            >
              Fail midway
            </button>
          </div>
          <dl className="dev-panel__stats">
            <div>
              <dt>Cursor</dt>
              <dd>{lastSeq ?? '—'}</dd>
            </div>
            <div>
              <dt>Applied</dt>
              <dd>{stats?.applied ?? '—'}</dd>
            </div>
            <div>
              <dt>Duplicates ignored</dt>
              <dd>{stats?.duplicatesIgnored ?? '—'}</dd>
            </div>
            <div>
              <dt>Gaps detected</dt>
              <dd>{stats?.gapsDetected ?? '—'}</dd>
            </div>
            <div>
              <dt>Reconnects</dt>
              <dd>{reconnects ?? '—'}</dd>
            </div>
          </dl>
        </div>
      )}
    </div>
  );
}
