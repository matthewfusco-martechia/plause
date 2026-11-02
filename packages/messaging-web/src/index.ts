import type { Env, SendOutcome } from '../../contracts/src/index';
import type { DeliveryRequest, MessagingTransport } from '../../messaging-mock/src/index';
import { CONVERSATION_SEND_ELIGIBILITY_SQL, REMINDER_SEND_ELIGIBILITY_SQL } from '../../contracts/src/delivery-policy';
import { sha256 } from '../../security/src/index';
import { getQuietHoursEnd } from '../../scheduling/src/index';

/** Publish to the authenticated web inbox. Delivery requires a separate client receipt. */
export class WebMessagingTransport implements MessagingTransport {
  readonly supportsIdempotentRetry = true;
  constructor(private readonly env: Pick<Env, 'DB'>) {}
  async send(request: DeliveryRequest): Promise<SendOutcome> {
    if (request.channel !== 'web' || request.recipient.provider !== 'web') return { state: 'failed', code: 'unsupported_channel' };
    const providerId = `web_${(await sha256(request.idempotencyKey)).slice(0, 32)}`;
    const policy = await this.env.DB.prepare(`SELECT m.reminder_occurrence_id,u.reminders_revision,u.reminder_timezone,u.quiet_start,u.quiet_end
      FROM outbound_jobs o JOIN messages m ON m.id=o.message_id JOIN conversations c ON c.id=m.conversation_id
      JOIN users u ON u.id=c.user_id WHERE o.id=?`).bind(request.jobId).first<{
        reminder_occurrence_id: string | null; reminders_revision: number; reminder_timezone: string; quiet_start: string; quiet_end: string;
      }>();
    if (policy?.reminder_occurrence_id && getQuietHoursEnd(Date.now(), policy.reminder_timezone, policy.quiet_start, policy.quiet_end) !== null) {
      return { state: 'retryable_failed', code: 'quiet_hours' };
    }
    await this.env.DB.prepare(`INSERT INTO web_delivery_receipts(idempotency_key,provider_message_id,conversation_id,message_id,state,created_at)
      SELECT o.idempotency_key,?,c.id,m.id,'sent',? FROM outbound_jobs o JOIN messages m ON m.id=o.message_id
      JOIN conversations c ON c.id=o.conversation_id JOIN users u ON u.id=c.user_id
      JOIN bindings b ON b.conversation_id=c.id AND b.user_id=c.user_id WHERE o.id=? AND o.idempotency_key=?
      AND o.status='sending' AND o.attempt_token=? AND c.id=? AND c.channel='web' AND c.provider='web'
      AND c.business_id=? AND c.subject_id=? AND b.provider=c.provider AND b.business_id=c.business_id AND b.subject_id=c.subject_id
      AND b.channel=c.channel AND b.status='active' AND u.status='active' AND c.status='active'
      AND c.ownership_version=? AND o.ownership_version=c.ownership_version AND c.lease_token=?
      AND c.lease_until>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER) AND m.context_revision=u.context_revision
      AND ${REMINDER_SEND_ELIGIBILITY_SQL} AND ${CONVERSATION_SEND_ELIGIBILITY_SQL}
      AND (m.reminder_occurrence_id IS NULL OR u.reminders_revision=?)
      AND NOT EXISTS (SELECT 1 FROM system_settings WHERE (key='outbound_paused' AND value!='false' OR key='restore_locked' AND value!='false')) ON CONFLICT DO NOTHING`)
      .bind(providerId, Date.now(), request.jobId, request.idempotencyKey, request.attemptToken, request.conversationId,
        request.recipient.businessId, request.recipient.subjectId, request.ownershipVersion, request.leaseToken, policy?.reminders_revision ?? -1).run();
    return await this.reconcile(request.idempotencyKey) ?? { state: 'failed', code: 'dispatch_blocked' };
  }
  async reconcile(key: string): Promise<SendOutcome | null> {
    const row = await this.env.DB.prepare('SELECT provider_message_id,state FROM web_delivery_receipts WHERE idempotency_key=?')
      .bind(key).first<{ provider_message_id: string; state: 'sent' | 'delivered' }>();
    return row ? { state: row.state, providerMessageId: row.provider_message_id } : null;
  }
}

export async function acknowledgeWebDelivery(env: Pick<Env, 'DB'>, userId: string, conversationId: string, ids: string[]): Promise<void> {
  if (ids.length === 0 || ids.length > 100 || new Set(ids).size !== ids.length) throw new Error('invalid_web_receipt');
  const marks = ids.map(() => '?').join(',');
  const scope = `EXISTS (SELECT 1 FROM conversations ac JOIN users au ON au.id=ac.user_id
    WHERE ac.id=? AND ac.user_id=? AND ac.channel='web' AND ac.provider='web' AND au.status='active')`;
  await env.DB.batch([
    env.DB.prepare(`UPDATE web_delivery_receipts SET state='delivered',delivered_at=COALESCE(delivered_at,?) WHERE conversation_id=?
      AND message_id IN (${marks}) AND EXISTS (SELECT 1 FROM conversations c JOIN users u ON u.id=c.user_id
        WHERE c.id=web_delivery_receipts.conversation_id AND c.user_id=? AND c.channel='web' AND u.status='active')`)
      .bind(Date.now(), conversationId, ...ids, userId),
    env.DB.prepare(`UPDATE outbound_jobs SET status='delivered',updated_at=? WHERE conversation_id=? AND message_id IN (${marks})
      AND EXISTS (SELECT 1 FROM web_delivery_receipts r WHERE r.message_id=outbound_jobs.message_id AND r.state='delivered') AND ${scope}`)
      .bind(Date.now(), conversationId, ...ids, conversationId, userId),
    env.DB.prepare(`UPDATE messages SET status='delivered' WHERE conversation_id=? AND id IN (${marks})
      AND EXISTS (SELECT 1 FROM web_delivery_receipts r WHERE r.message_id=messages.id AND r.state='delivered') AND ${scope}`)
      .bind(conversationId, ...ids, conversationId, userId),
  ]);
}
