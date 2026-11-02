ALTER TABLE messages ADD COLUMN model TEXT NOT NULL DEFAULT 'mock';
ALTER TABLE usage_ledgers ADD COLUMN model TEXT NOT NULL DEFAULT 'mock';
ALTER TABLE usage_ledgers ADD COLUMN provider_response_id TEXT;

-- Billing tombstones deliberately survive account/message deletion. Removing a
-- transcript must not refund a possibly charged request against the global cap.
-- No plaintext prompt or response is retained here.
CREATE TABLE model_attempts (
  message_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  attempt_token TEXT NOT NULL UNIQUE,
  lease_token TEXT NOT NULL,
  ownership_version INTEGER NOT NULL,
  input_digest TEXT NOT NULL,
  model TEXT NOT NULL,
  budget_month TEXT NOT NULL,
  reservation_micro_usd INTEGER NOT NULL CHECK (reservation_micro_usd >= 0),
  budget_debit_micro_usd INTEGER NOT NULL CHECK (budget_debit_micro_usd >= 0),
  state TEXT NOT NULL CHECK (state IN ('reserved','dispatched','completed','failed','unknown','purged')),
  error_code TEXT,
  response_ciphertext TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  provider_response_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  dispatched_at INTEGER,
  completed_at INTEGER,
  CHECK (state != 'completed' OR (response_ciphertext IS NOT NULL AND input_tokens IS NOT NULL AND output_tokens IS NOT NULL))
);
CREATE INDEX model_attempts_user_budget ON model_attempts(budget_month,user_id,budget_debit_micro_usd);
CREATE INDEX model_attempts_global_budget ON model_attempts(budget_month,budget_debit_micro_usd);

-- Purge personalized cached content without erasing retained cost metadata.
CREATE TRIGGER purge_model_cache_after_message_delete AFTER DELETE ON messages
BEGIN
  UPDATE model_attempts SET response_ciphertext=NULL,input_digest='',
    state=CASE WHEN state='completed' THEN 'purged' ELSE state END,
    updated_at=CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
  WHERE message_id=OLD.id;
END;
