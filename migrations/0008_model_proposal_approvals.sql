-- Preserve existing calendar approvals/events while admitting typed reminder proposals.
CREATE TABLE action_approvals_next (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  source_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  tool_name TEXT NOT NULL CHECK (tool_name IN ('calendar.create','reminder.create')),
  args_ciphertext TEXT NOT NULL,
  args_hash TEXT NOT NULL,
  connection_revision INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','approved','rejected','expired','revoked')),
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  model_generated INTEGER NOT NULL DEFAULT 0 CHECK (model_generated IN (0,1)),
  proposal_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  actions_revision INTEGER,
  reminders_revision INTEGER,
  context_revision INTEGER,
  CHECK (model_generated=0 OR (actions_revision IS NOT NULL AND reminders_revision IS NOT NULL AND context_revision IS NOT NULL))
);
INSERT INTO action_approvals_next(id,user_id,conversation_id,source_message_id,tool_name,args_ciphertext,args_hash,
  connection_revision,expires_at,state,created_at,decided_at)
  SELECT id,user_id,conversation_id,source_message_id,tool_name,args_ciphertext,args_hash,
    connection_revision,expires_at,state,created_at,decided_at FROM action_approvals;

CREATE TABLE demo_calendar_events_next (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  approval_id TEXT NOT NULL UNIQUE REFERENCES action_approvals_next(id) ON DELETE CASCADE,
  args_ciphertext TEXT NOT NULL,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','cancelled')),
  simulated INTEGER NOT NULL DEFAULT 1 CHECK (simulated = 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (ends_at > starts_at)
);
INSERT INTO demo_calendar_events_next SELECT * FROM demo_calendar_events;
DROP TABLE demo_calendar_events;
DROP TABLE action_approvals;
ALTER TABLE action_approvals_next RENAME TO action_approvals;
ALTER TABLE demo_calendar_events_next RENAME TO demo_calendar_events;
CREATE INDEX action_approvals_user_pending ON action_approvals(user_id,state,expires_at);
CREATE UNIQUE INDEX model_proposal_source ON action_approvals(source_message_id) WHERE model_generated=1;
CREATE INDEX demo_calendar_events_user_time ON demo_calendar_events(user_id,starts_at,status);

ALTER TABLE reminders ADD COLUMN approval_id TEXT REFERENCES action_approvals(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX reminders_approval ON reminders(approval_id) WHERE approval_id IS NOT NULL;
