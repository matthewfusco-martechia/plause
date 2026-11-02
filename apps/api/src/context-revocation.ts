import type { Env } from '../../../packages/contracts/src/index';

/** Join an already-owned consent mutation's D1 transaction. No facts/tasks/transcripts are deleted. */
export function contextRevocationStatements(env: Env, userId: string, gate: string, gateValues: (string | number)[], now: number,
  reason: 'google_disconnected' | 'google_reauthorization_required'): D1PreparedStatement[] {
  return [
    env.DB.prepare(`UPDATE outbound_jobs SET provider_request_ciphertext=NULL WHERE conversation_id IN
      (SELECT id FROM conversations WHERE user_id=?) AND ${gate}`).bind(userId, ...gateValues),
    env.DB.prepare(`UPDATE users SET context_revision=context_revision+1,
      memory_history_after_sequence=COALESCE((SELECT MAX(sequence) FROM inbox),0) WHERE id=? AND ${gate}`)
      .bind(userId, ...gateValues),
    env.DB.prepare(`UPDATE messages SET status='cancelled' WHERE id IN (SELECT i.message_id FROM inbox i
      JOIN conversations c ON c.id=i.conversation_id WHERE c.user_id=? AND i.status IN ('pending','processing')) AND ${gate}`)
      .bind(userId, ...gateValues),
    env.DB.prepare(`UPDATE inbox SET status='cancelled',last_error=?,completed_at=? WHERE conversation_id IN
      (SELECT id FROM conversations WHERE user_id=?) AND status IN ('pending','processing') AND ${gate}`)
      .bind(reason, now, userId, ...gateValues),
    env.DB.prepare(`UPDATE messages SET status=CASE WHEN EXISTS (SELECT 1 FROM outbound_jobs active_send
      WHERE active_send.message_id=messages.id AND active_send.status='sending') THEN 'delivery_unknown' ELSE 'cancelled' END
      WHERE id IN (SELECT o.message_id FROM outbound_jobs o JOIN conversations c ON c.id=o.conversation_id
        WHERE c.user_id=? AND o.status IN ('queued','retryable_failed','sending')) AND ${gate}`).bind(userId, ...gateValues),
    env.DB.prepare(`UPDATE outbound_jobs SET status=CASE WHEN status='sending' THEN 'delivery_unknown' ELSE 'cancelled' END,
      error_code=?,updated_at=? WHERE conversation_id IN (SELECT id FROM conversations WHERE user_id=?)
      AND status IN ('queued','retryable_failed','sending') AND ${gate}`).bind(reason, now, userId, ...gateValues),
    env.DB.prepare(`UPDATE conversations SET ownership_version=ownership_version+1,lease_token=NULL,lease_until=0
      WHERE user_id=? AND ${gate}`).bind(userId, ...gateValues),
    env.DB.prepare(`UPDATE model_attempts SET response_ciphertext=NULL,input_digest='',
      state=CASE WHEN state='completed' THEN 'purged' WHEN state='reserved' THEN 'failed' WHEN state='dispatched' THEN 'unknown' ELSE state END,
      budget_debit_micro_usd=CASE WHEN state='reserved' THEN 0 ELSE budget_debit_micro_usd END,
      error_code=?,updated_at=? WHERE user_id=? AND ${gate}`).bind(reason, now, userId, ...gateValues),
    env.DB.prepare(`UPDATE search_attempts SET result_ciphertext=NULL,query_digest='',
      state=CASE WHEN state='completed' THEN 'purged' WHEN state='dispatched' THEN 'unknown' ELSE state END,
      error_code=?,updated_at=? WHERE user_id=? AND ${gate}`).bind(reason, now, userId, ...gateValues),
  ];
}
