import type { Channel, ChannelSubject, Env, SendOutcome, MessageContent } from '../../contracts/src/index';
import { sha256 } from '../../security/src/index';
import { REMINDER_SEND_ELIGIBILITY_SQL, CONVERSATION_SEND_ELIGIBILITY_SQL } from '../../contracts/src/delivery-policy';
import { getQuietHoursEnd } from '../../scheduling/src/index';

export interface DeliveryRequest {
  jobId: string;
  conversationId: string;
  idempotencyKey: string;
  leaseToken: string;
  attemptToken: string;
  ownershipVersion: number;
  recipient: ChannelSubject;
  channel: Channel;
  text: string;
  content?: MessageContent;
}

export interface MessagingTransport {
  /** Must be backed by a documented, durable provider idempotency guarantee. */
  readonly supportsIdempotentRetry?: boolean;
  supportsIdempotentRetryFor?(channel: Channel): boolean;
  send(request: DeliveryRequest): Promise<SendOutcome>;
  /** null means no authoritative result; it must not trigger a blind retry. */
  reconcile(idempotencyKey: string): Promise<SendOutcome | null>;
}

/** No network access. The durable receipt is the mock's idempotency contract. */
export class MockMessagingTransport implements MessagingTransport {
  readonly supportsIdempotentRetry = true;
  private unknownReturned = false;
  constructor(private readonly env: Pick<Env, 'DB'>, private readonly options: { unknownAfterAcceptOnce?: boolean } = {}) {}

  async send(request: DeliveryRequest): Promise<SendOutcome> {
    if (request.channel !== 'mock' && request.channel !== 'web') return { state: 'failed', code: 'unsupported_channel' };
    const providerMessageId = `mock_${(await sha256(request.idempotencyKey)).slice(0, 32)}`;
    const policy = await this.env.DB.prepare(`SELECT m.reminder_occurrence_id,u.reminders_revision,u.reminder_timezone,u.quiet_start,u.quiet_end
      FROM outbound_jobs o JOIN messages m ON m.id=o.message_id JOIN conversations c ON c.id=o.conversation_id
      JOIN users u ON u.id=c.user_id WHERE o.id=?`).bind(request.jobId).first<{ reminder_occurrence_id: string | null; reminders_revision: number; reminder_timezone: string; quiet_start: string; quiet_end: string }>();
    if (policy?.reminder_occurrence_id && getQuietHoursEnd(Date.now(), policy.reminder_timezone, policy.quiet_start, policy.quiet_end) !== null) {
      return { state: 'retryable_failed', code: 'quiet_hours' };
    }
    // The simulated external side effect itself is gated atomically, rather than
    // trusting an earlier application-level authorization read.
    await this.env.DB.prepare(`INSERT OR IGNORE INTO mock_receipts (idempotency_key,provider_message_id,state,created_at)
      SELECT ?,?,'delivered',? FROM outbound_jobs o JOIN conversations c ON c.id=o.conversation_id
      JOIN bindings b ON b.conversation_id=c.id AND b.user_id=c.user_id JOIN users u ON u.id=c.user_id JOIN messages m ON m.id=o.message_id
      WHERE o.id=? AND o.idempotency_key=? AND o.status='sending' AND c.id=? AND c.channel=?
      AND c.provider=? AND c.business_id=? AND c.subject_id=? AND ${CONVERSATION_SEND_ELIGIBILITY_SQL} AND c.status='active'
      AND c.ownership_version=o.ownership_version AND c.ownership_version=? AND c.lease_token=? AND o.attempt_token=?
      AND c.lease_until>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
      AND b.status='active' AND u.status='active' AND m.context_revision=u.context_revision
      AND ${REMINDER_SEND_ELIGIBILITY_SQL} AND (m.reminder_occurrence_id IS NULL OR u.reminders_revision=?)
      AND NOT EXISTS (SELECT 1 FROM system_settings WHERE (key='outbound_paused' AND value!='false' OR key='restore_locked' AND value!='false'))`)
      .bind(request.idempotencyKey, providerMessageId, Date.now(), request.jobId, request.idempotencyKey,
        request.conversationId, request.channel, request.recipient.provider, request.recipient.businessId, request.recipient.subjectId,
        request.ownershipVersion, request.leaseToken, request.attemptToken, policy?.reminders_revision ?? -1).run();
    const receipt = await this.reconcile(request.idempotencyKey);
    if (!receipt) return { state: 'failed', code: 'dispatch_blocked' };
    if (this.options.unknownAfterAcceptOnce && !this.unknownReturned) {
      this.unknownReturned = true;
      return { state: 'delivery_unknown', code: 'mock_timeout_after_acceptance' };
    }
    return receipt;
  }

  async reconcile(idempotencyKey: string): Promise<SendOutcome | null> {
    const receipt = await this.env.DB.prepare('SELECT provider_message_id, state FROM mock_receipts WHERE idempotency_key = ?')
      .bind(idempotencyKey).first<{ provider_message_id: string; state: 'sent' | 'delivered' }>();
    return receipt ? { state: receipt.state, providerMessageId: receipt.provider_message_id } : null;
  }
}
