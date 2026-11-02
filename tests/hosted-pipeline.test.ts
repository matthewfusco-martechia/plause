import { describe, it, expect, vi } from 'vitest';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../apps/api/src/index';
import { ingestEvent, processConversation } from '../apps/api/src/pipeline';
import { getConversationView } from '../apps/api/src/store';
import { ModelCallError, type Env, type MessagingEvent, type ModelProvider, type QueueJob } from '../packages/contracts/src/index';
import { inviteAlex, testEnv } from './setup';

function runtime(overrides: Partial<Env> = {}): Env {
  return { ...testEnv, APP_ENV: 'local', MODEL_PROVIDER: 'openai', MESSAGING_PROVIDER: 'mock',
    LIVE_MODEL_ENABLED: 'true', OPENAI_API_KEY: 'sk-fictional-test-key-no-network',
    JOBS: { send: async (_job: QueueJob) => {} } as unknown as Queue<QueueJob>, ...overrides };
}
function inbound(text = 'A fictional request for Plause'): MessagingEvent {
  return { schemaVersion: 1, type: 'message.received', eventId: crypto.randomUUID(), messageId: crypto.randomUUID(),
    subject: { provider: 'mock', businessId: 'plause-local', subjectId: 'mock-alex' },
    channel: 'mock', occurredAt: new Date().toISOString(), text };
}
function provider() {
  return { generate: vi.fn<ModelProvider['generate']>(async () => ({ text: 'A controlled hosted reply.',
    inputTokens: 100, outputTokens: 10, model: 'gpt-6-luna', responseId: 'resp_pipeline_fixture' })) };
}
async function call(env: Env, path: string, init: RequestInit = {}) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request('http://localhost' + path, init) as Request<unknown, IncomingRequestCfProperties>, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

describe('hosted conversation integration without external calls', () => {
  it('records model provenance and one cost ledger while delivering one mock reply on replay', async () => {
    const env = runtime();
    const model = provider();
    const accepted = await ingestEvent(env, inbound());
    await processConversation(env, accepted.conversationId, { model });
    await processConversation(env, accepted.conversationId, { model });
    const view = await getConversationView(env, 'u_alex', accepted.conversationId);
    const replies = view!.messages.filter((message) => message.role === 'assistant');
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ model: 'gpt-6-luna', status: 'delivered' });
    expect(replies[0]!.inReplyTo).toBe(view!.messages.find((message) => message.role === 'user')!.id);
    expect(model.generate).toHaveBeenCalledTimes(1);
    const usage = await env.DB.prepare('SELECT COUNT(*) AS n,SUM(estimated_cost_micro_usd) AS cost FROM usage_ledgers').first();
    expect(usage).toEqual({ n: 1, cost: 30 });
  });

  it('reuses completed encrypted output after a reply transaction failure', async () => {
    const env = runtime();
    const model = provider();
    const accepted = await ingestEvent(env, inbound());
    await processConversation(env, accepted.conversationId, { model, beforeModelCommit: async () => { throw new Error('Simulated interrupted commit'); } });
    expect((await getConversationView(env, 'u_alex', accepted.conversationId))!.messages.filter((message) => message.role === 'assistant')).toHaveLength(0);
    await processConversation(env, accepted.conversationId, { model });
    const view = await getConversationView(env, 'u_alex', accepted.conversationId);
    expect(view!.messages.filter((message) => message.role === 'assistant')).toHaveLength(1);
    expect(model.generate).toHaveBeenCalledTimes(1);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM usage_ledgers').first()).toEqual({ n: 1 });
  });

  it('stops an uncertain generation and retains its full budget hold on repeated wakeups', async () => {
    const env = runtime();
    const model = { generate: vi.fn(async () => { throw new ModelCallError('model_timeout', true); }) };
    const accepted = await ingestEvent(env, inbound());
    await processConversation(env, accepted.conversationId, { model });
    await processConversation(env, accepted.conversationId, { model });
    expect(model.generate).toHaveBeenCalledTimes(1);
    expect(await env.DB.prepare('SELECT state,budget_debit_micro_usd FROM model_attempts').first())
      .toEqual({ state: 'unknown', budget_debit_micro_usd: 1324 });
    expect(await env.DB.prepare('SELECT status,last_error FROM inbox').first())
      .toEqual({ status: 'failed', last_error: 'model_timeout' });
    expect((await getConversationView(env, 'u_alex', accepted.conversationId))!.messages.filter((message) => message.role === 'assistant')).toEqual([
      expect.objectContaining({ model: 'plause-status', status: 'delivered', text: expect.stringContaining('couldn’t confirm the provider outcome') }),
    ]);
  });

  it('keeps authentication and history available while unconfigured hosted input is rejected', async () => {
    const env = runtime({ OPENAI_API_KEY: '' });
    const health = await call(env, '/health');
    const status = await health.json() as Record<string, unknown>;
    expect(status).toMatchObject({ model: 'openai', modelReady: false, modelStatus: 'not_configured', apple: { enabled: false, webhookConfigured: false, transportConfigured: false } });
    expect(JSON.stringify(status)).not.toContain('sk-');
    const login = await call(env, '/api/session', { method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/json' },
      body: JSON.stringify({ inviteToken: inviteAlex }) });
    expect(login.status).toBe(200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const { conversationId } = await login.json() as { conversationId: string };
    expect((await call(env, `/api/conversations/${conversationId}`, { headers: { cookie } })).status).toBe(200);
    const send = await call(env, `/api/conversations/${conversationId}/messages`, { method: 'POST',
      headers: { cookie, origin: 'http://localhost', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Do not send this to a model', clientMessageId: crypto.randomUUID() }) });
    expect(send.status).toBe(503);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM model_attempts').first()).toEqual({ n: 0 });
  });
});
