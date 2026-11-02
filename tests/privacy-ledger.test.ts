import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../packages/contracts/src/index';
import { createDeletionIntent, eraseAccount } from '../apps/api/src/account';
import { applyPrivacyRecord, privacyLedgerKey, readPrivacyLedgerPage, recoverPrivacyOperations, replayPrivacyLedger,
  requestErasure, type PrivacyRecord } from '../apps/api/src/privacy-ledger';
import { encryptText, sha256 } from '../packages/security/src/index';
import { getWebConversation } from '../apps/api/src/store';
import { inviteAlex, testEnv } from './setup';

function fakeBucket() {
  const records = new Map<string, string>();
  const put = vi.fn(async (key: string, value: string, _options?: R2PutOptions) => {
    if (records.has(key)) return null;
    records.set(key, value); return { key, size: value.length, etag: 'fixture-etag' };
  });
  const get = vi.fn(async (key: string) => {
    const value = records.get(key); if (value === undefined) return null;
    return { key, size: new TextEncoder().encode(value).byteLength, json: async () => JSON.parse(value) as unknown };
  });
  const list = vi.fn(async (options: R2ListOptions) => {
    const keys = [...records.keys()].filter((key) => key.startsWith(options.prefix ?? '')).sort();
    const offset = Number(options.cursor ?? 0); const limit = options.limit ?? 100;
    const selected = keys.slice(offset, offset + limit); const truncated = offset + selected.length < keys.length;
    return { objects: selected.map((key) => ({ key })), truncated, ...(truncated ? { cursor: String(offset + selected.length) } : {}) };
  });
  return { records, put, get, list, bucket: { put, get, list } as unknown as R2Bucket };
}
function runtime(bucket?: R2Bucket, scope = 'staging'): Env & { PRIVACY_LEDGER?: R2Bucket } {
  return { ...testEnv, APP_ENV: scope, ...(bucket ? { PRIVACY_LEDGER: bucket } : {}) };
}
async function intent(userId = 'u_alex', expiresAt = Date.now() + 60_000) {
  const token = `fixture-erasure-${crypto.randomUUID()}`;
  await testEnv.DB.prepare('INSERT INTO account_deletion_intents(token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)')
    .bind(await sha256(token), userId, expiresAt, Date.now()).run();
  return token;
}
async function userState(userId = 'u_alex') {
  return testEnv.DB.prepare('SELECT status FROM users WHERE id=?').bind(userId).first();
}
async function legacyData() {
  const local = { ...testEnv, APP_ENV: 'local', MESSAGING_PROVIDER: 'mock', MODEL_PROVIDER: 'mock' };
  const conversationId = await getWebConversation(local, 'u_alex');
  const body = await encryptText('A private message that an old backup contains.', local.CONTENT_ENCRYPTION_KEY);
  await testEnv.DB.batch([
    testEnv.DB.prepare("INSERT INTO messages(id,conversation_id,role,body_ciphertext,status,created_at) VALUES ('privacy_source',?,'user',?,'received',0)").bind(conversationId, body),
    testEnv.DB.prepare("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES ('old-session','u_alex',?)").bind(Date.now() + 60_000),
    testEnv.DB.prepare(`INSERT INTO google_calendar_connections(user_id,revision,connected,status,scope,access_token_ciphertext,refresh_token_ciphertext,expires_at,created_at,updated_at)
      VALUES ('u_alex',0,1,'connected','https://www.googleapis.com/auth/calendar.events.owned',?,?,?,0,0)`)
      .bind(await encryptText('private-access', local.CONTENT_ENCRYPTION_KEY), await encryptText('private-refresh', local.CONTENT_ENCRYPTION_KEY), Date.now() + 60_000),
    testEnv.DB.prepare(`INSERT INTO model_attempts(message_id,user_id,conversation_id,attempt_token,lease_token,ownership_version,input_digest,model,budget_month,
      reservation_micro_usd,budget_debit_micro_usd,state,created_at,updated_at)
      VALUES ('privacy_source','u_alex',?,'privacy-attempt','privacy-lease',0,'private-digest','gpt-6-luna','2026-10',1000,1000,'dispatched',0,0)`).bind(conversationId),
    testEnv.DB.prepare(`INSERT INTO search_attempts(message_id,user_id,conversation_id,context_revision,day,state,query_digest,attempt_token,created_at,updated_at)
      VALUES ('privacy_source','u_alex',?,0,'2026-10-31','dispatched','private-query','privacy-search-attempt',0,0)`).bind(conversationId),
  ]);
  return { conversationId };
}

