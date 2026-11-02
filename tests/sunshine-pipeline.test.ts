import { describe, it, expect, vi } from 'vitest';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../apps/api/src/index';
import { ingestSunshineEvent } from '../apps/api/src/sunshine-ingress';
import { processConversation } from '../apps/api/src/pipeline';
import { getConversationView, resolveBinding } from '../apps/api/src/store';
import { prepareReminderCommand } from '../apps/api/src/reminder-store';
import { normalizeAuthenticatedWebhook, SunshineMessagingClient, type SunshineEvent } from '../packages/messaging-sunshine/src/index';
import type { Env } from '../packages/contracts/src/index';
import { testEnv } from './setup';
import { decryptText } from '../packages/security/src/index';
import { RuntimeMessagingTransport } from '../apps/api/src/transport';
import original from './fixtures/sunshine/official-conversationMessageEvent.json';

const app = original.app.id, providerConversationId = original.events[0]!.payload.conversation.id;
const subjectId = original.events[0]!.payload.message.author.userId;
function runtime(): Env { return { ...testEnv, MESSAGING_PROVIDER: 'sunshine', LIVE_MESSAGING_ENABLED: 'true', APPLE_CHANNEL_APPROVED: 'true',
  SUNSHINE_SUBDOMAIN: 'plause-fixture', SUNSHINE_APP_ID: app, SUNSHINE_APPLE_INTEGRATION_ID: 'apple_fixture',
  SUNSHINE_WEBHOOK_ID: original.webhook.id, SUNSHINE_WEBHOOK_SECRET: 'synthetic-provider-webhook-key',
  SUNSHINE_KEY_ID: 'fixture_key', SUNSHINE_KEY_SECRET: 'synthetic-provider-api-key',
  SUNSHINE_BOT_SWITCHBOARD_ID: original.events[0]!.payload.conversation.activeSwitchboardIntegration.id,
  JOBS: { send: vi.fn(async () => {}) } as unknown as Env['JOBS'] }; }
function fixture(text = 'Hello Plause') {
  const body = structuredClone(original);
  body.events[0]!.id = crypto.randomUUID(); body.events[0]!.createdAt = new Date().toISOString();
  body.events[0]!.payload.message.id = crypto.randomUUID(); body.events[0]!.payload.message.content.text = text;
  body.events[0]!.payload.message.source.type = 'apple'; body.events[0]!.payload.message.source.integrationId = 'apple_fixture';
  return body;
}
async function enrolled(env: Env) {
  const now = Date.now();
  await env.DB.prepare(`INSERT INTO bindings(provider,business_id,subject_id,user_id,channel,verified_at,reply_consent_at,provider_conversation_id)
    VALUES ('sunshine',?,?,'u_alex','apple_business',?,?,?)`).bind(app, subjectId, now, now, providerConversationId).run();
  return (await resolveBinding(env, { provider: 'sunshine', businessId: app, subjectId }, 'apple_business')).id;
}
async function normalized(env: Env, body = fixture()) {
  return (await normalizeAuthenticatedWebhook(env, JSON.stringify(body), new Headers({ 'content-type': 'application/json', 'x-api-key': env.SUNSHINE_WEBHOOK_SECRET! })))[0]!;
}
function lifecycle(type: 'handoff.changed' | 'conversation.closed' | 'subject.revoked' | 'client.active', at: number, control: 'human' | 'bot' | 'unknown' = 'human'): SunshineEvent {
  const base = { eventId: crypto.randomUUID(), occurredAt: new Date(at).toISOString(), businessId: app, channel: 'apple_business' as const, providerConversationId };
  return type === 'handoff.changed' ? { ...base, type, control } : { ...base, type, subject: { provider: 'sunshine', businessId: app, subjectId } };
}
async function call(env: Env, body: string, key = env.SUNSHINE_WEBHOOK_SECRET) {
  const ctx = createExecutionContext(); const result = await worker.fetch(new Request('http://localhost/webhooks/messaging/sunshine',
    { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key! }, body }) as Request<unknown, IncomingRequestCfProperties>, env, ctx);
  await waitOnExecutionContext(ctx); return result;
}
const sentResponse = () => Response.json({ messages: [{ id: 'provider_reply_1', author: { type: 'business' } }] });

