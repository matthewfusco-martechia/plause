import { z } from 'zod';
import type { Env, SendOutcome } from '../../../packages/contracts/src/index';
import { assertRuntimeProviders, publicOrigin } from '../../../packages/contracts/src/runtime-policy';
import { SunshineMessagingClient, sunshineReadiness, type SunshineEvent } from '../../../packages/messaging-sunshine/src/index';
import { decryptText, encryptText, sha256, stableIdentityKeyMaterial } from '../../../packages/security/src/index';
import { identityReadiness } from './identity';
import { maintenanceState, providerCircuitOpen } from './runtime-operations';
import { PipelineError } from './store';

type Values = (string | number | null)[];
type Gate = { gate: string; gateBindings: Values; now: number };
type Control = 'bot' | 'human' | 'unknown';
type Kind = 'welcome' | 'proof_received' | 'linked';
type Configuration = Env & { ONBOARDING_MESSAGES_ENABLED?: string; ONBOARDING_GLOBAL_DAILY_LIMIT?: string };
const DAY = 86_400_000, FRESH = 300_000, LEASE = 30_000;
const dbNow = "CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)";
const operational = "NOT EXISTS(SELECT 1 FROM system_settings WHERE key='restore_locked' AND value!='false')";
const unpaused = "NOT EXISTS(SELECT 1 FROM system_settings WHERE key IN ('restore_locked','outbound_paused') AND value!='false')";
const id = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const routingSchema = z.object({ businessId: id, subjectId: id, providerConversationId: id }).strict();
type Routing = z.infer<typeof routingSchema>;
interface Scope { businessId: string; subjectHash: string; destinationHash: string; contactKey: string; routing: string }
interface Notice {
  id: string; contact_key: string; kind: Kind; status: string; contact_revision: number; challenge_id: string | null;
  binding_id: string | null; binding_revision: number | null; user_id: string | null; provider_message_id: string | null;
  attempt_token: string | null; lease_until: number; next_attempt_at: number; expires_at: number; created_at: number;
  business_id: string; routing_ciphertext: string | null;
}

/** Configuration only. This does not verify approval, enrollment, credentials or delivery. */
export function onboardingReadiness(env: Env): { enabled: boolean; configured: boolean } {
  const enabled = (env as Configuration).ONBOARDING_MESSAGES_ENABLED === 'true';
  try {
    cap(env);
    assertRuntimeProviders(env);
    const origin = publicOrigin(env), provider = sunshineReadiness(env);
    return { enabled, configured: enabled && env.APP_ENV !== 'local' && origin.startsWith('https:')
      && env.MESSAGING_PROVIDER === 'sunshine' && env.LIVE_MESSAGING_ENABLED === 'true' && env.APPLE_CHANNEL_APPROVED === 'true'
      && provider.webhookConfigured && provider.transportConfigured && identityReadiness(env).configured && !!env.CONTENT_ENCRYPTION_KEY };
  } catch { return { enabled, configured: false }; }
}

function cap(env: Env): number {
  const value = (env as Configuration).ONBOARDING_GLOBAL_DAILY_LIMIT ?? '500';
  if (!/^[1-9][0-9]{0,3}$/.test(value) || Number(value) > 5000) throw new PipelineError('Onboarding configuration unavailable.', 503, 'onboarding_config_invalid');
  return Number(value);
}
async function digest(env: Env, value: unknown): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(stableIdentityKeyMaterial(env.CONTENT_ENCRYPTION_KEY)),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`plause.onboarding.v1\u0000${JSON.stringify(value)}`)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
async function scope(env: Env, route: Routing): Promise<Scope> {
  routingSchema.parse(route);
  const subjectHash = await digest(env, ['subject', route.businessId, route.subjectId]);
  const destinationHash = await digest(env, ['destination', route.businessId, route.providerConversationId]);
  return { businessId: route.businessId, subjectHash, destinationHash,
    contactKey: await sha256(`${subjectHash}:${destinationHash}`), routing: await encryptText(JSON.stringify(route), env.CONTENT_ENCRYPTION_KEY) };
}

export async function onboardingEventConflict(env: Env, businessId: string, eventId: string): Promise<boolean> {
  return !!await env.DB.prepare("SELECT 1 FROM messaging_onboarding_events WHERE provider='sunshine' AND business_id=? AND event_id=?")
    .bind(businessId, eventId).first();
}
const externalNamespace = `NOT EXISTS(SELECT 1 FROM webhook_events WHERE provider='sunshine' AND business_id=? AND event_id=?)
  AND NOT EXISTS(SELECT 1 FROM provider_lifecycle_events WHERE provider='sunshine' AND business_id=? AND event_id=?)
  AND NOT EXISTS(SELECT 1 FROM channel_link_challenges WHERE provider='sunshine' AND business_id=? AND provider_event_id=?)`;
const namespaceValues = (businessId: string, eventId: string) => [businessId, eventId, businessId, eventId, businessId, eventId];

