import type { Env } from '../../../packages/contracts/src/index';
import { encryptionKeyringInfo, randomToken, sha256, stableIdentityKeyMaterial } from '../../../packages/security/src/index';
import { PipelineError } from './store';

const operational = "NOT EXISTS(SELECT 1 FROM system_settings WHERE key='restore_locked' AND value!='false')";
const retentionMs = 30 * 86_400_000;
type Provider = 'model' | 'search' | 'google' | 'messaging';
const providerErrors: Record<Provider, readonly string[]> = {
  model: ['model_auth_failed','model_config_invalid','model_network_error','model_rate_limited','model_request_rejected',
    'model_response_incomplete','model_response_invalid','model_response_too_large','model_timeout','model_unavailable',
    'model_usage_invalid','model_count_invalid','model_output_invalid','model_outcome_unknown','model_failed'],
  search: ['research_auth_failed','research_config_invalid','research_network_error','research_rate_limited','research_request_rejected',
    'research_response_invalid','research_response_too_large','research_timeout','research_unavailable','research_outcome_unknown','research_failed'],
  google: ['google_authorization_failed','google_config_invalid','google_network_error','google_rate_limited','google_request_rejected',
    'google_response_invalid','google_response_too_large','google_timeout','google_token_invalid','google_token_response_invalid',
    'google_write_outcome_unknown','google_write_response_invalid','google_calendar_outcome_unknown','google_calendar_failed'],
  messaging: ['sunshine_auth_failed','sunshine_config_invalid','sunshine_network_error','sunshine_rate_limited','sunshine_request_rejected',
    'sunshine_response_invalid','sunshine_response_too_large','sunshine_timeout','sunshine_unavailable','sunshine_operation_failed',
    'sunshine_send_failed','send_outcome_unknown'],
};

export async function maintenanceState(env: Pick<Env, 'DB'>) {
  const rows = await env.DB.prepare("SELECT key,value FROM system_settings WHERE key IN ('restore_locked','outbound_paused')")
    .all<{ key: string; value: string }>();
  const locked = rows.results.some((row) => row.key === 'restore_locked' && row.value !== 'false');
  const outboundPaused = rows.results.some((row) => row.key === 'outbound_paused' && row.value !== 'false');
  return { locked, reason: locked ? 'restore_locked' as const : null, outboundPaused };
}

export async function assertOperational(env: Pick<Env, 'DB'>, options: { outbound?: boolean } = {}): Promise<void> {
  const state = await maintenanceState(env);
  if (state.locked) throw new PipelineError('Service maintenance is in progress.', 503, 'restore_locked');
  if (options.outbound && state.outboundPaused) throw new PipelineError('Outbound work is paused.', 503, 'outbound_paused');
}

async function bucketKey(env: Env, scope: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(stableIdentityKeyMaterial(env.CONTENT_ENCRYPTION_KEY)),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`plause.rate.v1\u0000${scope}\u0000${value}`)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** All counters are committed in one D1 transaction, or none are incremented. */
async function consumeBuckets(env: Env, buckets: { key: string; maximum: number }[], windowMs: number, userId?: string) {
  const now = Date.now(), start = Math.floor(now / windowMs) * windowMs, token = randomToken();
  const capacity = buckets.map(() => '(SELECT COALESCE(MAX(request_count),0) FROM runtime_rate_buckets WHERE bucket_key=? AND window_start=?)<?').join(' AND ');
  const capacityValues = buckets.flatMap((bucket) => [bucket.key, start, bucket.maximum]);
  const account = userId === undefined ? '' : " AND EXISTS(SELECT 1 FROM users WHERE id=? AND status='active')";
  const first = buckets[0]!;
  const statements = [env.DB.prepare(`INSERT INTO runtime_rate_buckets(bucket_key,window_start,request_count,expires_at,mutation_token)
    SELECT ?,?,1,?,? WHERE ${capacity}${account} AND ${operational} ON CONFLICT(bucket_key,window_start) DO UPDATE SET
    request_count=runtime_rate_buckets.request_count+1,mutation_token=excluded.mutation_token
    WHERE runtime_rate_buckets.request_count<?`)
    .bind(first.key, start, start + windowMs, token, ...capacityValues, ...(userId === undefined ? [] : [userId]), first.maximum)];
  for (const bucket of buckets.slice(1)) statements.push(env.DB.prepare(`INSERT INTO runtime_rate_buckets(bucket_key,window_start,request_count,expires_at,mutation_token)
    SELECT ?,?,1,?,? WHERE EXISTS(SELECT 1 FROM runtime_rate_buckets WHERE bucket_key=? AND window_start=? AND mutation_token=?)
    ON CONFLICT(bucket_key,window_start) DO UPDATE SET request_count=runtime_rate_buckets.request_count+1,mutation_token=excluded.mutation_token`)
    .bind(bucket.key, start, start + windowMs, token, first.key, start, token));
  const results = await env.DB.batch(statements);
  if (results[0]!.meta.changes !== 1) throw new PipelineError('Request limit reached. Try again later.', 429, 'request_rate_limited');
}

