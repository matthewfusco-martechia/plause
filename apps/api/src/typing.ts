import type { Env } from '../../../packages/contracts/src/index';
import { SunshineMessagingClient, sunshineReadiness } from '../../../packages/messaging-sunshine/src/index';

export interface TypingContext { conversationId: string; leaseToken: string; ownershipVersion: number }
interface Destination { provider_conversation_id: string; revision: number }
const scope = `FROM conversations c JOIN users u ON u.id=c.user_id JOIN bindings b ON b.conversation_id=c.id
  AND b.user_id=c.user_id AND b.provider=c.provider AND b.business_id=c.business_id AND b.subject_id=c.subject_id AND b.channel=c.channel
  WHERE c.id=? AND c.lease_token=? AND c.ownership_version=?
  AND c.lease_until>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
  AND c.provider='sunshine' AND c.business_id=? AND c.channel='apple_business' AND c.status='active'
  AND c.mode='bot' AND c.provider_control='bot' AND u.status='active' AND b.status='active' AND b.reply_consent_at IS NOT NULL
  AND NOT EXISTS(SELECT 1 FROM system_settings WHERE key IN ('restore_locked','outbound_paused') AND value!='false')`;

function enabled(env: Env): boolean {
  return ['staging','production'].includes(env.APP_ENV) && env.MESSAGING_PROVIDER === 'sunshine'
    && env.LIVE_MESSAGING_ENABLED === 'true' && env.APPLE_CHANNEL_APPROVED === 'true'
    && 'TYPING_INDICATORS_ENABLED' in env && env.TYPING_INDICATORS_ENABLED === 'true'
    && sunshineReadiness(env).transportConfigured;
}

/** Ephemeral best-effort activity only. Revocation may suppress stop; the provider owns its expiry. */
export async function setTyping(env: Env, context: TypingContext, active: boolean): Promise<void> {
  if (!enabled(env) || typeof active !== 'boolean' || !context || typeof context.conversationId !== 'string'
    || !/^conv_[A-Za-z0-9_-]{1,150}$/.test(context.conversationId) || context.conversationId.endsWith('\n')
    || typeof context.leaseToken !== 'string' || !context.leaseToken || context.leaseToken.length > 200
    || !Number.isSafeInteger(context.ownershipVersion) || context.ownershipVersion < 0) return;
  const values = [context.conversationId, context.leaseToken, context.ownershipVersion, env.SUNSHINE_APP_ID!];
  try {
    const destination = await env.DB.prepare(`SELECT b.provider_conversation_id,b.revision ${scope}`).bind(...values).first<Destination>();
    if (!destination?.provider_conversation_id) return;
    const client = new SunshineMessagingClient(env, { timeoutMs: 1000, beforeSend: async () => {
      if (!enabled(env)) throw new Error('typing_blocked');
      const current = await env.DB.prepare(`SELECT 1 ${scope} AND b.revision=? AND b.provider_conversation_id=?`)
        .bind(...values, destination.revision, destination.provider_conversation_id).first();
      if (!current) throw new Error('typing_blocked');
    } });
    const outcome = await client.typing(destination.provider_conversation_id, active ? 'start' : 'stop');
    if (outcome.state !== 'accepted') console.warn(JSON.stringify({ code: 'typing_indicator_unavailable' }));
  } catch { console.warn(JSON.stringify({ code: 'typing_indicator_unavailable' })); }
}
