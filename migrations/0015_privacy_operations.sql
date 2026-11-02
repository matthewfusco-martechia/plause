-- No foreign keys: these minimal operations must survive account deletion and
-- be reapplied after restoring any older D1 snapshot. Cloud deletion is not
-- acknowledged until the independent R2 record is confirmed durable.
CREATE TABLE privacy_operations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,
  intent_hash TEXT UNIQUE,
  environment TEXT NOT NULL CHECK(environment IN ('local','staging','production')),
  ledger_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','recorded','completed')),
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX privacy_operations_recovery ON privacy_operations(environment,state,updated_at);

CREATE TRIGGER prevent_erased_user_recreation BEFORE INSERT ON users
WHEN EXISTS(SELECT 1 FROM privacy_operations WHERE user_id=NEW.id)
BEGIN
  SELECT RAISE(ABORT,'privacy_erasure_pending_or_completed');
END;
CREATE TRIGGER prevent_erased_user_reactivation BEFORE UPDATE OF status ON users
WHEN NEW.status='active' AND EXISTS(SELECT 1 FROM privacy_operations WHERE user_id=NEW.id)
BEGIN
  SELECT RAISE(ABORT,'privacy_erasure_pending_or_completed');
END;
