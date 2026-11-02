import { describe, expect, it, vi } from 'vitest';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../apps/api/src/index';
import { ingestEvent, processConversation } from '../apps/api/src/pipeline';
import { getConversationView, getWebConversation } from '../apps/api/src/store';
import { listMemoriesForUser } from '../apps/api/src/memory-store';
import { MockMessagingTransport, type MessagingTransport } from '../packages/messaging-mock/src/index';
import type { Env, MessagingEvent, ModelProvider, ModelRequest, QueueJob } from '../packages/contracts/src/index';
import { inviteAlex, testEnv } from './setup';

const fact = 'My preferred meeting place is Juniper Pier.';
const otherFact = 'I prefer afternoon meetings in Cedar Park.';

function runtime(hosted = false): Env {
  return { ...testEnv, APP_ENV: 'local', MODEL_PROVIDER: hosted ? 'openai' : 'mock', MESSAGING_PROVIDER: 'mock',
    ...(hosted ? { LIVE_MODEL_ENABLED: 'true', OPENAI_API_KEY: 'test-key-with-no-network-access' } : {}),
    JOBS: { send: async (_job: QueueJob) => {} } as unknown as Queue<QueueJob> };
}

async function inbound(env: Env, text: string, channel: 'mock' | 'web' = 'mock', userId = 'u_alex') {
  if (channel === 'web') await getWebConversation(env, userId);
  const event: MessagingEvent = { schemaVersion: 1, type: 'message.received', eventId: crypto.randomUUID(), messageId: crypto.randomUUID(),
    subject: { provider: channel, businessId: 'plause-local', subjectId: channel === 'web' ? userId : userId === 'u_alex' ? 'mock-alex' : 'mock-sam' },
    channel, occurredAt: new Date().toISOString(), text };
  return ingestEvent(env, event);
}

async function save(env: Env, userId = 'u_alex', content = fact) {
  const accepted = await inbound(env, `remember: ${content}`, 'mock', userId);
  await processConversation(env, accepted.conversationId);
  const snapshot = await listMemoriesForUser(env, userId);
  return { ...accepted, memoryId: snapshot.memories.find((memory) => memory.text === content)!.id, revision: snapshot.revision };
}

function probingModel(text = 'An innocuous test response.') {
  const seen: ModelRequest[] = [];
  const model: ModelProvider = { generate: vi.fn(async (request) => {
    seen.push(request);
    return { text, inputTokens: 100, outputTokens: 10, model: 'gpt-6-luna', responseId: 'resp_memory_fixture' };
  }) };
  return { model, seen };
}

async function countReceipts(env: Env): Promise<number> {
  return (await env.DB.prepare('SELECT COUNT(*) AS n FROM mock_receipts').first<{ n: number }>())!.n;
}

