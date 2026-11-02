import { z } from 'zod';
import type { Env } from '../../../packages/contracts/src/index';
import { sha256 } from '../../../packages/security/src/index';
import { PipelineError } from './store';
import { onboardingRevocationStatements } from './messaging-onboarding';

type PrivacyEnvironment = 'local' | 'staging' | 'production';
type PrivacyEnv = Env & { PRIVACY_LEDGER?: R2Bucket };
const identifier = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
export const privacyRecordSchema = z.object({ version: z.literal(1), environment: z.enum(['local', 'staging', 'production']),
  userId: identifier, operationId: identifier, requestedAt: z.number().int().nonnegative().safe() }).strict();
export type PrivacyRecord = z.infer<typeof privacyRecordSchema>;
export interface ErasureOutcome { deleted: boolean; pending: boolean; operationId: string | null }
interface Operation { id: string; user_id: string; environment: PrivacyEnvironment; ledger_key: string;
  state: 'pending' | 'recorded' | 'completed'; created_at: number }
const dbNow = "CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)";

function environment(env: Env): PrivacyEnvironment {
  if (env.APP_ENV !== 'local' && env.APP_ENV !== 'staging' && env.APP_ENV !== 'production') {
    throw new PipelineError('Privacy environment unavailable.', 503, 'privacy_configuration_invalid');
  }
  return env.APP_ENV;
}
export function privacyLedgerKey(record: Pick<PrivacyRecord, 'environment' | 'userId'>): string {
  if (!identifier.safeParse(record.userId).success || !['local', 'staging', 'production'].includes(record.environment)) {
    throw new PipelineError('Invalid privacy record.', 400, 'privacy_record_invalid');
  }
  return `erasures/v1/${record.environment}/${record.userId}.json`;
}

async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('privacy_ledger_timeout')), 5000);
  })]); } finally { clearTimeout(timer); }
}

async function readRecord(bucket: R2Bucket, key: string, expectedEnvironment: PrivacyEnvironment): Promise<PrivacyRecord> {
  const object = await bounded(bucket.get(key));
  if (!object || object.size > 2048) throw new Error('privacy_ledger_record_missing');
  const record = privacyRecordSchema.parse(await bounded(object.json<unknown>()));
  if (record.environment !== expectedEnvironment || privacyLedgerKey(record) !== key) throw new Error('privacy_ledger_scope_invalid');
  return record;
}

async function recordOperation(env: PrivacyEnv, operation: Operation): Promise<boolean> {
  if (operation.state === 'completed') return true;
  if (operation.state === 'recorded') return true;
  // Local-only erasure preserves its D1 tombstone, but makes no independent
  // durability promise unless a bucket was actually supplied.
  if (operation.environment === 'local' && !env.PRIVACY_LEDGER) {
    await env.DB.prepare("UPDATE privacy_operations SET state='recorded',error_code=NULL,updated_at=? WHERE id=? AND state='pending'")
      .bind(Date.now(), operation.id).run();
    return true;
  }
  if (!env.PRIVACY_LEDGER) {
    await env.DB.prepare("UPDATE privacy_operations SET error_code='privacy_ledger_unavailable',updated_at=? WHERE id=? AND state='pending'")
      .bind(Date.now(), operation.id).run();
    return false;
  }
  const record: PrivacyRecord = { version: 1, environment: operation.environment,
    userId: operation.user_id, operationId: operation.id, requestedAt: operation.created_at };
  try {
    // Never overwrite an earlier erasure. A timed-out put may still finish;
    // recovery reads the same deterministic key and completes the operation.
    await bounded(env.PRIVACY_LEDGER.put(operation.ledger_key, JSON.stringify(record), {
      onlyIf: new Headers({ 'if-none-match': '*' }), httpMetadata: { contentType: 'application/json', cacheControl: 'no-store' },
    }));
    const durable = await readRecord(env.PRIVACY_LEDGER, operation.ledger_key, operation.environment);
    if (durable.userId !== operation.user_id) throw new Error('privacy_ledger_scope_invalid');
    await env.DB.prepare("UPDATE privacy_operations SET state='recorded',error_code=NULL,updated_at=? WHERE id=? AND state='pending'")
      .bind(Date.now(), operation.id).run();
    return true;
  } catch {
    await env.DB.prepare("UPDATE privacy_operations SET error_code='privacy_ledger_unavailable',updated_at=? WHERE id=? AND state='pending'")
      .bind(Date.now(), operation.id).run();
    return false;
  }
}

