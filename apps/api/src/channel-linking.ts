import type { Channel, Env } from '../../../packages/contracts/src/index';
import { z } from 'zod';
import { randomToken, sha256 } from '../../../packages/security/src/index';
import { requireRecentIdentitySession } from './auth';
import { requireIdentityOrigin } from './identity';
import { PipelineError } from './store';
import { assertOperational } from './runtime-operations';
import { onboardingLinkedStatements, onboardingProofStatements, onboardingRevocationStatements } from './messaging-onboarding';

const LIFETIME_MS = 5 * 60_000;
const dbNow = "CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)";
const operational = "NOT EXISTS (SELECT 1 FROM system_settings WHERE key='restore_locked' AND value!='false')";
interface Challenge {
  id: string; user_id: string; session_hash: string; status: string; expires_at: number; reply_consent: number; proactive_consent: number;
  provider: string | null; business_id: string | null; subject_id: string | null; channel: Channel | null;
  provider_event_id: string | null; provider_conversation_id: string | null; proved_at: number | null; provider_proved_at: number | null;
  provider_control: 'bot' | 'human' | 'unknown' | null;
}
const fail = (code: string, status = 409) => new PipelineError('Channel linking could not be completed. Start a fresh link from the signed-in account.', status, code);
const opaque = (value: unknown, maximum = 200): value is string => typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\x00-\x20\x7f]/.test(value);

export function parseChannelLinkCommand(text: string): { type: 'prove'; code: string } | { type: 'invalid' } | null {
  if (!/^link[ \t]+plause\b/i.test(text.trim())) return null;
  if (/[\r\n\u0085\u2028\u2029]/.test(text)) return { type: 'invalid' };
  const match = /^link[ \t]+plause[ \t]+([A-Za-z0-9_-]{43})$/i.exec(text.trim());
  return match ? { type: 'prove', code: match[1]! } : { type: 'invalid' };
}

export async function startChannelLink(env: Env, request: Request, userId: string, consent: { replyConsent: boolean; proactiveConsent: boolean }) {
  requireIdentityOrigin(env, request);
  await assertOperational(env);
  const proof = await requireRecentIdentitySession(env, request, userId);
  if (request.method !== 'POST' || consent.replyConsent !== true || typeof consent.proactiveConsent !== 'boolean') throw fail('channel_consent_required', 400);
  const code = randomToken(); const id = `link_${crypto.randomUUID()}`; const now = Date.now(); const expiresAt = now + LIFETIME_MS;
  const hash = await sha256(code);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM channel_link_challenges WHERE user_id=? AND status IN ('pending','proved')").bind(userId),
    env.DB.prepare(`INSERT INTO channel_link_challenges(id,code_hash,user_id,session_hash,status,reply_consent,proactive_consent,expires_at,created_at)
      SELECT ?,?,s.user_id,s.token_hash,'pending',1,?,?,? FROM sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token_hash=? AND s.user_id=? AND s.expires_at>${dbNow} AND s.authenticated_at>=${dbNow}-300000 AND u.status='active' AND ${operational}`)
      .bind(id, hash, consent.proactiveConsent ? 1 : 0, expiresAt, now, proof.tokenHash, userId),
  ]);
  if (!await env.DB.prepare('SELECT 1 FROM channel_link_challenges WHERE id=?').bind(id).first()) throw fail('channel_session_changed', 401);
  return { id, code, command: `link plause ${code}`, expiresAt };
}

export interface VerifiedChannelLink {
  provider: string; businessId: string; subjectId: string; channel: Channel; eventId: string; code: string; providerConversationId?: string; occurredAt?: string;
  control?: 'bot' | 'human' | 'unknown';
}

async function destinationOccupied(env: Env, provider: string, businessId: string, destination: string | null,
  subjectId: string, userId: string): Promise<boolean> {
  if (destination === null) return false;
  return !!await env.DB.prepare(`SELECT 1 FROM bindings WHERE provider=? AND business_id=? AND provider_conversation_id=?
    AND status='active' AND (subject_id!=? OR user_id!=?)`).bind(provider, businessId, destination, subjectId, userId).first();
}

