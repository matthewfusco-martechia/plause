/** SQL fragment shared by the application claim and atomic mock receipt. Aliases m and u are required. */
export const BOUND_CHANNEL_ELIGIBILITY_SQL = `((c.channel='web' AND c.provider='web') OR (c.channel='mock' AND c.provider='mock')
  OR (c.channel='apple_business' AND c.provider='sunshine' AND b.reply_consent_at IS NOT NULL AND b.provider_conversation_id IS NOT NULL))`;

export const REMINDER_SEND_ELIGIBILITY_SQL = `(m.reminder_occurrence_id IS NULL OR EXISTS (
  SELECT 1 FROM reminder_occurrences ro JOIN reminders r ON r.id=ro.reminder_id
  WHERE ro.id=m.reminder_occurrence_id AND ro.message_id=m.id AND ro.user_id=u.id AND r.user_id=u.id
  AND ro.conversation_id=m.conversation_id AND r.version=ro.reminder_version
  AND ro.status='queued' AND r.status='active' AND u.reminders_enabled=1))`;

/** A staff reply is authorized by its current leased claim, never by its model label. */
export const CONVERSATION_SEND_ELIGIBILITY_SQL = `(c.provider_control='bot' AND (
  (c.mode='bot' AND m.operator_user_id IS NULL) OR (c.mode='human' AND m.support_notice=1 AND m.operator_user_id IS NULL
    AND EXISTS (SELECT 1 FROM messages source WHERE source.id=m.in_reply_to_message_id AND source.conversation_id=c.id
      AND source.role='user' AND source.is_memory_control=1)) OR (c.mode='human' AND m.operator_user_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM operator_grants og JOIN users operator ON operator.id=og.user_id
    JOIN support_claims sc ON sc.operator_user_id=og.user_id
    WHERE og.user_id=m.operator_user_id AND og.status='active' AND og.role IN ('admin','support') AND operator.status='active'
    AND og.revision=m.operator_grant_revision AND sc.grant_revision=og.revision AND sc.conversation_id=c.id
    AND sc.claim_version=m.support_claim_version AND sc.expires_at>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
  ))))`;
