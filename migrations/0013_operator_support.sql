CREATE TABLE operator_grants (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('admin','support')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  status TEXT NOT NULL CHECK (status IN ('active','revoked')),
  granted_by TEXT,
  mutation_token TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE support_claims (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  operator_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  grant_revision INTEGER NOT NULL,
  claim_version INTEGER NOT NULL CHECK (claim_version >= 1),
  expires_at INTEGER NOT NULL,
  mutation_token TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX support_claims_operator ON support_claims(operator_user_id,expires_at);

-- Retain the opaque actor ID after operator deletion. Clearing it would make a
-- historical human message indistinguishable from an automatic bot message.
ALTER TABLE messages ADD COLUMN operator_user_id TEXT;
ALTER TABLE messages ADD COLUMN operator_grant_revision INTEGER;
ALTER TABLE messages ADD COLUMN support_claim_version INTEGER;

CREATE TABLE support_reply_requests (
  operator_user_id TEXT NOT NULL,
  client_message_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  text_digest TEXT NOT NULL,
  claim_version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(operator_user_id,client_message_id)
);
