import type { Env } from '../../../packages/contracts/src/index';
import { decryptText, encryptText, sha256 } from '../../../packages/security/src/index';
import type { SessionProof } from './auth';

const DB_NOW = "CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)";
const CLAIM_MS = 5 * 60_000;
type Gate = { sql: string; values: (string | number)[] };
export type OperatorRole = 'admin' | 'support';
export interface OperatorActor { userId: string; role: OperatorRole; grantRevision: number; proof: SessionProof }
export interface SupportClaim { conversationId: string; operatorUserId: string; grantRevision: number; claimVersion: number; expiresAt: number }
interface ClaimRow { conversation_id: string; operator_user_id: string | null; grant_revision: number; claim_version: number; expires_at: number }
interface SupportInboxRow {
  conversationId: string; channel: string; lastActivityAt: number; providerControl: string; replyAvailable: number;
  customerDisplayName: string; operatorUserId: string | null; claimVersion: number | null; expiresAt: number | null; customerMessageCount: number;
}
class SupportError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
function fail(status: number, code: string): never { throw new SupportError(status, code); }
function statement(env: Env, sql: string, values: (string | number)[], gate: Gate) {
  return env.DB.prepare(`${sql} AND (${gate.sql})`).bind(...values, ...gate.values);
}
function sessionGate(env: Env, proof: SessionProof): Gate {
  return { sql: `EXISTS (SELECT 1 FROM sessions os JOIN users ou ON ou.id=os.user_id
    LEFT JOIN external_identities oi ON oi.id=os.identity_id AND oi.user_id=ou.id
    WHERE os.token_hash=? AND os.user_id=? AND ou.status='active' AND os.expires_at>${DB_NOW}
    AND NOT EXISTS (SELECT 1 FROM system_settings WHERE key='restore_locked' AND value!='false')
    AND os.authenticated_at BETWEEN ${DB_NOW}-300000 AND ${DB_NOW}+30000
    AND ((os.auth_method='development_invitation' AND ?='local') OR
      (os.auth_method='google' AND oi.issuer='https://accounts.google.com')))`,
    values: [proof.tokenHash, proof.user.id, env.APP_ENV] };
}
function actorGate(env: Env, actor: OperatorActor): Gate {
  const session = sessionGate(env, actor.proof);
  return { sql: `${session.sql} AND EXISTS (SELECT 1 FROM operator_grants og WHERE og.user_id=?
    AND og.status='active' AND og.role=? AND og.revision=?)`, values: [...session.values, actor.userId, actor.role, actor.grantRevision] };
}
function conversationGate(conversationId: string): Gate {
  return { sql: `EXISTS (SELECT 1 FROM conversations sc JOIN users su ON su.id=sc.user_id JOIN bindings sb
    ON sb.provider=sc.provider AND sb.business_id=sc.business_id AND sb.subject_id=sc.subject_id
    AND sb.user_id=sc.user_id AND sb.channel=sc.channel WHERE sc.id=? AND sc.status='active'
    AND sc.mode='human' AND sc.provider_control='bot' AND su.status='active' AND sb.status='active')`, values: [conversationId] };
}
function combine(...gates: Gate[]): Gate { return { sql: gates.map((gate) => `(${gate.sql})`).join(' AND '), values: gates.flatMap((gate) => gate.values) }; }
function claimGate(env: Env, actor: OperatorActor, conversationId: string, version: number): Gate {
  return combine(actorGate(env, actor), conversationGate(conversationId), { sql: `EXISTS (SELECT 1 FROM support_claims cl
    WHERE cl.conversation_id=? AND cl.operator_user_id=? AND cl.grant_revision=? AND cl.claim_version=? AND cl.expires_at>${DB_NOW})`,
    values: [conversationId, actor.userId, actor.grantRevision, version] });
}
function mutationGate(table: 'support_claims' | 'operator_grants', key: string, token: string): Gate {
  return { sql: `EXISTS (SELECT 1 FROM ${table} WHERE ${table === 'support_claims' ? 'conversation_id' : 'user_id'}=? AND mutation_token=?)`, values: [key, token] };
}
function claimView(row: ClaimRow): SupportClaim {
  return { conversationId: row.conversation_id, operatorUserId: row.operator_user_id!, grantRevision: row.grant_revision,
    claimVersion: row.claim_version, expiresAt: row.expires_at };
}
function id(value: string) { if (!value || value.length > 200) fail(400, 'invalid_identifier'); }
function version(value: number) { if (!Number.isSafeInteger(value) || value < 1) fail(400, 'invalid_claim_version'); }
async function assertProviderControlAvailable(env: Env, actor: OperatorActor, conversationId: string) {
  const gate = actorGate(env, actor);
  const row = await env.DB.prepare(`SELECT c.provider_control FROM conversations c JOIN users u ON u.id=c.user_id
    JOIN bindings b ON b.provider=c.provider AND b.business_id=c.business_id AND b.subject_id=c.subject_id AND b.user_id=c.user_id AND b.channel=c.channel
    WHERE c.id=? AND c.mode='human' AND c.status='active' AND u.status='active' AND b.status='active' AND ${gate.sql}`)
    .bind(conversationId, ...gate.values).first<{ provider_control: string }>();
  if (row && row.provider_control !== 'bot') fail(409, 'support_provider_control_unavailable');
}

