import { describe, expect, it, vi } from 'vitest';
import { classifyFailure, terminalFailureStatements, type FailureContext } from '../apps/api/src/failures';
import { ingestEvent, processConversation } from '../apps/api/src/pipeline';
import { getConversationView, setConversationMode } from '../apps/api/src/store';
import { ModelCallError, type Env, type MessagingEvent, type ModelProvider, type QueueJob } from '../packages/contracts/src/index';
import { testEnv } from './setup';

function runtime(overrides: Partial<Env> = {}): Env {
  return { ...testEnv, APP_ENV: 'local', MODEL_PROVIDER: 'openai', MESSAGING_PROVIDER: 'mock', LIVE_MODEL_ENABLED: 'true',
    OPENAI_API_KEY: 'synthetic-no-live-key', JOBS: { send: async (_job: QueueJob) => {} } as unknown as Queue<QueueJob>, ...overrides };
}
function inbound(text = 'A fictional request'): MessagingEvent {
  return { schemaVersion: 1, type: 'message.received', eventId: crypto.randomUUID(), messageId: crypto.randomUUID(),
    subject: { provider: 'mock', businessId: 'plause-local', subjectId: 'mock-alex' }, channel: 'mock', occurredAt: new Date().toISOString(), text };
}
async function replies(env: Env, conversationId: string) {
  return (await getConversationView(env, 'u_alex', conversationId))!.messages.filter((message) => message.model === 'plause-status');
}
async function wakeRepeatedly(env: Env, conversationId: string, model?: ModelProvider) {
  for (let index = 0; index < 4; index++) await processConversation(env, conversationId, model ? { model } : {});
}
async function processingContext(env: Env): Promise<FailureContext> {
  const { conversationId } = await ingestEvent(env, inbound());
  const input = await env.DB.prepare('SELECT sequence,message_id FROM inbox WHERE conversation_id=?').bind(conversationId)
    .first<{ sequence: number; message_id: string }>();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("UPDATE conversations SET lease_token='failure-test-lease',lease_until=? WHERE id=?").bind(now + 60_000, conversationId),
    env.DB.prepare("UPDATE inbox SET status='processing' WHERE sequence=?").bind(input!.sequence),
    env.DB.prepare("UPDATE messages SET status='processing' WHERE id=?").bind(input!.message_id),
  ]);
  return { userId: 'u_alex', conversationId, messageId: input!.message_id, inboxSequence: input!.sequence,
    leaseToken: 'failure-test-lease', ownershipVersion: 0, contextRevision: 0, now };
}

