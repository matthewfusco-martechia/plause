ALTER TABLE conversations ADD COLUMN provider_control TEXT NOT NULL DEFAULT 'bot' CHECK(provider_control IN ('bot','human','unknown'));
ALTER TABLE conversations ADD COLUMN handoff_reason TEXT CHECK(handoff_reason IN ('customer','operator','provider'));
ALTER TABLE outbound_jobs ADD COLUMN provider_request_ciphertext TEXT;

CREATE TABLE web_delivery_receipts (
  idempotency_key TEXT PRIMARY KEY,
  provider_message_id TEXT NOT NULL UNIQUE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK(state IN ('sent','delivered')),
  created_at INTEGER NOT NULL,
  delivered_at INTEGER
);