describe('memory privacy across conversations and queued work', () => {
  it('resets future context across web and mock while keeping the visible transcript', async () => {
    const env = runtime();
    const saved = await save(env);
    const old = await inbound(env, 'My recent conversation also mentioned Juniper Pier.');
    await processConversation(env, old.conversationId, { model: probingModel(fact).model });
    await inbound(env, 'An older queued request about Juniper Pier.', 'web');
    await inbound(env, `forget memory ${saved.memoryId}`, 'web');
    const probe = probingModel();
    const next = await inbound(env, 'What meeting places do you know about?');
    await processConversation(env, next.conversationId, { model: probe.model });
    expect(probe.seen).toHaveLength(1);
    expect(probe.seen[0]).toMatchObject({ history: [], memories: [] });
    expect(probe.seen[0]!.contextRevision).toBeGreaterThan(saved.revision);
    expect(JSON.stringify(probe.seen)).not.toContain('Juniper Pier');
    const view = await getConversationView(env, 'u_alex', saved.conversationId);
    expect(view!.messages.some((message) => message.text.includes('Juniper Pier'))).toBe(true);
  });

  it('cancels older work across both user channels without cancelling another tenant', async () => {
    const env = runtime();
    const alex = await save(env);
    const sam = await save(env, 'u_sam', otherFact);
    const first = await inbound(env, 'Old mock input.');
    const second = await inbound(env, 'Old web input.', 'web');
    const other = await inbound(env, 'A separate tenant request.', 'mock', 'u_sam');
    await inbound(env, `forget memory ${alex.memoryId}`, 'web');
    const forbidden = probingModel();
    await processConversation(env, first.conversationId, { model: forbidden.model });
    await processConversation(env, second.conversationId, { model: forbidden.model });
    expect(forbidden.seen).toEqual([]);
    const allowed = probingModel();
    await processConversation(env, other.conversationId, { model: allowed.model });
    expect(allowed.seen).toHaveLength(1);
    expect(allowed.seen[0]!.memories).toEqual([{ id: sam.memoryId, text: otherFact }]);
    expect((await listMemoriesForUser(env, 'u_sam')).revision).toBe(sam.revision);
  });

  it('fences a response already being generated when another channel forgets a fact', async () => {
    const env = runtime();
    const saved = await save(env);
    const accepted = await inbound(env, 'Please use my preferred meeting place.');
    const model: ModelProvider = { generate: async (request) => {
      expect(request.memories).toEqual([{ id: saved.memoryId, text: fact }]);
      await inbound(env, `forget memory ${saved.memoryId}`, 'web');
      return { text: `Stale response: ${fact}`, inputTokens: 1, outputTokens: 1 };
    } };
    const before = await countReceipts(env);
    await processConversation(env, accepted.conversationId, { model });
    expect(await countReceipts(env)).toBe(before);
    const view = await getConversationView(env, 'u_alex', accepted.conversationId);
    expect(view!.messages.some((message) => message.text.startsWith('Stale response:'))).toBe(false);
  });

  it('blocks an old queued reply when a forget command arrives immediately before dispatch', async () => {
    const env = runtime();
    const saved = await save(env);
    const accepted = await inbound(env, 'Use my saved place.');
    const before = await countReceipts(env);
    await processConversation(env, accepted.conversationId, {
      model: probingModel(`Queued stale response: ${fact}`).model,
      beforeDispatch: async () => { await inbound(env, `forget memory ${saved.memoryId}`, 'web'); },
    });
    expect(await countReceipts(env)).toBe(before);
    const old = await env.DB.prepare("SELECT m.status FROM messages m WHERE m.conversation_id=? AND m.role='assistant' AND m.is_memory_control=0")
      .bind(accepted.conversationId).first<{ status: string }>();
    expect(old!.status).toBe('cancelled');
  });

  it('checks user revision in the mock side effect itself after the application authorization read', async () => {
    const env = runtime();
    await save(env);
    const accepted = await inbound(env, 'A response whose context is revoked at the final boundary.');
    const mock = new MockMessagingTransport(env);
    const transport: MessagingTransport = { send: async (request) => {
      await env.DB.prepare('UPDATE users SET context_revision=context_revision+1 WHERE id=?').bind('u_alex').run();
      return mock.send(request);
    }, reconcile: (key) => mock.reconcile(key) };
    const before = await countReceipts(env);
    await processConversation(env, accepted.conversationId, { model: probingModel().model, transport });
    expect(await countReceipts(env)).toBe(before);
    const output = await env.DB.prepare("SELECT status,error_code FROM outbound_jobs WHERE message_id IN (SELECT id FROM messages WHERE is_memory_control=0)").first();
    expect(output).toEqual({ status: 'failed', error_code: 'dispatch_blocked' });
  });

  it('records an in-flight send as uncertain immediately when a privacy command arrives', async () => {
    const env = runtime();
    const saved = await save(env);
    const accepted = await inbound(env, 'A request with an in-flight transport.');
    let observedStatus: string | undefined;
    const transport: MessagingTransport = { send: async (request) => {
      await inbound(env, `forget memory ${saved.memoryId}`, 'web');
      const message = await env.DB.prepare(`SELECT m.status FROM messages m JOIN outbound_jobs o ON o.message_id=m.id WHERE o.id=?`)
        .bind(request.jobId).first<{ status: string }>();
      observedStatus = message?.status;
      return { state: 'delivery_unknown', code: 'simulated_connection_lost' };
    }, reconcile: async () => null };
    await processConversation(env, accepted.conversationId, { model: probingModel().model, transport });
    const old = await env.DB.prepare(`SELECT status FROM outbound_jobs WHERE message_id IN
      (SELECT id FROM messages WHERE role='assistant' AND is_memory_control=0)`).first<{ status: string }>();
    expect(observedStatus).toBe('delivery_unknown');
    expect(old!.status).toBe('delivery_unknown');
  });

  it('turns memory off without deleting facts and resets context again when enabled', async () => {
    const env = runtime();
    const saved = await save(env);
    const old = await inbound(env, 'This old context must be excluded after disabling.');
    await processConversation(env, old.conversationId, { model: probingModel(fact).model });
    await inbound(env, 'disable memory', 'web');
    const off = probingModel();
    const disabledTurn = await inbound(env, 'An input while saved memory is off.');
    await processConversation(env, disabledTurn.conversationId, { model: off.model });
    expect(off.seen[0]).toMatchObject({ history: [], memories: [] });
    expect((await listMemoriesForUser(env, 'u_alex')).memories.map((memory) => memory.text)).toEqual([fact]);
    await inbound(env, 'enable memory', 'web');
    const on = probingModel();
    const enabledTurn = await inbound(env, 'An input after explicitly enabling memory.');
    await processConversation(env, enabledTurn.conversationId, { model: on.model });
    expect(on.seen[0]).toMatchObject({ history: [], memories: [{ id: saved.memoryId, text: fact }] });
  });

  it('allows forgetting after the ordinary daily message cap has been exhausted', async () => {
    const env = runtime();
    const saved = await save(env);
    await env.DB.prepare('UPDATE users SET daily_message_limit=1 WHERE id=?').bind('u_alex').run();
    const accepted = await inbound(env, `forget memory ${saved.memoryId}`);
    expect(accepted.duplicate).toBe(false);
    expect((await listMemoriesForUser(env, 'u_alex')).memories).toEqual([]);
  });

  it('keeps an uncertain obsolete send visible without blocking new privacy confirmations or ordinary turns', async () => {
    const env = runtime();
    const saved = await save(env);
    const old = await inbound(env, 'An input whose delivery will be uncertain.');
    const mock = new MockMessagingTransport(env);
    let oldSends = 0;
    const transport: MessagingTransport = {
      supportsIdempotentRetry: true,
      send: vi.fn(async (request) => {
        if (request.text.startsWith('Uncertain old result:')) {
          oldSends++;
          return { state: 'delivery_unknown' as const, code: 'simulated_missing_receipt' };
        }
        return mock.send(request);
      }),
      reconcile: vi.fn(async () => null),
    };
    await processConversation(env, old.conversationId, { model: probingModel(`Uncertain old result: ${fact}`).model, transport });
    await env.DB.prepare("UPDATE outbound_jobs SET next_attempt_at=0 WHERE status='delivery_unknown'").run();
    await inbound(env, `forget memory ${saved.memoryId}`);
    const next = await inbound(env, 'A new ordinary turn after forgetting.');
    const probe = probingModel('A new response with fresh context.');
    await processConversation(env, next.conversationId, { model: probe.model, transport });
    expect(oldSends).toBe(1);
    expect(transport.reconcile).not.toHaveBeenCalled();
    expect(probe.seen).toHaveLength(1);
    expect(probe.seen[0]).toMatchObject({ memories: [], history: [] });
    const view = await getConversationView(env, 'u_alex', next.conversationId);
    expect(view!.messages.find((message) => message.text.startsWith('Uncertain old result:'))!.status).toBe('delivery_unknown');
    expect(view!.messages.find((message) => message.text.startsWith('Forgot '))!.status).toBe('delivered');
    expect(view!.messages.find((message) => message.text === 'A new response with fresh context.')!.status).toBe('delivered');
    expect(await countReceipts(env)).toBe(3);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM outbound_jobs WHERE status='delivery_unknown'").first()).toEqual({ n: 1 });
  });
});

