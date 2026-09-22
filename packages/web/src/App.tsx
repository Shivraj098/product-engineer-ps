import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiClient,
  RunStream,
  createRunView,
  viewFromSnapshot,
  type RunView,
} from '@tether/client-core';
import { TetherError, type ConversationTurn } from '@tether/protocol';
import { Composer } from './components/Composer';
import { DevPanel } from './components/DevPanel';
import { MessageList, type DisplayTurn } from './components/MessageList';
import { describeError } from './errors';
import { useRunStreamState } from './useRunStreamState';

const STORAGE_KEY = 'tether:conversationId';

interface LiveTurn {
  id: string;
  content: string;
  stream: RunStream;
}

interface HistoricalTurn {
  id: string;
  content: string;
  run: RunView;
}

export interface AppProps {
  /** Injectable so tests can run against a scripted fetch instead of a real server. */
  api?: ApiClient;
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
}

function turnFromSnapshot(turn: ConversationTurn): HistoricalTurn {
  return { id: turn.message.id, content: turn.message.content, run: viewFromSnapshot(turn.run) };
}

const EXAMPLE_PROMPTS = ['Tell me about resumable streams', 'Explain event sourcing in one page'];

export default function App({ api: apiProp, storage = window.localStorage }: AppProps) {
  const apiRef = useRef(apiProp ?? new ApiClient({ baseUrl: '' }));
  const api = apiRef.current;

  const [conversationId, setConversationId] = useState<string>();
  const [turns, setTurns] = useState<HistoricalTurn[]>([]);
  const [live, setLive] = useState<LiveTurn>();
  const [draft, setDraft] = useState('');
  const [loadError, setLoadError] = useState<string>();
  const [sendError, setSendError] = useState<string>();
  const [devOpen, setDevOpen] = useState(false);
  const [online, setOnline] = useState(true);

  const liveState = useRunStreamState(live?.stream);
  const isBusy = liveState?.run.status === 'running';

  const startLive = useCallback(
    (id: string, content: string, runId: string, initial: RunView) => {
      const stream = new RunStream({ runId, api, initial });
      stream.start();
      setOnline(true);
      setLive({ id, content, stream });
    },
    [api],
  );

  useEffect(() => {
    let cancelled = false;

    async function load(): Promise<void> {
      let id = storage.getItem(STORAGE_KEY) ?? undefined;
      try {
        if (!id) {
          id = (await api.createConversation()).conversationId;
          storage.setItem(STORAGE_KEY, id);
        }
        const snapshot = await api.getConversationSnapshot(id);
        if (cancelled) {
          return;
        }
        setConversationId(id);
        if (snapshot.turns.length > 0) {
          const history = snapshot.turns.slice(0, -1).map(turnFromSnapshot);
          const last = snapshot.turns[snapshot.turns.length - 1]!;
          setTurns(history);
          startLive(
            last.message.id,
            last.message.content,
            last.run.runId,
            viewFromSnapshot(last.run),
          );
        }
      } catch (error) {
        if (error instanceof TetherError && error.code === 'CONVERSATION_NOT_FOUND') {
          // Stale id from a previous server instance (for example, an in-memory dev DB that
          // restarted): drop it and start a fresh conversation instead of failing forever.
          storage.removeItem(STORAGE_KEY);
          void load();
          return;
        }
        if (!cancelled) {
          setLoadError(describeError(error));
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
    // Runs once: `api`, `storage` and `startLive` are stable for the lifetime of this component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSend = useCallback(
    async (content: string) => {
      if (!conversationId || isBusy) {
        return;
      }
      setSendError(undefined);
      if (live && liveState) {
        setTurns((previous) => [
          ...previous,
          { id: live.id, content: live.content, run: liveState.run },
        ]);
      }
      const messageId = crypto.randomUUID();
      try {
        const { run } = await api.sendMessage(conversationId, { messageId, content });
        startLive(messageId, content, run.id, createRunView(run.id));
      } catch (error) {
        setSendError(describeError(error));
      }
    },
    [api, conversationId, isBusy, live, liveState, startLive],
  );

  const displayTurns: DisplayTurn[] = [
    ...turns.map((turn) => ({ id: turn.id, content: turn.content, run: turn.run })),
    ...(live && liveState
      ? [
          {
            id: live.id,
            content: live.content,
            run: liveState.run,
            connection: liveState.connection,
          },
        ]
      : []),
  ];

  return (
    <div className="app">
      <header className="app__header">
        <h1>Tether</h1>
        {liveState && (
          <p className="app__subtitle">
            <StatusLine run={liveState.run.status} connection={liveState.connection} />
          </p>
        )}
      </header>

      <main className="app__main">
        {loadError && (
          <p className="load-error" role="alert">
            {loadError}
          </p>
        )}
        {displayTurns.length === 0 && !loadError ? (
          <div className="empty-state">
            <p>Send a message to start a resumable reply.</p>
            <div className="empty-state__prompts">
              {EXAMPLE_PROMPTS.map((prompt) => (
                <button key={prompt} type="button" onClick={() => setDraft(prompt)}>
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <MessageList turns={displayTurns} />
        )}
      </main>

      <Composer
        disabled={isBusy || !conversationId}
        onSend={(content) => void handleSend(content)}
        error={sendError}
        value={draft}
        onChange={setDraft}
      />

      <DevPanel
        open={devOpen}
        onToggle={() => setDevOpen((value) => !value)}
        online={online}
        onGoOffline={() => {
          setOnline(false);
          live?.stream.goOffline();
        }}
        onGoOnline={() => {
          setOnline(true);
          live?.stream.goOnline();
        }}
        onDropConnections={() => {
          void fetch('/api/dev/drop-connections', { method: 'POST' });
        }}
        onReconnectNow={() => live?.stream.retryNow()}
        onFillPrompt={setDraft}
        lastSeq={liveState?.run.lastSeq}
        stats={liveState?.run.stats}
        reconnects={liveState?.reconnects}
      />
    </div>
  );
}

/** A plain-text summary used for the visually-hidden live region announcing state changes. */
function StatusLine({
  run,
  connection,
}: {
  run: string;
  connection: { status: string } | undefined;
}) {
  return (
    <span
      className="visually-hidden"
      role="status"
    >{`Run ${run}, connection ${connection?.status ?? 'idle'}`}</span>
  );
}
