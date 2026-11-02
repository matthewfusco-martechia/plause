import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accountRateLimitExempt, assertOperational, enforceAccountApiRateLimit, enforceAuthStartRateLimit,
  journalDeadLetter, maintenanceState, providerCircuitOpen, recoverDeadLetters, runRetention, runtimeOperationsReadiness } from '../apps/api/src/runtime-operations';
import { ingestEvent, processConversation } from '../apps/api/src/pipeline';
import { getWebConversation, resolveBinding } from '../apps/api/src/store';
import type { Env, MessagingEvent, QueueJob } from '../packages/contracts/src/index';
import { rotateEncryptionKeyring } from '../packages/security/src/index';
import { testEnv } from './setup';

const origin = 'http://localhost:8787';
const writes = () => new Request(`${origin}/api/conversations/example/messages`, { method: 'POST' });
const envFor = (overrides: Partial<Env> = {}): Env => ({ ...testEnv,
  JOBS: { send: async (_job: QueueJob) => {} } as unknown as Queue<QueueJob>, ...overrides });
const incoming = (text = 'A private message'): Extract<MessagingEvent, { type: 'message.received' }> => ({
  schemaVersion: 1, type: 'message.received', eventId: crypto.randomUUID(), messageId: crypto.randomUUID(),
  channel: 'mock', subject: { provider: 'mock', businessId: 'plause-local', subjectId: 'mock-alex' }, occurredAt: new Date().toISOString(), text,
});
afterEach(() => vi.useRealTimers());
beforeEach(async () => { await testEnv.DB.batch([testEnv.DB.prepare('DELETE FROM runtime_rate_buckets'), testEnv.DB.prepare('DELETE FROM provider_circuits')]); });