function cloudAddress(request: Request): string {
  const value = request.headers.get('cf-connecting-ip');
  if (!value || value.length > 64 || /[^0-9a-fA-F:.]/.test(value)) throw new PipelineError('Trusted request metadata unavailable.', 503, 'trusted_client_address_required');
  if (value.includes(':')) {
    try { return new URL(`https://[${value}]/`).hostname; } catch { /* Invalid IPv6 fails closed below. */ }
  } else {
    const parts = value.split('.');
    if (parts.length === 4 && parts.every((part) => /^(0|[1-9][0-9]{0,2})$/.test(part) && Number(part) <= 255)) return value;
  }
  throw new PipelineError('Trusted request metadata unavailable.', 503, 'trusted_client_address_required');
}

/** Cloudflare supplies CF-Connecting-IP; X-Forwarded-For and caller local keys are ignored in cloud mode. */
export async function enforceAuthStartRateLimit(env: Env, request: Request, options: { localKey?: string } = {}): Promise<void> {
  await assertOperational(env);
  const address = env.APP_ENV === 'local' ? options.localKey : cloudAddress(request);
  if (!address || address.length > 200 || /[\x00-\x1f\x7f]/.test(address)) throw new PipelineError('Local rate-limit fixture key required.', 503, 'local_rate_key_required');
  const scoped = await bucketKey(env, 'auth-start', address); const global = await bucketKey(env, 'auth-start-global', 'service');
  await consumeBuckets(env, [{ key: scoped, maximum: 10 }, { key: global, maximum: 300 }], 600_000);
}

export function accountRateLimitExempt(request: Request, privacyControl = false): boolean {
  const url = new URL(request.url);
  return privacyControl || ['GET','HEAD'].includes(request.method)
    || url.pathname === '/api/account' || url.pathname.startsWith('/api/account/')
    || /^\/api\/conversations\/[^/]+\/receipts$/.test(url.pathname)
    || request.method === 'DELETE' && (url.pathname === '/api/session' || url.pathname === '/api/calendar/google'
      || /^\/api\/channel-bindings\/[^/]+$/.test(url.pathname));
}

/** The trusted route parser, never a client header, may mark an explicit privacy control. */
export async function enforceAccountApiRateLimit(env: Env, userId: string, request: Request, options: { privacyControl?: boolean } = {}): Promise<void> {
  if (accountRateLimitExempt(request, options.privacyControl)) return;
  if (!userId || userId.length > 200) throw new PipelineError('Account unavailable.', 403, 'account_unavailable');
  await assertOperational(env);
  await consumeBuckets(env, [{ key: await bucketKey(env, 'account-write', userId), maximum: 60 }], 60_000, userId);
}

export async function journalDeadLetter(env: Env, body: unknown, queueMessageId: string) {
  await assertOperational(env);
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).sort().join(',') !== 'conversationId,kind'
    || !('kind' in body) || body.kind !== 'conversation' || !('conversationId' in body)
    || typeof body.conversationId !== 'string' || !/^conv_[A-Za-z0-9_-]{1,150}$/.test(body.conversationId)
    || body.conversationId.endsWith('\n') || typeof queueMessageId !== 'string' || !queueMessageId || queueMessageId.length > 200) {
    return { recorded: false as const, reason: 'invalid_job' as const };
  }
  const id = `dlq_${await sha256(queueMessageId)}`, now = Date.now();
  const result = await env.DB.prepare(`INSERT INTO dead_letter_jobs(id,conversation_id,state,next_retry_at,created_at,updated_at)
    SELECT ?,c.id,'pending',?,?,? FROM conversations c JOIN users u ON u.id=c.user_id WHERE c.id=? AND u.status='active' AND ${operational}
    ON CONFLICT(id) DO NOTHING`).bind(id, now, now, now, body.conversationId).run();
  const row = await env.DB.prepare('SELECT conversation_id FROM dead_letter_jobs WHERE id=?').bind(id).first<{ conversation_id: string }>();
  if (!row) return { recorded: false as const, reason: 'unavailable' as const };
  if (row.conversation_id !== body.conversationId) throw new PipelineError('Dead-letter reference conflict.', 409, 'dead_letter_conflict');
  return { recorded: true as const, duplicate: result.meta.changes === 0 };
}

