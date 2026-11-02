import type { Channel, ChannelSubject, Env } from '../../../packages/contracts/src/index';
import { decryptText, encryptText } from '../../../packages/security/src/index';
import { assertOperational } from './runtime-operations';

export type ConversationMode = 'bot' | 'human';
export interface ConversationRow {
  id: string;
  user_id: string;
  channel: Channel;
  provider: 'mock' | 'web' | 'sunshine';
  business_id: string;
  subject_id: string;
  status: 'active' | 'closed';
  mode: ConversationMode;
  provider_control: 'bot' | 'human' | 'unknown';
  ownership_version: number;
  lease_token: string | null;
  lease_until: number;
}

export class PipelineError extends Error {
  constructor(message: string, public readonly status = 400, public readonly code = 'invalid_request') {
    super(message);
    this.name = 'PipelineError';
  }
}

export async function resolveBinding(env: Env, subject: ChannelSubject, channel: Channel): Promise<ConversationRow> {
  const binding = await env.DB.prepare(`SELECT b.user_id, b.channel, b.status, u.status AS user_status
    FROM bindings b JOIN users u ON u.id=b.user_id WHERE b.provider=? AND b.business_id=? AND b.subject_id=?`)
    .bind(subject.provider, subject.businessId, subject.subjectId)
    .first<{ user_id: string; channel: Channel; status: string; user_status: string }>();
  if (!binding || binding.status !== 'active' || binding.user_status !== 'active') {
    throw new PipelineError('This channel identity is not enrolled or has been revoked.', 403, 'unknown_sender');
  }
  if (binding.channel !== channel || !['mock', 'web', 'apple_business'].includes(channel)
    || channel === 'apple_business' && subject.provider !== 'sunshine') {
    throw new PipelineError('This channel is not enabled for the bound identity.', 400, 'channel_mismatch');
  }
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO conversations (id,user_id,channel,provider,business_id,subject_id,created_at,last_activity_at)
      SELECT ?,b.user_id,b.channel,b.provider,b.business_id,b.subject_id,?,? FROM bindings b JOIN users u ON u.id=b.user_id
      WHERE b.provider=? AND b.business_id=? AND b.subject_id=? AND b.status='active' AND u.status='active'
      ON CONFLICT(provider,business_id,subject_id) DO NOTHING`)
      .bind(`conv_${crypto.randomUUID()}`, now, now, subject.provider, subject.businessId, subject.subjectId),
    env.DB.prepare(`UPDATE bindings SET conversation_id=(SELECT id FROM conversations c
      WHERE c.provider=bindings.provider AND c.business_id=bindings.business_id AND c.subject_id=bindings.subject_id)
      WHERE provider=? AND business_id=? AND subject_id=? AND status='active'`)
      .bind(subject.provider, subject.businessId, subject.subjectId),
  ]);
  const conversation = await env.DB.prepare(`SELECT c.* FROM conversations c JOIN bindings b ON b.conversation_id=c.id
    JOIN users u ON u.id=c.user_id WHERE b.provider=? AND b.business_id=? AND b.subject_id=?
    AND b.status='active' AND u.status='active' AND b.user_id=c.user_id`)
    .bind(subject.provider, subject.businessId, subject.subjectId).first<ConversationRow>();
  if (!conversation) throw new PipelineError('This channel identity is unavailable.', 403, 'unknown_sender');
  return conversation;
}

export async function getWebConversation(env: Env, userId: string): Promise<string> {
  await env.DB.prepare(`INSERT INTO bindings (provider,business_id,subject_id,user_id,channel)
    SELECT 'web','plause-local',id,id,'web' FROM users WHERE id=? AND status='active'
    ON CONFLICT(provider,business_id,subject_id) DO NOTHING`).bind(userId).run();
  const conversation = await resolveBinding(env, { provider: 'web', businessId: 'plause-local', subjectId: userId }, 'web');
  if (conversation.user_id !== userId) throw new PipelineError('Conversation unavailable.', 403, 'forbidden');
  // A web browser can re-open its own closed thread only by submitting a new message.
  return conversation.id;
}

export async function getConversationView(env: Env, userId: string, conversationId: string) {
  const conversation = await env.DB.prepare(`SELECT c.*,u.context_revision FROM conversations c JOIN users u ON u.id=c.user_id
    WHERE c.id=? AND c.user_id=? AND u.status='active'`).bind(conversationId, userId).first<ConversationRow & { context_revision: number }>();
  if (!conversation) return null;
  const rows = await env.DB.prepare(`SELECT id,role,body_ciphertext,status,created_at,model,in_reply_to_message_id FROM
    (SELECT rowid AS sort_order,id,role,body_ciphertext,status,created_at,model,in_reply_to_message_id FROM messages
    WHERE conversation_id=? AND (?=1 OR role!='assistant' OR status IN ('sent','delivered')) ORDER BY rowid DESC LIMIT 100) ORDER BY sort_order ASC`)
    .bind(conversationId, env.MESSAGING_PROVIDER === 'mock' ? 1 : 0).all<{ id: string; role: 'user' | 'assistant' | 'system'; body_ciphertext: string; status: string; created_at: number; model: string; in_reply_to_message_id: string | null }>();
  const messages = await Promise.all(rows.results.map(async (message) => ({
    id: message.id, role: message.role, text: await decryptText(message.body_ciphertext, env.CONTENT_ENCRYPTION_KEY),
    status: message.status, createdAt: message.created_at, model: message.model, inReplyTo: message.in_reply_to_message_id,
  })));
  await assertOperational(env);
  const current = await env.DB.prepare(`SELECT c.ownership_version,u.context_revision FROM conversations c JOIN users u ON u.id=c.user_id
    WHERE c.id=? AND c.user_id=? AND u.status='active'`).bind(conversationId, userId)
    .first<{ ownership_version: number; context_revision: number }>();
  if (!current) return null;
  if (current.context_revision !== conversation.context_revision || current.ownership_version !== conversation.ownership_version) {
    throw new PipelineError('Conversation changed while reading. Please retry.', 409, 'conversation_changed');
  }
  return { id: conversation.id, mode: conversation.mode, channel: conversation.channel, status: conversation.status,
    ownershipVersion: conversation.ownership_version, messages };
}

/** Ownership changes fence in-flight model commits and suppress unsent AI work. */
export async function setConversationMode(env: Env, userId: string, conversationId: string, mode: ConversationMode): Promise<boolean> {
  if (mode !== 'bot' && mode !== 'human') return false;
  const current = await env.DB.prepare(`SELECT c.* FROM conversations c JOIN users u ON u.id=c.user_id
    WHERE c.id=? AND c.user_id=? AND u.status='active' AND c.status='active'`)
    .bind(conversationId, userId).first<ConversationRow>();
  if (!current) return false;
  if (current.mode === mode) return true;
  const now = Date.now();
  const notice = mode === 'human'
    ? (env.APP_ENV === 'local' ? 'The local operator enabled human support mode. Automatic replies are paused. This demo has no staffed support team.' : 'Human support requested. Automatic replies are paused. Staff availability and response times depend on published support coverage.')
    : 'The local operator resumed automatic demo replies. Previously cancelled replies will not be sent.';
  const noticeCiphertext = await encryptText(notice, env.CONTENT_ENCRYPTION_KEY);
  await env.DB.batch([
    env.DB.prepare(`UPDATE conversations SET mode=?,handoff_reason=CASE WHEN ?='human' THEN 'customer' ELSE NULL END,ownership_version=ownership_version+1,lease_token=NULL,lease_until=0,last_activity_at=?
      WHERE id=? AND user_id=? AND status='active' AND ownership_version=?`)
      .bind(mode, mode, now, conversationId, userId, current.ownership_version),
    ...cancellationStatements(env, conversationId, now, mode === 'human'),
    env.DB.prepare(`INSERT INTO messages (id,conversation_id,role,body_ciphertext,status,created_at)
      SELECT ?,id,'system',?,'local_only',? FROM conversations WHERE id=? AND mode=? AND ownership_version=?`)
      .bind(`msg_${crypto.randomUUID()}`, noticeCiphertext, now, conversationId, mode, current.ownership_version + 1),
    env.DB.prepare(`INSERT INTO audit_events (id,actor_user_id,conversation_id,action,outcome,created_at)
      VALUES (?,?,?,'conversation.mode_changed',?,?)`).bind(crypto.randomUUID(), userId, conversationId, mode, now),
  ]);
  return true;
}

/** These statements run in the caller's transaction after changing ownership. */
export function cancellationStatements(env: Env, conversationId: string, now: number, enabled = true): D1PreparedStatement[] {
  if (!enabled) return [];
  return [
    env.DB.prepare(`UPDATE inbox SET status='cancelled',completed_at=? WHERE conversation_id=? AND status IN ('pending','processing')
      AND EXISTS (SELECT 1 FROM conversations WHERE id=? AND (mode='human' OR provider_control!='bot' OR status='closed'))`).bind(now, conversationId, conversationId),
    env.DB.prepare(`UPDATE messages SET status='cancelled' WHERE id IN (SELECT o.message_id FROM outbound_jobs o JOIN conversations c ON c.id=o.conversation_id
      WHERE o.conversation_id=? AND o.status IN ('queued','retryable_failed') AND (c.status='closed' OR c.provider_control!='bot' OR c.mode='human' AND EXISTS (SELECT 1 FROM messages sm WHERE sm.id=o.message_id AND sm.operator_user_id IS NULL AND sm.support_notice=0)))`).bind(conversationId),
    env.DB.prepare(`UPDATE outbound_jobs SET status='cancelled',error_code='ownership_changed',updated_at=? WHERE conversation_id=?
      AND status IN ('queued','retryable_failed') AND EXISTS (SELECT 1 FROM conversations c WHERE c.id=?
        AND (c.status='closed' OR c.provider_control!='bot' OR c.mode='human' AND EXISTS (SELECT 1 FROM messages sm WHERE sm.id=outbound_jobs.message_id AND sm.operator_user_id IS NULL AND sm.support_notice=0)))`).bind(now, conversationId, conversationId),
    env.DB.prepare(`UPDATE messages SET status='delivery_unknown' WHERE id IN (SELECT o.message_id FROM outbound_jobs o JOIN conversations c ON c.id=o.conversation_id
      WHERE o.conversation_id=? AND o.status='sending' AND (c.status='closed' OR c.provider_control!='bot' OR c.mode='human' AND EXISTS (SELECT 1 FROM messages sm WHERE sm.id=o.message_id AND sm.operator_user_id IS NULL AND sm.support_notice=0)))`).bind(conversationId),
    env.DB.prepare(`UPDATE outbound_jobs SET status='delivery_unknown',error_code='ownership_changed_during_send',updated_at=? WHERE conversation_id=?
      AND status='sending' AND EXISTS (SELECT 1 FROM conversations c WHERE c.id=?
        AND (c.status='closed' OR c.provider_control!='bot' OR c.mode='human' AND EXISTS (SELECT 1 FROM messages sm WHERE sm.id=outbound_jobs.message_id AND sm.operator_user_id IS NULL AND sm.support_notice=0)))`).bind(now, conversationId, conversationId),
  ];
}
