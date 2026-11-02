ALTER TABLE bindings ADD COLUMN provider_proved_at INTEGER;
ALTER TABLE channel_link_challenges ADD COLUMN provider_proved_at INTEGER;

-- Stop migration if legacy active rows share a provider destination. An operator
-- must investigate and explicitly revoke the conflicting binding; never merge
-- or reassign an account automatically.
CREATE UNIQUE INDEX active_provider_destination
  ON bindings(provider,business_id,provider_conversation_id)
  WHERE provider_conversation_id IS NOT NULL AND status='active';
