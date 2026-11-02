CREATE TABLE runtime_rate_buckets (
  bucket_key TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  request_count INTEGER NOT NULL CHECK(request_count>0),
  expires_at INTEGER NOT NULL,
  mutation_token TEXT NOT NULL,
  PRIMARY KEY(bucket_key,window_start)
);
CREATE INDEX runtime_rate_expiry ON runtime_rate_buckets(expires_at);

-- Only an opaque wakeup reference and fixed operational metadata are retained.
CREATE TABLE dead_letter_jobs (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK(state IN ('pending','resolved','cancelled')),
  recovery_attempts INTEGER NOT NULL DEFAULT 0,
  next_retry_at INTEGER NOT NULL,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX dead_letter_recovery ON dead_letter_jobs(state,next_retry_at,created_at);

-- Circuit state contains no user, conversation, request or provider response IDs.
CREATE TABLE provider_circuits (
  provider TEXT PRIMARY KEY CHECK(provider IN ('model','search','google','messaging')),
  opened_until INTEGER NOT NULL,
  latest_failure_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX webhook_payload_retention ON webhook_events(received_at);
CREATE INDEX model_provider_failures ON model_attempts(state,updated_at);
CREATE INDEX search_provider_failures ON search_attempts(state,updated_at);
CREATE INDEX google_provider_failures ON google_calendar_requests(state,updated_at);
CREATE INDEX messaging_provider_failures ON outbound_jobs(status,updated_at);