function cancel(env: Env, condition: string, values: Values, now: number, error: string): D1PreparedStatement {
  return env.DB.prepare(`UPDATE messaging_onboarding_notices SET status=CASE WHEN status='sending' THEN 'delivery_unknown' ELSE 'cancelled' END,
    error_code=?,updated_at=? WHERE status IN ('pending','sending') AND ${condition}`).bind(error, now, ...values);
}
function contactStatements(env: Env, s: Scope, at: number, control: Control, gate: Gate, increment: boolean): D1PreparedStatement[] {
  return [
    env.DB.prepare(`INSERT INTO messaging_onboarding_subjects(business_id,subject_hash,status,provider_event_at)
      SELECT ?,?,'active',? WHERE ${gate.gate} ON CONFLICT(business_id,subject_hash) DO UPDATE SET
      status=CASE WHEN ${increment ? '1' : "messaging_onboarding_subjects.status!='revoked'"} AND excluded.provider_event_at>messaging_onboarding_subjects.provider_event_at THEN 'active' ELSE messaging_onboarding_subjects.status END,
      provider_event_at=MAX(provider_event_at,excluded.provider_event_at)`)
      .bind(s.businessId, s.subjectHash, at, ...gate.gateBindings),
    env.DB.prepare(`INSERT INTO messaging_onboarding_contacts(contact_key,business_id,subject_hash,destination_hash,routing_ciphertext,
      control,status,provider_event_at,last_inbound_at,revision,created_at,updated_at,user_id,binding_id)
      SELECT ?,?,?,?, ?,?,'active',?,?,0,?,?,
      (SELECT user_id FROM messaging_onboarding_subjects WHERE business_id=? AND subject_hash=?),
      (SELECT binding_id FROM messaging_onboarding_subjects WHERE business_id=? AND subject_hash=?)
      WHERE ${gate.gate} AND EXISTS(SELECT 1 FROM messaging_onboarding_subjects WHERE business_id=? AND subject_hash=? AND status='active')
      ON CONFLICT(contact_key) DO UPDATE SET routing_ciphertext=${increment ? 'excluded.routing_ciphertext' : 'COALESCE(routing_ciphertext,excluded.routing_ciphertext)'},
      control=CASE WHEN excluded.provider_event_at>provider_event_at OR excluded.provider_event_at=provider_event_at AND excluded.control!='bot'
        THEN excluded.control ELSE control END,
      status=CASE WHEN excluded.provider_event_at>provider_event_at THEN 'active' ELSE status END,
      provider_event_at=MAX(provider_event_at,excluded.provider_event_at),last_inbound_at=MAX(last_inbound_at,excluded.last_inbound_at),
      revision=revision+${increment ? '1' : "CASE WHEN status!='active' AND excluded.provider_event_at>provider_event_at THEN 1 ELSE 0 END"},
      user_id=COALESCE(user_id,excluded.user_id),binding_id=COALESCE(binding_id,excluded.binding_id),updated_at=excluded.updated_at`)
      .bind(s.contactKey, s.businessId, s.subjectHash, s.destinationHash, s.routing, control, at, gate.now, gate.now, gate.now,
        s.businessId,s.subjectHash,s.businessId,s.subjectHash,...gate.gateBindings,s.businessId,s.subjectHash),
  ];
}
function noticeStatement(env: Env, s: Scope, kind: Kind, dedupeKey: string, gate: Gate,
  options: { challengeId?: string; bindingId?: string; bindingRevision?: number; userId?: string } = {}): D1PreparedStatement {
  return env.DB.prepare(`INSERT INTO messaging_onboarding_notices(id,dedupe_key,contact_key,kind,status,contact_revision,
    challenge_id,binding_id,binding_revision,user_id,next_attempt_at,expires_at,created_at,updated_at)
    SELECT ?,?,c.contact_key,?,'pending',c.revision,?,?,?,COALESCE(?,c.user_id),?,?,?,? FROM messaging_onboarding_contacts c
    JOIN messaging_onboarding_subjects s ON s.business_id=c.business_id AND s.subject_hash=c.subject_hash
    WHERE c.contact_key=? AND c.status='active' AND s.status='active' AND c.control='bot' AND c.routing_ciphertext IS NOT NULL
      AND c.last_inbound_at>=?-300000 AND ${gate.gate} ON CONFLICT(dedupe_key) DO NOTHING`)
    .bind(`onb_${crypto.randomUUID()}`, dedupeKey, kind, options.challengeId ?? null, options.bindingId ?? null,
      options.bindingRevision ?? null, options.userId ?? null, gate.now, gate.now + FRESH, gate.now, gate.now,
      s.contactKey, gate.now, ...gate.gateBindings);
}