describe('memory privacy and hosted result persistence without live calls', () => {
  it('purges a cached response and cancels its pending input instead of replaying erased facts', async () => {
    const env = runtime(true);
    const saved = await save(env);
    const accepted = await inbound(env, 'Use my remembered place.');
    const probe = probingModel(`Cached old response: ${fact}`);
    await processConversation(env, accepted.conversationId, { model: probe.model,
      beforeModelCommit: async () => { throw new Error('Simulated interruption before reply commit'); } });
    expect(await env.DB.prepare('SELECT state FROM model_attempts').first()).toEqual({ state: 'completed' });
    await inbound(env, `forget memory ${saved.memoryId}`, 'web');
    expect(await env.DB.prepare('SELECT state,response_ciphertext,input_digest,budget_debit_micro_usd FROM model_attempts').first())
      .toEqual({ state: 'purged', response_ciphertext: null, input_digest: '', budget_debit_micro_usd: 30 });
    await processConversation(env, accepted.conversationId, { model: probe.model });
    expect(probe.seen).toHaveLength(1);
    const view = await getConversationView(env, 'u_alex', accepted.conversationId);
    expect(view!.messages.some((message) => message.text.startsWith('Cached old response:'))).toBe(false);
  });

  it('retains late provider cost without restoring a revoked cache or sending its output', async () => {
    const env = runtime(true);
    const saved = await save(env);
    const accepted = await inbound(env, 'Use my saved place.');
    const model: ModelProvider = { generate: async () => {
      await inbound(env, `forget memory ${saved.memoryId}`, 'web');
      return { text: `Late paid response: ${fact}`, inputTokens: 100, outputTokens: 10, model: 'gpt-6-luna', responseId: 'resp_late_memory' };
    } };
    const before = await countReceipts(env);
    await processConversation(env, accepted.conversationId, { model });
    expect(await countReceipts(env)).toBe(before);
    expect(await env.DB.prepare('SELECT state,response_ciphertext,input_digest,budget_debit_micro_usd FROM model_attempts').first())
      .toEqual({ state: 'purged', response_ciphertext: null, input_digest: '', budget_debit_micro_usd: 30 });
    expect(await env.DB.prepare('SELECT estimated_cost_micro_usd,provider_response_id FROM usage_ledgers').first())
      .toEqual({ estimated_cost_micro_usd: 30, provider_response_id: 'resp_late_memory' });
    const view = await getConversationView(env, 'u_alex', accepted.conversationId);
    expect(view!.messages.some((message) => message.text.startsWith('Late paid response:'))).toBe(false);
  });

  it('revalidates context after a stalled token count and never starts paid generation after forgetting', async () => {
    const env = runtime(true);
    const saved = await save(env);
    const accepted = await inbound(env, 'Use my preferred place.');
    let countStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { countStarted = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let paid = 0;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString();
      if (url.endsWith('/responses/input_tokens')) {
        countStarted();
        await gate;
        return Response.json({ object: 'response.input_tokens', input_tokens: 100 });
      }
      paid++;
      throw new Error('Unexpected paid API call.');
    });
    try {
      const processing = processConversation(env, accepted.conversationId);
      await started;
      await inbound(env, `forget memory ${saved.memoryId}`, 'web');
      release();
      await processing;
      expect(paid).toBe(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(await env.DB.prepare('SELECT state,response_ciphertext,budget_debit_micro_usd FROM model_attempts').first())
        .toEqual({ state: 'failed', response_ciphertext: null, budget_debit_micro_usd: 0 });
    } finally { release(); fetchMock.mockRestore(); }
  });

  it('keeps conversational memory controls available when hosted credentials are missing or live use is disabled', async () => {
    const env = { ...runtime(true), OPENAI_API_KEY: '', LIVE_MODEL_ENABLED: 'false' };
    const call = async (path: string, init: RequestInit) => {
      const ctx = createExecutionContext();
      const response = await worker.fetch(new Request('http://localhost' + path, init) as Request<unknown, IncomingRequestCfProperties>, env, ctx);
      await waitOnExecutionContext(ctx);
      return response;
    };
    const session = await call('/api/session', { method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/json' },
      body: JSON.stringify({ inviteToken: inviteAlex }) });
    expect(session.status).toBe(200);
    const cookie = session.headers.get('set-cookie')!.split(';')[0]!;
    const { conversationId } = await session.json() as { conversationId: string };
    for (const text of ['remember: A locally controlled fact.', 'memories', 'disable memory', 'forget all memories']) {
      const accepted = await call(`/api/conversations/${conversationId}/messages`, { method: 'POST',
        headers: { cookie, origin: 'http://localhost', 'content-type': 'application/json' },
        body: JSON.stringify({ text, clientMessageId: crypto.randomUUID() }) });
      expect(accepted.status).toBe(202);
    }
    expect((await listMemoriesForUser(env, 'u_alex')).memories).toEqual([]);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM model_attempts').first()).toEqual({ n: 0 });
    expect(fetch).not.toHaveBeenCalled();
  });
});
