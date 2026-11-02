-- Retain opaque request tombstones after deletion so daily global limits cannot
-- be refunded by deleting an account or transcript. No plaintext query/results.
CREATE TABLE search_attempts (
  message_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  context_revision INTEGER NOT NULL,
  day TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('dispatched','completed','failed','unknown','purged')),
  query_digest TEXT NOT NULL,
  result_ciphertext TEXT,
  attempt_token TEXT NOT NULL UNIQUE,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX search_attempts_user_daily ON search_attempts(day,user_id);
CREATE INDEX search_attempts_global_daily ON search_attempts(day);

CREATE TRIGGER purge_research_after_message_delete AFTER DELETE ON messages
BEGIN
  UPDATE search_attempts SET result_ciphertext=NULL,query_digest='',
    state=CASE WHEN state='completed' THEN 'purged' ELSE state END,
    updated_at=CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
  WHERE message_id=OLD.id;
END;