/** Call only with an authenticated, normalized provider event. No raw input is retained. */
export async function recordOnboardingContact(env: Env, event: SunshineEvent): Promise<{ handled: boolean; recorded: boolean; duplicate: boolean }> {
  if (!onboardingReadiness(env).configured || event.businessId !== env.SUNSHINE_APP_ID) return { handled: false, recorded: false, duplicate: false };
  const now = Date.now(), at = Date.parse(event.occurredAt);
  if (!Number.isFinite(at)) throw new PipelineError('Provider event invalid.', 400, 'onboarding_event_invalid');
  if (event.type === 'message.received' && /^link[ \t]+plause\b/i.test(event.text.trim())) return { handled: false, recorded: false, duplicate: false };
  const subjectId = 'subject' in event ? event.subject.subjectId : null;
  const destination = event.providerConversationId ?? null;
  const fingerprint = await digest(env, event);
  const prior = await env.DB.prepare("SELECT payload_hash FROM messaging_onboarding_events WHERE provider='sunshine' AND business_id=? AND event_id=?")
    .bind(event.businessId, event.eventId).first<{ payload_hash: string }>();
  if (prior) {
    if (prior.payload_hash !== fingerprint) throw new PipelineError('Provider event conflict.', 409, 'provider_event_conflict');
    return { handled: true, recorded: true, duplicate: true };
  }
  const existing = await env.DB.prepare(`SELECT 1 FROM bindings b JOIN users u ON u.id=b.user_id WHERE b.provider='sunshine'
    AND b.business_id=? AND b.channel='apple_business' AND b.status='active' AND u.status='active'
    AND (? IS NULL OR b.subject_id=?) AND (? IS NULL OR b.provider_conversation_id=?)`)
    .bind(event.businessId, subjectId, subjectId, destination, destination).first();
  if (existing) return { handled: false, recorded: false, duplicate: false };
  const token = crypto.randomUUID();
  const s = subjectId && destination ? await scope(env, { businessId: event.businessId, subjectId, providerConversationId: destination }) : null;
  const gate: Gate = { gate: `EXISTS(SELECT 1 FROM messaging_onboarding_events WHERE provider='sunshine' AND business_id=? AND event_id=? AND mutation_token=?)`,
    gateBindings: [event.businessId, event.eventId, token], now };
  const statements = [env.DB.prepare(`INSERT INTO messaging_onboarding_events(provider,business_id,event_id,contact_key,payload_hash,provider_message_id,delivery_state,kind,occurred_at,received_at,mutation_token)
    SELECT 'sunshine',?,?,?,?,?,?,?,?,?,? WHERE ${externalNamespace} AND ${operational}
    AND NOT EXISTS(SELECT 1 FROM bindings b JOIN users u ON u.id=b.user_id WHERE b.provider='sunshine' AND b.business_id=?
      AND b.status='active' AND u.status='active' AND (? IS NULL OR b.subject_id=?) AND (? IS NULL OR b.provider_conversation_id=?))
    ON CONFLICT(provider,business_id,event_id) DO NOTHING`)
    .bind(event.businessId, event.eventId, s?.contactKey ?? null, fingerprint,
      event.type === 'delivery.updated' ? event.messageId : null,event.type === 'delivery.updated' ? event.state : null,
      event.type === 'message.received' ? 'ordinary' : 'lifecycle', at, now, token,
      ...namespaceValues(event.businessId, event.eventId), event.businessId, subjectId, subjectId, destination, destination)];
  if (event.type === 'message.received' && s && Math.abs(now - at) <= FRESH) {
    // Known/revoked subjects must explicitly prove a fresh link; no account hints.
      const welcomeGate: Gate = { ...gate, gate: `${gate.gate} AND c.user_id IS NULL AND NOT EXISTS(SELECT 1 FROM bindings WHERE provider='sunshine' AND business_id=? AND subject_id=?)`,
      gateBindings: [...gate.gateBindings, event.businessId, event.subject.subjectId] };
    const publicGate: Gate = { ...gate, gate: `${gate.gate} AND NOT EXISTS(SELECT 1 FROM bindings WHERE provider='sunshine' AND business_id=? AND subject_id=?)`,
      gateBindings: [...gate.gateBindings,event.businessId,event.subject.subjectId] };
    statements.push(...contactStatements(env, s, at, event.control, publicGate, false));
    statements.push(cancel(env, `contact_key=? AND EXISTS(SELECT 1 FROM messaging_onboarding_contacts c
      WHERE c.contact_key=? AND c.control!='bot') AND ${gate.gate}`, [s.contactKey,s.contactKey,...gate.gateBindings],now,'provider_control_changed'));
    statements.push(noticeStatement(env, s, 'welcome', `welcome:${s.subjectHash}:${Math.floor(now / DAY)}`, welcomeGate));
  } else if (event.type === 'delivery.updated') {
    statements.push(...receiptStatements(env, event, gate));
  } else if (event.type !== 'message.received') statements.push(...await onboardingLifecycleStatements(env, event, gate));
  await env.DB.batch(statements);
  const saved = await env.DB.prepare("SELECT payload_hash FROM messaging_onboarding_events WHERE provider='sunshine' AND business_id=? AND event_id=?")
    .bind(event.businessId, event.eventId).first<{ payload_hash: string }>();
  if (saved && saved.payload_hash !== fingerprint) throw new PipelineError('Provider event conflict.', 409, 'provider_event_conflict');
  if (!saved) {
    if (await env.DB.prepare(`SELECT 1 WHERE NOT (${externalNamespace})`).bind(...namespaceValues(event.businessId, event.eventId)).first()) {
      throw new PipelineError('Provider event conflict.', 409, 'provider_event_conflict');
    }
    return { handled: false, recorded: false, duplicate: false };
  }
  return { handled: true, recorded: true, duplicate: false };
}