/** Rechecks the DB session, not caller-supplied identity fields. No bearer ops shortcut. */
export async function requireOperatorActor(env: Env, proof: SessionProof | null): Promise<OperatorActor> {
  if (!proof) fail(401, 'identity_reauthentication_required');
  const gate = sessionGate(env, proof);
  const identity = await env.DB.prepare(`SELECT os.auth_method,oi.subject,oi.issuer FROM sessions os
    LEFT JOIN external_identities oi ON oi.id=os.identity_id AND oi.user_id=os.user_id
    WHERE os.token_hash=? AND (${gate.sql})`).bind(proof.tokenHash, ...gate.values)
    .first<{ auth_method: string; subject: string | null; issuer: string | null }>();
  if (!identity) fail(401, 'identity_reauthentication_required');
  let subjects: unknown;
  try { subjects = JSON.parse(env.OPERATOR_BOOTSTRAP_SUBJECTS ?? '[]'); } catch { subjects = []; }
  if (identity.auth_method === 'google' && identity.issuer === 'https://accounts.google.com'
    && Array.isArray(subjects) && subjects.every((value) => typeof value === 'string' && value.length > 0 && value.length <= 255)
    && subjects.includes(identity.subject)) {
    await env.DB.prepare(`INSERT INTO operator_grants(user_id,role,revision,status,granted_by,mutation_token,created_at,updated_at)
      SELECT ?,'admin',1,'active',NULL,?,${DB_NOW},${DB_NOW} WHERE ${gate.sql} ON CONFLICT(user_id) DO NOTHING`)
      .bind(proof.user.id, crypto.randomUUID(), ...gate.values).run();
  }
  const row = await env.DB.prepare(`SELECT role,revision FROM operator_grants WHERE user_id=? AND status='active' AND (${gate.sql})`)
    .bind(proof.user.id, ...gate.values).first<{ role: OperatorRole; revision: number }>();
  if (!row) fail(403, 'operator_role_required');
  return { userId: proof.user.id, role: row.role, grantRevision: row.revision, proof };
}
export async function getOperatorCapabilities(env: Env, proof: SessionProof | null) {
  if (!proof) return { role: null, canSupport: false, canManageOperators: false, reauthenticationRequired: false };
  try {
    const actor = await requireOperatorActor(env, proof);
    return { role: actor.role, canSupport: true, canManageOperators: actor.role === 'admin', reauthenticationRequired: false };
  } catch (error) {
    if (!(error instanceof SupportError)) throw error;
    return { role: null, canSupport: false, canManageOperators: false, reauthenticationRequired: error.status === 401 };
  }
}
async function assertActor(env: Env, actor: OperatorActor, admin = false) {
  if (actor.userId !== actor.proof.user.id || admin && actor.role !== 'admin') fail(403, 'operator_role_required');
  const gate = actorGate(env, actor);
  if (!await env.DB.prepare(`SELECT 1 AS ok WHERE ${gate.sql}`).bind(...gate.values).first()) fail(403, 'operator_access_changed');
}
export async function listOperatorGrants(env: Env, actor: OperatorActor) {
  await assertActor(env, actor, true);
  const gate = actorGate(env, actor);
  const rows = await env.DB.prepare(`SELECT g.user_id AS userId,u.display_name AS displayName,g.role,g.revision,g.status,g.updated_at AS updatedAt
    FROM operator_grants g JOIN users u ON u.id=g.user_id WHERE ${gate.sql} ORDER BY g.updated_at DESC,g.user_id LIMIT 100`).bind(...gate.values).all();
  return { grants: rows.results };
}