/** Retains all paid/request quota tombstones; only personalized content is purged. */
async function purgeRecordedOperation(env: Env, operationId: string): Promise<boolean> {
  const gate = "EXISTS(SELECT 1 FROM privacy_operations WHERE id=? AND user_id=? AND state IN('recorded','completed'))";
  const operation = await env.DB.prepare("SELECT * FROM privacy_operations WHERE id=? AND state IN('recorded','completed')")
    .bind(operationId).first<Operation>();
  if (!operation) return false;
  const userId = operation.user_id; const bindings = [operationId, userId]; const now = Date.now();
  await env.DB.batch([
    ...onboardingRevocationStatements(env, { userId, gate, gateBindings: bindings, now }),
    env.DB.prepare(`UPDATE model_attempts SET response_ciphertext=NULL,input_digest='',
      state=CASE WHEN state='completed' THEN 'purged' WHEN state='dispatched' THEN 'unknown' WHEN state='reserved' THEN 'failed' ELSE state END,
      budget_debit_micro_usd=CASE WHEN state='reserved' THEN 0 ELSE budget_debit_micro_usd END,
      error_code='account_erased',updated_at=? WHERE user_id=? AND ${gate}`).bind(now, userId, ...bindings),
    env.DB.prepare(`UPDATE search_attempts SET result_ciphertext=NULL,query_digest='',
      state=CASE WHEN state='completed' THEN 'purged' ELSE state END,error_code='account_erased',updated_at=?
      WHERE user_id=? AND ${gate}`).bind(now, userId, ...bindings),
    env.DB.prepare(`UPDATE google_calendar_requests SET result_ciphertext=NULL,query_digest='',
      state=CASE WHEN state='completed' THEN 'purged' WHEN state='dispatched' THEN 'unknown' ELSE state END,
      error_code='account_erased',updated_at=? WHERE user_id=? AND ${gate}`).bind(now, userId, ...bindings),
    env.DB.prepare(`DELETE FROM mock_receipts WHERE idempotency_key IN (SELECT o.idempotency_key FROM outbound_jobs o
      JOIN conversations c ON c.id=o.conversation_id WHERE c.user_id=?) AND ${gate}`).bind(userId, ...bindings),
    env.DB.prepare(`DELETE FROM users WHERE id=? AND ${gate}`).bind(userId, ...bindings),
    env.DB.prepare(`UPDATE privacy_operations SET state='completed',error_code=NULL,completed_at=COALESCE(completed_at,?),updated_at=?
      WHERE id=? AND state IN('recorded','completed') AND NOT EXISTS(SELECT 1 FROM users WHERE id=privacy_operations.user_id)`)
      .bind(now, now, operationId),
  ]);
  return !!await env.DB.prepare("SELECT 1 AS ok FROM privacy_operations WHERE id=? AND state='completed'").bind(operationId).first();
}

