import type { RunView } from '@tether/client-core';
import type { ConnectionState } from '@tether/client-core';
import { StatusBadge } from './StatusBadge';

export interface DisplayTurn {
  id: string;
  content: string;
  run: RunView;
  /** Only the most recent turn has a live connection; earlier ones are settled history. */
  connection?: ConnectionState;
}

export interface MessageListProps {
  turns: DisplayTurn[];
}

function FailureNote({ message }: { message: string }) {
  return (
    <p className="failure-note" role="alert">
      Reply interrupted: {message}
    </p>
  );
}

export function MessageList({ turns }: MessageListProps) {
  if (turns.length === 0) {
    return null;
  }
  return (
    <ol className="message-list" aria-label="Conversation">
      {turns.map((turn) => (
        <li key={turn.id} className="turn">
          <div className="bubble bubble--user">{turn.content}</div>
          <div className="bubble bubble--assistant">
            <p className="bubble__text">
              {turn.run.text}
              {turn.run.status === 'running' && <span className="cursor" aria-hidden="true" />}
            </p>
            <div className="bubble__footer">
              <StatusBadge runStatus={turn.run.status} connection={turn.connection} />
            </div>
            {turn.run.failure && <FailureNote message={turn.run.failure.message} />}
          </div>
        </li>
      ))}
    </ol>
  );
}