/** Server-only seam: call after the adapter verifies the raw provider webhook.
 * No public client route accepts this tuple, and proof records never enter model history.
 */
export async function recordVerifiedChannelLink(env: Env, event: VerifiedChannelLink) {
  await assertOperational(env);
  const allowed = env.APP_ENV === 'local'
    ? event.provider === 'mock' && event.channel === 'mock' && env.MESSAGING_PROVIDER === 'mock' && event.businessId === 'plause-local'
    : event.provider === 'sunshine' && event.channel === 'apple_business' && env.MESSAGING_PROVIDER === 'sunshine'
      && env.LIVE_MESSAGING_ENABLED === 'true' && env.APPLE_CHANNEL_APPROVED === 'true' && event.businessId === env.SUNSHINE_APP_ID;
  if (!allowed || !opaque(event.businessId) || !opaque(event.subjectId) || !opaque(event.eventId)
    || !/^[A-Za-z0-9_-]{43}$/.test(event.code) || (event.providerConversationId !== undefined && !opaque(event.providerConversationId))
    || (event.provider === 'sunshine' && (!opaque(event.providerConversationId) || event.occurredAt === undefined))
    || (event.control !== undefined && !['bot','human','unknown'].includes(event.control))
    || (event.occurredAt !== undefined && !z.string().datetime().safeParse(event.occurredAt).success)) throw fail('channel_proof_invalid', 400);
  const providerAt = event.occurredAt === undefined ? null : Date.parse(event.occurredAt);
  const hash = await sha256(event.code);
  const now = Date.now();
  const previous = await env.DB.prepare('SELECT * FROM channel_link_challenges WHERE code_hash=?').bind(hash).first<Challenge>();
  if (!previous) throw fail('channel_link_expired', 401);
  const sameProof = (row: Challenge | null) => !!row && row.provider_event_id === event.eventId && row.provider === event.provider && row.business_id === event.businessId
    && row.subject_id === event.subjectId && row.channel === event.channel
    && row.provider_conversation_id === (event.providerConversationId ?? null) && row.provider_proved_at === providerAt
    && (row.provider_control === null || row.provider_control === (event.control ?? 'unknown'))
    && ['proved', 'consumed'].includes(row.status);
  if (sameProof(previous)) {
    return { id: previous.id, proved: true as const, duplicate: true };
  }
  if (previous.expires_at <= now) throw fail('channel_link_expired', 401);
  const eventCollision = async () => !!await env.DB.prepare(`SELECT 1 FROM webhook_events WHERE provider=? AND business_id=? AND event_id=?
    UNION ALL SELECT 1 FROM provider_lifecycle_events WHERE provider=? AND business_id=? AND event_id=?
    UNION ALL SELECT 1 FROM messaging_onboarding_events WHERE provider=? AND business_id=? AND event_id=? LIMIT 1`)
    .bind(event.provider, event.businessId, event.eventId, event.provider, event.businessId, event.eventId,
      event.provider, event.businessId, event.eventId).first();
  if (await eventCollision()) throw new PipelineError('Provider event conflict.', 409, 'provider_event_conflict');
  const notices = await onboardingProofStatements(env, { challengeId: previous.id, provider: event.provider,
    businessId: event.businessId, subjectId: event.subjectId,
    ...(event.providerConversationId === undefined ? {} : { providerConversationId: event.providerConversationId }),
    providerEventId: event.eventId, providerOccurredAt: providerAt ?? now, ...(event.control === undefined ? {} : { control: event.control }) });
  let changed = false;
  try {
    const proof = env.DB.prepare(`UPDATE channel_link_challenges SET status='proved',provider=?,business_id=?,subject_id=?,channel=?,
    provider_event_id=?,provider_conversation_id=?,proved_at=?,provider_proved_at=?,provider_control=? WHERE code_hash=? AND status='pending' AND expires_at>${dbNow} AND ${operational}
    AND EXISTS (SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=channel_link_challenges.session_hash
      AND s.user_id=channel_link_challenges.user_id AND s.expires_at>${dbNow} AND u.status='active')
    AND NOT EXISTS (SELECT 1 FROM webhook_events WHERE provider=? AND business_id=? AND event_id=?)
    AND NOT EXISTS (SELECT 1 FROM provider_lifecycle_events WHERE provider=? AND business_id=? AND event_id=?)
    AND NOT EXISTS (SELECT 1 FROM messaging_onboarding_events WHERE provider=? AND business_id=? AND event_id=?)
    AND NOT EXISTS (SELECT 1 FROM bindings b WHERE b.provider=? AND b.business_id=? AND b.subject_id=? AND b.user_id!=channel_link_challenges.user_id)
    AND NOT EXISTS (SELECT 1 FROM bindings b WHERE b.provider=? AND b.business_id=? AND b.provider_conversation_id=? AND b.status='active'
      AND (b.subject_id!=? OR b.user_id!=channel_link_challenges.user_id))`)
    .bind(event.provider, event.businessId, event.subjectId, event.channel, event.eventId, event.providerConversationId ?? null, now, providerAt, event.control ?? 'unknown',
      hash, event.provider, event.businessId, event.eventId, event.provider, event.businessId, event.eventId,
      event.provider, event.businessId, event.eventId,
      event.provider, event.businessId, event.subjectId,
      event.provider, event.businessId, event.providerConversationId ?? null, event.subjectId);
    const result = await env.DB.batch([proof, ...notices]);
    changed = result[0]!.meta.changes === 1;
  } catch { throw fail('channel_proof_conflict'); }
  if (!changed) {
    const current = await env.DB.prepare('SELECT * FROM channel_link_challenges WHERE code_hash=?').bind(hash).first<Challenge>();
    if (sameProof(current)) return { id: previous.id, proved: true as const, duplicate: true };
    if (await eventCollision()) throw new PipelineError('Provider event conflict.', 409, 'provider_event_conflict');
    if (await destinationOccupied(env, event.provider, event.businessId, event.providerConversationId ?? null, event.subjectId, previous.user_id)) {
      throw fail('channel_destination_in_use');
    }
    throw fail('channel_proof_conflict');
  }
  return { id: previous.id, proved: true as const, duplicate: false };
}

