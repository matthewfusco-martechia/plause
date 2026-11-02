CREATE TABLE account_deletion_intents (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  consumed_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX account_deletion_user ON account_deletion_intents(user_id,expires_at);