function boundedLimit(value = 100): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 500) throw new PipelineError('Invalid maintenance batch limit.', 400, 'maintenance_limit_invalid');
  return value;
}
function timestamp(value = Date.now()): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new PipelineError('Invalid maintenance timestamp.', 400, 'maintenance_time_invalid');
  return value;
}
const pendingWork = `(EXISTS(SELECT 1 FROM inbox i WHERE i.conversation_id=c.id AND i.status IN ('pending','processing'))
  OR EXISTS(SELECT 1 FROM outbound_jobs o WHERE o.conversation_id=c.id AND o.status IN ('queued','sending','retryable_failed','delivery_unknown')))`;

/** Queue deliveries are wakeups only; existing D1 leases and ledgers still own execution. */
export async function recoverDeadLetters(env: Env, options: { now?: number; limit?: number } = {}) {
  const now = timestamp(options.now), limit = boundedLimit(options.limit), state = await maintenanceState(env);
  if (state.locked || state.outboundPaused) return { enqueued: 0, resolved: 0 };
  const resolved = await env.DB.prepare(`UPDATE dead_letter_jobs SET state='resolved',error_code=NULL,updated_at=? WHERE id IN
    (SELECT d.id FROM dead_letter_jobs d LEFT JOIN conversations c ON c.id=d.conversation_id LEFT JOIN users u ON u.id=c.user_id
      WHERE d.state='pending' AND (c.id IS NULL OR u.status!='active' OR NOT ${pendingWork}) ORDER BY d.created_at LIMIT ?)`)
    .bind(now, limit).run();
  const rows = await env.DB.prepare(`SELECT d.conversation_id FROM dead_letter_jobs d JOIN conversations c ON c.id=d.conversation_id
    JOIN users u ON u.id=c.user_id WHERE d.state='pending' AND d.next_retry_at<=? AND u.status='active' AND ${pendingWork}
    GROUP BY d.conversation_id ORDER BY MIN(d.created_at) LIMIT ?`).bind(now, limit).all<{ conversation_id: string }>();
  let enqueued = 0;
  for (const row of rows.results) {
    let code: string | null = null;
    try { await env.JOBS.send({ kind: 'conversation', conversationId: row.conversation_id }); enqueued++; }
    catch { code = 'queue_unavailable'; }
    await env.DB.prepare(`UPDATE dead_letter_jobs SET recovery_attempts=recovery_attempts+1,next_retry_at=?,error_code=?,updated_at=?
      WHERE conversation_id=? AND state='pending'`).bind(now + 30_000, code, now, row.conversation_id).run();
  }
  return { enqueued, resolved: resolved.meta.changes };
}

/** Keep event ID/hash tombstones: deleting them could authorize old webhook replays again. */
export async function runRetention(env: Env, options: { now?: number; limit?: number } = {}) {
  const now = timestamp(options.now), limit = boundedLimit(options.limit), cutoff = now - retentionMs;
  if ((await maintenanceState(env)).locked) return { webhookPayloadsPurged: 0, expiredLoginStatesRemoved: 0, rateBucketsRemoved: 0,
    resolvedDeadLettersRemoved: 0, lifecycleTombstonesRetained: 0 };
  const results = await env.DB.batch([
    env.DB.prepare(`UPDATE webhook_events SET payload_ciphertext='' WHERE rowid IN (SELECT e.rowid FROM webhook_events e
      WHERE e.received_at<? AND e.payload_ciphertext!='' AND ${operational}
      AND NOT EXISTS(SELECT 1 FROM inbox i WHERE i.conversation_id=e.conversation_id AND i.status IN ('pending','processing'))
      AND NOT EXISTS(SELECT 1 FROM outbound_jobs o WHERE o.conversation_id=e.conversation_id AND o.status IN ('queued','sending','retryable_failed','delivery_unknown'))
      AND NOT EXISTS(SELECT 1 FROM model_attempts a WHERE a.conversation_id=e.conversation_id AND a.state IN ('reserved','dispatched','unknown'))
      AND NOT EXISTS(SELECT 1 FROM search_attempts a WHERE a.conversation_id=e.conversation_id AND a.state IN ('dispatched','unknown'))
      AND NOT EXISTS(SELECT 1 FROM google_calendar_requests a WHERE a.conversation_id=e.conversation_id AND a.state IN ('dispatched','unknown'))
      AND (e.event_type!='message.received' OR EXISTS(SELECT 1 FROM messages m JOIN inbox i ON i.message_id=m.id
        WHERE m.conversation_id=e.conversation_id AND m.provider_message_id=e.provider_message_id AND m.role='user'
        AND i.status IN ('completed','cancelled','failed'))) ORDER BY e.received_at LIMIT ?)`)
      .bind(cutoff, limit),
    env.DB.prepare(`DELETE FROM identity_login_states WHERE state_hash IN (SELECT state_hash FROM identity_login_states WHERE expires_at<=? AND ${operational} ORDER BY expires_at LIMIT ?)`).bind(now, limit),
    env.DB.prepare(`DELETE FROM runtime_rate_buckets WHERE rowid IN (SELECT rowid FROM runtime_rate_buckets WHERE expires_at<=? AND ${operational} ORDER BY expires_at LIMIT ?)`).bind(now, limit),
    env.DB.prepare(`DELETE FROM dead_letter_jobs WHERE id IN (SELECT id FROM dead_letter_jobs WHERE state IN ('resolved','cancelled') AND updated_at<? AND ${operational} ORDER BY updated_at LIMIT ?)`).bind(cutoff, limit),
  ]);
  const lifecycle = await env.DB.prepare('SELECT COUNT(*) AS n FROM (SELECT 1 FROM provider_lifecycle_events WHERE received_at<? LIMIT ?)').bind(cutoff, limit).first<{ n: number }>();
  return { webhookPayloadsPurged: results[0]!.meta.changes, expiredLoginStatesRemoved: results[1]!.meta.changes,
    rateBucketsRemoved: results[2]!.meta.changes, resolvedDeadLettersRemoved: results[3]!.meta.changes,
    lifecycleTombstonesRetained: lifecycle?.n ?? 0 };
}