/** Ownership changes invalidate queued sends; dispatched outcomes stay unknown. */
function invalidate(env: Env, selection: Gate, gate: Gate, now: number): D1PreparedStatement[] {
  const chosen = `SELECT conversation_id FROM support_claims WHERE ${selection.sql}`;
  const values = selection.values;
  return [
    statement(env, `UPDATE conversations SET ownership_version=ownership_version+1,lease_token=NULL,lease_until=0
      WHERE id IN (${chosen})`, values, gate),
    statement(env, `UPDATE inbox SET status='cancelled',last_error='support_ownership_changed',completed_at=?
      WHERE conversation_id IN (${chosen}) AND status IN ('pending','processing')`, [now, ...values], gate),
    statement(env, `UPDATE messages SET status=CASE WHEN EXISTS (SELECT 1 FROM outbound_jobs os WHERE os.message_id=messages.id
      AND os.status='sending') THEN 'delivery_unknown' ELSE 'cancelled' END WHERE id IN
      (SELECT message_id FROM outbound_jobs WHERE conversation_id IN (${chosen}) AND status IN ('queued','retryable_failed','sending'))`, values, gate),
    statement(env, `UPDATE outbound_jobs SET status=CASE WHEN status='sending' THEN 'delivery_unknown' ELSE 'cancelled' END,
      error_code='support_ownership_changed',updated_at=? WHERE conversation_id IN (${chosen}) AND status IN ('queued','retryable_failed','sending')`, [now, ...values], gate),
  ];
}
export async function setOperatorGrant(env: Env, actor: OperatorActor, input: { userId: string; role: OperatorRole | null }) {
  await assertActor(env, actor, true); id(input.userId);
  if (input.role !== null && input.role !== 'admin' && input.role !== 'support') fail(400, 'invalid_operator_role');
  if (!await env.DB.prepare("SELECT 1 FROM users WHERE id=? AND status='active'").bind(input.userId).first()) fail(404, 'operator_user_unavailable');
  const token = crypto.randomUUID(), now = Date.now(), actorCondition = actorGate(env, actor);
  const changed = mutationGate('operator_grants', input.userId, token);
  const selection = { sql: 'operator_user_id=?', values: [input.userId] };
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO operator_grants(user_id,role,revision,status,granted_by,mutation_token,created_at,updated_at)
      SELECT ?,?,1,?,?,?, ?,? WHERE ${actorCondition.sql} ON CONFLICT(user_id) DO UPDATE SET
      role=CASE WHEN excluded.status='revoked' THEN operator_grants.role ELSE excluded.role END,
      revision=operator_grants.revision+1,status=excluded.status,granted_by=excluded.granted_by,
      mutation_token=excluded.mutation_token,updated_at=excluded.updated_at`)
      .bind(input.userId, input.role ?? 'support', input.role === null ? 'revoked' : 'active', actor.userId, token, now, now, ...actorCondition.values),
    ...invalidate(env, selection, changed, now),
    statement(env, `UPDATE support_claims SET operator_user_id=NULL,expires_at=0,claim_version=claim_version+1,
      mutation_token=?,updated_at=? WHERE operator_user_id=?`, [token, now, input.userId], changed),
    statement(env, `INSERT INTO audit_events(id,actor_user_id,action,outcome,created_at)
      SELECT ?,?,'operator.grant_changed',?,? WHERE 1=1`, [crypto.randomUUID(), actor.userId, input.role ?? 'revoked', now], changed),
  ]);
  const row = await env.DB.prepare('SELECT user_id AS userId,role,revision,status FROM operator_grants WHERE user_id=? AND mutation_token=?')
    .bind(input.userId, token).first();
  if (!row) fail(409, 'operator_access_changed');
  return row;
}
export function getSupportCoverage(env: Env) {
  const hours = (env.SUPPORT_HOURS ?? '').trim(), timeZone = (env.SUPPORT_TIME_ZONE ?? '').trim(), contact = (env.SUPPORT_CONTACT ?? '').trim();
  let validZone = false; try { if (timeZone) { new Intl.DateTimeFormat('en', { timeZone }); validZone = true; } } catch { /* Invalid config is unavailable. */ }
  const configured = env.SUPPORT_COVERAGE_ENABLED === 'true' && hours.length > 0 && hours.length <= 300
    && contact.length > 0 && contact.length <= 300 && validZone;
  return { configured, hours: configured ? hours : null, timeZone: configured ? timeZone : null,
    contact: configured ? contact : null, liveStaffingVerified: false };
}
export async function listSupportInbox(env: Env, actor: OperatorActor) {
  await assertActor(env, actor); const gate = actorGate(env, actor);
  const result = await env.DB.prepare(`SELECT c.id AS conversationId,c.channel,c.last_activity_at AS lastActivityAt,
    c.provider_control AS providerControl,CASE WHEN c.provider_control='bot' THEN 1 ELSE 0 END AS replyAvailable,
    u.display_name AS customerDisplayName,cl.operator_user_id AS operatorUserId,cl.claim_version AS claimVersion,cl.expires_at AS expiresAt,
    (SELECT COUNT(*) FROM messages m WHERE m.conversation_id=c.id AND m.role='user') AS customerMessageCount
    FROM conversations c JOIN users u ON u.id=c.user_id LEFT JOIN support_claims cl ON cl.conversation_id=c.id
    JOIN bindings b ON b.provider=c.provider AND b.business_id=c.business_id AND b.subject_id=c.subject_id AND b.user_id=c.user_id AND b.channel=c.channel
    WHERE c.mode='human' AND c.status='active' AND u.status='active' AND b.status='active' AND ${gate.sql}
    ORDER BY c.last_activity_at DESC,c.id LIMIT 50`).bind(...gate.values).all<SupportInboxRow>();
  return { conversations: result.results.map((row) => ({ ...row, replyAvailable: row.replyAvailable === 1 })), coverage: getSupportCoverage(env) };
}
export async function claimSupportConversation(env: Env, actor: OperatorActor, conversationId: string): Promise<SupportClaim> {
  await assertActor(env, actor); id(conversationId);
  await assertProviderControlAvailable(env, actor, conversationId);
  const prior = await env.DB.prepare(`SELECT * FROM support_claims WHERE conversation_id=? AND operator_user_id=?
    AND grant_revision=? AND expires_at>${DB_NOW}`).bind(conversationId, actor.userId, actor.grantRevision).first<ClaimRow>();
  if (prior) { await ownedClaim(env, actor, conversationId, prior.claim_version); return claimView(prior); }
  const token = crypto.randomUUID(), now = Date.now();
  const gate = combine(actorGate(env, actor), conversationGate(conversationId));
  const changed = mutationGate('support_claims', conversationId, token);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO support_claims(conversation_id,operator_user_id,grant_revision,claim_version,expires_at,mutation_token,created_at,updated_at)
      SELECT ?,?,?,1,${DB_NOW}+${CLAIM_MS},?,?,? WHERE ${gate.sql}
      ON CONFLICT(conversation_id) DO UPDATE SET operator_user_id=excluded.operator_user_id,grant_revision=excluded.grant_revision,
      claim_version=support_claims.claim_version+1,expires_at=excluded.expires_at,mutation_token=excluded.mutation_token,updated_at=excluded.updated_at
      WHERE support_claims.expires_at<=${DB_NOW} OR support_claims.operator_user_id IS NULL`)
      .bind(conversationId, actor.userId, actor.grantRevision, token, now, now, ...gate.values),
    ...invalidate(env, { sql: 'conversation_id=?', values: [conversationId] }, changed, now),
    statement(env, `INSERT INTO audit_events(id,actor_user_id,conversation_id,action,outcome,created_at)
      SELECT ?,?,?,'support.claimed','claimed',? WHERE 1=1`, [crypto.randomUUID(), actor.userId, conversationId, now], changed),
  ]);
  const row = await env.DB.prepare('SELECT * FROM support_claims WHERE conversation_id=? AND mutation_token=?').bind(conversationId, token).first<ClaimRow>();
  if (!row) { await assertProviderControlAvailable(env, actor, conversationId); fail(409, 'support_claim_unavailable'); }
  return claimView(row);
}
async function ownedClaim(env: Env, actor: OperatorActor, conversationId: string, claimVersion: number) {
  version(claimVersion); const gate = claimGate(env, actor, conversationId, claimVersion);
  const row = await env.DB.prepare(`SELECT * FROM support_claims WHERE conversation_id=? AND ${gate.sql}`)
    .bind(conversationId, ...gate.values).first<ClaimRow>();
  if (!row) { await assertProviderControlAvailable(env, actor, conversationId); fail(409, 'support_claim_unavailable'); }
  return row;
}
export async function renewSupportClaim(env: Env, actor: OperatorActor, conversationId: string, claimVersion: number) {
  await ownedClaim(env, actor, conversationId, claimVersion);
  const gate = claimGate(env, actor, conversationId, claimVersion), token = crypto.randomUUID();
  await statement(env, `UPDATE support_claims SET expires_at=${DB_NOW}+${CLAIM_MS},updated_at=${DB_NOW},mutation_token=? WHERE conversation_id=?`,
    [token, conversationId], gate).run();
  const row = await env.DB.prepare('SELECT * FROM support_claims WHERE conversation_id=? AND mutation_token=?').bind(conversationId, token).first<ClaimRow>();
  if (!row) { await assertProviderControlAvailable(env, actor, conversationId); fail(409, 'support_claim_unavailable'); }
  return claimView(row);
}
async function closeClaim(env: Env, actor: OperatorActor, conversationId: string, claimVersion: number, resume: boolean) {
  await ownedClaim(env, actor, conversationId, claimVersion);
  const token = crypto.randomUUID(), now = Date.now(), gate = claimGate(env, actor, conversationId, claimVersion);
  const changed = mutationGate('support_claims', conversationId, token);
  await env.DB.batch([
    statement(env, `UPDATE support_claims SET mutation_token=?,updated_at=? WHERE conversation_id=?`, [token, now, conversationId], gate),
    ...invalidate(env, { sql: 'conversation_id=?', values: [conversationId] }, changed, now),
    statement(env, `UPDATE conversations SET mode=? WHERE id=?`, [resume ? 'bot' : 'human', conversationId], changed),
    statement(env, `UPDATE support_claims SET operator_user_id=NULL,expires_at=0,claim_version=claim_version+1 WHERE conversation_id=?`, [conversationId], changed),
    statement(env, `INSERT INTO audit_events(id,actor_user_id,conversation_id,action,outcome,created_at)
      SELECT ?,?,?,?,'completed',? WHERE 1=1`, [crypto.randomUUID(), actor.userId, conversationId, resume ? 'support.resumed' : 'support.released', now], changed),
  ]);
  if (!await env.DB.prepare('SELECT 1 FROM support_claims WHERE conversation_id=? AND mutation_token=?').bind(conversationId, token).first()) {
    await assertProviderControlAvailable(env, actor, conversationId); fail(409, 'support_claim_unavailable');
  }
  return { ok: true, mode: resume ? 'bot' : 'human' };
}
export function releaseSupportClaim(env: Env, actor: OperatorActor, conversationId: string, claimVersion: number) { return closeClaim(env, actor, conversationId, claimVersion, false); }
export function resumeSupportConversation(env: Env, actor: OperatorActor, conversationId: string, claimVersion: number) { return closeClaim(env, actor, conversationId, claimVersion, true); }