/** Validate the destructive intent once, revoke access, record independently, then erase. */
export async function requestErasure(env: PrivacyEnv, userId: string, token: string): Promise<ErasureOutcome> {
  const scope = environment(env);
  if (!identifier.safeParse(userId).success || !token || token.length > 1000) return { deleted: false, pending: false, operationId: null };
  const intentHash = await sha256(token); const operationId = `erase_${crypto.randomUUID()}`; const now = Date.now();
  const own = "EXISTS(SELECT 1 FROM privacy_operations WHERE id=? AND user_id=? AND environment=? AND state='pending')";
  const ownBindings = [operationId, userId, scope];
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO privacy_operations(id,user_id,intent_hash,environment,ledger_key,state,created_at,updated_at)
      SELECT ?,u.id,?,?,?,'pending',?,? FROM users u JOIN account_deletion_intents i ON i.user_id=u.id
      WHERE u.id=? AND u.status='active' AND i.token_hash=? AND i.consumed_by IS NULL AND i.expires_at>${dbNow}`)
      .bind(operationId, intentHash, scope, privacyLedgerKey({ environment: scope, userId }), now, now, userId, intentHash),
    env.DB.prepare(`UPDATE account_deletion_intents SET consumed_by=? WHERE token_hash=? AND user_id=? AND consumed_by IS NULL AND ${own}`)
      .bind(operationId, intentHash, userId, ...ownBindings),
    env.DB.prepare(`UPDATE users SET status='disabled',context_revision=context_revision+1,google_calendar_revision=google_calendar_revision+1,
      reminders_revision=reminders_revision+1,actions_revision=actions_revision+1 WHERE id=? AND ${own}`).bind(userId, ...ownBindings),
    env.DB.prepare(`UPDATE conversations SET mode='human',ownership_version=ownership_version+1,lease_token=NULL,lease_until=0
      WHERE user_id=? AND ${own}`).bind(userId, ...ownBindings),
    env.DB.prepare(`UPDATE bindings SET status='revoked',revision=revision+1,revoked_at=? WHERE user_id=? AND ${own}`).bind(now, userId, ...ownBindings),
    ...onboardingRevocationStatements(env, { userId, gate: own, gateBindings: ownBindings, now }),
    env.DB.prepare(`DELETE FROM sessions WHERE user_id=? AND ${own}`).bind(userId, ...ownBindings),
    env.DB.prepare(`DELETE FROM invitations WHERE user_id=? AND ${own}`).bind(userId, ...ownBindings),
    env.DB.prepare(`DELETE FROM google_oauth_pending WHERE user_id=? AND ${own}`).bind(userId, ...ownBindings),
  ]);
  const operation = await env.DB.prepare('SELECT * FROM privacy_operations WHERE user_id=? AND intent_hash=? AND environment=?')
    .bind(userId, intentHash, scope).first<Operation>();
  if (!operation) return { deleted: false, pending: false, operationId: null };
  if (operation.state === 'completed') return { deleted: true, pending: false, operationId: operation.id };
  if (!await recordOperation(env, operation)) return { deleted: false, pending: true, operationId: operation.id };
  const deleted = await purgeRecordedOperation(env, operation.id);
  return { deleted, pending: !deleted, operationId: operation.id };
}

/** Pending users stay disabled even if the intent expires while R2 is unavailable. */
export async function recoverPrivacyOperations(env: PrivacyEnv, limit = 25): Promise<number> {
  const scope = environment(env);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new PipelineError('Invalid privacy recovery limit.', 400, 'privacy_limit_invalid');
  const rows = await env.DB.prepare("SELECT * FROM privacy_operations WHERE environment=? AND state!='completed' ORDER BY updated_at,id LIMIT ?")
    .bind(scope, limit).all<Operation>();
  const results = await Promise.allSettled(rows.results.map(async (operation) => await recordOperation(env, operation)
    && await purgeRecordedOperation(env, operation.id)));
  return results.filter((result) => result.status === 'fulfilled' && result.value).length;
}

/** Operator-only data. It contains opaque account IDs and must never be public. */
export async function readPrivacyLedgerPage(env: PrivacyEnv, options: { cursor?: string; limit?: number } = {}): Promise<{ records: PrivacyRecord[]; cursor: string | null }> {
  const scope = environment(env); const limit = options.limit ?? 100;
  if (!env.PRIVACY_LEDGER) throw new PipelineError('Independent privacy ledger unavailable.', 503, 'privacy_ledger_unavailable');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || (options.cursor && options.cursor.length > 2000)) {
    throw new PipelineError('Invalid privacy ledger page.', 400, 'privacy_limit_invalid');
  }
  try {
    const page = await bounded(env.PRIVACY_LEDGER.list({ prefix: `erasures/v1/${scope}/`, limit,
      ...(options.cursor ? { cursor: options.cursor } : {}) }));
    const records = await Promise.all(page.objects.map((object) => readRecord(env.PRIVACY_LEDGER!, object.key, scope)));
    if (page.truncated && !page.cursor) throw new Error('privacy_ledger_cursor_missing');
    return { records, cursor: page.truncated ? page.cursor : null };
  } catch { throw new PipelineError('Independent privacy ledger unavailable.', 503, 'privacy_ledger_unavailable'); }
}

/** Reapply an independently obtained record, including accounts absent from this backup. */
export async function applyPrivacyRecord(env: Env, value: unknown): Promise<void> {
  const result = privacyRecordSchema.safeParse(value);
  if (!result.success || result.data.environment !== environment(env)) throw new PipelineError('Invalid privacy record.', 400, 'privacy_record_invalid');
  const record = result.data; const key = privacyLedgerKey(record); const now = Date.now();
  await env.DB.prepare(`INSERT INTO privacy_operations(id,user_id,environment,ledger_key,state,created_at,updated_at)
    VALUES (?,?,?,?,'recorded',?,?) ON CONFLICT(user_id) DO UPDATE SET state=CASE WHEN privacy_operations.state='completed' THEN 'completed' ELSE 'recorded' END,
    error_code=NULL,updated_at=excluded.updated_at WHERE privacy_operations.environment=excluded.environment
      AND privacy_operations.ledger_key=excluded.ledger_key`).bind(record.operationId, record.userId, record.environment, key, record.requestedAt, now).run();
  const operation = await env.DB.prepare('SELECT id FROM privacy_operations WHERE user_id=? AND environment=?')
    .bind(record.userId, record.environment).first<{ id: string }>();
  if (!operation || !await purgeRecordedOperation(env, operation.id)) throw new PipelineError('Privacy replay incomplete.', 503, 'privacy_replay_incomplete');
}

/** Call while restored service is fenced; a page is not a complete restore gate. */
export async function replayPrivacyLedger(env: PrivacyEnv, options: { cursor?: string; limit?: number } = {}): Promise<{ applied: number; cursor: string | null }> {
  const page = await readPrivacyLedgerPage(env, options);
  for (const record of page.records) await applyPrivacyRecord(env, record);
  return { applied: page.records.length, cursor: page.cursor };
}
