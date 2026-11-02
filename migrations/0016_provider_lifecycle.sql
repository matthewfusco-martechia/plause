ALTER TABLE conversations ADD COLUMN provider_event_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN support_notice INTEGER NOT NULL DEFAULT 0 CHECK(support_notice IN (0,1));
CREATE TABLE provider_lifecycle_events (
  provider TEXT NOT NULL,
  business_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  payload_hash TEXT NOT NULL,
  mutation_token TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  PRIMARY KEY(provider,business_id,event_id)
);
CREATE INDEX provider_lifecycle_retention ON provider_lifecycle_events(received_at);