/** Five recent provider failures open a local circuit; no external probe or retry runs. */
export async function providerCircuitOpen(env: Env, provider: Provider): Promise<boolean> {
  if (!Object.hasOwn(providerErrors, provider)) throw new PipelineError('Invalid provider circuit.', 400, 'provider_circuit_invalid');
  const errors = providerErrors[provider], marks = errors.map(() => '?').join(','), now = Date.now();
  const table = provider === 'model' ? 'model_attempts' : provider === 'search' ? 'search_attempts' : provider === 'google' ? 'google_calendar_requests' : 'outbound_jobs';
  const states = provider === 'messaging' ? "status IN ('failed','retryable_failed','delivery_unknown')" : "state IN ('failed','unknown')";
  const failures = await env.DB.prepare(`SELECT COUNT(*) AS n,MAX(updated_at) AS newest FROM ${table}
    WHERE ${states} AND error_code IN (${marks}) AND updated_at>? AND updated_at<=?`).bind(...errors, now - 60_000, now).first<{ n: number; newest: number | null }>();
  if (failures && failures.n >= 5 && failures.newest !== null) await env.DB.prepare(`INSERT INTO provider_circuits(provider,opened_until,latest_failure_at,updated_at)
    VALUES(?,?,?,?) ON CONFLICT(provider) DO UPDATE SET opened_until=MAX(provider_circuits.opened_until,excluded.opened_until),
    latest_failure_at=MAX(provider_circuits.latest_failure_at,excluded.latest_failure_at),updated_at=excluded.updated_at`)
    .bind(provider, failures.newest + 60_000, failures.newest, now).run();
  const state = await env.DB.prepare('SELECT opened_until FROM provider_circuits WHERE provider=?').bind(provider).first<{ opened_until: number }>();
  return !!state && state.opened_until > now;
}

export async function runtimeOperationsReadiness(env: Env) {
  const [maintenance, deadLetters, model, search, google, messaging] = await Promise.all([maintenanceState(env),
    env.DB.prepare("SELECT COUNT(*) AS pending,MIN(created_at) AS oldestPendingAt FROM dead_letter_jobs WHERE state='pending'").first(),
    providerCircuitOpen(env, 'model'), providerCircuitOpen(env, 'search'), providerCircuitOpen(env, 'google'), providerCircuitOpen(env, 'messaging')]);
  let encryption: { configured: boolean; format: 'legacy' | 'keyring' | null; retainedKeyCount: number | null };
  try { const info = encryptionKeyringInfo(env.CONTENT_ENCRYPTION_KEY); encryption = { configured: true, format: info.format, retainedKeyCount: info.keyIds.length }; }
  catch { encryption = { configured: false, format: null, retainedKeyCount: null }; }
  return { maintenance, encryption, deadLetters, providerCircuits: { model, search, google, messaging } };
}
