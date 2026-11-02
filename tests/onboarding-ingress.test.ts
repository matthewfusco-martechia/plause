import { describe, expect, it, vi } from 'vitest';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../apps/api/src/index';
import type { Env, QueueJob } from '../packages/contracts/src/index';
import { sha256 } from '../packages/security/src/index';
import { testEnv } from './setup';
import original from './fixtures/sunshine/official-conversationMessageEvent.json';
import receiptOriginal from './fixtures/sunshine/official-conversationMessageDeliveryChannelEvent.json';

// Apple variants of the checked-in official Sunshine fixtures are synthetic.
// Every provider operation is intercepted; no live OAuth, provider or model call.
const origin = 'https://staging.plause.si';
const app = original.app.id, destination = original.events[0]!.payload.conversation.id;
const subject = original.events[0]!.payload.message.author.userId;
function runtime(): Env {
  return { ...testEnv, APP_ENV: 'staging', PUBLIC_ORIGIN: origin, MODEL_PROVIDER: 'mock', MESSAGING_PROVIDER: 'sunshine',
    LIVE_MESSAGING_ENABLED: 'true', APPLE_CHANNEL_APPROVED: 'true', ONBOARDING_MESSAGES_ENABLED: 'true', ONBOARDING_GLOBAL_DAILY_LIMIT: '500',
    AUTH_GOOGLE_ENABLED: 'true', AUTH_GOOGLE_CLIENT_ID: 'fixture.apps.googleusercontent.com', AUTH_GOOGLE_CLIENT_SECRET: 'synthetic-google-client-secret',
    SUNSHINE_SUBDOMAIN: 'fixture', SUNSHINE_APP_ID: app, SUNSHINE_APPLE_INTEGRATION_ID: 'apple_fixture',
    SUNSHINE_WEBHOOK_ID: original.webhook.id, SUNSHINE_WEBHOOK_SECRET: 'synthetic-provider-webhook-key',
    SUNSHINE_KEY_ID: 'fixture_key', SUNSHINE_KEY_SECRET: 'synthetic-provider-api-key',
    SUNSHINE_BOT_SWITCHBOARD_ID: original.events[0]!.payload.conversation.activeSwitchboardIntegration.id,
    SUNSHINE_AGENT_SWITCHBOARD_ID: 'staff_fixture', JOBS: { send: vi.fn(async () => {}) } as unknown as Env['JOBS'] };
}
function message(text = 'Hello, I would like an assistant.') {
  const body = structuredClone(original), event = body.events[0]!;
  event.id = crypto.randomUUID(); event.createdAt = new Date().toISOString(); event.payload.message.id = crypto.randomUUID();
  event.payload.message.content.text = text; event.payload.message.source.type = 'apple'; event.payload.message.source.integrationId = 'apple_fixture';
  return body;
}
async function request(env: Env, pathname: string, init: RequestInit = {}) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(origin + pathname, init) as Request<unknown, IncomingRequestCfProperties>, env, ctx);
  await waitOnExecutionContext(ctx); return response;
}
function ingress(env: Env, body: unknown, key = env.SUNSHINE_WEBHOOK_SECRET!) {
  return request(env, '/webhooks/messaging/sunshine', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key }, body: JSON.stringify(body) });
}
async function cookie(userId = 'u_alex') {
  const now = Date.now(), token = `synthetic-session-${crypto.randomUUID()}`, identity = `identity_${crypto.randomUUID()}`;
  await testEnv.DB.batch([
    testEnv.DB.prepare(`INSERT INTO external_identities(id,user_id,issuer,subject,subject_digest,created_at)
      VALUES (?,?,'https://accounts.google.com',?,?,?)`).bind(identity, userId, `subject-${userId}`, await sha256(`subject-${userId}`), now),
    testEnv.DB.prepare(`INSERT INTO sessions(token_hash,user_id,expires_at,auth_method,authenticated_at,identity_id)
      VALUES (?,?,?,'google',?,?)`).bind(await sha256(token), userId, now + 3600000, now, identity),
  ]);
  return `plause_session=${token}`;
}
function browserHeaders(session: string) { return { cookie: session, origin, 'content-type': 'application/json' }; }
async function begin(env: Env, session: string) {
  const response = await request(env, '/api/channel-links', { method: 'POST', headers: browserHeaders(session), body: JSON.stringify({ replyConsent: true, proactiveConsent: false }) });
  expect(response.status).toBe(201);
  return await response.json() as { id: string; code: string; command: string; expiresAt: number };
}
async function drain(env: Env) {
  const ack = vi.fn(), retry = vi.fn();
  await worker.queue({ queue: 'fixture-jobs', messages: [{ body: { kind: 'messages_onboarding' }, id: crypto.randomUUID(), ack, retry }] } as unknown as MessageBatch<QueueJob>, env);
  expect(ack).toHaveBeenCalledTimes(1); expect(retry).not.toHaveBeenCalled();
}
function provider() {
  let sequence = 0;
  const network = vi.fn<typeof fetch>(async (url, init) => {
    expect(String(url)).toBe(`https://fixture.zendesk.com/sc/v2/apps/${app}/conversations/${destination}/messages`);
    expect(init?.method).toBe('POST');
    const body = JSON.parse(String(init?.body));
    expect(body.destination).toEqual({ integrationId: 'apple_fixture' }); expect(body.author).toEqual({ type: 'business', subtypes: ['AI'] });
    return Response.json({ messages: [{ id: `provider_notice_${++sequence}`, author: { type: 'business' } }] });
  });
  vi.stubGlobal('fetch', network); return network;
}
async function count(env: Env, table: 'users' | 'messages' | 'inbox' | 'webhook_events' | 'model_attempts' | 'messaging_onboarding_notices' | 'messaging_onboarding_events') {
  return (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
}

describe('Messages first-contact HTTP, queue and account integration', () => {
  it('persists an unlinked public greeting, queues work and sends one deterministic notice without private history', async () => {
    const env = runtime(), body = message('A confidential first question that must not be retained.');
    expect((await ingress(env, body)).status).toBe(202);
    expect(env.JOBS.send).toHaveBeenCalledWith({ kind: 'messages_onboarding' });
    expect(await count(env, 'users')).toBe(2); expect(await count(env, 'messages')).toBe(0); expect(await count(env, 'inbox')).toBe(0);
    expect(await count(env, 'webhook_events')).toBe(0); expect(await count(env, 'model_attempts')).toBe(0);
    const journal = await env.DB.prepare('SELECT * FROM messaging_onboarding_events').all();
    expect(JSON.stringify(journal.results)).not.toContain(body.events[0]!.payload.message.content.text);
    expect(JSON.stringify(journal.results)).not.toContain(subject);
    const network = provider(); await drain(env); await drain(env);
    expect(network).toHaveBeenCalledTimes(1);
    const wire = JSON.parse(String(network.mock.calls[0]![1]!.body));
    expect(wire.content.text).toContain('I’m Plause, an AI assistant'); expect(wire.content.text).toContain(`${origin}/?onboarding=messages`);
    expect(wire.content.text).toContain('signup is currently closed'); expect(wire.content.text).not.toContain('confidential');
    expect((await ingress(env, body)).status).toBe(202); await drain(env); expect(network).toHaveBeenCalledTimes(1);
  });

  it('requires authenticated webhook and correct Apple app/integration before creating public work', async () => {
    const env = runtime(), body = message();
    expect((await ingress(env, body, 'forged-key')).status).toBe(401);
    const otherApp = structuredClone(body); otherApp.app.id = 'untrusted_app';
    expect((await ingress(env, otherApp)).status).toBe(400);
    const otherIntegration = structuredClone(body); otherIntegration.events[0]!.payload.message.source.integrationId = 'untrusted_integration';
    const response = await ingress(env, otherIntegration); expect(response.status).toBe(202); expect(await response.json()).toEqual({ accepted: 0 });
    expect(await count(env, 'messaging_onboarding_notices')).toBe(0); expect(await count(env, 'messages')).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps first-contact disabled unless explicitly configured and never falls back to a model turn', async () => {
    const env = { ...runtime(), ONBOARDING_MESSAGES_ENABLED: 'false' };
    expect((await ingress(env, message())).status).toBe(202); await drain(env);
    expect(await count(env, 'messaging_onboarding_notices')).toBe(0); expect(await count(env, 'messages')).toBe(0);
    expect(env.JOBS.send).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  it('completes possession proof and separate signed-in confirmation with exact-once public notices', async () => {
    const env = runtime(), session = await cookie(), first = message();
    await ingress(env, first); const network = provider(); await drain(env);
    const link = await begin(env, session), proof = message(link.command);
    expect((await ingress(env, proof)).status).toBe(202); await drain(env);
    expect(network).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(network.mock.calls[1]![1]!.body)).content.text).toContain('not linked yet');
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM bindings WHERE provider='sunshine'").first()).toEqual({ n: 0 });
    const status = await request(env, `/api/channel-links/${link.id}`, { headers: browserHeaders(session) });
    expect(status.status).toBe(200); expect(await status.json()).toMatchObject({ status: 'proved', proof: { provider: 'sunshine', channel: 'apple_business' } });
    const confirmation = await request(env, `/api/channel-links/${link.id}/confirm`, { method: 'POST', headers: browserHeaders(session), body: '{}' });
    expect(confirmation.status).toBe(200); await drain(env);
    expect(network).toHaveBeenCalledTimes(3);
    expect(JSON.parse(String(network.mock.calls[2]![1]!.body)).content.text).toContain('linked to your Plause account');
    expect(await env.DB.prepare("SELECT user_id,status,provider_conversation_id,proactive_consent_at FROM bindings WHERE provider='sunshine'").first())
      .toEqual({ user_id: 'u_alex', status: 'active', provider_conversation_id: destination, proactive_consent_at: null });
    // A public event replay cannot be converted to a private AI input after linking.
    expect((await ingress(env, first)).status).toBe(202); expect((await ingress(env, proof)).status).toBe(202);
    const repeat = await request(env, `/api/channel-links/${link.id}/confirm`, { method: 'POST', headers: browserHeaders(session), body: '{}' });
    expect(repeat.status).toBe(200); await drain(env); expect(network).toHaveBeenCalledTimes(3);
    expect(await count(env, 'messages')).toBe(0); expect(await count(env, 'inbox')).toBe(0); expect(await count(env, 'model_attempts')).toBe(0);
    const serialized = JSON.stringify((await env.DB.prepare('SELECT * FROM messaging_onboarding_notices').all()).results);
    expect(serialized).not.toContain(link.code); expect(serialized).not.toContain(subject);
  });

  it('does not expose or confirm the original user link through another signed-in account', async () => {
    const env = runtime(), owner = await cookie(), other = await cookie('u_sam'), link = await begin(env, owner);
    expect((await ingress(env, message(link.command))).status).toBe(202);
    const read = await request(env, `/api/channel-links/${link.id}`, { headers: browserHeaders(other) }); expect(read.status).toBe(404);
    const confirm = await request(env, `/api/channel-links/${link.id}/confirm`, { method: 'POST', headers: browserHeaders(other), body: '{}' });
    expect(confirm.status).toBe(409); expect(await confirm.json()).toEqual({ error: 'channel_link_conflict' });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM bindings WHERE provider='sunshine'").first()).toEqual({ n: 0 });
    expect(await count(env, 'messages')).toBe(0); expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['invalid', 'unknown', 'expired'] as const)('acknowledges %s proof without turning codes into welcome or model input', async (kind) => {
    const env = runtime(); let command = 'link plause wrong';
    if (kind === 'unknown') command = `link plause ${'a'.repeat(43)}`;
    if (kind === 'expired') {
      const link = await begin(env, await cookie()); command = link.command;
      await env.DB.prepare('UPDATE channel_link_challenges SET expires_at=0 WHERE id=?').bind(link.id).run();
    }
    const response = await ingress(env, message(command)); expect(response.status).toBe(202); await drain(env);
    expect(await count(env, 'messaging_onboarding_notices')).toBe(0); expect(await count(env, 'messaging_onboarding_events')).toBe(0);
    expect(await count(env, 'messages')).toBe(0); expect(await count(env, 'model_attempts')).toBe(0); expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects provider event reuse across public greeting and possession-proof namespaces', async () => {
    const env = runtime(), first = message(); expect((await ingress(env, first)).status).toBe(202);
    const link = await begin(env, await cookie()), conflicting = structuredClone(first);
    conflicting.events[0]!.payload.message.content.text = link.command;
    const response = await ingress(env, conflicting); expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: 'provider_event_conflict' });
    expect(await env.DB.prepare('SELECT status FROM channel_link_challenges WHERE id=?').bind(link.id).first()).toEqual({ status: 'pending' });
    expect(await count(env, 'messages')).toBe(0); expect(await count(env, 'messaging_onboarding_notices')).toBe(1);
  });

  it('handles authenticated public channel receipts without claiming device delivery or creating private history', async () => {
    const env = runtime(); await ingress(env, message()); const network = provider(); await drain(env);
    const body = structuredClone(receiptOriginal), event = body.events[0]!;
    event.id = crypto.randomUUID(); event.createdAt = new Date().toISOString();
    event.payload.destination.type = 'apple'; event.payload.destination.integrationId = 'apple_fixture';
    event.payload.message.id = 'provider_notice_1';
    const response = await ingress(env, body); expect(response.status).toBe(202); expect(await response.json()).toEqual({ accepted: 1 });
    expect((await ingress(env, body)).status).toBe(202); await drain(env);
    expect(await env.DB.prepare('SELECT status FROM messaging_onboarding_notices').first()).toEqual({ status: 'sent' });
    expect(await count(env, 'messages')).toBe(0); expect(await count(env, 'model_attempts')).toBe(0); expect(network).toHaveBeenCalledTimes(1);
  });

  it('does not queue public notices while restore is locked', async () => {
    const env = runtime(); await env.DB.prepare("INSERT INTO system_settings(key,value) VALUES('restore_locked','true')").run();
    const response = await ingress(env, message()); expect(response.status).toBe(503);
    expect(await count(env, 'messaging_onboarding_notices')).toBe(0); expect(fetch).not.toHaveBeenCalled();
  });
});
