import { describe, expect, it, vi } from 'vitest';
import { normalizeAuthenticatedWebhook, serializeSunshineContent, sunshineReadiness, SunshineMessagingClient,
  type SunshineEnvironment, type SunshineSendRequest } from '../packages/messaging-sunshine/src/index';
import messageFixture from './fixtures/sunshine/official-conversationMessageEvent.json';
import deliveryFixture from './fixtures/sunshine/official-conversationMessageDeliveryChannelEvent.json';
import failureFixture from './fixtures/sunshine/official-conversationMessageDeliveryFailureEvent.json';
import clientFixture from './fixtures/sunshine/official-clientUpdateEvent.json';
import removeFixture from './fixtures/sunshine/official-clientRemoveEvent.json';
import switchboardFixture from './fixtures/sunshine/official-switchboardPassControlEvent.json';
import mergeFixture from './fixtures/sunshine/official-userMergeEvent.json';

// These originals are published API-spec examples, not captured Apple traffic.
// Apple variants below change only the documented channel/integration fields.
const config: SunshineEnvironment = {
  SUNSHINE_SUBDOMAIN: 'plause-fixture', SUNSHINE_APP_ID: messageFixture.app.id,
  SUNSHINE_APPLE_INTEGRATION_ID: 'apple_integration_fixture', SUNSHINE_WEBHOOK_ID: messageFixture.webhook.id,
  SUNSHINE_WEBHOOK_SECRET: 'synthetic-webhook-secret-never-used-live', SUNSHINE_KEY_ID: 'int_fixture',
  SUNSHINE_KEY_SECRET: 'synthetic-api-secret-never-used-live',
  SUNSHINE_BOT_SWITCHBOARD_ID: '5eecde2dcdbffb08f5c3ed37', SUNSHINE_AGENT_SWITCHBOARD_ID: 'human_switchboard_fixture',
};
const headers = (): Headers => new Headers({ 'content-type': 'application/json; charset=utf-8', 'x-api-key': config.SUNSHINE_WEBHOOK_SECRET! });
// OpenAPI fixture JSON permits numerous optional fields; tests mutate those
// fields to exercise strict normalization rather than claiming provider captures.
type Fixture = { app: { id: string }; webhook: { id: string; version: string };
  events: { id: string; type: string; createdAt: string; payload: Record<string, any> }[] };
function appleMessage(): Fixture {
  const body: Fixture = structuredClone(messageFixture);
  body.events[0]!.payload.message.source = { type: 'apple', integrationId: config.SUNSHINE_APPLE_INTEGRATION_ID };
  return body;
}
function appleLifecycle(source: unknown): Fixture {
  const body = structuredClone(source) as Fixture;
  body.app.id = config.SUNSHINE_APP_ID!; body.webhook.id = config.SUNSHINE_WEBHOOK_ID!;
  const payload = body.events[0]!.payload;
  if (payload.client) { payload.client.type = 'apple'; payload.client.integrationId = config.SUNSHINE_APPLE_INTEGRATION_ID; }
  if (payload.destination) { payload.destination.type = 'apple'; payload.destination.integrationId = config.SUNSHINE_APPLE_INTEGRATION_ID; }
  return body;
}
const normalized = (body: unknown, requestHeaders = headers()) => normalizeAuthenticatedWebhook(config, JSON.stringify(body), requestHeaders);