export async function onboardingProofStatements(env: Env, input: {
  challengeId: string; provider: string; businessId: string; subjectId: string; providerConversationId?: string;
  providerEventId: string; providerOccurredAt: number; control?: Control;
}): Promise<D1PreparedStatement[]> {
  if (!onboardingReadiness(env).configured || input.provider !== 'sunshine' || input.businessId !== env.SUNSHINE_APP_ID || !input.providerConversationId) return [];
  const now = Date.now();
  if (!Number.isSafeInteger(input.providerOccurredAt) || Math.abs(now - input.providerOccurredAt) > FRESH) return [];
  const s = await scope(env, { businessId: input.businessId, subjectId: input.subjectId, providerConversationId: input.providerConversationId });
  const token = crypto.randomUUID();
  const proofGate = `EXISTS(SELECT 1 FROM channel_link_challenges WHERE id=? AND status='proved' AND provider='sunshine'
    AND business_id=? AND subject_id=? AND provider_conversation_id=? AND provider_event_id=? AND provider_proved_at=?
    AND provider_control=? AND expires_at>${dbNow})`;
  const proofValues: Values = [input.challengeId, input.businessId, input.subjectId, input.providerConversationId, input.providerEventId,
    input.providerOccurredAt,input.control ?? 'unknown'];
  const gate: Gate = { gate: `EXISTS(SELECT 1 FROM messaging_onboarding_events WHERE provider='sunshine' AND business_id=? AND event_id=? AND mutation_token=?)`,
    gateBindings: [input.businessId, input.providerEventId, token], now };
  return [env.DB.prepare(`INSERT INTO messaging_onboarding_events(provider,business_id,event_id,contact_key,payload_hash,kind,occurred_at,received_at,mutation_token)
    SELECT 'sunshine',?,?,?,?,'link_proof',?,?,? WHERE ${proofGate}
    AND NOT EXISTS(SELECT 1 FROM webhook_events WHERE provider='sunshine' AND business_id=? AND event_id=?)
    AND NOT EXISTS(SELECT 1 FROM provider_lifecycle_events WHERE provider='sunshine' AND business_id=? AND event_id=?)
    AND ${operational} ON CONFLICT(provider,business_id,event_id) DO NOTHING`)
    .bind(input.businessId, input.providerEventId, s.contactKey, await digest(env, ['link_proof', input.challengeId, input.businessId, input.subjectId,
      input.providerConversationId, input.providerEventId, input.providerOccurredAt,input.control ?? 'unknown']), input.providerOccurredAt, now, token,
      ...proofValues, input.businessId, input.providerEventId, input.businessId, input.providerEventId),
    ...contactStatements(env, s, input.providerOccurredAt, input.control ?? 'unknown', gate, true),
    env.DB.prepare(`UPDATE messaging_onboarding_subjects SET user_id=COALESCE(user_id,(SELECT user_id FROM channel_link_challenges WHERE id=?))
      WHERE business_id=? AND subject_hash=? AND ${gate.gate}`).bind(input.challengeId,s.businessId,s.subjectHash,...gate.gateBindings),
    env.DB.prepare(`UPDATE messaging_onboarding_contacts SET user_id=COALESCE(user_id,(SELECT user_id FROM channel_link_challenges WHERE id=?))
      WHERE business_id=? AND subject_hash=? AND ${gate.gate}`).bind(input.challengeId,s.businessId,s.subjectHash,...gate.gateBindings),
    cancel(env, `contact_key=? AND ${gate.gate}`, [s.contactKey, ...gate.gateBindings], now, 'proof_received'),
    env.DB.prepare(`INSERT INTO messaging_onboarding_notices(id,dedupe_key,contact_key,kind,status,contact_revision,challenge_id,user_id,
      next_attempt_at,expires_at,created_at,updated_at) SELECT ?,?,c.contact_key,'proof_received','pending',c.revision,p.id,p.user_id,?,?,?,?
      FROM messaging_onboarding_contacts c JOIN channel_link_challenges p ON p.id=? WHERE c.contact_key=? AND c.status='active'
      AND c.control='bot' AND c.routing_ciphertext IS NOT NULL AND ${gate.gate} ON CONFLICT(dedupe_key) DO NOTHING`)
      .bind(`onb_${crypto.randomUUID()}`,`proof:${input.challengeId}`,now,now+FRESH,now,now,input.challengeId,s.contactKey,...gate.gateBindings),
  ];
}

