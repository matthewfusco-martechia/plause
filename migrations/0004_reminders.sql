ALTER TABLE users ADD COLUMN reminders_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN reminders_enabled INTEGER NOT NULL DEFAULT 0 CHECK (reminders_enabled IN (0,1));
ALTER TABLE users ADD COLUMN reminder_timezone TEXT NOT NULL DEFAULT 'America/New_York';
ALTER TABLE users ADD COLUMN quiet_start TEXT NOT NULL DEFAULT '22:00';
ALTER TABLE users ADD COLUMN quiet_end TEXT NOT NULL DEFAULT '08:00';

CREATE TABLE reminders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  instruction_ciphertext TEXT NOT NULL,
  schedule_json TEXT NOT NULL CHECK (json_valid(schedule_json)),
  next_run_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','cancelled','completed')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX reminders_due ON reminders(status,next_run_at);
CREATE INDEX reminders_user ON reminders(user_id,created_at,id);

CREATE TABLE reminder_occurrences (
  id TEXT PRIMARY KEY,
  reminder_id TEXT NOT NULL REFERENCES reminders(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  scheduled_for INTEGER NOT NULL,
  reminder_version INTEGER NOT NULL,
  enqueue_token TEXT,
  message_id TEXT UNIQUE REFERENCES messages(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','deferred','delivered','cancelled')),
  created_at INTEGER NOT NULL,
  UNIQUE(reminder_id,scheduled_for)
);
CREATE INDEX reminder_occurrences_pending ON reminder_occurrences(status,reminder_id,scheduled_for);
CREATE INDEX reminder_occurrences_user ON reminder_occurrences(user_id,created_at);

-- Nullable back-reference avoids circular foreign-key insertion requirements:
-- the occurrence is inserted before the corresponding notification message.
ALTER TABLE messages ADD COLUMN reminder_occurrence_id TEXT;
CREATE UNIQUE INDEX messages_reminder_occurrence ON messages(reminder_occurrence_id) WHERE reminder_occurrence_id IS NOT NULL;
