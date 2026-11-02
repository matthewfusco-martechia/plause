-- A provider revoke can invalidate other tokens for the same Google project.
-- Keep reconnect fenced until an explicit revocation has a confirmed outcome.
ALTER TABLE google_calendar_connections ADD COLUMN revocation_claim_token TEXT;
ALTER TABLE google_calendar_connections ADD COLUMN revocation_started_at INTEGER;
