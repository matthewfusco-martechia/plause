ALTER TABLE users ADD COLUMN memory_enabled INTEGER NOT NULL DEFAULT 1 CHECK (memory_enabled IN (0,1));
ALTER TABLE users ADD COLUMN context_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN memory_history_after_sequence INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN context_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN is_memory_control INTEGER NOT NULL DEFAULT 0 CHECK (is_memory_control IN (0,1));
ALTER TABLE model_attempts ADD COLUMN context_revision INTEGER NOT NULL DEFAULT 0;

CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body_ciphertext TEXT NOT NULL,
  source_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX memories_user ON memories(user_id,created_at,id);