export async function getChannelLink(env: Env, request: Request, userId: string, id: string) {
  await assertOperational(env);
  const proof = await requireRecentIdentitySession(env, request, userId);
  const row = await env.DB.prepare(`SELECT p.* FROM channel_link_challenges p JOIN users u ON u.id=p.user_id
    WHERE p.id=? AND p.user_id=? AND p.session_hash=? AND u.status='active' AND ${operational}`).bind(id, userId, proof.tokenHash).first<Challenge>();
  if (!row) throw fail('channel_link_unavailable', 404);
  return { id: row.id, status: row.expires_at <= Date.now() && row.status !== 'consumed' ? 'expired' : row.status,
    expiresAt: row.expires_at, replyConsent: row.reply_consent === 1, proactiveConsent: row.proactive_consent === 1,
    proof: row.provider && row.subject_id ? { provider: row.provider, businessId: row.business_id, channel: row.channel,
      subjectHint: `…${row.subject_id.slice(-6)}` } : null };
}

export async function confirmChannelLink(env: Env, request: Request, userId: string, id: string) {
  requireIdentityOrigin(env, request);
  await assertOperational(env);
  const proof = await requireRecentIdentitySession(env, request, userId);
  if (request.method !== 'POST') throw fail('channel_request_invalid', 400);
  const completed = await env.DB.prepare(`SELECT b.id,b.provider,b.channel FROM bindings b JOIN channel_link_challenges p
    ON p.provider=b.provider AND p.business_id=b.business_id AND p.subject_id=b.subject_id
    WHERE p.id=? AND p.user_id=? AND p.session_hash=? AND p.status='consumed' AND b.user_id=p.user_id AND b.status='active'
      AND b.channel=p.channel AND b.provider_conversation_id IS p.provider_conversation_id AND ${operational}`)
    .bind(id, userId, proof.tokenHash).first<{ id: string; provider: string; channel: Channel }>();
  if (completed) return { linked: true as const, bindingId: completed.id, provider: completed.provider, channel: completed.channel };
  const operation = randomToken(); const bindingId = `binding_${crypto.randomUUID()}`; const now = Date.now();
  const own = "EXISTS (SELECT 1 FROM channel_link_challenges WHERE id=? AND user_id=? AND consumed_by=? AND status='consumed')";
  const values = [id, userId, operation];
  const changedDestination = `SELECT b.conversation_id FROM bindings b JOIN channel_link_challenges p
    ON p.provider=b.provider AND p.business_id=b.business_id AND p.subject_id=b.subject_id
    WHERE p.id=? AND p.user_id=? AND p.consumed_by=? AND p.status='consumed' AND b.user_id=p.user_id
    AND b.conversation_id IS NOT NULL AND b.provider_conversation_id IS NOT p.provider_conversation_id`;
  const notices = await onboardingLinkedStatements(env, { challengeId: id, userId, operationToken: operation, now });
  await env.DB.batch([
    env.DB.prepare(`UPDATE channel_link_challenges SET status='consumed',consumed_by=? WHERE id=? AND user_id=? AND session_hash=?
      AND status='proved' AND expires_at>${dbNow} AND ${operational} AND EXISTS (SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id
        WHERE s.token_hash=channel_link_challenges.session_hash AND s.user_id=channel_link_challenges.user_id
        AND s.expires_at>${dbNow} AND s.authenticated_at>=${dbNow}-300000 AND u.status='active')
      AND NOT EXISTS (SELECT 1 FROM bindings b WHERE b.provider=channel_link_challenges.provider AND b.business_id=channel_link_challenges.business_id
        AND b.subject_id=channel_link_challenges.subject_id AND b.user_id!=channel_link_challenges.user_id)
      AND NOT EXISTS (SELECT 1 FROM bindings b WHERE b.provider=channel_link_challenges.provider AND b.business_id=channel_link_challenges.business_id
        AND b.provider_conversation_id=channel_link_challenges.provider_conversation_id AND b.status='active'
        AND (b.subject_id!=channel_link_challenges.subject_id OR b.user_id!=channel_link_challenges.user_id))`)
      .bind(operation, id, userId, proof.tokenHash),
    // Fence the old destination before replacing it. All these statements use the
    // same consumed operation and run before the binding changes in this batch.
    env.DB.prepare(`UPDATE conversations SET status='closed',provider_control=CASE WHEN provider='sunshine' THEN 'unknown' ELSE 'bot' END,provider_event_at=0,
      ownership_version=ownership_version+1,lease_token=NULL,lease_until=0 WHERE id IN (${changedDestination}) AND user_id=?`)
      .bind(...values, userId),
    env.DB.prepare(`UPDATE messages SET status='cancelled' WHERE id IN (SELECT message_id FROM inbox
      WHERE conversation_id IN (${changedDestination}) AND status IN ('pending','processing'))`).bind(...values),
    env.DB.prepare(`UPDATE inbox SET status='cancelled',last_error='channel_destination_changed',completed_at=?
      WHERE conversation_id IN (${changedDestination}) AND status IN ('pending','processing')`).bind(now, ...values),
    env.DB.prepare(`UPDATE messages SET status=CASE WHEN EXISTS(SELECT 1 FROM outbound_jobs o
      WHERE o.message_id=messages.id AND o.status='sending') THEN 'delivery_unknown' ELSE 'cancelled' END
      WHERE id IN(SELECT message_id FROM outbound_jobs WHERE conversation_id IN (${changedDestination})
        AND status IN ('queued','retryable_failed','sending'))`).bind(...values),
    env.DB.prepare(`UPDATE outbound_jobs SET status=CASE WHEN status='sending' THEN 'delivery_unknown' ELSE 'cancelled' END,
      error_code='channel_destination_changed',updated_at=? WHERE conversation_id IN (${changedDestination})
      AND status IN ('queued','retryable_failed','sending')`).bind(now, ...values),
    env.DB.prepare(`UPDATE outbound_jobs SET provider_request_ciphertext=NULL WHERE conversation_id IN (${changedDestination})`).bind(...values),
    env.DB.prepare(`UPDATE support_claims SET operator_user_id=NULL,expires_at=0,claim_version=claim_version+1,
      mutation_token=?,updated_at=? WHERE conversation_id IN (${changedDestination})`).bind(operation, now, ...values),
    env.DB.prepare(`INSERT INTO bindings(id,provider,business_id,subject_id,user_id,channel,status,verified_at,reply_consent_at,proactive_consent_at,provider_conversation_id,provider_proved_at)
      SELECT ?,provider,business_id,subject_id,user_id,channel,'active',proved_at,?,CASE WHEN proactive_consent=1 THEN ? ELSE NULL END,provider_conversation_id,provider_proved_at
      FROM channel_link_challenges WHERE id=? AND ${own}
      ON CONFLICT(provider,business_id,subject_id) DO UPDATE SET status='active',revision=bindings.revision+1,
        verified_at=excluded.verified_at,reply_consent_at=excluded.reply_consent_at,proactive_consent_at=excluded.proactive_consent_at,
        revoked_at=NULL,provider_conversation_id=excluded.provider_conversation_id,provider_proved_at=excluded.provider_proved_at WHERE bindings.user_id=excluded.user_id`)
      .bind(bindingId, now, now, id, ...values),
    ...notices,
    env.DB.prepare(`INSERT INTO audit_events(id,actor_user_id,action,outcome,created_at)
      SELECT ?,?,'identity.channel_link','linked',? WHERE ${own}`).bind(crypto.randomUUID(), userId, now, ...values),
  ]);
  const linked = await env.DB.prepare(`SELECT b.id,b.provider,b.channel FROM bindings b JOIN channel_link_challenges p
    ON p.provider=b.provider AND p.business_id=b.business_id AND p.subject_id=b.subject_id
    JOIN users u ON u.id=b.user_id WHERE p.id=? AND p.user_id=? AND p.consumed_by=? AND b.user_id=p.user_id AND b.status='active' AND u.status='active' AND ${operational}`)
    .bind(id, userId, operation).first<{ id: string; provider: string; channel: Channel }>();
  if (!linked) {
    const candidate = await env.DB.prepare('SELECT * FROM channel_link_challenges WHERE id=? AND user_id=? AND session_hash=?')
      .bind(id, userId, proof.tokenHash).first<Challenge>();
    if (candidate?.provider && candidate.business_id && candidate.subject_id
      && await destinationOccupied(env, candidate.provider, candidate.business_id, candidate.provider_conversation_id, candidate.subject_id, userId)) {
      throw fail('channel_destination_in_use');
    }
    throw fail('channel_link_conflict');
  }
  return { linked: true as const, bindingId: linked.id, provider: linked.provider, channel: linked.channel };
}