describe('verified provider-to-agent integration with offline fixtures', () => {
  it('authenticates the actual webhook route and ignores unenrolled subjects without work', async () => {
    const env = runtime();
    expect((await call(env, '{', 'wrong-key')).status).toBe(401);
    expect((await call(env, '{')).status).toBe(400);
    expect((await call(env, JSON.stringify(fixture()))).status).toBe(202);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM inbox').first()).toEqual({ n: 0 });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('durably deduplicates a verified event and sends once to the confirmed provider conversation', async () => {
    const env = runtime(), id = await enrolled(env), body = fixture();
    body.events[0]!.payload.message.author.user.externalId = 'u_sam';
    expect((await call(env, JSON.stringify(body))).status).toBe(202);
    expect((await call(env, JSON.stringify(body))).status).toBe(202);
    const network = vi.fn<typeof fetch>(async () => sentResponse()); vi.stubGlobal('fetch', network);
    await processConversation(env, id); await processConversation(env, id);
    expect(network).toHaveBeenCalledTimes(1);
    expect(String(network.mock.calls[0]![0])).toBe(`https://plause-fixture.zendesk.com/sc/v2/apps/${app}/conversations/${providerConversationId}/messages`);
    const wire = JSON.parse(network.mock.calls[0]![1]!.body as string);
    expect(wire.author).toEqual({ type: 'business', subtypes: ['AI'] });
    expect(wire.destination).toEqual({ integrationId: 'apple_fixture' });
    expect((await getConversationView(env, 'u_alex', id))!.messages.at(-1)!.status).toBe('sent');
    expect(await getConversationView(env, 'u_sam', id)).toBeNull();
  });
  it('will not redirect delivery when a webhook names another provider conversation', async () => {
    const env = runtime(); await enrolled(env); const body = fixture();
    body.events[0]!.payload.conversation.id = 'attacker_thread';
    expect(await ingestSunshineEvent(env, await normalized(env, body))).toEqual({ ignored: true });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM inbox').first()).toEqual({ n: 0 });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('holds old-app work when deployment credentials are switched to a different provider app', async () => {
    const env = runtime(), id = await enrolled(env); await ingestSunshineEvent(env, await normalized(env));
    const model = { generate: vi.fn(async () => ({ text: 'Must not run', inputTokens: 1, outputTokens: 1 })) };
    await processConversation({ ...env, SUNSHINE_APP_ID: 'new_app' }, id, { model });
    expect(model.generate).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    expect(await env.DB.prepare('SELECT status FROM inbox').first()).toEqual({ status: 'pending' });
  });
  it('fails closed on unknown provider control and does not call the model', async () => {
    const env = runtime(), id = await enrolled(env), event = await normalized(env);
    if (event.type !== 'message.received') throw new Error('fixture type');
    await ingestSunshineEvent(env, { ...event, control: 'unknown' });
    const model = { generate: vi.fn(async () => ({ text: 'must not run', inputTokens: 1, outputTokens: 1 })) };
    await processConversation(env, id, { model });
    expect(model.generate).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    expect((await getConversationView(env, 'u_alex', id))!.mode).toBe('human');
  });
  it('fences an in-flight model when the provider passes control to a human', async () => {
    const env = runtime(), id = await enrolled(env); await ingestSunshineEvent(env, await normalized(env));
    await processConversation(env, id, { beforeModelCommit: async () => {
      await ingestSunshineEvent(env, lifecycle('handoff.changed', Date.now() + 1));
    } });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE role='assistant'").first()).toEqual({ n: 0 });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('cancels queued messages when control changes immediately before dispatch', async () => {
    const env = runtime(), id = await enrolled(env); await ingestSunshineEvent(env, await normalized(env));
    await processConversation(env, id, { beforeDispatch: async () => { await ingestSunshineEvent(env, lifecycle('handoff.changed', Date.now() + 2)); } });
    expect(await env.DB.prepare('SELECT status FROM outbound_jobs').first()).toEqual({ status: 'cancelled' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('deduplicates lifecycle events and rejects conflicting event reuse across event kinds', async () => {
    const env = runtime(), id = await enrolled(env), at = Date.now(), event = lifecycle('handoff.changed', at);
    await ingestSunshineEvent(env, event); const first = await env.DB.prepare('SELECT ownership_version FROM conversations WHERE id=?').bind(id).first();
    expect(await ingestSunshineEvent(env, event)).toMatchObject({ duplicate: true });
    expect(await env.DB.prepare('SELECT ownership_version FROM conversations WHERE id=?').bind(id).first()).toEqual(first);
    await expect(ingestSunshineEvent(env, { ...event, control: 'bot' } as SunshineEvent)).rejects.toMatchObject({ code: 'provider_event_conflict' });
    const message = await normalized(env);
    await expect(ingestSunshineEvent(env, { ...message, eventId: event.eventId })).rejects.toMatchObject({ code: 'provider_event_conflict' });
  });
  it('does not allow a stale or equal-time bot event to override current human control', async () => {
    const env = runtime(), id = await enrolled(env), now = Date.now();
    await ingestSunshineEvent(env, lifecycle('handoff.changed', now, 'human'));
    await ingestSunshineEvent(env, lifecycle('handoff.changed', now - 10, 'bot'));
    await ingestSunshineEvent(env, lifecycle('handoff.changed', now, 'bot'));
    expect(await env.DB.prepare('SELECT mode,provider_control FROM conversations WHERE id=?').bind(id).first()).toEqual({ mode: 'human', provider_control: 'human' });
    await ingestSunshineEvent(env, lifecycle('handoff.changed', now + 10, 'bot'));
    expect(await env.DB.prepare('SELECT mode,provider_control FROM conversations WHERE id=?').bind(id).first()).toEqual({ mode: 'bot', provider_control: 'bot' });
  });
  it('preserves a customer support request when the provider later returns bot control', async () => {
    const env = runtime(), id = await enrolled(env);
    await ingestSunshineEvent(env, await normalized(env, fixture('I need human support')));
    await ingestSunshineEvent(env, lifecycle('handoff.changed', Date.now() + 20, 'human'));
    await ingestSunshineEvent(env, lifecycle('handoff.changed', Date.now() + 30, 'bot'));
    expect(await env.DB.prepare('SELECT mode,handoff_reason FROM conversations WHERE id=?').bind(id).first()).toEqual({ mode: 'human', handoff_reason: 'customer' });
  });
  it('revokes the entire subject and never restores enrollment from client.active', async () => {
    const env = runtime(), id = await enrolled(env); await ingestSunshineEvent(env, await normalized(env));
    await ingestSunshineEvent(env, lifecycle('subject.revoked', Date.now() + 10));
    await ingestSunshineEvent(env, lifecycle('client.active', Date.now() + 20));
    expect(await env.DB.prepare("SELECT status FROM bindings WHERE provider='sunshine'").first()).toEqual({ status: 'revoked' });
    expect((await getConversationView(env, 'u_alex', id))!.status).toBe('closed');
    await processConversation(env, id); expect(fetch).not.toHaveBeenCalled();
  });
  it('records closure before the first input and rejects a delayed pre-closure message while allowing new customer reinitiation', async () => {
    const env = runtime(); const now = Date.now();
    await env.DB.prepare(`INSERT INTO bindings(provider,business_id,subject_id,user_id,channel,reply_consent_at,provider_conversation_id)
      VALUES ('sunshine',?,?,'u_alex','apple_business',?,?)`).bind(app, subjectId, now, providerConversationId).run();
    await ingestSunshineEvent(env, lifecycle('conversation.closed', now + 10));
    const row = await env.DB.prepare("SELECT id,status FROM conversations WHERE provider='sunshine'").first<{ id: string; status: string }>();
    expect(row!.status).toBe('closed');
    const old = await normalized(env); await ingestSunshineEvent(env, { ...old, occurredAt: new Date(now).toISOString() });
    await processConversation(env, row!.id); expect(fetch).not.toHaveBeenCalled();
    expect((await getConversationView(env, 'u_alex', row!.id))!.status).toBe('closed');
    const recent = await normalized(env); await ingestSunshineEvent(env, { ...recent, occurredAt: new Date(now + 20).toISOString() });
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => sentResponse())); await processConversation(env, row!.id);
    expect((await getConversationView(env, 'u_alex', row!.id))!.status).toBe('active');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('leaves an uncertain POST unknown and only uses GET reconciliation on recovery', async () => {
    const env = runtime(), id = await enrolled(env); await ingestSunshineEvent(env, await normalized(env));
    const network = vi.fn<typeof fetch>(async (_url, init) => { if (init?.method === 'POST') throw new Error('connection lost after request'); return Response.json({ messages: [] }); });
    vi.stubGlobal('fetch', network); await processConversation(env, id);
    await env.DB.prepare('UPDATE outbound_jobs SET next_attempt_at=0').run();
    await processConversation(env, id);
    expect(network.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(1);
    expect(network.mock.calls.filter((call) => call[1]?.method === 'GET')).toHaveLength(1);
    expect(await env.DB.prepare('SELECT status FROM outbound_jobs').first()).toEqual({ status: 'delivery_unknown' });
  });
  it('blocks a reconciliation GET when a restore lock arrives during payload decryption', async () => {
    const env = runtime(), id = await enrolled(env); await ingestSunshineEvent(env, await normalized(env));
    const network = vi.fn<typeof fetch>(async () => sentResponse()); vi.stubGlobal('fetch', network);
    await processConversation(env, id);
    const job = await env.DB.prepare('SELECT idempotency_key FROM outbound_jobs').first<{ idempotency_key: string }>();
    await env.DB.prepare("UPDATE outbound_jobs SET status='delivery_unknown'").run();
    await env.DB.prepare('UPDATE conversations SET lease_token=?,lease_until=? WHERE id=?').bind('reconcile-fixture-lease', Date.now() + 60000, id).run();
    network.mockClear();
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; }), held = new Promise<void>((resolve) => { release = resolve; });
    const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
    const spy = vi.spyOn(crypto.subtle, 'decrypt').mockImplementationOnce(async (...args) => { enter(); await held; return decrypt(...args); });
    const pending = new RuntimeMessagingTransport(env).reconcile(job!.idempotency_key);
    try {
      await entered; await env.DB.prepare("INSERT INTO system_settings(key,value) VALUES ('restore_locked','true')").run();
      release(); expect(await pending).toBeNull(); expect(network).not.toHaveBeenCalled();
    } finally { release(); spy.mockRestore(); }
  });
  it('ignores old provider content after a fresh binding proof instead of replaying prior account history', async () => {
    const env = runtime(), id = await enrolled(env); const proofTime = Date.now();
    await env.DB.prepare("UPDATE bindings SET provider_proved_at=? WHERE provider='sunshine'").bind(proofTime).run();
    const old = await normalized(env); expect(await ingestSunshineEvent(env, { ...old, occurredAt: new Date(proofTime - 60000).toISOString() })).toEqual({ ignored: true });
    await processConversation(env, id); expect(fetch).not.toHaveBeenCalled();
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM inbox').first()).toEqual({ n: 0 });
  });
  it('does not claim proactive Apple reminder support without separate approval and consent', async () => {
    const env = runtime(), id = await enrolled(env);
    const plan = await prepareReminderCommand(env, 'u_alex', id, { type: 'create', instruction: 'Review', schedule: { kind: 'once', at: Date.now() + 60000 } });
    expect(plan.mutation).toBe(false); expect(plan.replyText).toContain('Proactive reminders are unavailable');
    const allowed = await prepareReminderCommand({ ...env, APPLE_PROACTIVE_ENABLED: 'true' }, 'u_alex', id,
      { type: 'create', instruction: 'Review', schedule: { kind: 'once', at: Date.now() + 60000 } });
    expect(allowed.mutation).toBe(false);
  });
  it.each(['approval_', 'gapproval_'])('turns a server-issued %s selection into the exact decision rather than its display label', async (prefix) => {
    const env = runtime(); await enrolled(env); const event = await normalized(env, fixture('Approve'));
    if (event.type !== 'message.received') throw new Error('fixture type');
    const selectionId = `approve ${prefix}${crypto.randomUUID()}`;
    await ingestSunshineEvent(env, { ...event, selectionId });
    const source = await env.DB.prepare("SELECT body_ciphertext FROM messages WHERE role='user'").first<{ body_ciphertext: string }>();
    expect(await decryptText(source!.body_ciphertext, env.CONTENT_ENCRYPTION_KEY)).toBe(selectionId);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('runs the Google control path in the Apple conversation without a provider call when disconnected', async () => {
    const env = runtime(), id = await enrolled(env);
    await ingestSunshineEvent(env, await normalized(env, fixture('google calendar help')));
    const network = vi.fn<typeof fetch>(async () => sentResponse()); vi.stubGlobal('fetch', network);
    await processConversation(env, id);
    const reply = (await getConversationView(env, 'u_alex', id))!.messages.at(-1)!;
    expect(reply.model).toBe('plause-google-calendar'); expect(reply.text).toContain('Real Google Calendar');
    expect(network).toHaveBeenCalledTimes(1);
    expect(String(network.mock.calls[0]![0])).toContain('zendesk.com');
  });
  it('delivers a real server approval review as provider quick replies and consumes its exact selection only once', async () => {
    const env = { ...runtime(), APPLE_PROACTIVE_ENABLED: 'true' }, id = await enrolled(env);
    await env.DB.prepare("UPDATE bindings SET proactive_consent_at=? WHERE provider='sunshine'").bind(Date.now()).run();
    await ingestSunshineEvent(env, await normalized(env, fixture('Please remind me to review the plan later.')));
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (_url, init) => { bodies.push(JSON.parse(init!.body as string)); return sentResponse(); }));
    await processConversation(env, id, { model: { generate: async () => ({ text: 'Untrusted completion claim', inputTokens: 20, outputTokens: 10,
      proposal: { type: 'reminder.create', instruction: 'Review the plan', schedule: { kind: 'once', at: Date.now() + 3600000 } } }) } });
    const approval = await env.DB.prepare("SELECT id,state FROM action_approvals WHERE tool_name='reminder.create'").first<{ id: string; state: string }>();
    expect(approval?.state).toBe('pending'); expect(bodies).toHaveLength(1);
    expect(bodies[0].content.actions).toEqual([{ type: 'reply', text: 'Approve', payload: `approve ${approval!.id}` },
      { type: 'reply', text: 'Reject', payload: `reject ${approval!.id}` }]);
    const event = await normalized(env, fixture('Approve'));
    if (event.type !== 'message.received') throw new Error('fixture type');
    const chosen = { ...event, selectionId: bodies[0].content.actions[0].payload };
    await ingestSunshineEvent(env, chosen); await ingestSunshineEvent(env, chosen);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM reminders').first()).toEqual({ n: 1 });
    expect(await env.DB.prepare('SELECT state FROM action_approvals').first()).toEqual({ state: 'approved' });
  });
  it('sends a human-authored response without the AI subtype and binds reconciliation to that author type', async () => {
    const env = runtime(); let body: Record<string, any>;
    const network = vi.fn<typeof fetch>(async (_url, init) => {
      if (init?.method === 'POST') { body = JSON.parse(init.body as string); return sentResponse(); }
      return Response.json({ messages: [{ id: 'provider_reply_1', author: body.author, content: body.content, metadata: body.metadata }] });
    });
    const client = new SunshineMessagingClient(env, { fetchImpl: network });
    const input = { conversationId: providerConversationId, idempotencyKey: 'staff_reply', content: { type: 'text' as const, text: 'A staff response' }, authorType: 'human' as const };
    expect((await client.send(input)).state).toBe('sent'); expect(body!.author).toEqual({ type: 'business' });
    expect(await client.reconcile(input)).toMatchObject({ state: 'sent' });
    expect(await client.reconcile({ ...input, authorType: 'ai' })).toBeNull();
  });
});