export async function onboardingLinkedStatements(env: Env, input: { challengeId: string; userId: string; operationToken: string; now: number }): Promise<D1PreparedStatement[]> {
  if (!onboardingReadiness(env).configured) return [];
  const challenge = await env.DB.prepare('SELECT provider,business_id,subject_id,provider_conversation_id FROM channel_link_challenges WHERE id=? AND user_id=?')
    .bind(input.challengeId, input.userId).first<{ provider: string; business_id: string; subject_id: string; provider_conversation_id: string }>();
  if (challenge?.provider !== 'sunshine' || challenge.business_id !== env.SUNSHINE_APP_ID || !challenge.provider_conversation_id) return [];
  const s = await scope(env, { businessId: challenge.business_id, subjectId: challenge.subject_id, providerConversationId: challenge.provider_conversation_id });
  const gate: Gate = { gate: `EXISTS(SELECT 1 FROM channel_link_challenges p JOIN bindings b ON b.provider=p.provider AND b.business_id=p.business_id
    AND b.subject_id=p.subject_id JOIN users u ON u.id=b.user_id WHERE p.id=? AND p.user_id=? AND p.status='consumed' AND p.consumed_by=?
    AND b.user_id=p.user_id AND b.status='active' AND b.provider_conversation_id=p.provider_conversation_id AND b.reply_consent_at IS NOT NULL
    AND u.status='active' AND ${operational})`, gateBindings: [input.challengeId, input.userId, input.operationToken], now: input.now };
  return [
    env.DB.prepare(`UPDATE messaging_onboarding_contacts SET user_id=?,binding_id=(SELECT id FROM bindings WHERE provider='sunshine'
      AND business_id=? AND subject_id=? AND user_id=?),revision=revision+1,updated_at=? WHERE business_id=? AND subject_hash=? AND ${gate.gate}`)
      .bind(input.userId, s.businessId, challenge.subject_id, input.userId, input.now, s.businessId, s.subjectHash, ...gate.gateBindings),
    env.DB.prepare(`UPDATE messaging_onboarding_subjects SET user_id=?,binding_id=(SELECT id FROM bindings WHERE provider='sunshine'
      AND business_id=? AND subject_id=? AND user_id=?) WHERE business_id=? AND subject_hash=? AND ${gate.gate}`)
      .bind(input.userId, s.businessId, challenge.subject_id, input.userId, s.businessId, s.subjectHash, ...gate.gateBindings),
    cancel(env, `contact_key IN(SELECT contact_key FROM messaging_onboarding_contacts WHERE business_id=? AND subject_hash=?) AND ${gate.gate}`,
      [s.businessId, s.subjectHash, ...gate.gateBindings], input.now, 'linked'),
    env.DB.prepare(`INSERT INTO messaging_onboarding_notices(id,dedupe_key,contact_key,kind,status,contact_revision,challenge_id,binding_id,binding_revision,
      user_id,next_attempt_at,expires_at,created_at,updated_at) SELECT ?,?,c.contact_key,'linked','pending',c.revision,?,b.id,b.revision,b.user_id,?,?,?,?
      FROM messaging_onboarding_contacts c JOIN bindings b ON b.id=c.binding_id JOIN messaging_onboarding_subjects s
      ON s.business_id=c.business_id AND s.subject_hash=c.subject_hash WHERE c.contact_key=? AND c.status='active' AND s.status='active'
      AND c.control='bot' AND c.routing_ciphertext IS NOT NULL AND c.last_inbound_at>=?-300000 AND ${gate.gate} ON CONFLICT(dedupe_key) DO NOTHING`)
      .bind(`onb_${crypto.randomUUID()}`, `linked:${input.challengeId}`, input.challengeId, input.now, input.now + FRESH, input.now, input.now,
        s.contactKey, input.now, ...gate.gateBindings),
  ];
}

/** Synchronous builder so disabling an account and suppressing public notices commit together. */
export function onboardingRevocationStatements(env: Env, input: { userId: string; bindingId?: string; gate: string; gateBindings: Values; now: number }): D1PreparedStatement[] {
  const condition = (alias = '') => { const prefix = alias ? `${alias}.` : '';
    return `(${prefix}user_id=?${input.bindingId ? ` AND ${prefix}binding_id=?` : ''} OR ${prefix}binding_id IS NULL AND ${prefix}contact_key IN(SELECT nn.contact_key FROM messaging_onboarding_notices nn WHERE nn.user_id=?${input.bindingId ? ' AND nn.binding_id=?' : ''}))`; };
  const subject = condition();
  const values: Values = [input.userId, ...(input.bindingId ? [input.bindingId] : [])];
  const contactValues = [...values,...values];
  return [
    cancel(env, `(user_id=?${input.bindingId ? ' AND binding_id=?' : ''} OR contact_key IN(SELECT contact_key FROM messaging_onboarding_contacts WHERE ${subject})) AND ${input.gate}`,
      [...values,...contactValues, ...input.gateBindings], input.now, 'account_or_binding_revoked'),
    env.DB.prepare(`UPDATE messaging_onboarding_subjects SET status='revoked' WHERE (user_id=?${input.bindingId ? ' AND binding_id=?' : ''}
      OR EXISTS(SELECT 1 FROM messaging_onboarding_contacts c WHERE c.business_id=messaging_onboarding_subjects.business_id
        AND c.subject_hash=messaging_onboarding_subjects.subject_hash AND ${condition('c')})) AND ${input.gate}`)
      .bind(...values,...contactValues,...input.gateBindings),
    env.DB.prepare(`UPDATE messaging_onboarding_contacts SET routing_ciphertext=NULL,status='revoked',revision=revision+1,updated_at=?
      WHERE ${subject} AND ${input.gate}`).bind(input.now, ...contactValues, ...input.gateBindings),
  ];
}

