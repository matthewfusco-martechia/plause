CREATE TABLE external_identities (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  subject_digest TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  UNIQUE(issuer,subject)
);

-- A keyed digest and timestamp prevent an older anonymous sign-in callback
-- from recreating an account erased while its code exchange was inflight.
CREATE TABLE identity_erasures (subject_digest TEXT PRIMARY KEY,erased_at INTEGER NOT NULL);
CREATE TRIGGER preserve_identity_erasure AFTER DELETE ON external_identities
BEGIN
  INSERT INTO identity_erasures(subject_digest,erased_at)
    VALUES(OLD.subject_digest,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER))
    ON CONFLICT(subject_digest) DO UPDATE SET erased_at=excluded.erased_at;
END;

ALTER TABLE sessions ADD COLUMN auth_method TEXT NOT NULL DEFAULT 'development_invitation' CHECK (auth_method IN ('development_invitation','google'));
ALTER TABLE sessions ADD COLUMN authenticated_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN identity_id TEXT REFERENCES external_identities(id) ON DELETE CASCADE;

CREATE TABLE identity_login_states (
  state_hash TEXT PRIMARY KEY,
  browser_hash TEXT NOT NULL,
  nonce_hash TEXT NOT NULL,
  verifier_ciphertext TEXT,
  intent TEXT NOT NULL CHECK (intent IN ('signin','reauth')),
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  original_session_hash TEXT REFERENCES sessions(token_hash) ON DELETE CASCADE,
  expected_identity_id TEXT REFERENCES external_identities(id) ON DELETE CASCADE,
  consumed_by TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX identity_login_browser ON identity_login_states(browser_hash,created_at);

ALTER TABLE bindings ADD COLUMN id TEXT;
UPDATE bindings SET id='binding_'||lower(hex(randomblob(16))) WHERE id IS NULL;
CREATE UNIQUE INDEX binding_id ON bindings(id);
CREATE TRIGGER assign_binding_id AFTER INSERT ON bindings WHEN NEW.id IS NULL
BEGIN
  UPDATE bindings SET id='binding_'||lower(hex(randomblob(16))) WHERE provider=NEW.provider
    AND business_id=NEW.business_id AND subject_id=NEW.subject_id;
END;
ALTER TABLE bindings ADD COLUMN verified_at INTEGER;
ALTER TABLE bindings ADD COLUMN reply_consent_at INTEGER;
ALTER TABLE bindings ADD COLUMN proactive_consent_at INTEGER;
ALTER TABLE bindings ADD COLUMN revoked_at INTEGER;
ALTER TABLE bindings ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bindings ADD COLUMN provider_conversation_id TEXT;

CREATE TABLE channel_link_challenges (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_hash TEXT NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending','proved','consumed','revoked')),
  reply_consent INTEGER NOT NULL CHECK (reply_consent=1),
  proactive_consent INTEGER NOT NULL CHECK (proactive_consent IN (0,1)),
  provider TEXT,
  business_id TEXT,
  subject_id TEXT,
  channel TEXT,
  provider_event_id TEXT,
  provider_conversation_id TEXT,
  proved_at INTEGER,
  consumed_by TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(provider,business_id,provider_event_id)
);
CREATE INDEX channel_links_user ON channel_link_challenges(user_id,expires_at);
