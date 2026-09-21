export const SCHEMA_VERSION = 1;

/**
 * The event log (`run_events`) is the source of truth. `runs.state` and `runs.last_seq`
 * are denormalised for cheap reads and are always updated in the same transaction as the
 * event insert. Constraints are the last line of defence: a bug in application code
 * should fail loudly here instead of silently corrupting history.
 */
export const SCHEMA_SQL = `
CREATE TABLE conversations (
  id         TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

-- User messages only. The assistant reply is derived from the run's events.
CREATE TABLE messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  content         TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 2000),
  created_at      TEXT NOT NULL
);

CREATE TABLE runs (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  user_message_id TEXT NOT NULL UNIQUE REFERENCES messages(id),
  state           TEXT NOT NULL CHECK (state IN ('running', 'completed', 'failed')),
  last_seq        INTEGER NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
  failure_code    TEXT,
  failure_message TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  CHECK ((state = 'failed') = (failure_code IS NOT NULL))
);

-- At most one active run per conversation, enforced by the database.
CREATE UNIQUE INDEX one_running_run_per_conversation
  ON runs (conversation_id) WHERE state = 'running';

CREATE TABLE run_events (
  run_id     TEXT NOT NULL REFERENCES runs(id),
  seq        INTEGER NOT NULL CHECK (seq >= 1),
  type       TEXT NOT NULL CHECK (type IN ('delta', 'completed', 'failed')),
  payload    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
) WITHOUT ROWID;
`;
