CREATE TABLE google_calendar_approvals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  source_message_id TEXT UNIQUE,
  tool_name TEXT NOT NULL CHECK (tool_name IN ('google_calendar.create','google_calendar.update')),
  arguments_ciphertext TEXT,
  arguments_digest TEXT NOT NULL,
  event_id TEXT NOT NULL,
  connection_revision INTEGER NOT NULL,
  context_revision INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','executing','completed','failed','unknown','rejected','expired','revoked')),
  execution_token TEXT,
  expires_at INTEGER NOT NULL,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX google_calendar_approvals_user ON google_calendar_approvals(user_id,created_at);

-- No foreign keys: deletion must not refund the global operation quota.
CREATE TABLE google_calendar_requests (
  message_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  context_revision INTEGER NOT NULL,
  connection_revision INTEGER,
  approval_id TEXT,
  operation TEXT NOT NULL,
  day TEXT NOT NULL,
  counted INTEGER NOT NULL CHECK (counted IN (0,1)),
  state TEXT NOT NULL CHECK (state IN ('dispatched','completed','failed','unknown','purged')),
  query_digest TEXT NOT NULL,
  result_ciphertext TEXT,
  attempt_token TEXT NOT NULL UNIQUE,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX google_calendar_requests_user_daily ON google_calendar_requests(day,user_id,counted);
CREATE INDEX google_calendar_requests_global_daily ON google_calendar_requests(day,counted);

CREATE TRIGGER purge_google_calendar_after_source_delete AFTER DELETE ON messages
BEGIN
  UPDATE google_calendar_requests SET result_ciphertext=NULL,query_digest='',
    state=CASE WHEN state='completed' THEN 'purged' ELSE state END,
    updated_at=CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
  WHERE message_id=OLD.id OR approval_id IN (SELECT id FROM google_calendar_approvals WHERE source_message_id=OLD.id);
  UPDATE google_calendar_approvals SET arguments_ciphertext=NULL,arguments_digest='',source_message_id=NULL,
    state=CASE WHEN state='pending' THEN 'revoked' WHEN state='executing' THEN 'unknown' ELSE state END,
    updated_at=CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
  WHERE source_message_id=OLD.id;
END;