export async function getSupportConversation(env: Env, actor: OperatorActor, conversationId: string, before?: number) {
  await assertActor(env, actor); id(conversationId);
  if (before !== undefined && (!Number.isSafeInteger(before) || before < 1)) fail(400, 'invalid_message_cursor');
  const claim = await env.DB.prepare(`SELECT * FROM support_claims WHERE conversation_id=? AND operator_user_id=?
    AND grant_revision=? AND expires_at>${DB_NOW}`).bind(conversationId, actor.userId, actor.grantRevision).first<ClaimRow>();
  if (!claim) fail(409, 'support_claim_unavailable');
  await ownedClaim(env, actor, conversationId, claim.claim_version);
  const gate = claimGate(env, actor, conversationId, claim.claim_version);
  const rows = await env.DB.prepare(`SELECT rowid AS cursor,id,role,body_ciphertext,status,created_at,model,operator_user_id FROM messages
    WHERE conversation_id=? AND rowid<? AND (${gate.sql}) ORDER BY rowid DESC LIMIT 100`)
    .bind(conversationId, before ?? Number.MAX_SAFE_INTEGER, ...gate.values)
    .all<{ cursor: number; id: string; role: string; body_ciphertext: string; status: string; created_at: number; model: string; operator_user_id: string | null }>();
  const messages = await Promise.all(rows.results.reverse().map(async (row) => ({ id: row.id, role: row.role,
    text: await decryptText(row.body_ciphertext, env.CONTENT_ENCRYPTION_KEY), status: row.status, createdAt: row.created_at,
    model: row.model, operatorUserId: row.operator_user_id })));
  // Recheck after asynchronous decryption: account erasure, message deletion,
  // release, expired claim or revoked role must not return stale private text.
  const remaining = await env.DB.prepare(`SELECT COUNT(*) AS count FROM messages WHERE conversation_id=?
    AND id IN (SELECT value FROM json_each(?)) AND ${gate.sql}`)
    .bind(conversationId, JSON.stringify(messages.map((message) => message.id)), ...gate.values).first<{ count: number }>();
  if (remaining?.count !== messages.length || !await env.DB.prepare(`SELECT 1 WHERE ${gate.sql}`).bind(...gate.values).first()) fail(409, 'support_access_changed');
  return { conversationId, mode: 'human', providerControl: 'bot', replyAvailable: true, claim: claimView(claim), messages,
    nextBefore: messages.length === 100 ? rows.results[0]!.cursor : null };
}
export async function enqueueSupportReply(env: Env, actor: OperatorActor, conversationId: string,
  input: { text: string; clientMessageId: string; claimVersion: number }) {
  await assertActor(env, actor); id(conversationId); version(input.claimVersion);
  if (typeof input.text !== 'string' || input.text.length > 4000 || !input.text.trim()) fail(400, 'invalid_support_reply');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.clientMessageId)) fail(400, 'invalid_client_message_id');
  const digest = await sha256(input.text), clientId = input.clientMessageId.toLowerCase();
  const existing = async () => env.DB.prepare(`SELECT r.conversation_id,r.message_id,r.text_digest,m.status FROM support_reply_requests r
    JOIN messages m ON m.id=r.message_id WHERE r.operator_user_id=? AND r.client_message_id=?`)
    .bind(actor.userId, clientId).first<{ conversation_id: string; message_id: string; text_digest: string; status: string }>();
  const replay = (row: NonNullable<Awaited<ReturnType<typeof existing>>>) => {
    if (row.conversation_id !== conversationId || row.text_digest !== digest) fail(409, 'support_reply_conflict');
    return { messageId: row.message_id, status: row.status, duplicate: true };
  };
  const prior = await existing(); if (prior) { await assertActor(env, actor); return replay(prior); }
  const gate = claimGate(env, actor, conversationId, input.claimVersion);
  const messageId = `msg_${crypto.randomUUID()}`, now = Date.now();
  const body = await encryptText(input.text, env.CONTENT_ENCRYPTION_KEY);
  const outboundKey = `human:${await sha256(`${actor.userId}:${clientId}`)}`;
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO messages(id,conversation_id,role,body_ciphertext,content_hash,status,created_at,model,
      context_revision,is_memory_control,operator_user_id,operator_grant_revision,support_claim_version)
      SELECT ?,c.id,'assistant',?,?,'queued',?,'plause-human',u.context_revision,1,?,?,?
      FROM conversations c JOIN users u ON u.id=c.user_id WHERE c.id=? AND ${gate.sql}
      AND NOT EXISTS (SELECT 1 FROM support_reply_requests WHERE operator_user_id=? AND client_message_id=?)`)
      .bind(messageId, body, digest, now, actor.userId, actor.grantRevision, input.claimVersion, conversationId,
        ...gate.values, actor.userId, clientId),
    env.DB.prepare(`INSERT INTO support_reply_requests(operator_user_id,client_message_id,conversation_id,message_id,text_digest,claim_version,created_at)
      SELECT ?,?,conversation_id,id,?,?,? FROM messages WHERE id=?`).bind(actor.userId, clientId, digest, input.claimVersion, now, messageId),
    env.DB.prepare(`INSERT INTO outbound_jobs(id,conversation_id,message_id,idempotency_key,status,ownership_version,next_attempt_at,created_at,updated_at,expires_at)
      SELECT ?,c.id,m.id,?,'queued',c.ownership_version,?,?,?,? FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.id=?`)
      .bind(`out_${crypto.randomUUID()}`, outboundKey, now, now, now, now + 24 * 60 * 60_000, messageId),
    env.DB.prepare(`INSERT INTO audit_events(id,actor_user_id,conversation_id,action,outcome,created_at)
      SELECT ?,?,conversation_id,'support.reply_queued','queued',? FROM messages WHERE id=?`).bind(crypto.randomUUID(), actor.userId, now, messageId),
  ]);
  const row = await existing(); if (!row) { await assertProviderControlAvailable(env, actor, conversationId); fail(409, 'support_claim_unavailable'); }
  await assertActor(env, actor);
  return row.message_id === messageId ? { messageId, status: row.status, duplicate: false } : replay(row);
}
