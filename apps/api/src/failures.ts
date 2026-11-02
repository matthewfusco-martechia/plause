import { ModelCallError, type Env } from '../../../packages/contracts/src/index';
import { encryptText } from '../../../packages/security/src/index';

export interface FailureNotice { code: string; text: string }

// Only reviewed, content-free classifications may enter the durable error field.
// In particular, an exception message or an arbitrary provider code is never copy.
const safeCodes = new Set([
  'model_circuit_open', 'research_circuit_open', 'google_calendar_circuit_open',
  'cached_model_response_invalid', 'hosted_model_not_enabled', 'invalid_hosted_policy', 'invalid_model_memory', 'invalid_model_request', 'invalid_model_planning_context',
  'model_attempt_failed', 'model_attempt_in_progress', 'model_budget_exhausted', 'model_cache_purged', 'model_cancelled_before_dispatch',
  'model_context_revoked', 'model_input_conflict', 'model_outcome_unknown', 'model_ownership_invalid', 'model_reservation_abandoned',
  'model_response_invalid', 'unpriced_model', 'model_authorization_failed', 'model_config_invalid', 'model_count_invalid',
  'model_input_limit', 'model_network_error', 'model_output_invalid', 'model_refused', 'model_request_invalid',
  'model_response_incomplete', 'model_response_too_large', 'model_usage_invalid', 'model_auth_failed', 'model_rate_limited',
  'model_unavailable', 'model_request_rejected', 'model_timeout', 'model_aborted', 'research_cache_invalid', 'research_cache_purged',
  'research_cancelled_before_dispatch', 'research_config_invalid', 'research_daily_limit', 'research_not_enabled',
  'research_outcome_unknown', 'research_ownership_invalid', 'research_query_conflict', 'research_query_invalid', 'research_network_error',
  'research_response_invalid', 'research_response_too_large', 'research_auth_failed', 'research_rate_limited', 'research_unavailable',
  'research_request_rejected', 'research_timeout', 'research_aborted', 'research_failed',
  'google_calendar_approval_invalid', 'google_calendar_approval_revoked', 'google_calendar_cache_invalid', 'google_calendar_cache_purged',
  'google_calendar_cancelled', 'google_calendar_local_only', 'google_calendar_not_enabled', 'google_calendar_ownership_invalid',
  'google_calendar_source_conflict', 'google_calendar_timeout', 'google_calendar_outcome_unknown', 'google_calendar_failed',
  'google_calendar_disabled', 'google_calendar_not_configured', 'google_calendar_config_invalid', 'google_calendar_not_connected',
]);
const configurationCodes = new Set(['hosted_model_not_enabled', 'invalid_hosted_policy', 'unpriced_model', 'model_config_invalid',
  'model_auth_failed', 'model_authorization_failed', 'research_config_invalid', 'research_not_enabled', 'research_auth_failed']);

/** Fixed copy only: neither prompts, exception messages nor provider bodies are echoed. */
export function classifyFailure(error: unknown): FailureNotice {
  const code = error instanceof ModelCallError && safeCodes.has(error.code) ? error.code : 'model_failed';
  if (code.startsWith('google_calendar_')) {
    if (code === 'google_calendar_timeout' || code === 'google_calendar_outcome_unknown'
      || error instanceof ModelCallError && error.chargePossible) return { code,
      text: 'I couldn’t confirm the calendar outcome. No calendar write will be retried automatically. Open the Google controls and check the exact calendar action ID before deciding what to do next.' };
    if (['google_calendar_disabled', 'google_calendar_not_enabled', 'google_calendar_local_only', 'google_calendar_not_configured',
      'google_calendar_config_invalid', 'google_calendar_not_connected'].includes(code)) return { code,
      text: 'Real Google Calendar isn’t connected and ready for this request. Review the Google connection controls and reconnect explicitly if needed. This request will not be retried automatically.' };
    return { code,
      text: 'I couldn’t complete this calendar request. No calendar write will be retried automatically. Review the exact action and current Google connection in the controls before deciding what to do next.' };
  }
  if (error instanceof ModelCallError && error.chargePossible) return { code,
    text: 'I couldn’t confirm the provider outcome for this request. It will not be retried automatically. Check usage before deciding whether to send a new request.' };
  if (code === 'model_budget_exhausted') return { code,
    text: 'The configured AI spending limit has been reached. No model generation was started for this message. Check account usage before trying again.' };
  if (code === 'research_daily_limit') return { code,
    text: 'The configured daily search limit has been reached. No external search was started for this message. Please try again after the limit resets.' };
  if (configurationCodes.has(code)) return { code,
    text: 'This service isn’t ready to complete this request. Check the local provider configuration. This message will not be retried automatically.' };
  if (code === 'model_input_limit') return { code,
    text: 'This request exceeds the configured AI input limit. No model generation was started for this message. Try a shorter message or a fresh conversation.' };
  return { code,
    text: 'I couldn’t complete this request. Automatic retries have stopped. You can send a new message when you’re ready.' };
}

