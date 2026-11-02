ALTER TABLE users ADD COLUMN google_calendar_revision INTEGER NOT NULL DEFAULT 0 CHECK (google_calendar_revision >= 0);

CREATE TABLE google_calendar_connections (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  connected INTEGER NOT NULL DEFAULT 0 CHECK (connected IN (0,1)),
  status TEXT NOT NULL DEFAULT 'disconnected' CHECK (status IN ('disconnected','pending','connected','reauthorization_required')),
  scope TEXT,
  access_token_ciphertext TEXT,
  refresh_token_ciphertext TEXT,
  expires_at INTEGER,
  refresh_claim_token TEXT,
  refresh_started_at INTEGER,
  mutation_token TEXT,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE google_oauth_pending (
  state_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_hash TEXT NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
  browser_hash TEXT NOT NULL,
  verifier_ciphertext TEXT,
  revision INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  consumed_by TEXT,
  consumed_at INTEGER
);
CREATE INDEX google_oauth_pending_user ON google_oauth_pending(user_id,expires_at);
