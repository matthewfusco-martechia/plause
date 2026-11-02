import { describe, expect, it, vi } from 'vitest';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../apps/api/src/index';
import { getConversationView, getWebConversation } from '../apps/api/src/store';
import { ingestEvent, processConversation } from '../apps/api/src/pipeline';
import { prepareReminderCommand, reminderStatements, enqueueDueReminders } from '../apps/api/src/reminder-store';
import { acknowledgeWebDelivery } from '../packages/messaging-web/src/index';
import { assertRuntimeProviders, publicOrigin, requestAllowed, proactiveChannelAllowed } from '../packages/contracts/src/runtime-policy';
import { sha256 } from '../packages/security/src/index';
import type { Env } from '../packages/contracts/src/index';
import { testEnv } from './setup';

const origin = 'https://plause-staging.example.com';
const runtime = (): Env => ({ ...testEnv, APP_ENV: 'staging', PUBLIC_ORIGIN: origin, MESSAGING_PROVIDER: 'web',
  JOBS: { send: vi.fn(async () => {}) } as unknown as Env['JOBS'] });
async function request(env: Env, path: string, init: RequestInit = {}) {
  const ctx = createExecutionContext();
  const result = await worker.fetch(new Request(origin + path, init) as Request<unknown, IncomingRequestCfProperties>, env, ctx);
  await waitOnExecutionContext(ctx); return result;
}
async function fixtureSession(user = 'u_alex') {
  const token = `synthetic-verified-cloud-session-${user}-with-entropy`;
  const now = Date.now(), identity = `identity_${user}`;
  await testEnv.DB.batch([
    testEnv.DB.prepare(`INSERT INTO external_identities(id,user_id,issuer,subject,subject_digest,created_at)
      VALUES (?,?,'https://accounts.google.com',?,?,?)`).bind(identity, user, `sub-${user}`, await sha256(`sub-${user}`), now),
    testEnv.DB.prepare(`INSERT INTO sessions(token_hash,user_id,expires_at,auth_method,authenticated_at,identity_id)
      VALUES (?,?,?,'google',?,?)`).bind(await sha256(token), user, now + 3600000, now, identity),
  ]);
  return `plause_session=${token}`;
}
async function turn(env: Env, text = 'Hello Plause') {
  const id = await getWebConversation(env, 'u_alex');
  const result = await ingestEvent(env, { schemaVersion: 1, type: 'message.received', channel: 'web',
    eventId: crypto.randomUUID(), messageId: crypto.randomUUID(), occurredAt: new Date().toISOString(), text,
    subject: { provider: 'web', businessId: 'plause-local', subjectId: 'u_alex' } });
  return { ...result, id };
}

describe('cloud runtime policy', () => {
  it.each(['https://localhost','http://plause.example.com','https://plause.example.com/path','https://user:pass@plause.example.com','https://plause.example.com/'])('rejects unsafe public origin %s', (PUBLIC_ORIGIN) => {
    expect(() => publicOrigin({ ...runtime(), PUBLIC_ORIGIN })).toThrow();
  });
  it('accepts separate HTTPS web staging and rejects requests for another origin', () => {
    const env = runtime(); expect(publicOrigin(env)).toBe(origin);
    expect(requestAllowed(env, new Request(origin))).toBe(true);
    expect(requestAllowed(env, new Request('https://other.example.com'))).toBe(false);
    expect(() => assertRuntimeProviders(env)).not.toThrow();
  });
  it('requires actual model and transport selection in production, including a web fallback before Apple is enabled', () => {
    expect(() => assertRuntimeProviders({ ...runtime(), APP_ENV: 'production' })).toThrow();
    expect(() => assertRuntimeProviders({ ...runtime(), APP_ENV: 'production', MODEL_PROVIDER: 'openai' })).not.toThrow();
    expect(() => assertRuntimeProviders({ ...runtime(), APP_ENV: 'production', MODEL_PROVIDER: 'openai', MESSAGING_PROVIDER: 'mock' })).toThrow();
    expect(() => assertRuntimeProviders({ ...runtime(), MESSAGING_PROVIDER: 'sunshine' })).toThrow();
  });
  it('defaults Apple proactive delivery off independently of reply approval', () => {
    const env = { ...runtime(), MESSAGING_PROVIDER: 'sunshine', LIVE_MESSAGING_ENABLED: 'true', APPLE_CHANNEL_APPROVED: 'true' };
    expect(proactiveChannelAllowed(env, 'apple_business')).toBe(false);
    expect(proactiveChannelAllowed({ ...env, APPLE_PROACTIVE_ENABLED: 'true' }, 'apple_business')).toBe(true);
  });
});