describe('Sunshine documented webhook authentication and scope', () => {
  it('reports configuration separately from Apple approval/provider health', () => {
    expect(sunshineReadiness(config)).toEqual({ webhookConfigured: true, transportConfigured: true });
    expect(sunshineReadiness({})).toEqual({ webhookConfigured: false, transportConfigured: false });
    expect(sunshineReadiness({ ...config, SUNSHINE_SUBDOMAIN: 'https://attacker.test/path' }).transportConfigured).toBe(false);
  });
  it('authenticates with the documented shared X-API-Key before attempting JSON parsing', async () => {
    await expect(normalizeAuthenticatedWebhook(config, 'MALFORMED_SECRET_BODY', new Headers())).rejects.toMatchObject({ code: 'sunshine_webhook_unauthorized' });
    const bad = headers(); bad.set('x-api-key', 'wrong-secret');
    await expect(normalizeAuthenticatedWebhook(config, '{', bad)).rejects.toMatchObject({ code: 'sunshine_webhook_unauthorized' });
    const duplicate = headers(); duplicate.append('x-api-key', config.SUNSHINE_WEBHOOK_SECRET!);
    await expect(normalizeAuthenticatedWebhook(config, '{', duplicate)).rejects.toMatchObject({ code: 'sunshine_webhook_unauthorized' });
  });
  it('does not accept the unrelated Zendesk Support HMAC headers as Sunshine authentication', async () => {
    const unrelated = new Headers({ 'content-type': 'application/json', 'x-zendesk-webhook-signature': 'fake-signature',
      'x-zendesk-webhook-signature-timestamp': new Date().toISOString() });
    await expect(normalized(appleMessage(), unrelated)).rejects.toMatchObject({ code: 'sunshine_webhook_unauthorized' });
  });
  it.each(['app', 'webhook', 'version'] as const)('rejects wrong %s scope before normalization', async (scope) => {
    const body = appleMessage();
    if (scope === 'app') body.app.id = 'another_app';
    else if (scope === 'webhook') body.webhook.id = 'another_webhook';
    else body.webhook.version = 'v1';
    await expect(normalized(body)).rejects.toMatchObject({ code: scope === 'version' ? 'sunshine_payload_invalid' : 'sunshine_webhook_scope_invalid' });
  });
  it('requires JSON and bounds raw bytes even after authentication', async () => {
    const wrong = headers(); wrong.set('content-type', 'text/plain');
    await expect(normalized(appleMessage(), wrong)).rejects.toMatchObject({ code: 'sunshine_content_type_invalid' });
    await expect(normalizeAuthenticatedWebhook(config, 'é'.repeat(132_000), headers())).rejects.toMatchObject({ code: 'sunshine_payload_too_large' });
    await expect(normalizeAuthenticatedWebhook(config, '{', headers())).rejects.toMatchObject({ code: 'sunshine_payload_invalid' });
  });
  it('bounds a batch and validates every supported event before returning any of it', async () => {
    const body = appleMessage(); const event = body.events[0]!;
    body.events = Array.from({ length: 101 }, (_, n) => ({ ...event, id: `fixture_${n}` }));
    await expect(normalized(body)).rejects.toMatchObject({ code: 'sunshine_payload_invalid' });
    body.events = [event, { ...event, id: 'malformed', payload: {} }];
    await expect(normalized(body)).rejects.toMatchObject({ code: 'sunshine_payload_invalid' });
  });
  it('deduplicates an identical event within a batch and rejects a conflicting event ID', async () => {
    const body = appleMessage(); body.events.push(structuredClone(body.events[0]!));
    expect(await normalized(body)).toHaveLength(1);
    body.events[1]!.payload.message.content.text = 'conflicting text';
    await expect(normalized(body)).rejects.toMatchObject({ code: 'sunshine_event_conflict' });
  });
});