describe('runtime operational controls', () => {
  it('distinguishes restore lock from outbound pause and fails closed for an invalid lock value', async () => {
    expect(await maintenanceState(testEnv)).toEqual({ locked: false, reason: null, outboundPaused: false });
    await testEnv.DB.prepare("INSERT INTO system_settings(key,value) VALUES('outbound_paused','true')").run();
    await expect(assertOperational(testEnv)).resolves.toBeUndefined();
    await expect(assertOperational(testEnv, { outbound: true })).rejects.toMatchObject({ code: 'outbound_paused', status: 503 });
    await testEnv.DB.prepare("INSERT INTO system_settings(key,value) VALUES('restore_locked','unexpected')").run();
    await expect(assertOperational(testEnv)).rejects.toMatchObject({ code: 'restore_locked', status: 503 });
    expect((await maintenanceState(testEnv)).locked).toBe(true);
    await testEnv.DB.prepare("UPDATE system_settings SET value='false'").run();
    await expect(assertOperational(testEnv, { outbound: true })).resolves.toBeUndefined();
  });

  it('enforces the anonymous per-address limit atomically without retaining raw addresses or honoring cloud fixture overrides', async () => {
    const env = envFor({ APP_ENV: 'production' });
    const request = new Request('https://plause.example.com/api/auth/google/start', { method: 'POST',
      headers: { 'cf-connecting-ip': '203.0.113.18', 'x-forwarded-for': '198.51.100.29' } });
    const results = await Promise.allSettled(Array.from({ length: 13 }, () => enforceAuthStartRateLimit(env, request, { localKey: crypto.randomUUID() })));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(10);
    for (const failure of results.filter((result) => result.status === 'rejected')) expect(failure.reason).toMatchObject({ status: 429 });
    const rows = await env.DB.prepare('SELECT * FROM runtime_rate_buckets').all();
    expect(rows.results).toHaveLength(2);
    expect(JSON.stringify(rows.results)).not.toMatch(/203\.0\.113|198\.51\.100/);
    expect(rows.results.every((row) => row.request_count === 10)).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('requires trusted cloud metadata and an explicit local fixture key', async () => {
    await expect(enforceAuthStartRateLimit(envFor({ APP_ENV: 'production' }), writes(), { localKey: 'ignored' }))
      .rejects.toMatchObject({ code: 'trusted_client_address_required' });
    await expect(enforceAuthStartRateLimit(envFor(), writes())).rejects.toMatchObject({ code: 'local_rate_key_required' });
    await expect(enforceAuthStartRateLimit(envFor(), writes(), { localKey: 'local-test-client' })).resolves.toBeUndefined();
    const env = envFor({ APP_ENV: 'staging' });
    await expect(enforceAuthStartRateLimit(env, new Request(origin, { headers: { 'cf-connecting-ip': '2001:db8::1' } })))
      .resolves.toBeUndefined();
    await expect(enforceAuthStartRateLimit(env, new Request(origin, { headers: { 'cf-connecting-ip': '999.1.1.1' } })))
      .rejects.toMatchObject({ code: 'trusted_client_address_required' });
  });

  it('uses one stable bucket across content-key rotation and a fresh fixed window after expiry', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); const fixed = Math.floor(Date.now() / 600_000) * 600_000 + 1000; vi.setSystemTime(fixed);
    const env = envFor();
    for (let index = 0; index < 10; index++) await enforceAuthStartRateLimit(env, writes(), { localKey: 'one-local-client' });
    const rotated = { ...env, CONTENT_ENCRYPTION_KEY: rotateEncryptionKeyring(env.CONTENT_ENCRYPTION_KEY,
      btoa(String.fromCharCode(...new Uint8Array(32).fill(89))), 'rotated') };
    await expect(enforceAuthStartRateLimit(rotated, writes(), { localKey: 'one-local-client' })).rejects.toMatchObject({ status: 429 });
    vi.setSystemTime(fixed + 600_000);
    await expect(enforceAuthStartRateLimit(rotated, writes(), { localKey: 'one-local-client' })).resolves.toBeUndefined();
  });

  it('bounds the global anonymous bucket without charging a rejected address bucket', async () => {
    for (let client = 0; client < 30; client++) {
      await Promise.all(Array.from({ length: 10 }, () => enforceAuthStartRateLimit(envFor(), writes(), { localKey: `client-${client}` })));
    }
    await expect(enforceAuthStartRateLimit(envFor(), writes(), { localKey: 'one-more-client' })).rejects.toMatchObject({ status: 429 });
    const counts = await testEnv.DB.prepare('SELECT request_count,COUNT(*) AS n FROM runtime_rate_buckets GROUP BY request_count ORDER BY request_count').all();
    expect(counts.results).toEqual([{ request_count: 10, n: 30 }, { request_count: 300, n: 1 }]);
  });

  it('limits user writes atomically while preserving privacy, read and receipt access and tenant independence', async () => {
    const env = envFor();
    const results = await Promise.allSettled(Array.from({ length: 63 }, () => enforceAccountApiRateLimit(env, 'u_alex', writes())));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(60);
    await expect(enforceAccountApiRateLimit(env, 'u_sam', writes())).resolves.toBeUndefined();
    for (const [path, method] of [['/api/account/deletion-intent','POST'], ['/api/account','DELETE'], ['/api/memories/export','GET'],
      ['/api/conversations/conv_one/receipts','POST'], ['/api/channel-bindings/binding_one','DELETE'], ['/api/calendar/google','DELETE'], ['/api/session','DELETE']] as const) {
      const request = new Request(`${origin}${path}`, { method }); expect(accountRateLimitExempt(request)).toBe(true);
      await expect(enforceAccountApiRateLimit(env, 'u_alex', request)).resolves.toBeUndefined();
    }
    await expect(enforceAccountApiRateLimit(env, 'u_alex', writes(), { privacyControl: true })).resolves.toBeUndefined();
    await expect(enforceAccountApiRateLimit(env, 'u_alex', writes())).rejects.toMatchObject({ status: 429 });
  });

  it('journals only opaque valid wakeups, deduplicates queue redelivery and never stores arbitrary payloads', async () => {
    const env = envFor(), conversationId = await getWebConversation(env, 'u_alex');
    for (const body of [{ kind: 'conversation', conversationId, text: 'PRIVATE INPUT' }, { kind: 'other', conversationId },
      { kind: 'conversation', conversationId: `${conversationId}\n` }, 'PRIVATE INPUT']) {
      expect(await journalDeadLetter(env, body, 'queue-id')).toEqual({ recorded: false, reason: 'invalid_job' });
    }
    const body = { kind: 'conversation', conversationId };
    expect(await journalDeadLetter(env, body, 'private-queue-id')).toEqual({ recorded: true, duplicate: false });
    expect(await journalDeadLetter(env, body, 'private-queue-id')).toEqual({ recorded: true, duplicate: true });
    const rows = await env.DB.prepare('SELECT * FROM dead_letter_jobs').all(); expect(rows.results).toHaveLength(1);
    expect(JSON.stringify(rows.results)).not.toMatch(/PRIVATE INPUT|private-queue-id/);
    await expect(journalDeadLetter(env, { kind: 'conversation', conversationId: await getWebConversation(env, 'u_sam') }, 'private-queue-id'))
      .rejects.toMatchObject({ code: 'dead_letter_conflict' });
  });

  it('recovers durable pending work after queue failure, then resolves its journal after processing', async () => {
    const send = vi.fn(async (_job: QueueJob) => {}); const env = envFor({ JOBS: { send } as unknown as Queue<QueueJob> });
    const accepted = await ingestEvent(env, incoming()); send.mockClear();
    await journalDeadLetter(env, { kind: 'conversation', conversationId: accepted.conversationId }, 'queue-one');
    expect(await recoverDeadLetters(env)).toEqual({ enqueued: 1, resolved: 0 });
    expect(send).toHaveBeenCalledExactlyOnceWith({ kind: 'conversation', conversationId: accepted.conversationId });
    expect(await recoverDeadLetters(env)).toEqual({ enqueued: 0, resolved: 0 });
    await processConversation(env, accepted.conversationId);
    expect(await recoverDeadLetters(env)).toEqual({ enqueued: 0, resolved: 1 });
    expect(await env.DB.prepare('SELECT state,recovery_attempts FROM dead_letter_jobs').first()).toEqual({ state: 'resolved', recovery_attempts: 1 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps DLQ work durable on queue failure and performs no recovery or retention under restore lock', async () => {
    const env = envFor({ JOBS: { send: async () => { throw new Error('PRIVATE PROVIDER ERROR'); } } as unknown as Queue<QueueJob> });
    const accepted = await ingestEvent(env, incoming());
    await journalDeadLetter(env, { kind: 'conversation', conversationId: accepted.conversationId }, 'queue-two');
    expect(await recoverDeadLetters(env)).toEqual({ enqueued: 0, resolved: 0 });
    expect(await env.DB.prepare('SELECT state,error_code FROM dead_letter_jobs').first()).toEqual({ state: 'pending', error_code: 'queue_unavailable' });
    await env.DB.prepare("INSERT INTO system_settings(key,value) VALUES('restore_locked','true')").run();
    expect(await recoverDeadLetters(env)).toEqual({ enqueued: 0, resolved: 0 });
    expect((await runRetention(env)).webhookPayloadsPurged).toBe(0);
    await expect(journalDeadLetter(env, { kind: 'conversation', conversationId: accepted.conversationId }, 'queue-three'))
      .rejects.toMatchObject({ code: 'restore_locked' });
  });

  it('purges only old terminal webhook payloads, preserves dedupe tombstones, and does not repeat a control after replay', async () => {
    const env = envFor(); const event = incoming('remember: My favorite color is green.');
    const accepted = await ingestEvent(env, event); await processConversation(env, accepted.conversationId);
    const old = Date.now() - 31 * 86_400_000;
    await env.DB.prepare('UPDATE webhook_events SET received_at=?').bind(old).run();
    await env.DB.prepare("INSERT INTO provider_lifecycle_events(provider,business_id,event_id,conversation_id,payload_hash,mutation_token,received_at) VALUES('sunshine','app','old-event',?,'opaque-digest','opaque-token',?)")
      .bind(accepted.conversationId, old).run();
    expect((await runRetention(env)).webhookPayloadsPurged).toBe(1);
    const stored = await env.DB.prepare('SELECT payload_ciphertext,payload_hash FROM webhook_events').first<{ payload_ciphertext: string; payload_hash: string }>();
    expect(stored!.payload_ciphertext).toBe(''); expect(stored!.payload_hash).toMatch(/^[a-f0-9]{64}$/);
    expect((await ingestEvent(env, event)).duplicate).toBe(true);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM memories').first()).toEqual({ n: 1 });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM provider_lifecycle_events').first()).toEqual({ n: 1 });
  });

  it('retains payloads while any uncertain send or charged model outcome is unresolved', async () => {
    const env = envFor(); const accepted = await ingestEvent(env, incoming());
    await processConversation(env, accepted.conversationId);
    const old = Date.now() - 31 * 86_400_000;
    await env.DB.prepare('UPDATE webhook_events SET received_at=?').bind(old).run();
    const source = await env.DB.prepare("SELECT id FROM messages WHERE conversation_id=? AND role='user'").bind(accepted.conversationId).first<{ id: string }>();
    await env.DB.prepare(`INSERT INTO model_attempts(message_id,user_id,conversation_id,attempt_token,lease_token,ownership_version,input_digest,model,budget_month,
      reservation_micro_usd,budget_debit_micro_usd,state,error_code,created_at,updated_at) VALUES(?,'u_alex',?,'held-attempt','old-lease',0,'digest','fixture','2026-10',100,100,'unknown','model_timeout',?,?)`)
      .bind(source!.id, accepted.conversationId, old, old).run();
    expect((await runRetention(env)).webhookPayloadsPurged).toBe(0);
    expect(await env.DB.prepare('SELECT state,budget_debit_micro_usd FROM model_attempts').first()).toEqual({ state: 'unknown', budget_debit_micro_usd: 100 });
    await env.DB.prepare("UPDATE model_attempts SET state='failed'").run();
    await env.DB.prepare("UPDATE outbound_jobs SET status='delivery_unknown'").run();
    expect((await runRetention(env)).webhookPayloadsPurged).toBe(0);
    await env.DB.prepare("UPDATE outbound_jobs SET status='delivered'").run();
    expect((await runRetention(env)).webhookPayloadsPurged).toBe(1);
    expect(await env.DB.prepare('SELECT budget_debit_micro_usd FROM model_attempts').first()).toEqual({ budget_debit_micro_usd: 100 });
  });

  it('opens a content-free provider circuit after five recent failures and holds it until 60s after the newest failure', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); const now = Date.now();
    const env = envFor();
    for (let index = 0; index < 5; index++) await env.DB.prepare(`INSERT INTO search_attempts(message_id,user_id,conversation_id,context_revision,day,state,query_digest,attempt_token,error_code,created_at,updated_at)
      VALUES(?,'opaque-user','opaque-chat',0,'2026-10-31','unknown','',?,'research_timeout',?,?)`)
      .bind(`search-${index}`, `attempt-${index}`, now - 50_000 + index * 10_000, now - 50_000 + index * 10_000).run();
    expect(await providerCircuitOpen(env, 'search')).toBe(true);
    expect(await providerCircuitOpen(env, 'model')).toBe(false);
    vi.setSystemTime(now + 15_000); // Several triggering failures have aged out; the circuit remains latched.
    expect(await providerCircuitOpen(env, 'search')).toBe(true);
    vi.setSystemTime(now + 50_001);
    expect(await providerCircuitOpen(env, 'search')).toBe(false);
    const state = JSON.stringify(await runtimeOperationsReadiness(env));
    expect(state).not.toMatch(/opaque-user|opaque-chat|attempt-/);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM search_attempts').first()).toEqual({ n: 5 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not turn user refusals or revoked authorization into a global provider outage', async () => {
    const now = Date.now();
    for (let index = 0; index < 6; index++) await testEnv.DB.prepare(`INSERT INTO search_attempts(message_id,user_id,conversation_id,context_revision,day,state,query_digest,attempt_token,error_code,created_at,updated_at)
      VALUES(?,'opaque-user','opaque-chat',0,'2026-10-31','failed','',?,'research_context_revoked',?,?)`)
      .bind(`revoked-${index}`, `revoked-attempt-${index}`, now, now).run();
    expect(await providerCircuitOpen(testEnv, 'search')).toBe(false);
    const info = await runtimeOperationsReadiness(testEnv);
    expect(info.encryption).toMatchObject({ configured: true, format: 'legacy', retainedKeyCount: 1 });
  });
});