export interface FailureContext {
  userId: string; conversationId: string; messageId: string; inboxSequence: number; leaseToken: string;
  ownershipVersion: number; contextRevision: number; now: number;
}

/** A retry may not change a cancelled source back to received after a privacy race. */
export function retryFailureStatements(env: Env, context: FailureContext, code: string): D1PreparedStatement[] {
  const eligibility = (inboxStatus: 'processing' | 'pending') => `EXISTS (SELECT 1 FROM conversations c
    JOIN users u ON u.id=c.user_id JOIN bindings b ON b.conversation_id=c.id AND b.user_id=c.user_id
    JOIN messages m ON m.conversation_id=c.id JOIN inbox i ON i.message_id=m.id AND i.conversation_id=c.id
    WHERE c.id=? AND c.user_id=? AND m.id=? AND i.sequence=? AND i.status='${inboxStatus}' AND m.status='processing'
    AND m.role='user' AND m.is_memory_control=0 AND m.context_revision=? AND u.context_revision=?
    AND c.lease_token=? AND c.ownership_version=? AND c.lease_until>?
    AND c.lease_until>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
    AND c.mode='bot' AND c.status='active' AND u.status='active' AND b.status='active'
    AND b.provider=c.provider AND b.business_id=c.business_id AND b.subject_id=c.subject_id AND b.channel=c.channel)`;
  const bindings = [context.conversationId, context.userId, context.messageId, context.inboxSequence, context.contextRevision,
    context.contextRevision, context.leaseToken, context.ownershipVersion, context.now];
  return [
    env.DB.prepare(`UPDATE inbox SET status='pending',last_error=?,completed_at=NULL
      WHERE sequence=? AND status='processing' AND ${eligibility('processing')}`).bind(code, context.inboxSequence, ...bindings),
    env.DB.prepare(`UPDATE messages SET status='received' WHERE id=? AND status='processing' AND ${eligibility('pending')}`)
      .bind(context.messageId, ...bindings),
  ];
}

/** All returned statements must run in one D1 batch. A stale/cancelled turn writes nothing. */
export async function terminalFailureStatements(env: Env, context: FailureContext, failure: FailureNotice): Promise<D1PreparedStatement[]> {
  const replyId = `msg_${crypto.randomUUID()}`;
  const ciphertext = await encryptText(failure.text, env.CONTENT_ENCRYPTION_KEY);
  return [
    env.DB.prepare(`INSERT INTO messages
      (id,conversation_id,in_reply_to_message_id,role,body_ciphertext,status,created_at,model,context_revision,is_memory_control)
      SELECT ?,c.id,m.id,'assistant',?,'queued',?,'plause-status',?,1 FROM conversations c
      JOIN users u ON u.id=c.user_id JOIN bindings b ON b.conversation_id=c.id AND b.user_id=c.user_id
      JOIN messages m ON m.conversation_id=c.id JOIN inbox i ON i.message_id=m.id AND i.conversation_id=c.id
      WHERE c.id=? AND c.user_id=? AND m.id=? AND i.sequence=? AND i.status='processing' AND m.status='processing'
      AND m.role='user' AND m.is_memory_control=0 AND m.context_revision=? AND u.context_revision=?
      AND c.lease_token=? AND c.ownership_version=? AND c.lease_until>?
      AND c.lease_until>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
      AND c.mode='bot' AND c.status='active' AND u.status='active' AND b.status='active'
      AND b.provider=c.provider AND b.business_id=c.business_id AND b.subject_id=c.subject_id AND b.channel=c.channel
      AND NOT EXISTS (SELECT 1 FROM system_settings WHERE (key='outbound_paused' AND value!='false' OR key='restore_locked' AND value!='false')) ON CONFLICT DO NOTHING`)
      .bind(replyId, ciphertext, context.now, context.contextRevision, context.conversationId, context.userId, context.messageId,
        context.inboxSequence, context.contextRevision, context.contextRevision, context.leaseToken, context.ownershipVersion, context.now),
    env.DB.prepare(`INSERT INTO outbound_jobs
      (id,conversation_id,message_id,idempotency_key,status,ownership_version,next_attempt_at,created_at,updated_at,expires_at)
      SELECT ?,conversation_id,id,?,'queued',?,?,?,?,? FROM messages WHERE id=? ON CONFLICT DO NOTHING`)
      .bind(`out_${crypto.randomUUID()}`, `reply:${context.messageId}`, context.ownershipVersion, context.now, context.now,
        context.now, context.now + 86_400_000, replyId),
    env.DB.prepare(`UPDATE inbox SET status='failed',last_error=?,completed_at=? WHERE sequence=? AND status='processing'
      AND EXISTS (SELECT 1 FROM messages WHERE id=?)`).bind(failure.code, context.now, context.inboxSequence, replyId),
    env.DB.prepare(`UPDATE messages SET status='failed' WHERE id=? AND status='processing'
      AND EXISTS (SELECT 1 FROM messages WHERE id=?)`).bind(context.messageId, replyId),
  ];
}