describe('Sunshine opaque Apple identity and typed events', () => {
  it('preserves the provider user and conversation IDs without trusting externalId as a Plause account', async () => {
    const body = appleMessage(); body.events[0]!.payload.message.author.user.externalId = 'u_sam';
    expect(await normalized(body)).toEqual([{ type: 'message.received', eventId: messageFixture.events[0]!.id,
      occurredAt: messageFixture.events[0]!.createdAt, businessId: config.SUNSHINE_APP_ID, channel: 'apple_business',
      subject: { provider: 'sunshine', businessId: config.SUNSHINE_APP_ID, subjectId: '26508c10541a4b0ff472e5e2' },
      providerConversationId: 'f52b01137aa6c250bc7251fa', messageId: '5f74c7d84a146f3abd72af1d', text: 'hello', control: 'bot' }]);
  });
  it('ignores the original official Telegram example and a wrong Apple integration', async () => {
    expect(await normalized(messageFixture)).toEqual([]);
    const body = appleMessage(); body.events[0]!.payload.message.source.integrationId = 'different_integration';
    expect(await normalized(body)).toEqual([]);
  });
  it.each(['author_mismatch', 'missing_user', 'source_mismatch'] as const)('rejects ambiguous %s identity', async (mode) => {
    const body = appleMessage(); const message = body.events[0]!.payload.message;
    if (mode === 'author_mismatch') message.author.user.id = 'another_user';
    if (mode === 'missing_user') delete message.author.userId;
    if (mode === 'source_mismatch') message.source.client = { type: 'apple', integrationId: 'different_integration' };
    await expect(normalized(body)).rejects.toMatchObject({ code: mode === 'source_mismatch' ? 'sunshine_source_invalid' : 'sunshine_author_invalid' });
  });
  it('keeps quick reply payload as untrusted selection data rather than replacing user text', async () => {
    const body = appleMessage(); body.events[0]!.payload.message.content = { type: 'text', text: 'Approve', payload: 'untrusted_payload' };
    expect((await normalized(body))[0]).toMatchObject({ type: 'message.received', text: 'Approve', selectionId: 'untrusted_payload' });
  });
  it.each(['image', 'file', 'form', 'location', 'apple_passthrough'])('does not execute %s content as a command', async (type) => {
    const body = appleMessage(); body.events[0]!.payload.message.content = { type, text: 'approve gapproval_fake' };
    expect(await normalized(body)).toEqual([]);
  });
  it('never creates a model input from the business author', async () => {
    const body = appleMessage(); body.events[0]!.payload.message.author = { type: 'business' };
    expect(await normalized(body)).toEqual([]);
  });
  it('observes explicit agent control on business API replies without treating API echoes as incoming Apple text', async () => {
    const body = appleMessage(); body.events[0]!.payload.message.author = { type: 'business' };
    body.events[0]!.payload.message.source = { type: 'api:conversations' };
    body.events[0]!.payload.conversation.activeSwitchboardIntegration = { id: 'agent_switchboard' };
    expect((await normalized(body))[0]).toMatchObject({ type: 'handoff.changed', control: 'human' });
    delete body.events[0]!.payload.conversation.activeSwitchboardIntegration;
    expect(await normalized(body)).toEqual([]);
  });
  it('fails closed when switchboard control is missing or belongs to an agent', async () => {
    const body = appleMessage(); delete body.events[0]!.payload.conversation.activeSwitchboardIntegration;
    expect((await normalized(body))[0]).toMatchObject({ control: 'unknown' });
    body.events[0]!.payload.conversation.activeSwitchboardIntegration = { id: 'agent_integration', integrationType: 'zd:agentWorkspace' };
    expect((await normalized(body))[0]).toMatchObject({ control: 'human' });
    body.events[0]!.payload.message.author = { type: 'business' };
    expect((await normalized(body))[0]).toMatchObject({ type: 'handoff.changed', control: 'human' });
  });
  it('records channel acceptance as sent and ignores unsupported Apple end-user delivery', async () => {
    const body = appleLifecycle(deliveryFixture);
    expect((await normalized(body))[0]).toMatchObject({ type: 'delivery.updated', state: 'sent' });
    body.events[0]!.type = 'conversation:message:delivery:user';
    expect(await normalized(body)).toEqual([]);
  });
  it('only treats a final delivery failure as failed and never exposes provider error text', async () => {
    const body = appleLifecycle(failureFixture);
    body.events[0]!.payload.error.message = 'SECRET_PROVIDER_ERROR';
    expect(JSON.stringify(await normalized(body))).not.toContain('SECRET_PROVIDER_ERROR');
    expect((await normalized(body))[0]).toMatchObject({ type: 'delivery.updated', state: 'failed' });
    body.events[0]!.payload.isFinalEvent = false; expect(await normalized(body)).toEqual([]);
  });
  it('normalizes Apple closure from blocked client even without a conversation ID', async () => {
    const body = appleLifecycle(clientFixture); body.events[0]!.payload.client.status = 'blocked';
    delete body.events[0]!.payload.conversation;
    expect((await normalized(body))[0]).toMatchObject({ type: 'conversation.closed', subject: { provider: 'sunshine' } });
    expect((await normalized(body))[0]).not.toHaveProperty('providerConversationId');
  });
  it('never turns a blocked source client into an input or an unblock into automatic consent', async () => {
    const body = appleMessage(); body.events[0]!.payload.message.source.client = {
      type: 'apple', integrationId: config.SUNSHINE_APPLE_INTEGRATION_ID, status: 'blocked' };
    expect((await normalized(body))[0]).toMatchObject({ type: 'conversation.closed' });
    const active = appleLifecycle(clientFixture); active.events[0]!.payload.client.status = 'active';
    expect((await normalized(active))[0]).toMatchObject({ type: 'client.active' });
  });
  it('revokes a removed client by opaque subject even when provider omits its conversation', async () => {
    const body = appleLifecycle(removeFixture); delete body.events[0]!.payload.conversation;
    expect((await normalized(body))[0]).toMatchObject({ type: 'subject.revoked', subject: { subjectId: '6a2343df57be6fe0f98efc33' } });
  });
  it('only supplies a conversation target for switchboard events, without inventing a user', async () => {
    const body = appleLifecycle(switchboardFixture);
    const event = (await normalized(body))[0];
    expect(event).toMatchObject({ type: 'handoff.changed', control: 'bot', providerConversationId: 'f52b01137aa6c250bc7251fa' });
    expect(event).not.toHaveProperty('subject');
    delete body.events[0]!.payload.conversation.activeSwitchboardIntegration;
    body.events[0]!.type = 'switchboard:releaseControl';
    expect((await normalized(body))[0]).toMatchObject({ control: 'unknown' });
  });
  it('revokes both sides of a provider user merge without merging Plause accounts', async () => {
    const events = await normalized(appleLifecycle(mergeFixture));
    expect(events).toHaveLength(2); expect(new Set(events.map((event) => event.eventId)).size).toBe(2);
    expect(events.map((event) => event.type)).toEqual(['subject.revoked', 'subject.revoked']);
    expect(await normalized(appleLifecycle(mergeFixture))).toEqual(events);
    const body = appleMessage(); body.events[0]!.type = 'user:remove';
    body.events[0]!.payload = { user: { id: 'opaque_deleted_user' } };
    expect((await normalized(body))[0]).toMatchObject({ type: 'subject.revoked', subject: { subjectId: 'opaque_deleted_user' } });
  });
});