export async function listChannelBindings(env: Env, userId: string) {
  await assertOperational(env);
  const rows = await env.DB.prepare(`SELECT b.id,b.provider,b.business_id,b.subject_id,b.channel,b.status,b.verified_at,b.reply_consent_at,b.proactive_consent_at,b.revoked_at
    FROM bindings b JOIN users u ON u.id=b.user_id WHERE b.user_id=? AND b.channel!='web' AND u.status='active' AND ${operational} ORDER BY b.id LIMIT 50`)
    .bind(userId).all<{ id: string; provider: string; business_id: string; subject_id: string; channel: Channel; status: string;
      verified_at: number | null; reply_consent_at: number | null; proactive_consent_at: number | null; revoked_at: number | null }>();
  return { bindings: rows.results.map((row) => ({ id: row.id, provider: row.provider, businessId: row.business_id,
    subjectHint: `…${row.subject_id.slice(-6)}`, channel: row.channel, status: row.status, verifiedAt: row.verified_at,
    replyConsentAt: row.reply_consent_at, proactiveConsentAt: row.proactive_consent_at, revokedAt: row.revoked_at })) };
}

export async function revokeChannelBinding(env: Env, request: Request, userId: string, id: string) {
  requireIdentityOrigin(env, request);
  await assertOperational(env);
  const proof = await requireRecentIdentitySession(env, request, userId);
  if (request.method !== 'DELETE' && request.method !== 'POST') throw fail('channel_request_invalid', 400);
  const row = await env.DB.prepare('SELECT conversation_id,revision,status,channel FROM bindings WHERE id=? AND user_id=?')
    .bind(id, userId).first<{ conversation_id: string | null; revision: number; status: string; channel: Channel }>();
  if (!row || row.channel === 'web') throw fail('channel_binding_unavailable', 404);
  if (row.status === 'revoked') {
    await env.DB.batch(onboardingRevocationStatements(env, { userId, bindingId: id, now: Date.now(),
      gate: "EXISTS(SELECT 1 FROM bindings WHERE id=? AND user_id=? AND status='revoked' AND revision=?)",
      gateBindings: [id, userId, row.revision] }));
    return { revoked: true as const };
  }
  const now = Date.now();
  const gate = "EXISTS (SELECT 1 FROM bindings WHERE id=? AND user_id=? AND status='revoked' AND revision=?)";
  const values = [id, userId, row.revision + 1];
  const statements = [env.DB.prepare(`UPDATE bindings SET status='revoked',revoked_at=?,revision=revision+1 WHERE id=? AND user_id=? AND revision=?
    AND EXISTS (SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.user_id=? AND s.expires_at>${dbNow}
      AND s.authenticated_at>=${dbNow}-300000 AND u.status='active') AND ${operational}`).bind(now, id, userId, row.revision, proof.tokenHash, userId)];
  statements.push(...onboardingRevocationStatements(env, { userId, bindingId: id, gate, gateBindings: values, now }));
  if (row.conversation_id) {
    statements.push(env.DB.prepare(`UPDATE conversations SET status='closed',ownership_version=ownership_version+1,lease_token=NULL,lease_until=0
      WHERE id=? AND user_id=? AND ${gate}`).bind(row.conversation_id, userId, ...values));
    statements.push(
      env.DB.prepare(`UPDATE inbox SET status='cancelled',completed_at=? WHERE conversation_id=? AND status IN ('pending','processing') AND ${gate}`)
        .bind(now, row.conversation_id, ...values),
      env.DB.prepare(`UPDATE messages SET status=CASE WHEN EXISTS (SELECT 1 FROM outbound_jobs o WHERE o.message_id=messages.id AND o.status='sending')
        THEN 'delivery_unknown' ELSE 'cancelled' END WHERE id IN (SELECT message_id FROM outbound_jobs WHERE conversation_id=?
          AND status IN ('queued','retryable_failed','sending')) AND ${gate}`).bind(row.conversation_id, ...values),
      env.DB.prepare(`UPDATE outbound_jobs SET status=CASE WHEN status='sending' THEN 'delivery_unknown' ELSE 'cancelled' END,
        error_code='channel_revoked',updated_at=? WHERE conversation_id=? AND status IN ('queued','retryable_failed','sending') AND ${gate}`)
        .bind(now, row.conversation_id, ...values),
    );
  }
  statements.push(env.DB.prepare(`INSERT INTO audit_events(id,actor_user_id,action,outcome,created_at)
    SELECT ?,?,'identity.channel_revoke','revoked',? WHERE ${gate}`).bind(crypto.randomUUID(), userId, now, ...values));
  await env.DB.batch(statements);
  if (!await env.DB.prepare(`SELECT 1 FROM bindings WHERE id=? AND user_id=? AND status='revoked'`).bind(id, userId).first()) throw fail('channel_session_changed');
  return { revoked: true as const };
}