export async function onboardingLifecycleStatements(env: Env, event: SunshineEvent, gate: Gate): Promise<D1PreparedStatement[]> {
  if (event.businessId !== env.SUNSHINE_APP_ID) return [];
  if (event.type === 'delivery.updated') return receiptStatements(env, event, gate);
  if (event.type === 'message.received' || event.type === 'client.active') return [];
  const at = Date.parse(event.occurredAt);
  if (!Number.isFinite(at)) return [];
  const subjectHash = 'subject' in event ? await digest(env, ['subject', event.businessId, event.subject.subjectId]) : null;
  const destinationHash = event.providerConversationId ? await digest(env, ['destination', event.businessId, event.providerConversationId]) : null;
  const target = `business_id=? AND (? IS NULL OR subject_hash=?) AND (? IS NULL OR destination_hash=?)`;
  const values: Values = [event.businessId, subjectHash, subjectHash, destinationHash, destinationHash];
  const state = event.type === 'subject.revoked' ? 'revoked' : 'closed';
  const statements: D1PreparedStatement[] = [];
  if (subjectHash && event.type !== 'handoff.changed') statements.push(env.DB.prepare(`INSERT INTO messaging_onboarding_subjects(business_id,subject_hash,status,provider_event_at)
    SELECT ?,?,?,? WHERE ${gate.gate} ON CONFLICT(business_id,subject_hash) DO UPDATE SET status=excluded.status,
    provider_event_at=MAX(provider_event_at,excluded.provider_event_at) WHERE excluded.status='revoked' OR excluded.provider_event_at>=provider_event_at`)
    .bind(event.businessId, subjectHash, state, at, ...gate.gateBindings));
  statements.push(env.DB.prepare(`UPDATE messaging_onboarding_contacts SET ${event.type === 'handoff.changed' ? 'control=?' : 'status=?'},
    provider_event_at=MAX(provider_event_at,?),revision=revision+1,updated_at=?${event.type === 'subject.revoked' ? ',routing_ciphertext=NULL' : ''}
    WHERE ${target} AND (?='subject.revoked' OR provider_event_at<=?) AND ${gate.gate}`)
    .bind(event.type === 'handoff.changed' ? event.control : state, at, gate.now, ...values, event.type, at, ...gate.gateBindings));
  // A bot takeover may allow future explicit notices, but never resurrect cancelled work.
  if (event.type !== 'handoff.changed' || event.control !== 'bot') statements.push(cancel(env,
    `contact_key IN(SELECT contact_key FROM messaging_onboarding_contacts WHERE ${target} AND (status!='active' OR control!='bot')) AND ${gate.gate}`,
    [...values, ...gate.gateBindings], gate.now, 'provider_lifecycle_changed'));
  return statements;
}

function receiptStatements(env: Env, event: Extract<SunshineEvent, { type: 'delivery.updated' }>, gate: Gate): D1PreparedStatement[] {
  return [env.DB.prepare(`UPDATE messaging_onboarding_notices SET status=CASE WHEN status='delivered' THEN status
    WHEN ?='delivered' THEN 'delivered' WHEN status='failed' THEN status ELSE ? END,updated_at=?
    WHERE provider_message_id=? AND contact_key IN(SELECT contact_key FROM messaging_onboarding_contacts WHERE business_id=?) AND ${gate.gate}`)
    .bind(event.state, event.state, gate.now, event.messageId, event.businessId, ...gate.gateBindings)];
}

function template(env: Env, kind: Kind): string {
  const url = `${publicOrigin(env)}/?onboarding=messages`;
  if (kind === 'welcome') return `Hi, I’m Plause, an AI assistant. To use your account and personal tools in Messages, sign in and link this conversation at ${url}\nLinking requires your permission and a separate confirmation. ${identityReadiness(env).signupEnabled ? 'Approved participants can create an account there.' : 'Sign-in is available to existing approved accounts; new signup is currently closed.'} For human help, use the support contact on that page. Your message has not been sent to an AI model.`;
  if (kind === 'proof_received') return `Message proof received. Return to the signed-in Plause page, review this exact channel and confirm the link. This conversation is not linked yet. ${url}`;
  return `This Messages conversation is linked to your Plause account. I’m an AI assistant. You can now send your request here. Saved facts and connected tools use the permissions you choose; actions that change things require their stated approval. Manage or revoke access at ${url}`;
}

