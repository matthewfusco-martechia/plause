import { describe, it, expect, vi } from 'vitest';
import { createExecutionContext, createMessageBatch, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../apps/api/src/index';
import { ingestEvent, processConversation, recoverPending } from '../apps/api/src/pipeline';
import { getConversationView, setConversationMode } from '../apps/api/src/store';
import { MockMessagingTransport, type MessagingTransport } from '../packages/messaging-mock/src/index';
import { signWebhook } from '../packages/security/src/index';
import type { Env, MessagingEvent, ModelProvider, QueueJob } from '../packages/contracts/src/index';
import { inviteAlex, inviteSam, testEnv } from './setup';

const origin = 'http://localhost';
function runtime() {
  const jobs: QueueJob[] = [];
  const env = { ...testEnv, JOBS: { send: async (job: QueueJob) => { jobs.push(job); } } as unknown as Queue<QueueJob> };
  return { env, jobs };
}
function inbound(text = 'Hello Plause', subjectId = 'mock-alex'): MessagingEvent {
  return { schemaVersion: 1, type: 'message.received', eventId: crypto.randomUUID(),
    messageId: crypto.randomUUID(), subject: { provider: 'mock', businessId: 'plause-local', subjectId },
    channel: 'mock', occurredAt: new Date().toISOString(), text };
}
async function call(env: Env, path: string, init: RequestInit = {}) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(origin + path, init) as Request<unknown, IncomingRequestCfProperties>, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
async function webhook(env: Env, event: MessagingEvent) {
  const body = JSON.stringify(event);
  return call(env, '/webhooks/messaging/mock', { method: 'POST', body,
    headers: { 'content-type': 'application/json', 'x-plause-signature': await signWebhook(body, env.MOCK_WEBHOOK_SECRET) } });
}
async function session(env: Env, token = inviteAlex) {
  const response = await call(env, '/api/session', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ inviteToken: token }) });
  expect(response.status).toBe(200);
  return { cookie: response.headers.get('set-cookie')!.split(';')[0]!, ...await response.json() as { conversationId: string; user: { id: string } } };
}
async function count(table: string) {
  if (!['messages', 'inbox', 'outbound_jobs', 'mock_receipts', 'usage_ledgers', 'webhook_events'].includes(table)) throw new Error('Unsafe test table');
  return (await testEnv.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
}

describe('messaging-first vertical slice', () => {
  it('authenticates ingress, processes queued work and delivers exactly one logical mock reply on replay', async () => {
    const { env, jobs } = runtime();
    const event = inbound();
    const response = await webhook(env, event);
    expect(response.status).toBe(202);
    const accepted = await response.json() as { conversationId: string };
    const replay = await webhook(env, event);
    expect(replay.status).toBe(202);
    expect((await replay.json() as { duplicate: boolean }).duplicate).toBe(true);
    const batch = createMessageBatch('plause-local-jobs', jobs.map((body) => ({ id: crypto.randomUUID(), timestamp: new Date(), attempts: 1, body })));
    await worker.queue(batch, env);
    await processConversation(env, accepted.conversationId);
    const view = await getConversationView(env, 'u_alex', accepted.conversationId);
    expect(view?.messages.filter((message) => message.role === 'user')).toHaveLength(1);
    expect(view?.messages.filter((message) => message.role === 'assistant')).toHaveLength(1);
    expect(view?.messages.find((message) => message.role === 'assistant')?.status).toBe('delivered');
    expect(await count('mock_receipts')).toBe(1);
    expect(await count('usage_ledgers')).toBe(1);
  });

  it('rejects an event ID reused with different content', async () => {
    const { env } = runtime();
    const event = inbound('First request');
    await ingestEvent(env, event);
    const altered = { ...event, text: 'Different request' } as MessagingEvent;
    await expect(ingestEvent(env, altered)).rejects.toMatchObject({ status: 409 });
    expect(await count('inbox')).toBe(1);
  });

  it('deduplicates a provider message delivered under another event ID', async () => {
    const { env } = runtime();
    const event = inbound();
    const first = await ingestEvent(env, event);
    await ingestEvent(env, { ...event, eventId: crypto.randomUUID() });
    await processConversation(env, first.conversationId);
    expect(await count('inbox')).toBe(1);
    expect(await count('mock_receipts')).toBe(1);
  });

  it('rejects missing, invalid, stale signatures and unknown senders before creating work', async () => {
    const { env } = runtime();
    const body = JSON.stringify(inbound());
    for (const signature of ['', 'invalid', await signWebhook(body, env.MOCK_WEBHOOK_SECRET, Math.floor(Date.now() / 1000) - 301)]) {
      const response = await call(env, '/webhooks/messaging/mock', { method: 'POST', body,
        headers: { 'content-type': 'application/json', 'x-plause-signature': signature } });
      expect(response.status).toBe(401);
    }
    expect((await webhook(env, inbound('Hello', 'unknown-subject'))).status).toBe(403);
    expect(await count('inbox')).toBe(0);
  });

  it('recovers accepted input even when its queue wakeup was lost', async () => {
    const { env, jobs } = runtime();
    env.JOBS = { send: async () => { throw new Error('Simulated queue outage'); } } as unknown as Queue<QueueJob>;
    const accepted = await ingestEvent(env, inbound());
    expect(jobs).toHaveLength(0);
    expect(await count('inbox')).toBe(1);
    env.JOBS = { send: async (job: QueueJob) => { jobs.push(job); } } as unknown as Queue<QueueJob>;
    expect(await recoverPending(env)).toBeGreaterThan(0);
    expect(jobs.some((job) => job.kind === 'conversation' && job.conversationId === accepted.conversationId)).toBe(true);
    await processConversation(env, accepted.conversationId);
    expect(await count('mock_receipts')).toBe(1);
  });

  it('keeps turns ordered and supplies earlier context to later turns', async () => {
    const { env } = runtime();
    const accepted = await ingestEvent(env, inbound('My favorite color is green.'));
    await ingestEvent(env, inbound('What did I say earlier?'));
    await processConversation(env, accepted.conversationId);
    await processConversation(env, accepted.conversationId);
    const view = await getConversationView(env, 'u_alex', accepted.conversationId);
    const replies = view!.messages.filter((message) => message.role === 'assistant');
    expect(replies).toHaveLength(2);
    expect(replies[1]!.text).toContain('My favorite color is green.');
    expect(await count('mock_receipts')).toBe(2);
  });

  it('prevents concurrent workers from generating two replies to one message', async () => {
    const { env } = runtime();
    const accepted = await ingestEvent(env, inbound());
    const model = { generate: vi.fn(async () => ({ text: 'One simulated answer', inputTokens: 1, outputTokens: 1 })) };
    await Promise.all([processConversation(env, accepted.conversationId, { model }), processConversation(env, accepted.conversationId, { model })]);
    expect(model.generate).toHaveBeenCalledTimes(1);
    expect(await count('mock_receipts')).toBe(1);
  });

  it('includes completed assistant turns when later inputs arrived before processing', async () => {
    const { env } = runtime();
    const accepted = await ingestEvent(env, inbound('Queued input A'));
    await ingestEvent(env, inbound('Queued input B'));
    await ingestEvent(env, inbound('Future input C'));
    const seen: Array<{ text: string; history: Array<{ role: 'user' | 'assistant'; text: string }> }> = [];
    const model: ModelProvider = { generate: async (request) => {
      seen.push({ text: request.text, history: request.history });
      return { text: `Answer to ${request.text}`, inputTokens: 1, outputTokens: 1 };
    } };
    await processConversation(env, accepted.conversationId, { model });
    expect(seen[0]).toEqual({ text: 'Queued input A', history: [] });
    expect(seen[1]).toEqual({ text: 'Queued input B', history: [
      { role: 'user', text: 'Queued input A' },
      { role: 'assistant', text: 'Answer to Queued input A' },
    ] });
    expect(seen[1]!.history.some((message) => message.text.includes('Queued input B') || message.text.includes('Future input C'))).toBe(false);
    expect(seen[2]!.history).toEqual([
      { role: 'user', text: 'Queued input A' }, { role: 'assistant', text: 'Answer to Queued input A' },
      { role: 'user', text: 'Queued input B' }, { role: 'assistant', text: 'Answer to Queued input B' },
    ]);
  });

  it('recovers an expired processing lease without losing accepted input', async () => {
    const { env } = runtime();
    const accepted = await ingestEvent(env, inbound());
    await env.DB.prepare("UPDATE conversations SET lease_token='crashed-worker',lease_until=? WHERE id=?").bind(Date.now() - 1, accepted.conversationId).run();
    await env.DB.prepare("UPDATE inbox SET status='processing' WHERE conversation_id=?").bind(accepted.conversationId).run();
    await processConversation(env, accepted.conversationId);
    expect(await count('mock_receipts')).toBe(1);
  });

  it('reconciles a timeout after provider acceptance without resending', async () => {
    const { env } = runtime();
    const accepted = await ingestEvent(env, inbound());
    const transport = new MockMessagingTransport(env, { unknownAfterAcceptOnce: true });
    await processConversation(env, accepted.conversationId, { transport });
    await env.DB.prepare('UPDATE outbound_jobs SET next_attempt_at=0').run();
    await processConversation(env, accepted.conversationId, { transport });
    expect(await count('mock_receipts')).toBe(1);
    const view = await getConversationView(env, 'u_alex', accepted.conversationId);
    expect(view!.messages.find((message) => message.role === 'assistant')!.status).toBe('delivered');
  });

  it('does not blindly resend an uncertain attempt without an authoritative receipt', async () => {
    const { env } = runtime();
    const accepted = await ingestEvent(env, inbound());
    const transport: MessagingTransport = {
      send: vi.fn(async () => ({ state: 'delivery_unknown' as const, code: 'test_timeout' })),
      reconcile: vi.fn(async () => null),
    };
    await processConversation(env, accepted.conversationId, { transport });
    await processConversation(env, accepted.conversationId, { transport });
    expect(transport.send).toHaveBeenCalledTimes(1);
    const view = await getConversationView(env, 'u_alex', accepted.conversationId);
    expect(view!.messages.find((message) => message.role === 'assistant')!.status).toBe('delivery_unknown');
  });

  it('suppresses an in-flight agent reply after human takeover', async () => {
    const { env } = runtime();
    const accepted = await ingestEvent(env, inbound());
    const model: ModelProvider = { generate: async () => {
      await setConversationMode(env, 'u_alex', accepted.conversationId, 'human');
      return { text: 'This stale reply must not be sent', inputTokens: 1, outputTokens: 1 };
    } };
    await processConversation(env, accepted.conversationId, { model });
    const view = await getConversationView(env, 'u_alex', accepted.conversationId);
    expect(view!.mode).toBe('human');
    expect(await count('mock_receipts')).toBe(0);
    expect(view!.messages.some((message) => message.text.includes('This stale reply'))).toBe(false);
  });

  it('handles support keywords before invoking a model', async () => {
    const { env } = runtime();
    const accepted = await ingestEvent(env, inbound('agent'));
    const model = { generate: vi.fn() };
    await processConversation(env, accepted.conversationId, { model });
    expect(model.generate).not.toHaveBeenCalled();
    expect((await getConversationView(env, 'u_alex', accepted.conversationId))!.mode).toBe('human');
    expect(await count('mock_receipts')).toBe(0);
  });

  it('honors the global send pause and recovers delivery on resume', async () => {
    const { env } = runtime();
    const accepted = await ingestEvent(env, inbound());
    await env.DB.prepare("INSERT INTO system_settings(key,value) VALUES ('outbound_paused','true')").run();
    await processConversation(env, accepted.conversationId);
    expect(await count('mock_receipts')).toBe(0);
    await env.DB.prepare("UPDATE system_settings SET value='false' WHERE key='outbound_paused'").run();
    await processConversation(env, accepted.conversationId);
    expect(await count('mock_receipts')).toBe(1);
  });

  it('closes the channel and cancels queued work before any reply is sent', async () => {
    const { env } = runtime();
    const event = inbound();
    const accepted = await ingestEvent(env, event);
    await ingestEvent(env, { schemaVersion: 1, type: 'conversation.closed', eventId: crypto.randomUUID(), subject: event.subject,
      channel: 'mock', occurredAt: new Date().toISOString() });
    await processConversation(env, accepted.conversationId);
    expect((await getConversationView(env, 'u_alex', accepted.conversationId))!.status).toBe('closed');
    expect(await count('mock_receipts')).toBe(0);
  });

  it('does not treat delivery callbacks as new customer messages', async () => {
    const { env } = runtime();
    const event = inbound();
    const accepted = await ingestEvent(env, event);
    await processConversation(env, accepted.conversationId);
    const job = await env.DB.prepare('SELECT provider_message_id FROM outbound_jobs LIMIT 1').first<{ provider_message_id: string }>();
    await ingestEvent(env, { schemaVersion: 1, type: 'delivery.updated', eventId: crypto.randomUUID(),
      subject: event.subject, channel: 'mock', occurredAt: new Date().toISOString(), messageId: job!.provider_message_id, state: 'sent' });
    await processConversation(env, accepted.conversationId);
    expect(await count('inbox')).toBe(1);
    expect(await count('mock_receipts')).toBe(1);
    expect((await getConversationView(env, 'u_alex', accepted.conversationId))!.messages.find((message) => message.role === 'assistant')!.status).toBe('delivered');
  });

  it('encrypts message bodies and raw event payloads before storage', async () => {
    const { env } = runtime();
    await ingestEvent(env, inbound('Fictional private test text'));
    const row = await env.DB.prepare('SELECT body_ciphertext FROM messages LIMIT 1').first<{ body_ciphertext: string }>();
    const event = await env.DB.prepare('SELECT payload_ciphertext FROM webhook_events LIMIT 1').first<{ payload_ciphertext: string }>();
    expect(row!.body_ciphertext).toMatch(/^v1:/);
    expect(row!.body_ciphertext).not.toContain('Fictional private test text');
    expect(event!.payload_ciphertext).toMatch(/^v1:/);
  });

  it('rechecks closure immediately before provider acceptance', async () => {
    const { env } = runtime();
    const event = inbound();
    const accepted = await ingestEvent(env, event);
    await processConversation(env, accepted.conversationId, { beforeDispatch: async () => {
      await ingestEvent(env, { schemaVersion: 1, type: 'conversation.closed', eventId: crypto.randomUUID(),
        subject: event.subject, channel: 'mock', occurredAt: new Date().toISOString() });
    } });
    expect(await count('mock_receipts')).toBe(0);
    const job = await env.DB.prepare('SELECT status FROM outbound_jobs LIMIT 1').first<{ status: string }>();
    expect(job!.status).toBe('cancelled');
  });

  it('recovers a crashed pre-send claim through the mock durable idempotency guarantee', async () => {
    const { env } = runtime();
    const accepted = await ingestEvent(env, inbound());
    await expect(processConversation(env, accepted.conversationId, { beforeDispatch: async () => {
      throw new Error('Simulated crash before provider acceptance');
    } })).rejects.toThrow();
    expect(await count('mock_receipts')).toBe(0);
    await processConversation(env, accepted.conversationId);
    expect(await count('mock_receipts')).toBe(1);
  });

  it('rejects a stale dispatch worker even when another worker holds a valid lease', async () => {
    const { env } = runtime();
    const accepted = await ingestEvent(env, inbound());
    const durableMock = new MockMessagingTransport(env);
    const transport: MessagingTransport = {
      send: async (request) => {
        await env.DB.prepare("UPDATE conversations SET lease_token='replacement-worker',lease_until=? WHERE id=?")
          .bind(Date.now() + 10000, accepted.conversationId).run();
        return durableMock.send(request);
      },
      reconcile: (key) => durableMock.reconcile(key),
    };
    await processConversation(env, accepted.conversationId, { transport });
    expect(await count('mock_receipts')).toBe(0);
  });

  it('fences a model result from an expired worker and permits later recovery', async () => {
    const { env } = runtime();
    const accepted = await ingestEvent(env, inbound());
    await processConversation(env, accepted.conversationId, { beforeModelCommit: async () => {
      await env.DB.prepare("UPDATE conversations SET lease_token='new-worker',lease_until=0 WHERE id=?").bind(accepted.conversationId).run();
    } });
    expect(await count('outbound_jobs')).toBe(0);
    await processConversation(env, accepted.conversationId);
    expect(await count('mock_receipts')).toBe(1);
  });

  it('bounds retries for model failures and leaves the failed request visible', async () => {
    const { env } = runtime();
    const accepted = await ingestEvent(env, inbound());
    const model: ModelProvider = { generate: vi.fn(async () => { throw new Error('Simulated model failure'); }) };
    for (let i = 0; i < 5; i++) await processConversation(env, accepted.conversationId, { model });
    expect(model.generate).toHaveBeenCalledTimes(3);
    const view = await getConversationView(env, 'u_alex', accepted.conversationId);
    expect(view!.messages[0]!.status).toBe('failed');
    expect(view!.messages.filter((message) => message.role === 'assistant')).toEqual([
      expect.objectContaining({ model: 'plause-status', status: 'delivered', text: expect.stringContaining('Automatic retries have stopped') }),
    ]);
    expect(await count('outbound_jobs')).toBe(1);
  });

  it('retries a confirmed transient send failure using the original idempotency key', async () => {
    const { env } = runtime();
    const accepted = await ingestEvent(env, inbound());
    const durableMock = new MockMessagingTransport(env);
    const keys: string[] = [];
    const transport: MessagingTransport = {
      send: async (request) => {
        keys.push(request.idempotencyKey);
        return keys.length === 1 ? { state: 'retryable_failed', code: 'test_rate_limit' } : durableMock.send(request);
      },
      reconcile: (key) => durableMock.reconcile(key),
    };
    await processConversation(env, accepted.conversationId, { transport });
    expect(await count('mock_receipts')).toBe(0);
    await env.DB.prepare('UPDATE outbound_jobs SET next_attempt_at=0').run();
    await processConversation(env, accepted.conversationId, { transport });
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(1);
    expect(await count('mock_receipts')).toBe(1);
  });

  it('enforces an atomic daily intake cap while allowing safe replay', async () => {
    const { env } = runtime();
    await env.DB.prepare("UPDATE users SET daily_message_limit=1 WHERE id='u_alex'").run();
    const event = inbound();
    await ingestEvent(env, event);
    await expect(ingestEvent(env, inbound('Another message'))).rejects.toMatchObject({ status: 429 });
    expect((await ingestEvent(env, event)).duplicate).toBe(true);
    expect(await count('inbox')).toBe(1);
  });

  it('revokes pending delivery when a channel binding is removed', async () => {
    const { env } = runtime();
    const accepted = await ingestEvent(env, inbound());
    await env.DB.prepare("UPDATE bindings SET status='revoked' WHERE subject_id='mock-alex'").run();
    await processConversation(env, accepted.conversationId);
    expect(await count('mock_receipts')).toBe(0);
    await expect(ingestEvent(env, inbound())).rejects.toMatchObject({ status: 403 });
  });
});

describe('account and channel boundaries', () => {
  it('isolates conversation reads, writes, and ownership changes between accounts', async () => {
    const { env } = runtime();
    const alex = await session(env);
    const sam = await session(env, inviteSam);
    const path = `/api/conversations/${alex.conversationId}`;
    expect((await call(env, path, { headers: { cookie: sam.cookie } })).status).toBe(404);
    expect((await call(env, `${path}/messages`, { method: 'POST', headers: { cookie: sam.cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Wrong tenant', clientMessageId: crypto.randomUUID() }) })).status).toBe(404);
    expect((await call(env, `${path}/handoff`, { method: 'POST', headers: { cookie: sam.cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'human' }) })).status).toBe(404);
  });

  it('uses an HttpOnly expiring session and rejects cross-origin mutations', async () => {
    const { env } = runtime();
    const response = await call(env, '/api/session', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ inviteToken: inviteAlex }) });
    expect(response.headers.get('set-cookie')).toContain('HttpOnly');
    expect(response.headers.get('set-cookie')).toContain('SameSite=Strict');
    const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
    expect((await call(env, '/api/session', { method: 'DELETE', headers: { cookie, origin: 'https://untrusted.test' } })).status).toBe(403);
    expect((await call(env, '/api/me')).status).toBe(401);
    await env.DB.prepare('UPDATE sessions SET expires_at=0').run();
    expect((await call(env, '/api/me', { headers: { cookie } })).status).toBe(401);
  });

  it('deduplicates a browser retry with the same client ID and rejects changed text', async () => {
    const { env } = runtime();
    const alex = await session(env);
    const clientMessageId = crypto.randomUUID();
    const post = (text: string) => call(env, `/api/conversations/${alex.conversationId}/messages`, { method: 'POST', headers: { cookie: alex.cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify({ text, clientMessageId }) });
    expect((await post('Same message')).status).toBe(202);
    const replay = await post('Same message');
    expect(replay.status).toBe(202);
    expect((await replay.json() as { duplicate: boolean }).duplicate).toBe(true);
    expect((await post('Changed message')).status).toBe(409);
    expect(await count('inbox')).toBe(1);
  });

  it('fails closed for a public host and for unconfigured real provider modes', async () => {
    const { env } = runtime();
    const ctx = createExecutionContext();
    expect((await worker.fetch(new Request('https://plause.example/api/me'), env, ctx)).status).toBe(503);
    expect((await call({ ...env, MESSAGING_PROVIDER: 'apple_business' }, '/api/me')).status).toBe(503);
  });

  it('requires independent operator authorization to pause delivery', async () => {
    const { env } = runtime();
    const response = await call(env, '/api/operator/pause', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"paused":true}' });
    expect(response.status).toBe(401);
  });
});
