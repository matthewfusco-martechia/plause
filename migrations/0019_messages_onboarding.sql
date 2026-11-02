-- Public, deterministic onboarding is separate from private account conversations.
-- Hashed event/quota/unknown tombstones survive account erasure; routing does not.
ALTER TABLE channel_link_challenges ADD COLUMN provider_control TEXT CHECK(provider_control IN ('bot','human','unknown'));
CREATE TABLE messaging_onboarding_subjects (
  business_id TEXT NOT NULL,
  subject_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','closed','revoked')),
  provider_event_at INTEGER NOT NULL,
  user_id TEXT,
  binding_id TEXT,
  PRIMARY KEY(business_id,subject_hash)
);
CREATE TABLE messaging_onboarding_contacts (
  contact_key TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  subject_hash TEXT NOT NULL,
  destination_hash TEXT NOT NULL,
  routing_ciphertext TEXT,
  user_id TEXT,
  binding_id TEXT,
  control TEXT NOT NULL CHECK(control IN ('bot','human','unknown')),
  status TEXT NOT NULL CHECK(status IN ('active','closed','revoked')),
  provider_event_at INTEGER NOT NULL,
  last_inbound_at INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(business_id,subject_hash,destination_hash)
);
CREATE INDEX onboarding_contacts_subject ON messaging_onboarding_contacts(business_id,subject_hash);
CREATE INDEX onboarding_contacts_user ON messaging_onboarding_contacts(user_id,binding_id);
CREATE TABLE messaging_onboarding_events (
  provider TEXT NOT NULL CHECK(provider='sunshine'),
  business_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  contact_key TEXT,
  payload_hash TEXT NOT NULL,
  provider_message_id TEXT,
  delivery_state TEXT CHECK(delivery_state IN ('sent','delivered','failed')),
  kind TEXT NOT NULL CHECK(kind IN ('ordinary','lifecycle','link_proof')),
  occurred_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  mutation_token TEXT NOT NULL,
  PRIMARY KEY(provider,business_id,event_id)
);
CREATE TABLE messaging_onboarding_notices (
  id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  contact_key TEXT NOT NULL REFERENCES messaging_onboarding_contacts(contact_key),
  kind TEXT NOT NULL CHECK(kind IN ('welcome','proof_received','linked')),
  status TEXT NOT NULL CHECK(status IN ('pending','sending','sent','delivery_unknown','delivered','failed','cancelled')),
  contact_revision INTEGER NOT NULL,
  challenge_id TEXT,
  binding_id TEXT,
  binding_revision INTEGER,
  user_id TEXT,
  provider_message_id TEXT,
  attempt_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  dispatched_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  error_code TEXT
);
CREATE INDEX onboarding_notices_work ON messaging_onboarding_notices(status,next_attempt_at);
CREATE INDEX onboarding_notices_contact ON messaging_onboarding_notices(contact_key,status);
CREATE INDEX onboarding_notices_quota ON messaging_onboarding_notices(dispatched_at);
CREATE TRIGGER erase_messaging_onboarding BEFORE DELETE ON users BEGIN
  UPDATE messaging_onboarding_notices SET status=CASE WHEN status='sending' THEN 'delivery_unknown' WHEN status='pending' THEN 'cancelled' ELSE status END,
    user_id=NULL,error_code='account_erased' WHERE user_id=OLD.id;
  UPDATE messaging_onboarding_contacts SET routing_ciphertext=NULL,user_id=NULL,binding_id=NULL,status='revoked',revision=revision+1
    WHERE user_id=OLD.id;
  UPDATE messaging_onboarding_subjects SET user_id=NULL,binding_id=NULL,status='revoked' WHERE user_id=OLD.id;
END;
