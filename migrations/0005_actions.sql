ALTER TABLE users ADD COLUMN actions_revision INTEGER NOT NULL DEFAULT 0 CHECK (actions_revision >= 0);

-- Development-only connection state. It contains no OAuth or provider secrets.
CREATE TABLE demo_calendar_connections (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  connected INTEGER NOT NULL DEFAULT 0 CHECK (connected IN (0,1)),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE action_approvals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  source_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  tool_name TEXT NOT NULL CHECK (tool_name = 'calendar.create'),
  args_ciphertext TEXT NOT NULL,
  args_hash TEXT NOT NULL,
  connection_revision INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','approved','rejected','expired','revoked')),
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE INDEX action_approvals_user_pending ON action_approvals(user_id,state,expires_at);

CREATE TABLE demo_calendar_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  approval_id TEXT NOT NULL UNIQUE REFERENCES action_approvals(id) ON DELETE CASCADE,
  args_ciphertext TEXT NOT NULL,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','cancelled')),
  simulated INTEGER NOT NULL DEFAULT 1 CHECK (simulated = 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (ends_at > starts_at)
);
CREATE INDEX demo_calendar_events_user_time ON demo_calendar_events(user_id,starts_at,status);