describe('authenticated web delivery', () => {
  it('reports missing cloud prerequisites and a restore lock truthfully without exposing private configuration', async () => {
    const env = runtime();
    const unavailable = await request(env, '/ready'); expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({ ready: false, privacyLedgerConfigured: false, identityConfigured: false, liveAcceptanceVerified: false });
    await env.DB.prepare("INSERT INTO system_settings(key,value) VALUES ('restore_locked','true')").run();
    const cookie = await fixtureSession();
    expect((await request(env, '/api/account/export', { headers: { cookie } })).status).toBe(503);
  });
  it('does not commit a reply when restore maintenance begins after generation and before encryption/commit', async () => {
    const env = runtime(), accepted = await turn(env);
    await processConversation(env, accepted.id, { beforeModelCommit: async () => {
      await env.DB.prepare("INSERT INTO system_settings(key,value) VALUES ('restore_locked','true')").run();
    } });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE role='assistant'").first()).toEqual({ n: 0 });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM web_delivery_receipts').first()).toEqual({ n: 0 });
  });
  it('publishes a real web receipt once and waits for an authenticated client acknowledgment before delivered', async () => {
    const env = runtime(), accepted = await turn(env);
    await processConversation(env, accepted.id);
    await processConversation(env, accepted.id);
    const reply = (await getConversationView(env, 'u_alex', accepted.id))!.messages.find((m) => m.role === 'assistant')!;
    expect(reply.status).toBe('sent');
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM web_delivery_receipts').first()).toEqual({ n: 1 });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM mock_receipts').first()).toEqual({ n: 0 });
    const cookie = await fixtureSession();
    const response = await request(env, `/api/conversations/${accepted.id}/receipts`, { method: 'POST',
      headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify({ messageIds: [reply.id] }) });
    expect(response.status).toBe(200);
    expect((await getConversationView(env, 'u_alex', accepted.id))!.messages.at(-1)?.status).toBe('delivered');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('enforces receipt ownership even when the helper is called without the HTTP route', async () => {
    const env = runtime(), accepted = await turn(env); await processConversation(env, accepted.id);
    const reply = (await getConversationView(env, 'u_alex', accepted.id))!.messages.at(-1)!;
    await acknowledgeWebDelivery(env, 'u_sam', accepted.id, [reply.id]);
    expect((await env.DB.prepare('SELECT state FROM web_delivery_receipts').first())).toEqual({ state: 'sent' });
    await acknowledgeWebDelivery(env, 'u_alex', accepted.id, [reply.id]);
    await env.DB.prepare("UPDATE messages SET status='sent' WHERE id=?").bind(reply.id).run();
    await acknowledgeWebDelivery(env, 'u_sam', accepted.id, [reply.id]);
    expect((await env.DB.prepare('SELECT status FROM messages WHERE id=?').bind(reply.id).first())).toEqual({ status: 'sent' });
  });
  it('hides unpublished assistant content while outbound delivery is paused', async () => {
    const env = runtime(), accepted = await turn(env);
    await processConversation(env, accepted.id, { beforeDispatch: async () => {
      await env.DB.prepare("INSERT INTO system_settings(key,value) VALUES ('outbound_paused','true')").run();
    } });
    expect((await getConversationView(env, 'u_alex', accepted.id))!.messages.filter((m) => m.role === 'assistant')).toEqual([]);
    await env.DB.prepare("UPDATE system_settings SET value='false' WHERE key='outbound_paused'").run();
    await processConversation(env, accepted.id);
    expect((await getConversationView(env, 'u_alex', accepted.id))!.messages.filter((m) => m.role === 'assistant')).toHaveLength(1);
  });
  it('does not expose invitation auth, mock ingress, or customer-controlled resume in staging', async () => {
    const env = runtime(), cookie = await fixtureSession(), conversationId = await getWebConversation(env, 'u_alex');
    expect((await request(env, '/api/session', { method: 'POST' })).status).toBe(404);
    expect((await request(env, '/webhooks/messaging/mock', { method: 'POST' })).status).toBe(404);
    expect((await request(env, `/api/conversations/${conversationId}/handoff`, { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'bot' }) })).status).toBe(403);
    expect((await request(env, '/api/operator/status', { headers: { authorization: `Bearer ${env.OPERATOR_TOKEN}` } })).status).toBe(401);
  });
  it('sends one deterministic handoff acknowledgment while pausing model replies', async () => {
    const env = runtime(), accepted = await turn(env, 'I need human support');
    await processConversation(env, accepted.id);
    const view = (await getConversationView(env, 'u_alex', accepted.id))!;
    expect(view.mode).toBe('human');
    const replies = view.messages.filter((m) => m.role === 'assistant');
    expect(replies).toHaveLength(1); expect(replies[0]!.text).toContain('Staff availability has not been configured');
    expect(replies[0]!.status).toBe('sent');
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM model_attempts').first()).toEqual({ n: 0 });
  });
  it('schedules web reminders in staging using the same durable occurrence fences', async () => {
    const env = runtime(), accepted = await turn(env, 'remind me at 2090-01-01T12:00:00Z: review the plan');
    const reminder = await env.DB.prepare('SELECT id FROM reminders').first<{ id: string }>();
    expect(reminder).not.toBeNull();
    await env.DB.prepare("UPDATE users SET quiet_start='00:00',quiet_end='00:00' WHERE id='u_alex'").run();
    await env.DB.prepare('UPDATE reminders SET next_run_at=? WHERE id=?').bind(Date.now() - 1000, reminder!.id).run();
    expect(await enqueueDueReminders(env)).toBe(1);
    expect(await enqueueDueReminders(env)).toBe(0);
    await processConversation(env, accepted.id);
    expect((await getConversationView(env, 'u_alex', accepted.id))!.messages.some((m) => m.text === 'Reminder: review the plan' && m.status === 'sent')).toBe(true);
  });
});