describe('Independent privacy ledger and serialized erasure', () => {
  it('writes the minimal independent tombstone before acknowledging cloud deletion', async () => {
    const storage = fakeBucket(); const env = runtime(storage.bucket); const token = await intent();
    const result = await requestErasure(env, 'u_alex', token);
    expect(result).toMatchObject({ deleted: true, pending: false }); expect(result.operationId).toMatch(/^erase_/);
    expect(await userState()).toBeNull(); expect(await userState('u_sam')).toEqual({ status: 'active' });
    const [key, raw] = [...storage.records.entries()][0]!;
    expect(key).toBe('erasures/v1/staging/u_alex.json');
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual(['environment', 'operationId', 'requestedAt', 'userId', 'version']);
    expect(JSON.parse(raw)).toMatchObject({ userId: 'u_alex', operationId: result.operationId, environment: 'staging', version: 1 });
    expect(raw).not.toContain(token); expect(raw).not.toContain('private');
    expect((storage.put.mock.calls[0]![2]!.onlyIf as Headers).get('if-none-match')).toBe('*');
    const row = await env.DB.prepare('SELECT state,intent_hash FROM privacy_operations WHERE id=?').bind(result.operationId).first();
    expect(row).toEqual({ state: 'completed', intent_hash: await sha256(token) });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('disables access immediately but reports pending when the independent ledger is absent', async () => {
    await legacyData(); const env = runtime(); const token = await intent();
    const result = await requestErasure(env, 'u_alex', token);
    expect(result).toMatchObject({ deleted: false, pending: true });
    expect(await userState()).toEqual({ status: 'disabled' });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id='u_alex'").first()).toEqual({ n: 0 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM invitations WHERE user_id='u_alex'").first()).toEqual({ n: 0 });
    expect(await env.DB.prepare("SELECT DISTINCT status FROM bindings WHERE user_id='u_alex'").all()).toMatchObject({ results: [{ status: 'revoked' }] });
    expect(await env.DB.prepare("SELECT mode,lease_token,lease_until FROM conversations WHERE user_id='u_alex'").first())
      .toEqual({ mode: 'human', lease_token: null, lease_until: 0 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE id='privacy_source'").first()).toEqual({ n: 1 });
    expect(await env.DB.prepare('SELECT consumed_by FROM account_deletion_intents WHERE token_hash=?').bind(await sha256(token)).first())
      .toEqual({ consumed_by: result.operationId });
    expect(await eraseAccount(env, 'u_alex', token)).toBe(false);
  });
  it('recovers a pending operation even after the original destructive intent expires', async () => {
    const missing = runtime(); const token = await intent();
    const requested = await requestErasure(missing, 'u_alex', token);
    await testEnv.DB.prepare('UPDATE account_deletion_intents SET expires_at=0').run();
    const storage = fakeBucket(); const env = runtime(storage.bucket);
    expect(await recoverPrivacyOperations(env)).toBe(1); expect(await userState()).toBeNull();
    expect(await recoverPrivacyOperations(env)).toBe(0);
    expect(await requestErasure(env, 'u_alex', token)).toEqual({ deleted: true, pending: false, operationId: requested.operationId });
  });
  it('holds pending on a failed write or failed confirmation read, then completes idempotently', async () => {
    const storage = fakeBucket(); const env = runtime(storage.bucket); const token = await intent();
    storage.put.mockRejectedValueOnce(new Error('SECRET_R2_ERROR'));
    expect(await requestErasure(env, 'u_alex', token)).toMatchObject({ pending: true, deleted: false });
    storage.get.mockRejectedValueOnce(new Error('SECRET_R2_READ_ERROR'));
    expect(await requestErasure(env, 'u_alex', token)).toMatchObject({ pending: true, deleted: false });
    expect(storage.records.size).toBe(1); expect(await recoverPrivacyOperations(env)).toBe(1); expect(storage.records.size).toBe(1);
    expect(JSON.stringify(await env.DB.prepare('SELECT * FROM privacy_operations').all())).not.toContain('SECRET_R2');
  });
  it('serializes concurrent same-token requests into one operation and one immutable record', async () => {
    const storage = fakeBucket(); const env = runtime(storage.bucket); const token = await intent();
    const results = await Promise.all([requestErasure(env, 'u_alex', token), requestErasure(env, 'u_alex', token)]);
    expect(results.every((result) => result.deleted)).toBe(true);
    expect(new Set(results.map((result) => result.operationId)).size).toBe(1); expect(storage.records.size).toBe(1);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM privacy_operations').first()).toEqual({ n: 1 });
  });
  it('never accepts another user, invalid, expired, or already superseded destructive intent', async () => {
    const storage = fakeBucket(); const env = runtime(storage.bucket); const token = await intent();
    expect(await requestErasure(env, 'u_sam', token)).toEqual({ deleted: false, pending: false, operationId: null });
    expect(await requestErasure(env, 'u_alex', 'unknown-token')).toEqual({ deleted: false, pending: false, operationId: null });
    await env.DB.prepare('UPDATE account_deletion_intents SET expires_at=0').run();
    expect(await requestErasure(env, 'u_alex', token)).toEqual({ deleted: false, pending: false, operationId: null });
    expect(await userState()).toEqual({ status: 'active' }); expect(storage.put).not.toHaveBeenCalled();
  });
  it('preserves possible-charge holds and request counts while removing private caches and OAuth credentials', async () => {
    await legacyData(); const storage = fakeBucket(); const env = runtime(storage.bucket);
    expect((await requestErasure(env, 'u_alex', await intent())).deleted).toBe(true);
    expect(await env.DB.prepare("SELECT state,budget_debit_micro_usd,input_digest,response_ciphertext FROM model_attempts WHERE message_id='privacy_source'").first())
      .toEqual({ state: 'unknown', budget_debit_micro_usd: 1000, input_digest: '', response_ciphertext: null });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM search_attempts WHERE user_id='u_alex'").first()).toEqual({ n: 1 });
    expect(await env.DB.prepare("SELECT query_digest,result_ciphertext FROM search_attempts WHERE message_id='privacy_source'").first())
      .toEqual({ query_digest: '', result_ciphertext: null });
    for (const table of ['google_calendar_connections', 'sessions', 'conversations']) {
      expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id='u_alex'`).first()).toEqual({ n: 0 });
    }
  });
  it('prevents pending account reactivation and completed opaque-account-ID reuse', async () => {
    const env = runtime(); const token = await intent(); await requestErasure(env, 'u_alex', token);
    await expect(env.DB.prepare("UPDATE users SET status='active' WHERE id='u_alex'").run()).rejects.toThrow('privacy_erasure_pending_or_completed');
    const storage = fakeBucket(); await recoverPrivacyOperations(runtime(storage.bucket));
    await expect(env.DB.prepare("INSERT INTO users(id,display_name,status,created_at) VALUES('u_alex','Recreated','active',0)").run())
      .rejects.toThrow('privacy_erasure_pending_or_completed');
  });
  it('keeps the local boolean erasure API compatible without making an R2 durability claim', async () => {
    const local = runtime(undefined, 'local');
    const confirmation = await createDeletionIntent(local, 'u_alex', inviteAlex, 'DELETE MY PLAUSE ACCOUNT');
    expect(await eraseAccount(local, 'u_alex', confirmation.confirmationToken)).toBe(true);
    expect(await userState()).toBeNull();
    expect(await local.DB.prepare('SELECT environment,state FROM privacy_operations').first()).toEqual({ environment: 'local', state: 'completed' });
  });
});

describe('Independent ledger replay against an older restored snapshot', () => {
  it('purges restored accounts, sessions and provider grants without resetting quota tombstones', async () => {
    await legacyData(); const storage = fakeBucket(); const env = runtime(storage.bucket);
    await requestErasure(env, 'u_alex', await intent());
    // Simulate loading the pre-erasure account/auth rows from an older D1 dump;
    // the independently stored R2 record is deliberately left untouched.
    await env.DB.prepare('DELETE FROM privacy_operations').run();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO users(id,display_name,status,created_at) VALUES('u_alex','Alex restored','active',0)"),
      env.DB.prepare("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES('restored-session','u_alex',?)").bind(Date.now() + 60_000),
      env.DB.prepare(`INSERT INTO google_calendar_connections(user_id,revision,connected,status,scope,access_token_ciphertext,refresh_token_ciphertext,expires_at,created_at,updated_at)
        VALUES('u_alex',0,1,'connected','https://www.googleapis.com/auth/calendar.events.owned','restored-access','restored-refresh',?,0,0)`).bind(Date.now() + 60_000),
    ]);
    expect(await userState()).toEqual({ status: 'active' });
    expect(await replayPrivacyLedger(env)).toEqual({ applied: 1, cursor: null });
    expect(await userState()).toBeNull();
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id='u_alex'").first()).toEqual({ n: 0 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM google_calendar_connections WHERE user_id='u_alex'").first()).toEqual({ n: 0 });
    expect(await env.DB.prepare("SELECT budget_debit_micro_usd FROM model_attempts WHERE message_id='privacy_source'").first())
      .toEqual({ budget_debit_micro_usd: 1000 });
  });
  it('retains an erasure even when the account was not present in the older snapshot', async () => {
    const env = runtime();
    const record: PrivacyRecord = { version: 1, environment: 'staging', userId: 'absent_opaque_account', operationId: 'erase_absent_fixture', requestedAt: Date.now() };
    await applyPrivacyRecord(env, record);
    expect(await env.DB.prepare("SELECT state FROM privacy_operations WHERE user_id='absent_opaque_account'").first()).toEqual({ state: 'completed' });
    await expect(env.DB.prepare("INSERT INTO users(id,display_name,status,created_at) VALUES('absent_opaque_account','Resurrected','active',0)").run())
      .rejects.toThrow('privacy_erasure_pending_or_completed');
  });
  it('paginates every independently scoped record and does not consume another environment', async () => {
    const storage = fakeBucket(); const env = runtime(storage.bucket);
    for (const [userId, scope] of [['u_alex', 'staging'], ['u_sam', 'staging'], ['other_environment', 'production']] as const) {
      const record = { version: 1 as const, environment: scope, userId, operationId: `erase_${userId}`, requestedAt: Date.now() };
      storage.records.set(privacyLedgerKey(record), JSON.stringify(record));
    }
    const first = await readPrivacyLedgerPage(env, { limit: 1 }); expect(first.records).toHaveLength(1); expect(first.cursor).not.toBeNull();
    const applied = await replayPrivacyLedger(env, { limit: 1 }); expect(applied.applied).toBe(1);
    const second = await replayPrivacyLedger(env, { limit: 1, cursor: applied.cursor! }); expect(second).toEqual({ applied: 1, cursor: null });
    expect(await userState()).toBeNull(); expect(await userState('u_sam')).toBeNull();
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM privacy_operations WHERE user_id='other_environment'").first()).toEqual({ n: 0 });
  });
  it('rejects corrupt, cross-environment, wrong-key, oversized and extra-content records', async () => {
    const storage = fakeBucket(); const env = runtime(storage.bucket);
    const valid = { version: 1, environment: 'staging', userId: 'u_alex', operationId: 'erase_test', requestedAt: Date.now() };
    for (const value of [{ ...valid, environment: 'production' }, { ...valid, userId: '../u_alex' }, { ...valid, email: 'private@example.com' }]) {
      await expect(applyPrivacyRecord(env, value)).rejects.toMatchObject({ code: 'privacy_record_invalid' });
    }
    storage.records.set('erasures/v1/staging/wrong_user.json', JSON.stringify(valid));
    await expect(replayPrivacyLedger(env)).rejects.toMatchObject({ code: 'privacy_ledger_unavailable' });
    storage.records.clear(); storage.records.set('erasures/v1/staging/u_alex.json', 'x'.repeat(2049));
    await expect(replayPrivacyLedger(env)).rejects.toMatchObject({ code: 'privacy_ledger_unavailable' });
    expect(await userState()).toEqual({ status: 'active' });
  });
  it('fails closed when an independent ledger cannot be read during restore', async () => {
    await expect(replayPrivacyLedger(runtime())).rejects.toMatchObject({ code: 'privacy_ledger_unavailable' });
    await expect(recoverPrivacyOperations(runtime(), 0)).rejects.toMatchObject({ code: 'privacy_limit_invalid' });
    await expect(requestErasure(runtime(undefined, 'invalid-environment'), 'u_alex', await intent())).rejects.toMatchObject({ code: 'privacy_configuration_invalid' });
  });
});
