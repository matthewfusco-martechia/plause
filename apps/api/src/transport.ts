import type { Channel, Env, MessageContent, SendOutcome } from '../../../packages/contracts/src/index';
import { proactiveChannelAllowed } from '../../../packages/contracts/src/runtime-policy';
import { CONVERSATION_SEND_ELIGIBILITY_SQL, REMINDER_SEND_ELIGIBILITY_SQL } from '../../../packages/contracts/src/delivery-policy';
import { MockMessagingTransport, type DeliveryRequest, type MessagingTransport } from '../../../packages/messaging-mock/src/index';
import { WebMessagingTransport } from '../../../packages/messaging-web/src/index';
import { SunshineMessagingClient, serializeSunshineContent } from '../../../packages/messaging-sunshine/src/index';
import { decryptText, encryptText } from '../../../packages/security/src/index';
import { getQuietHoursEnd } from '../../../packages/scheduling/src/index';
import { assertOperational, providerCircuitOpen } from './runtime-operations';

interface VendorRow { operator_user_id: string | null; provider_conversation_id: string; revision: number; body_ciphertext: string; reminder_occurrence_id: string | null; provider_request_ciphertext: string | null }
const vendorGate = `o.id=? AND o.idempotency_key=? AND o.status='sending' AND o.attempt_token=? AND c.id=?
 AND c.channel='apple_business' AND c.provider='sunshine' AND c.business_id=? AND c.subject_id=?
 AND b.provider=c.provider AND b.business_id=c.business_id AND b.subject_id=c.subject_id AND b.channel=c.channel
 AND b.status='active' AND b.reply_consent_at IS NOT NULL AND u.status='active' AND c.status='active'
 AND c.ownership_version=? AND c.ownership_version=o.ownership_version AND c.lease_token=?
 AND c.lease_until>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER) AND m.context_revision=u.context_revision
 AND ${CONVERSATION_SEND_ELIGIBILITY_SQL} AND ${REMINDER_SEND_ELIGIBILITY_SQL}
 AND (m.reminder_occurrence_id IS NULL OR b.proactive_consent_at IS NOT NULL)
 AND NOT EXISTS (SELECT 1 FROM system_settings WHERE (key='outbound_paused' AND value!='false' OR key='restore_locked' AND value!='false'))`;
const vendorFrom = `FROM outbound_jobs o JOIN messages m ON m.id=o.message_id JOIN conversations c ON c.id=o.conversation_id
 JOIN users u ON u.id=c.user_id JOIN bindings b ON b.conversation_id=c.id AND b.user_id=c.user_id`;
const bindings = (r: DeliveryRequest) => [r.jobId, r.idempotencyKey, r.attemptToken, r.conversationId,
  r.recipient.businessId, r.recipient.subjectId, r.ownershipVersion, r.leaseToken];

async function serverContent(env: Env, messageId: string, text: string): Promise<MessageContent> {
  const approval = await env.DB.prepare(`SELECT id FROM action_approvals WHERE state='pending' AND expires_at>?
    AND (proposal_message_id=? OR source_message_id=(SELECT in_reply_to_message_id FROM messages WHERE id=?))
    UNION ALL SELECT id FROM google_calendar_approvals WHERE state='pending' AND expires_at>?
    AND source_message_id=(SELECT in_reply_to_message_id FROM messages WHERE id=?) LIMIT 1`)
    .bind(Date.now(), messageId, messageId, Date.now(), messageId).first<{ id: string }>();
  return approval ? { type: 'quick_replies', text, options: [{ id: `approve ${approval.id}`, label: 'Approve' },
    { id: `reject ${approval.id}`, label: 'Reject' }] } : { type: 'text', text };
}