// Every send revalidates this immediately before HTTP through the adapter callback.
const eligible = `c.contact_key=n.contact_key AND c.revision=n.contact_revision AND c.status='active' AND c.control='bot'
  AND c.routing_ciphertext IS NOT NULL AND c.last_inbound_at>=${dbNow}-300000 AND n.expires_at>${dbNow}
  AND EXISTS(SELECT 1 FROM messaging_onboarding_subjects s WHERE s.business_id=c.business_id AND s.subject_hash=c.subject_hash AND s.status='active')
  AND (c.user_id IS NULL OR EXISTS(SELECT 1 FROM users u WHERE u.id=c.user_id AND u.status='active'))
  AND (n.kind!='welcome' OR NOT EXISTS(SELECT 1 FROM bindings b WHERE b.provider='sunshine' AND b.business_id=c.business_id AND b.status='active'
    AND b.id=c.binding_id))
  AND (n.kind!='proof_received' OR EXISTS(SELECT 1 FROM channel_link_challenges p JOIN users u ON u.id=p.user_id JOIN sessions ss ON ss.token_hash=p.session_hash
    WHERE p.id=n.challenge_id AND p.status='proved' AND p.expires_at>${dbNow} AND u.status='active' AND ss.expires_at>${dbNow}))
  AND (n.kind!='linked' OR EXISTS(SELECT 1 FROM bindings b JOIN users u ON u.id=b.user_id WHERE b.id=n.binding_id AND b.revision=n.binding_revision
    AND b.status='active' AND b.reply_consent_at IS NOT NULL AND b.user_id=n.user_id AND u.status='active'
    AND (b.conversation_id IS NULL OR EXISTS(SELECT 1 FROM conversations cc WHERE cc.id=b.conversation_id AND cc.user_id=b.user_id
      AND cc.status='active' AND cc.mode='bot' AND cc.provider_control='bot')))) AND ${unpaused}`;

/** Durable public notices have one POST attempt; uncertain sends are GET-only thereafter. */
export async function processOnboarding(env: Env, options: { limit?: number; fetchImpl?: typeof fetch; beforeDispatch?: () => Promise<void> } = {}): Promise<number> {
  if (!onboardingReadiness(env).configured) return 0;
  const limits = cap(env), limit = options.limit ?? 5;
  if (!Number.isInteger(limit) || limit < 1 || limit > 25) throw new PipelineError('Onboarding limit invalid.', 400, 'onboarding_limit_invalid');
  const maintenance = await maintenanceState(env);
  if (maintenance.locked || maintenance.outboundPaused || await providerCircuitOpen(env, 'messaging')) return 0;
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("UPDATE messaging_onboarding_notices SET status='delivery_unknown',error_code='interrupted_dispatch',updated_at=? WHERE status='sending' AND lease_until<=?").bind(now, now),
    env.DB.prepare("UPDATE messaging_onboarding_notices SET status='cancelled',error_code='notice_expired',updated_at=? WHERE status='pending' AND expires_at<=?").bind(now, now),
    env.DB.prepare(`UPDATE messaging_onboarding_contacts SET routing_ciphertext=NULL WHERE updated_at<?
      AND NOT EXISTS(SELECT 1 FROM messaging_onboarding_notices n WHERE n.contact_key=messaging_onboarding_contacts.contact_key AND n.status IN ('pending','sending'))`).bind(now - DAY),
  ]);
  const rows = await env.DB.prepare(`SELECT n.*,c.business_id,c.routing_ciphertext FROM messaging_onboarding_notices n
    JOIN messaging_onboarding_contacts c ON c.contact_key=n.contact_key WHERE c.routing_ciphertext IS NOT NULL AND n.next_attempt_at<=?
    AND (n.status='delivery_unknown' OR n.status='pending' AND ${eligible}
      AND (SELECT COUNT(*) FROM messaging_onboarding_notices WHERE dispatched_at>=?)<?)
    ORDER BY CASE WHEN n.status='pending' THEN 0 ELSE 1 END,n.created_at,n.rowid LIMIT ?`)
    .bind(now,Math.floor(now/DAY)*DAY,limits,limit).all<Notice>();
  let attempted = 0;
  for (const notice of rows.results) {
    if (notice.business_id !== env.SUNSHINE_APP_ID || !notice.routing_ciphertext) continue;
    let route: Routing;
    try { route = routingSchema.parse(JSON.parse(await decryptText(notice.routing_ciphertext, env.CONTENT_ENCRYPTION_KEY))); }
    catch { continue; }
    const s = await scope(env, route);
    if (s.contactKey !== notice.contact_key || route.businessId !== env.SUNSHINE_APP_ID) continue;
    const request = { conversationId: route.providerConversationId, idempotencyKey: `onboarding:${notice.id}`, content: { type: 'text' as const, text: template(env, notice.kind) } };
    if (notice.status === 'delivery_unknown') {
      // Reconciliation cannot restore routing after revocation; no POST is attempted.
      const stillPrivate = async () => {
        if (!await env.DB.prepare(`SELECT 1 FROM messaging_onboarding_contacts c JOIN messaging_onboarding_notices n ON n.contact_key=c.contact_key
          WHERE n.id=? AND n.status='delivery_unknown' AND c.routing_ciphertext=? AND c.status='active' AND ${unpaused}
          AND (c.user_id IS NULL OR EXISTS(SELECT 1 FROM users WHERE id=c.user_id AND status='active'))`)
          .bind(notice.id, notice.routing_ciphertext).first()) throw new Error('onboarding_read_blocked');
      };
      const client = new SunshineMessagingClient(env, { ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}), beforeRead: stillPrivate });
      const result = await client.reconcile({ ...request, ...(notice.provider_message_id ? { providerMessageId: notice.provider_message_id } : {}) });
      if (result) await recordOutcome(env, notice.id, notice.attempt_token, result, notice.routing_ciphertext);
      await env.DB.prepare("UPDATE messaging_onboarding_notices SET next_attempt_at=? WHERE id=? AND status='delivery_unknown'")
        .bind(Date.now() + 60_000, notice.id).run();
      continue;
    }
    const token = crypto.randomUUID(), day = Math.floor(Date.now() / DAY) * DAY;
    const claimed = await env.DB.prepare(`UPDATE messaging_onboarding_notices AS n SET status='sending',attempt_token=?,lease_until=?,dispatched_at=?,updated_at=?
      WHERE n.id=? AND n.status='pending' AND EXISTS(SELECT 1 FROM messaging_onboarding_contacts c WHERE ${eligible})
      AND NOT EXISTS(SELECT 1 FROM messaging_onboarding_notices other WHERE other.contact_key=n.contact_key AND other.id!=n.id AND other.status='sending' AND other.lease_until>${dbNow})
      AND (SELECT COUNT(*) FROM messaging_onboarding_notices WHERE dispatched_at>=?)<?`)
      .bind(token, Date.now() + LEASE, Date.now(), Date.now(), notice.id, day, limits).run();
    if (claimed.meta.changes !== 1) continue;
    attempted++;
    await options.beforeDispatch?.();
    const beforeSend = async () => {
      if (!onboardingReadiness(env).configured || await providerCircuitOpen(env, 'messaging')) throw new Error('onboarding_dispatch_blocked');
      if (!await env.DB.prepare(`SELECT 1 FROM messaging_onboarding_notices n JOIN messaging_onboarding_contacts c ON c.contact_key=n.contact_key
        WHERE n.id=? AND n.status='sending' AND n.attempt_token=? AND n.lease_until>${dbNow} AND c.routing_ciphertext=? AND ${eligible}`)
        .bind(notice.id, token, notice.routing_ciphertext).first()) throw new Error('onboarding_dispatch_blocked');
    };
    const client = new SunshineMessagingClient(env, { ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}), beforeSend });
    const outcome = await client.send(request);
    await recordOutcome(env, notice.id, token, outcome, notice.routing_ciphertext);
  }
  return attempted;
}