describe('fixed content-free failure classification', () => {
  it.each([
    ['model_budget_exhausted', 'spending limit'], ['research_daily_limit', 'daily search limit'],
    ['hosted_model_not_enabled', 'isn’t ready'], ['model_auth_failed', 'isn’t ready'], ['research_auth_failed', 'isn’t ready'],
    ['invalid_hosted_policy', 'isn’t ready'], ['model_input_limit', 'input limit'], ['model_request_rejected', 'Automatic retries have stopped'],
  ])('explains %s without reflecting exception content', (code, phrase) => {
    const notice = classifyFailure(new ModelCallError(code));
    expect(notice.code).toBe(code);
    expect(notice.text).toContain(phrase);
    expect(notice.text.length).toBeLessThan(1000);
  });
  it('puts uncertain outcome copy ahead of optimistic error-specific copy', () => {
    const notice = classifyFailure(new ModelCallError('model_budget_exhausted', true));
    expect(notice.text).toContain('couldn’t confirm the provider outcome');
    expect(notice.text).toContain('not be retried automatically');
    expect(notice.text).not.toContain('No model generation');
  });
  it.each([new Error('SECRET_PROMPT https://provider.invalid?key=SECRET_KEY'),
    new ModelCallError('secret_prompt_and_key'), new ModelCallError('model_timeout\nSECRET_KEY')])
    ('drops arbitrary exception messages and unreviewed codes', (error) => {
      const notice = classifyFailure(error);
      expect(notice.code).toBe('model_failed');
      expect(JSON.stringify(notice)).not.toMatch(/SECRET|secret_prompt|provider\.invalid/);
    });

  it.each(['google_calendar_timeout', 'google_calendar_outcome_unknown'])('describes %s as a calendar outcome without an AI billing claim', (code) => {
    for (const chargePossible of [false, true]) {
      const notice = classifyFailure(new ModelCallError(code, chargePossible));
      expect(notice.code).toBe(code);
      expect(notice.text).toContain('couldn’t confirm the calendar outcome');
      expect(notice.text).toContain('No calendar write will be retried automatically');
      expect(notice.text).toContain('exact calendar action ID');
      expect(notice.text).not.toMatch(/AI|charg|bill|usage|generation|spending/i);
    }
  });
  it.each(['google_calendar_not_enabled', 'google_calendar_disabled', 'google_calendar_local_only',
    'google_calendar_not_configured', 'google_calendar_config_invalid', 'google_calendar_not_connected'])
    ('provides configuration guidance for %s without promising zero model cost', (code) => {
      const notice = classifyFailure(new ModelCallError(code));
      expect(notice.code).toBe(code);
      expect(notice.text).toContain('Review the Google connection controls');
      expect(notice.text).not.toMatch(/charg|bill|generation|spending|no (?:AI|model)/i);
    });
  it.each(['google_calendar_approval_invalid', 'google_calendar_approval_revoked', 'google_calendar_cache_invalid',
    'google_calendar_cache_purged', 'google_calendar_cancelled', 'google_calendar_ownership_invalid', 'google_calendar_source_conflict', 'google_calendar_failed'])
    ('keeps the reviewed %s classification content-free', (code) => {
      const notice = classifyFailure(new ModelCallError(code));
      expect(notice.code).toBe(code);
      expect(notice.text).toContain('No calendar write will be retried automatically');
      expect(notice.text).not.toContain(code);
    });
  it('rejects unreviewed Google codes and preserves the safe planning-context classification', () => {
    expect(classifyFailure(new ModelCallError('google_calendar_secret_prompt')).code).toBe('model_failed');
    expect(classifyFailure(new ModelCallError('invalid_model_planning_context')).code).toBe('invalid_model_planning_context');
  });
});

describe('atomic terminal status replies', () => {
  it('commits one encrypted control reply, outbox, failed input and durable classification together', async () => {
    const env = runtime();
    const context = await processingContext(env);
    const notice = classifyFailure(new ModelCallError('model_budget_exhausted'));
    const first = await env.DB.batch(await terminalFailureStatements(env, context, notice));
    expect(first.map((result) => result.meta.changes)).toEqual([1, 1, 1, 1]);
    const replay = await env.DB.batch(await terminalFailureStatements(env, context, notice));
    expect(replay.every((result) => result.meta.changes === 0)).toBe(true);
    expect(await replies(env, context.conversationId)).toEqual([expect.objectContaining({ text: notice.text,
      model: 'plause-status', status: 'queued', inReplyTo: context.messageId })]);
    expect(await env.DB.prepare('SELECT status,last_error FROM inbox').first()).toEqual({ status: 'failed', last_error: notice.code });
    expect(await env.DB.prepare('SELECT status FROM messages WHERE id=?').bind(context.messageId).first()).toEqual({ status: 'failed' });
    const ack = await env.DB.prepare("SELECT body_ciphertext,context_revision,is_memory_control FROM messages WHERE model='plause-status'").first<{
      body_ciphertext: string; context_revision: number; is_memory_control: number }>();
    expect(ack).toMatchObject({ context_revision: 0, is_memory_control: 1 });
    expect(ack!.body_ciphertext).not.toContain(notice.text);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM usage_ledgers').first()).toEqual({ n: 0 });
  });

  it.each([
    ["UPDATE conversations SET mode='human'", 'handoff'], ["UPDATE conversations SET status='closed'", 'closed conversation'],
    ["UPDATE users SET status='disabled' WHERE id='u_alex'", 'disabled account'],
    ["UPDATE bindings SET status='revoked' WHERE user_id='u_alex'", 'revoked binding'],
    ["UPDATE bindings SET channel='web' WHERE user_id='u_alex'", 'channel mismatch'],
    ["UPDATE bindings SET subject_id='replacement' WHERE user_id='u_alex'", 'subject mismatch'],
    ["UPDATE conversations SET user_id='u_sam'", 'changed account'],
    ["UPDATE conversations SET ownership_version=ownership_version+1", 'changed ownership'],
    ["UPDATE conversations SET lease_token='replacement'", 'changed lease'],
    ['UPDATE conversations SET lease_until=0', 'expired lease'],
    ["UPDATE users SET context_revision=context_revision+1 WHERE id='u_alex'", 'privacy revision'],
    ['UPDATE messages SET context_revision=context_revision+1', 'input revision'],
    ["UPDATE messages SET status='cancelled'", 'cancelled input'],
    ["UPDATE inbox SET status='cancelled'", 'cancelled inbox'],
    ["INSERT INTO system_settings(key,value) VALUES ('outbound_paused','true')", 'global pause'],
  ])('writes nothing after %s (%s)', async (sql) => {
    const env = runtime();
    const context = await processingContext(env);
    const statements = await terminalFailureStatements(env, context, classifyFailure(new ModelCallError('model_timeout', true)));
    await env.DB.prepare(sql).run();
    const results = await env.DB.batch(statements);
    expect(results.every((result) => result.meta.changes === 0)).toBe(true);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE model='plause-status'").first()).toEqual({ n: 0 });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM outbound_jobs').first()).toEqual({ n: 0 });
  });

  it('rolls back the acknowledgement and failure state together if any statement fails', async () => {
    const env = runtime();
    const context = await processingContext(env);
    const statements = await terminalFailureStatements(env, context, classifyFailure(new ModelCallError('model_timeout', true)));
    await expect(env.DB.batch([...statements, env.DB.prepare('UPDATE missing_transaction_fixture SET value=1')])).rejects.toThrow();
    expect(await replies(env, context.conversationId)).toHaveLength(0);
    expect(await env.DB.prepare('SELECT status,last_error FROM inbox').first()).toEqual({ status: 'processing', last_error: null });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM outbound_jobs').first()).toEqual({ n: 0 });
  });
});