export class RuntimeMessagingTransport implements MessagingTransport {
  private readonly mock: MockMessagingTransport;
  private readonly web: WebMessagingTransport;
  constructor(private readonly env: Env) { this.mock = new MockMessagingTransport(env); this.web = new WebMessagingTransport(env); }
  supportsIdempotentRetryFor(channel: Channel): boolean { return channel === 'web' || channel === 'mock' && this.env.MESSAGING_PROVIDER === 'mock'; }
  async send(request: DeliveryRequest): Promise<SendOutcome> {
    if (this.env.MESSAGING_PROVIDER === 'mock' && ['local','staging'].includes(this.env.APP_ENV)) return this.mock.send(request);
    if (request.channel === 'web') return this.web.send(request);
    if (request.channel !== 'apple_business' || this.env.MESSAGING_PROVIDER !== 'sunshine'
      || this.env.LIVE_MESSAGING_ENABLED !== 'true' || this.env.APPLE_CHANNEL_APPROVED !== 'true') return { state: 'failed', code: 'provider_not_enabled' };
    if (request.recipient.provider !== 'sunshine' || request.recipient.businessId !== this.env.SUNSHINE_APP_ID) return { state: 'failed', code: 'provider_scope_rejected' };
    await assertOperational(this.env, { outbound: true });
    if (await providerCircuitOpen(this.env, 'messaging')) return { state: 'retryable_failed', code: 'messaging_circuit_open' };
    const row = await this.env.DB.prepare(`SELECT b.provider_conversation_id,b.revision,m.body_ciphertext,m.reminder_occurrence_id,m.operator_user_id,o.provider_request_ciphertext
      ${vendorFrom} WHERE ${vendorGate}`).bind(...bindings(request)).first<VendorRow>();
    if (!row?.provider_conversation_id) return { state: 'failed', code: 'dispatch_blocked' };
    if (row.reminder_occurrence_id && !proactiveChannelAllowed(this.env, request.channel)) return { state: 'failed', code: 'proactive_not_enabled' };
    if (await decryptText(row.body_ciphertext, this.env.CONTENT_ENCRYPTION_KEY) !== request.text) return { state: 'failed', code: 'content_changed' };
    const job = await this.env.DB.prepare('SELECT message_id FROM outbound_jobs WHERE id=?').bind(request.jobId).first<{ message_id: string }>();
    if (!job) return { state: 'failed', code: 'dispatch_blocked' };
    const content = await serverContent(this.env, job.message_id, request.text);
    const frozen = await encryptText(JSON.stringify({ providerConversationId: row.provider_conversation_id, bindingRevision: row.revision, content, authorType: row.operator_user_id ? 'human' : 'ai' }), this.env.CONTENT_ENCRYPTION_KEY);
    await this.env.DB.prepare(`UPDATE outbound_jobs SET provider_request_ciphertext=COALESCE(provider_request_ciphertext,?) WHERE id=?
      AND EXISTS (SELECT 1 ${vendorFrom} WHERE ${vendorGate} AND b.revision=? AND b.provider_conversation_id=? AND m.body_ciphertext=?)`)
      .bind(frozen, request.jobId, ...bindings(request), row.revision, row.provider_conversation_id, row.body_ciphertext).run();
    const saved = await this.env.DB.prepare('SELECT provider_request_ciphertext FROM outbound_jobs WHERE id=?').bind(request.jobId).first<{ provider_request_ciphertext: string | null }>();
    if (!saved?.provider_request_ciphertext) return { state: 'failed', code: 'dispatch_blocked' };
    const payload = await this.decode(saved.provider_request_ciphertext);
    if (!payload || payload.bindingRevision !== row.revision || payload.providerConversationId !== row.provider_conversation_id) return { state: 'failed', code: 'destination_changed' };
    const client = new SunshineMessagingClient(this.env, { beforeSend: async () => {
      const preferences = row.reminder_occurrence_id ? await this.env.DB.prepare(`SELECT u.reminders_revision,u.reminder_timezone,u.quiet_start,u.quiet_end
        FROM users u JOIN conversations c ON c.user_id=u.id WHERE c.id=?`).bind(request.conversationId)
        .first<{ reminders_revision: number; reminder_timezone: string; quiet_start: string; quiet_end: string }>() : null;
      const current = await this.env.DB.prepare(`SELECT 1 ${vendorFrom} WHERE ${vendorGate} AND b.revision=? AND b.provider_conversation_id=?
        AND m.body_ciphertext=? AND o.provider_request_ciphertext=? AND (m.reminder_occurrence_id IS NULL OR u.reminders_revision=?)`)
        .bind(...bindings(request), row.revision, row.provider_conversation_id, row.body_ciphertext, saved.provider_request_ciphertext,
          preferences?.reminders_revision ?? -1).first();
      if (!current) throw new Error('dispatch_blocked');
      if (row.reminder_occurrence_id && (!preferences || !proactiveChannelAllowed(this.env, request.channel)
        || getQuietHoursEnd(Date.now(), preferences.reminder_timezone, preferences.quiet_start, preferences.quiet_end) !== null)) throw new Error('quiet_hours');
    } });
    return client.send({ conversationId: payload.providerConversationId, idempotencyKey: request.idempotencyKey, content: payload.content, authorType: payload.authorType });
  }
  private async decode(value: string): Promise<{ providerConversationId: string; bindingRevision: number; content: MessageContent; authorType: 'ai' | 'human' } | null> {
    try {
      const parsed = JSON.parse(await decryptText(value, this.env.CONTENT_ENCRYPTION_KEY)) as { providerConversationId: string; bindingRevision: number; content: MessageContent; authorType: 'ai' | 'human' };
      if (typeof parsed.providerConversationId !== 'string' || !parsed.providerConversationId || !Number.isSafeInteger(parsed.bindingRevision) || !['ai','human'].includes(parsed.authorType)) return null;
      serializeSunshineContent(parsed.content);
      return parsed;
    } catch { return null; }
  }
  async reconcile(key: string): Promise<SendOutcome | null> {
    if (this.env.MESSAGING_PROVIDER === 'mock' && ['local','staging'].includes(this.env.APP_ENV)) return this.mock.reconcile(key);
    const row = await this.env.DB.prepare(`SELECT c.channel,o.provider_request_ciphertext,o.provider_message_id FROM outbound_jobs o
      JOIN conversations c ON c.id=o.conversation_id WHERE o.idempotency_key=?`).bind(key)
      .first<{ channel: string; provider_request_ciphertext: string | null; provider_message_id: string | null }>();
    if (row?.channel === 'web') return this.web.reconcile(key);
    if (!row?.provider_request_ciphertext || this.env.MESSAGING_PROVIDER !== 'sunshine') return null;
    const payload = await this.decode(row.provider_request_ciphertext);
    if (!payload) return null;
    return new SunshineMessagingClient(this.env, { beforeRead: async () => {
      await assertOperational(this.env, { outbound: true });
      const permitted = await this.env.DB.prepare(`SELECT 1 ${vendorFrom} WHERE o.idempotency_key=?
        AND o.provider_request_ciphertext=? AND o.status IN ('sending','delivery_unknown') AND c.provider='sunshine'
        AND c.channel='apple_business' AND c.business_id=? AND b.provider=c.provider AND b.business_id=c.business_id
        AND b.subject_id=c.subject_id AND b.channel=c.channel AND b.status='active' AND u.status='active' AND c.status='active'
        AND b.revision=? AND b.provider_conversation_id=? AND m.context_revision=u.context_revision
        AND o.ownership_version=c.ownership_version AND c.lease_token IS NOT NULL
        AND c.lease_until>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
        AND ${CONVERSATION_SEND_ELIGIBILITY_SQL} AND ${REMINDER_SEND_ELIGIBILITY_SQL}
        AND NOT EXISTS (SELECT 1 FROM system_settings WHERE key IN ('restore_locked','outbound_paused') AND value!='false')`)
        .bind(key, row.provider_request_ciphertext, this.env.SUNSHINE_APP_ID!, payload.bindingRevision, payload.providerConversationId).first();
      if (!permitted) throw new Error('reconciliation_blocked');
    } }).reconcile({ conversationId: payload.providerConversationId, idempotencyKey: key,
      content: payload.content, authorType: payload.authorType, ...(row.provider_message_id ? { providerMessageId: row.provider_message_id } : {}) });
  }
}