async function recordOutcome(env: Env, noticeId: string, token: string | null, outcome: SendOutcome, routing: string): Promise<void> {
  const state = outcome.state === 'retryable_failed' ? 'failed' : outcome.state;
  const gate = `id=? AND attempt_token IS ? AND status IN ('sending','delivery_unknown','sent','delivered')
    AND EXISTS(SELECT 1 FROM messaging_onboarding_contacts c WHERE c.contact_key=messaging_onboarding_notices.contact_key AND c.routing_ciphertext=?)`;
  const values: Values = [noticeId,token,routing];
  await env.DB.batch([
    env.DB.prepare(`UPDATE messaging_onboarding_notices SET status=CASE WHEN status IN ('delivered','failed') THEN status ELSE ? END,
      provider_message_id=COALESCE(?,provider_message_id),error_code=?,updated_at=?,next_attempt_at=? WHERE ${gate}`)
      .bind(state, 'providerMessageId' in outcome ? outcome.providerMessageId : null, 'code' in outcome ? outcome.code : null,
        Date.now(), Date.now() + 60_000,...values),
    env.DB.prepare(`UPDATE messaging_onboarding_notices SET status=CASE WHEN status='delivered' OR EXISTS(SELECT 1 FROM messaging_onboarding_events e
      WHERE e.contact_key=messaging_onboarding_notices.contact_key AND e.provider_message_id=messaging_onboarding_notices.provider_message_id
        AND e.delivery_state='delivered') OR EXISTS(SELECT 1 FROM webhook_events e JOIN bindings b
        ON b.provider=e.provider AND b.business_id=e.business_id AND b.subject_id=e.subject_id JOIN messaging_onboarding_contacts c ON c.binding_id=b.id
        WHERE c.contact_key=messaging_onboarding_notices.contact_key AND e.provider_message_id=messaging_onboarding_notices.provider_message_id
        AND e.delivery_state='delivered') THEN 'delivered' WHEN EXISTS(SELECT 1 FROM messaging_onboarding_events e
      WHERE e.contact_key=messaging_onboarding_notices.contact_key AND e.provider_message_id=messaging_onboarding_notices.provider_message_id
        AND e.delivery_state='failed') OR EXISTS(SELECT 1 FROM webhook_events e JOIN bindings b
        ON b.provider=e.provider AND b.business_id=e.business_id AND b.subject_id=e.subject_id JOIN messaging_onboarding_contacts c ON c.binding_id=b.id
        WHERE c.contact_key=messaging_onboarding_notices.contact_key AND e.provider_message_id=messaging_onboarding_notices.provider_message_id
        AND e.delivery_state='failed') THEN 'failed' ELSE status END WHERE ${gate}`).bind(...values),
  ]);
}
