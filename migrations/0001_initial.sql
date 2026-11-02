PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'deleted')),
  created_at INTEGER NOT NULL,
  daily_message_limit INTEGER NOT NULL DEFAULT 100 CHECK (daily_message_limit > 0)
);

CREATE TABLE invitations (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_expiry ON sessions(expires_at);

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('web', 'mock', 'apple_business')),
  provider TEXT NOT NULL,
  business_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  mode TEXT NOT NULL DEFAULT 'bot' CHECK (mode IN ('bot', 'human')),
  ownership_version INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL,
  UNIQUE(provider, business_id, subject_id)
);
CREATE INDEX conversations_user ON conversations(user_id, created_at);

CREATE TABLE bindings (
  provider TEXT NOT NULL,
  business_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('web', 'mock', 'apple_business')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  PRIMARY KEY(provider, business_id, subject_id)
);

CREATE TABLE webhook_events (
  provider TEXT NOT NULL,
  business_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  provider_message_id TEXT,
  delivery_state TEXT,
  payload_hash TEXT NOT NULL,
  payload_ciphertext TEXT NOT NULL,
  ingest_token TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  PRIMARY KEY(provider, business_id, event_id)
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  provider_message_id TEXT,
  in_reply_to_message_id TEXT UNIQUE REFERENCES messages(id) ON DELETE SET NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  body_ciphertext TEXT NOT NULL,
  content_hash TEXT,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(conversation_id, provider_message_id, role)
);
CREATE INDEX messages_conversation ON messages(conversation_id, created_at);

CREATE TABLE inbox (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'cancelled', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  accepted_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX inbox_pending ON inbox(status, conversation_id, sequence);

CREATE TABLE outbound_jobs (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('queued', 'sending', 'sent', 'delivered', 'retryable_failed', 'delivery_unknown', 'failed', 'cancelled')),
  ownership_version INTEGER NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  attempt_token TEXT,
  provider_message_id TEXT,
  error_code TEXT,
  next_attempt_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX outbound_pending ON outbound_jobs(conversation_id, created_at, id);
CREATE INDEX outbound_provider_message ON outbound_jobs(conversation_id, provider_message_id);
CREATE INDEX outbound_recovery ON outbound_jobs(status, next_attempt_at);

CREATE TABLE mock_receipts (
  idempotency_key TEXT PRIMARY KEY,
  provider_message_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('sent', 'delivered')),
  created_at INTEGER NOT NULL
);

CREATE TABLE usage_ledgers (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  estimated_cost_micro_usd INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  outcome TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE system_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