describe('conversation failure feedback without live requests', () => {
  it('reports an exhausted hosted allowance once without calling the model or opening an attempt', async () => {
    const env = runtime({ MODEL_USER_MONTHLY_BUDGET_MICRO_USD: '1' });
    const model = { generate: vi.fn<ModelProvider['generate']>() };
    const accepted = await ingestEvent(env, inbound());
    await wakeRepeatedly(env, accepted.conversationId, model);
    expect(model.generate).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(await replies(env, accepted.conversationId)).toEqual([expect.objectContaining({ status: 'delivered', text: expect.stringContaining('spending limit') })]);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM model_attempts').first()).toEqual({ n: 0 });
    expect(await env.DB.prepare('SELECT last_error,status FROM inbox').first()).toEqual({ last_error: 'model_budget_exhausted', status: 'failed' });
  });

  it('reports a configuration change after acceptance without sending a model request', async () => {
    const env = runtime();
    const accepted = await ingestEvent(env, inbound());
    const model = { generate: vi.fn<ModelProvider['generate']>() };
    await wakeRepeatedly({ ...env, LIVE_MODEL_ENABLED: 'false' }, accepted.conversationId, model);
    expect(model.generate).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(await replies(env, accepted.conversationId)).toEqual([expect.objectContaining({ status: 'delivered', text: expect.stringContaining('isn’t ready') })]);
  });

  it('uses the real hosted adapter authorization failure and never repeats its request', async () => {
    const fetchSpy = vi.fn<typeof fetch>(async () => new Response('SECRET_PROVIDER_BODY', { status: 401 }));
    vi.stubGlobal('fetch', fetchSpy);
    const env = runtime();
    const event = inbound('SECRET_PROMPT');
    const accepted = await ingestEvent(env, event);
    await ingestEvent(env, event);
    await wakeRepeatedly(env, accepted.conversationId);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const feedback = await replies(env, accepted.conversationId);
    expect(feedback).toHaveLength(1);
    expect(feedback[0]).toMatchObject({ status: 'delivered', text: expect.stringContaining('isn’t ready') });
    expect(feedback[0]!.text).not.toContain('SECRET');
    expect(await env.DB.prepare('SELECT status,last_error FROM inbox').first()).toEqual({ status: 'failed', last_error: 'model_auth_failed' });
    expect(await env.DB.prepare('SELECT state,budget_debit_micro_usd FROM model_attempts').first()).toEqual({ state: 'failed', budget_debit_micro_usd: 0 });
  });

  it('reports a real hosted adapter timeout as uncertain and preserves its hold without another request', async () => {
    const fetchSpy = vi.fn<typeof fetch>(async (url) => String(url).endsWith('/input_tokens')
      ? Response.json({ object: 'response.input_tokens', input_tokens: 100 }) : new Promise<Response>(() => {}));
    vi.stubGlobal('fetch', fetchSpy);
    const env = runtime({ MODEL_TIMEOUT_MS: '30' });
    const accepted = await ingestEvent(env, inbound());
    await processConversation(env, accepted.conversationId, { modelTimeoutMs: 500 });
    await wakeRepeatedly(env, accepted.conversationId);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(await replies(env, accepted.conversationId)).toEqual([expect.objectContaining({ status: 'delivered',
      text: expect.stringContaining('couldn’t confirm the provider outcome') })]);
    expect(await env.DB.prepare('SELECT state,budget_debit_micro_usd FROM model_attempts').first()).toEqual({ state: 'unknown', budget_debit_micro_usd: 1324 });
    expect(await env.DB.prepare('SELECT status,last_error FROM inbox').first()).toEqual({ status: 'failed', last_error: 'model_timeout' });
  });

  it('reports search quota without a second external search or repeated status reply', async () => {
    const fetchSpy = vi.fn<typeof fetch>(async () => Response.json({ results: [] }));
    vi.stubGlobal('fetch', fetchSpy);
    const env = runtime({ MODEL_PROVIDER: 'mock', SEARCH_PROVIDER: 'tavily', LIVE_SEARCH_ENABLED: 'true',
      TAVILY_API_KEY: 'synthetic-no-live-key', SEARCH_USER_DAILY_LIMIT: '1' });
    const first = await ingestEvent(env, inbound('search: public libraries'));
    await processConversation(env, first.conversationId);
    await ingestEvent(env, inbound('search: public museums'));
    await wakeRepeatedly(env, first.conversationId);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(await replies(env, first.conversationId)).toEqual([expect.objectContaining({ status: 'delivered', text: expect.stringContaining('daily search limit') })]);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM search_attempts').first()).toEqual({ n: 1 });
  });

  it('reports an uncertain real search adapter failure without retrying its request', async () => {
    const fetchSpy = vi.fn<typeof fetch>(async () => new Response('SECRET_SEARCH_BODY', { status: 503 }));
    vi.stubGlobal('fetch', fetchSpy);
    const env = runtime({ MODEL_PROVIDER: 'mock', SEARCH_PROVIDER: 'tavily', LIVE_SEARCH_ENABLED: 'true', TAVILY_API_KEY: 'synthetic-no-live-key' });
    const accepted = await ingestEvent(env, inbound('search: public libraries'));
    await wakeRepeatedly(env, accepted.conversationId);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(await replies(env, accepted.conversationId)).toEqual([expect.objectContaining({ status: 'delivered',
      text: expect.stringContaining('couldn’t confirm the provider outcome') })]);
    expect(await env.DB.prepare('SELECT state,error_code FROM search_attempts').first()).toEqual({ state: 'unknown', error_code: 'research_unavailable' });
  });

  it('preserves two generic pending retries, then sends one terminal status without echoing exceptions', async () => {
    const env = runtime({ MODEL_PROVIDER: 'mock' });
    const accepted = await ingestEvent(env, inbound());
    const model = { generate: vi.fn(async () => { throw new Error('SECRET_PROMPT_AND_KEY'); }) };
    for (let attempt = 0; attempt < 2; attempt++) {
      await processConversation(env, accepted.conversationId, { model });
      expect(await replies(env, accepted.conversationId)).toHaveLength(0);
      expect(await env.DB.prepare('SELECT status,last_error FROM inbox').first()).toEqual({ status: 'pending', last_error: 'model_failed' });
    }
    await wakeRepeatedly(env, accepted.conversationId, model);
    expect(model.generate).toHaveBeenCalledTimes(3);
    expect(await replies(env, accepted.conversationId)).toEqual([expect.objectContaining({ status: 'delivered', text: classifyFailure(new Error()).text })]);
  });

  it('keeps status replies and failed inputs out of the next model history', async () => {
    const env = runtime({ MODEL_PROVIDER: 'mock' });
    const accepted = await ingestEvent(env, inbound());
    await processConversation(env, accepted.conversationId, { model: { generate: async () => { throw new ModelCallError('model_auth_failed'); } } });
    await ingestEvent(env, inbound('A fresh fictional request'));
    const model = { generate: vi.fn<ModelProvider['generate']>(async () => ({ text: 'A fresh result', inputTokens: 10, outputTokens: 3, model: 'mock' })) };
    await processConversation(env, accepted.conversationId, { model });
    expect(model.generate).toHaveBeenCalledTimes(1);
    expect(model.generate.mock.calls[0]![0].history).toEqual([]);
    expect(await replies(env, accepted.conversationId)).toHaveLength(1);
  });

  it.each(['handoff', 'close', 'disable memory'] as const)('does not acknowledge an in-flight failure cancelled by %s', async (change) => {
    const env = runtime();
    const accepted = await ingestEvent(env, inbound());
    const model = { generate: vi.fn(async () => {
      if (change === 'handoff') await setConversationMode(env, 'u_alex', accepted.conversationId, 'human');
      else if (change === 'close') {
        const base = inbound();
        await ingestEvent(env, { schemaVersion: 1, type: 'conversation.closed', eventId: base.eventId, subject: base.subject,
          channel: base.channel, occurredAt: base.occurredAt });
      } else await ingestEvent(env, inbound(change));
      throw new ModelCallError('model_timeout', true);
    }) };
    await processConversation(env, accepted.conversationId, { model });
    await processConversation(env, accepted.conversationId, { model });
    expect(model.generate).toHaveBeenCalledTimes(1);
    expect(await replies(env, accepted.conversationId)).toHaveLength(0);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM inbox WHERE status='failed'").first()).toEqual({ n: 0 });
  });

  it('does not resurrect a completed result after a privacy callback cancels its commit', async () => {
    const env = runtime();
    const accepted = await ingestEvent(env, inbound());
    const model = { generate: vi.fn(async () => ({ text: 'A fictional result', model: 'gpt-6-luna', inputTokens: 100, outputTokens: 10 })) };
    await processConversation(env, accepted.conversationId, { model, beforeModelCommit: async () => {
      await ingestEvent(env, inbound('disable memory'));
      throw new ModelCallError('model_outcome_unknown', true);
    } });
    expect(model.generate).toHaveBeenCalledTimes(1);
    expect(await replies(env, accepted.conversationId)).toHaveLength(0);
    expect(await env.DB.prepare('SELECT state,response_ciphertext FROM model_attempts').first()).toEqual({ state: 'purged', response_ciphertext: null });
  });

  it('does not change a privacy-cancelled source back to received after a generic retryable commit failure', async () => {
    const env = runtime();
    const accepted = await ingestEvent(env, inbound());
    const original = await env.DB.prepare('SELECT message_id FROM inbox').first<{ message_id: string }>();
    const model = { generate: vi.fn(async () => ({ text: 'A fictional result', model: 'gpt-6-luna', inputTokens: 100, outputTokens: 10 })) };
    await processConversation(env, accepted.conversationId, { model, beforeModelCommit: async () => {
      await ingestEvent(env, inbound('disable memory'));
      throw new Error('Simulated interrupted commit');
    } });
    expect(await env.DB.prepare('SELECT status FROM messages WHERE id=?').bind(original!.message_id).first()).toEqual({ status: 'cancelled' });
    expect(await env.DB.prepare('SELECT status FROM inbox WHERE message_id=?').bind(original!.message_id).first()).toEqual({ status: 'cancelled' });
    expect(await replies(env, accepted.conversationId)).toHaveLength(0);
    expect(model.generate).toHaveBeenCalledTimes(1);
  });
});