const sendRequest: SunshineSendRequest = { conversationId: 'opaque_conversation_fixture', idempotencyKey: 'outbox-fixture-key',
  content: { type: 'text', text: 'This is a synthetic test reply.' } };
function accepted() { return Response.json({ messages: [{ id: 'provider_message_fixture', author: { type: 'business' } }] }, { status: 201 }); }
function client(fetchImpl: typeof fetch, options: { timeoutMs?: number; beforeSend?: () => Promise<void> } = {}) {
  return new SunshineMessagingClient(config, { fetchImpl, ...options });
}

describe('Sunshine fixed-endpoint outbound adapter', () => {
  it('sends one AI-attributed Apple-pinned message with hashed durable metadata', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => accepted()); const fence = vi.fn(async () => {});
    const provider = client(fetchImpl, { beforeSend: fence });
    expect(provider.supportsIdempotentRetry).toBe(false);
    expect(await provider.send(sendRequest)).toEqual({ state: 'sent', providerMessageId: 'provider_message_fixture' });
    expect(fetchImpl).toHaveBeenCalledTimes(1); expect(fence).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`https://plause-fixture.zendesk.com/sc/v2/apps/${config.SUNSHINE_APP_ID}/conversations/${sendRequest.conversationId}/messages`);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', headers: {
      authorization: `Basic ${btoa(`${config.SUNSHINE_KEY_ID}:${config.SUNSHINE_KEY_SECRET}`)}` } });
    const body = JSON.parse(init!.body as string);
    expect(body).toMatchObject({ author: { type: 'business', subtypes: ['AI'] }, content: sendRequest.content,
      destination: { integrationId: config.SUNSHINE_APPLE_INTEGRATION_ID } });
    expect(body.metadata.plauseDispatchId).toMatch(/^[0-9a-f]{64}$/);
    expect(body.metadata.plauseContentDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(body.metadata)).not.toContain(sendRequest.idempotencyKey);
    expect(body).not.toHaveProperty('override');
  });
  it('checks current authorization immediately before network dispatch', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    expect(await client(fetchImpl, { beforeSend: async () => { throw new Error('SECRET_TENANT_STATE'); } }).send(sendRequest))
      .toEqual({ state: 'failed', code: 'sunshine_dispatch_blocked' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('does not dispatch when the fence stalls beyond deadline or the signal was revoked', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    expect(await client(fetchImpl, { timeoutMs: 20, beforeSend: () => new Promise(() => {}) }).send(sendRequest))
      .toEqual({ state: 'failed', code: 'sunshine_timeout' });
    const abort = new AbortController(); abort.abort();
    expect(await client(fetchImpl).send(sendRequest, abort.signal)).toEqual({ state: 'failed', code: 'sunshine_aborted' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each([400, 401, 403, 404, 423])('returns a sanitized definitive failure for HTTP %i, without retries', async (status) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('SECRET_PROVIDER_BODY', { status }));
    const result = await client(fetchImpl).send(sendRequest); expect(result.state).toBe('failed');
    expect(JSON.stringify(result)).not.toContain('SECRET_PROVIDER_BODY'); expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it.each([301, 302, 303, 307, 308, 408, 409, 429, 500, 503])('retains unknown outcome for HTTP %i and never repeats POST', async (status) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('SECRET_PROVIDER_BODY', { status }));
    expect((await client(fetchImpl).send(sendRequest)).state).toBe('delivery_unknown'); expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it.each(['network', 'malformed', 'multiple', 'missing_id'] as const)('holds %s acceptance uncertainty without resending', async (mode) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      if (mode === 'network') throw new Error('SECRET_NETWORK_ERROR');
      if (mode === 'malformed') return new Response('{');
      if (mode === 'multiple') return Response.json({ messages: [{ id: 'one', author: { type: 'business' } }, { id: 'two', author: { type: 'business' } }] });
      return Response.json({ messages: [{}] });
    });
    expect((await client(fetchImpl).send(sendRequest)).state).toBe('delivery_unknown'); expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('bounds a fetch that ignores abort and preserves the unknown send outcome', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => new Promise<Response>(() => {}));
    expect(await client(fetchImpl, { timeoutMs: 20 }).send(sendRequest)).toEqual({ state: 'delivery_unknown', code: 'sunshine_timeout' });
    expect(fetchImpl).toHaveBeenCalledTimes(1); expect(fetchImpl.mock.calls[0]![1]!.signal!.aborted).toBe(true);
  });
  it.each(['declared', 'streamed', 'stalled'] as const)('bounds %s response bodies', async (mode) => {
    let cancelled = false;
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { if (mode !== 'stalled') controller.enqueue(new Uint8Array(513 * 1024)); },
      cancel() { cancelled = true; },
    }), mode === 'declared' ? { headers: { 'content-length': String(513 * 1024) } } : {}));
    const result = await client(fetchImpl, { timeoutMs: 25 }).send(sendRequest);
    expect(result.state).toBe('delivery_unknown'); expect(cancelled).toBe(true); expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it.each(['../wrong', 'https://attacker.test', 'x/y'])('rejects unsafe conversation path %s before HTTP', async (conversationId) => {
    const fetchImpl = vi.fn<typeof fetch>();
    expect(await client(fetchImpl).send({ ...sendRequest, conversationId })).toMatchObject({ state: 'failed' }); expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('rejects arbitrary host configuration and unbounded deadlines', () => {
    for (const subdomain of ['attacker.test', 'x/path', 'x:443', 'x@host', '-x', 'x-']) {
      expect(() => new SunshineMessagingClient({ ...config, SUNSHINE_SUBDOMAIN: subdomain })).toThrow('sunshine_transport_not_configured');
    }
    expect(() => client(vi.fn(), { timeoutMs: 10_001 })).toThrow('sunshine_config_invalid');
  });
});

describe('Sunshine reconciliation and rich messages', () => {
  it('does not follow a reconciliation redirect or resend a possibly accepted message', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 302,
      headers: { location: 'https://redirect-target.invalid/do-not-follow' } }));
    const provider = client(fetchImpl);
    expect(await provider.send(sendRequest)).toEqual({ state: 'delivery_unknown', code: 'sunshine_request_rejected' });
    expect(await provider.reconcile(sendRequest)).toBeNull();
    expect(fetchImpl.mock.calls.map(([, init]) => [init!.method, init!.redirect])).toEqual([['POST', 'manual'], ['GET', 'manual']]);
  });
  it('reconciles a matching durable marker and exact content with one GET only', async () => {
    let body: Record<string, any> = {};
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      if (init!.method === 'POST') { body = JSON.parse(init!.body as string); return accepted(); }
      return Response.json({ messages: [{ id: 'provider_message_fixture', author: { type: 'business' },
        metadata: body.metadata, content: { text: body.content.text, type: 'text' } }],
        links: { next: 'https://attacker.test/do-not-follow' }, meta: { hasMore: true } });
    });
    const provider = client(fetchImpl); await provider.send(sendRequest);
    expect(await provider.reconcile(sendRequest)).toEqual({ state: 'sent', providerMessageId: 'provider_message_fixture' });
    expect(fetchImpl.mock.calls.map(([, init]) => init!.method)).toEqual(['POST', 'GET']);
    expect(fetchImpl.mock.calls[1]![0]).toBe(fetchImpl.mock.calls[0]![0]);
  });
  it.each(['missing', 'changed_text', 'changed_marker', 'user_author', 'duplicate', 'wrong_id'] as const)
    ('does not resolve uncertain %s records or resend them', async (mode) => {
      let body: Record<string, any> = {};
      const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
        if (init!.method === 'POST') { body = JSON.parse(init!.body as string); return accepted(); }
        const entry = { id: 'provider_message_fixture', author: { type: 'business' }, metadata: body.metadata, content: body.content };
        if (mode === 'changed_text') entry.content.text = 'changed';
        if (mode === 'changed_marker') entry.metadata.plauseDispatchId = 'other';
        if (mode === 'user_author') entry.author.type = 'user';
        return Response.json({ messages: mode === 'missing' ? [] : mode === 'duplicate' ? [entry, entry] : [entry] });
      });
      const provider = client(fetchImpl); await provider.send(sendRequest);
      expect(await provider.reconcile({ ...sendRequest, ...(mode === 'wrong_id' ? { providerMessageId: 'different' } : {}) })).toBeNull();
      expect(fetchImpl.mock.calls.map(([, init]) => init!.method)).toEqual(['POST', 'GET']);
    });
  it('keeps a lost, malformed, oversized, or failed GET uncertain without any POST', async () => {
    for (const response of [new Response('', { status: 404 }), Response.json({ messages: Array.from({ length: 101 }, () => ({})) }), new Response('{')]) {
      const fetchImpl = vi.fn<typeof fetch>(async () => response);
      expect(await client(fetchImpl).reconcile(sendRequest)).toBeNull(); expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(fetchImpl.mock.calls[0]![1]!.method).toBe('GET');
    }
  });
  it('serializes native quick reply actions without action execution authority', () => {
    expect(serializeSunshineContent({ type: 'quick_replies', text: 'Review this exact draft.', options: [
      { id: 'approve:gapproval_fixture', label: 'Approve' }, { id: 'reject:gapproval_fixture', label: 'Reject' },
    ] })).toEqual({ type: 'text', text: 'Review this exact draft.', actions: [
      { type: 'reply', text: 'Approve', payload: 'approve:gapproval_fixture' }, { type: 'reply', text: 'Reject', payload: 'reject:gapproval_fixture' },
    ] });
  });
  it('emits one safe HTTPS URL for Apple automatic rich preview without fetching it', () => {
    expect(serializeSunshineContent({ type: 'rich_link', title: 'Review your account', url: 'https://plause.app/account' }))
      .toEqual({ type: 'text', text: 'Review your account\nhttps://plause.app/account' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['http://plause.app', 'https://u:p@plause.app', 'https://localhost/', 'https://127.0.0.1/',
    'https://[::1]/', 'https://internal.corp/', 'https://x.local/', 'https://plause.app:8443/', 'https://localtest.me/'])
    ('rejects unsafe rich preview URL %s', (url) => {
      expect(() => serializeSunshineContent({ type: 'rich_link', title: 'Link', url })).toThrow('sunshine_content_invalid');
    });
  it('rejects unknown content fields, oversized text, duplicate selections, and broad quick reply lists', () => {
    const invalid = [ { type: 'text', text: 'x', override: { apple: {} } }, { type: 'text', text: 'x'.repeat(4001) },
      { type: 'quick_replies', text: 'x', options: [{ id: 'a', label: 'a' }, { id: 'a', label: 'b' }] },
      { type: 'quick_replies', text: 'x', options: Array.from({ length: 6 }, (_, n) => ({ id: `i${n}`, label: 'x' })) } ];
    for (const value of invalid) expect(() => serializeSunshineContent(value as never)).toThrow('sunshine_content_invalid');
  });
  it('uses only documented typing activity and configured Agent Workspace passControl endpoints', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 })); const fence = vi.fn(async () => {});
    const provider = client(fetchImpl, { beforeSend: fence });
    expect(await provider.typing(sendRequest.conversationId, 'start')).toEqual({ state: 'accepted' });
    expect(await provider.typing(sendRequest.conversationId, 'stop')).toEqual({ state: 'accepted' });
    expect(await provider.handoff(sendRequest.conversationId)).toEqual({ state: 'accepted' });
    expect(fetchImpl.mock.calls.map(([url]) => String(url).split('/').at(-1))).toEqual(['activity', 'activity', 'passControl']);
    expect(JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string)).toEqual({ author: { type: 'business' }, type: 'typing:start' });
    expect(JSON.parse(fetchImpl.mock.calls[2]![1]!.body as string)).toEqual({ switchboardIntegration: 'human_switchboard_fixture' });
    expect(fence).toHaveBeenCalledTimes(3);
  });
});
