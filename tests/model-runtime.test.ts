import { describe, expect, it, vi } from 'vitest';
import { generateHostedReply, hostedPolicy, type HostedGenerationContext } from '../apps/api/src/model-runtime';
import { setConversationMode } from '../apps/api/src/store';
import { ModelCallError, type Env, type ModelProvider, type ModelRequest, type ModelResponse } from '../packages/contracts/src/index';
import { encryptText, sha256 } from '../packages/security/src/index';
import { testEnv } from './setup';

function hostedEnv(overrides: Partial<Env> = {}): Env {
  return { ...testEnv, MODEL_PROVIDER: 'openai', MESSAGING_PROVIDER: 'mock', APP_ENV: 'local', LIVE_MODEL_ENABLED: 'true',
    OPENAI_API_KEY: 'test-placeholder-no-network-permitted', ...overrides };
}

const request: ModelRequest = { text: 'A fictional hosted model test message.', history: [] };
const response: ModelResponse = { text: 'A synthetic response from an injected test provider.', inputTokens: 100, outputTokens: 10,
  model: 'gpt-6-luna', responseId: 'resp_synthetic_fixture' };

async function contextFor(userId = 'u_alex'): Promise<HostedGenerationContext> {
  const id = crypto.randomUUID();
  const conversationId = `hosted_conv_${id}`;
  const messageId = `hosted_msg_${id}`;
  const leaseToken = `hosted_lease_${id}`;
  const subjectId = `hosted_subject_${id}`;
  await testEnv.DB.batch([
    testEnv.DB.prepare(`INSERT INTO conversations (id,user_id,channel,provider,business_id,subject_id,lease_token,lease_until,created_at,last_activity_at)
      VALUES (?,?,'web','web','plause-local',?,?,?,?,?)`)
      .bind(conversationId, userId, subjectId, leaseToken, Date.now() + 60_000, Date.now(), Date.now()),
    testEnv.DB.prepare(`INSERT INTO bindings (provider,business_id,subject_id,user_id,channel,conversation_id)
      VALUES ('web','plause-local',?,?,'web',?)`).bind(subjectId, userId, conversationId),
    testEnv.DB.prepare(`INSERT INTO messages (id,conversation_id,role,body_ciphertext,content_hash,status,created_at)
      VALUES (?,?,'user',?,?,'processing',?)`)
      .bind(messageId, conversationId, await encryptText(request.text, testEnv.CONTENT_ENCRYPTION_KEY), await sha256(request.text), Date.now()),
  ]);
  return { userId, conversationId, messageId, leaseToken, ownershipVersion: 0 };
}

async function renew(context: HostedGenerationContext): Promise<HostedGenerationContext> {
  const leaseToken = crypto.randomUUID();
  await testEnv.DB.prepare('UPDATE conversations SET lease_token=?,lease_until=? WHERE id=?')
    .bind(leaseToken, Date.now() + 60_000, context.conversationId).run();
  return { ...context, leaseToken };
}

async function attempt(messageId: string) {
  return testEnv.DB.prepare('SELECT * FROM model_attempts WHERE message_id=?').bind(messageId)
    .first<{ state: string; reservation_micro_usd: number; budget_debit_micro_usd: number; response_ciphertext: string | null }>();
}

async function concurrentBudgetCase(env: Env, users: string[]) {
  const contexts = await Promise.all(users.map((user) => contextFor(user)));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const provider = { generate: vi.fn(async () => { await gate; return response; }) };
  const rejected: unknown[] = [];
  const pending = contexts.map((context) => generateHostedReply(env, context, request, provider).catch((error: unknown) => {
    rejected.push(error);
    throw error;
  }));
  // Attach rejection handlers immediately while the successful call is held open.
  const settled = Promise.allSettled(pending);
  try {
    await vi.waitFor(() => { expect(provider.generate).toHaveBeenCalledTimes(1); expect(rejected).toHaveLength(1); });
    const debit = await testEnv.DB.prepare('SELECT SUM(budget_debit_micro_usd) AS total FROM model_attempts').first<{ total: number }>();
    expect(debit!.total).toBe(1324);
  } finally { release(); }
  const results = await settled;
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(rejected[0]).toMatchObject({ code: 'model_budget_exhausted', retryable: false });
}

describe('hosted policy and atomic spend reservations', () => {
  it('defaults to the reviewed model, conservative rates and bounded lease', () => {
    expect(hostedPolicy(hostedEnv())).toEqual({ model: 'gpt-6-luna', maxInputTokens: 4096, maxOutputTokens: 600,
      timeoutMs: 20_000, leaseMs: 60_000, userMonthlyBudgetMicroUsd: 5_000_000, globalMonthlyBudgetMicroUsd: 50_000_000,
      inputRateMicroUsdPerMillion: 250_000, outputRateMicroUsdPerMillion: 500_000 });
  });

  it.each([
    { OPENAI_MODEL: 'unreviewed-model' }, { MODEL_MAX_INPUT_TOKENS: '20001' }, { MODEL_MAX_OUTPUT_TOKENS: '2001' },
    { MODEL_TIMEOUT_MS: '45001' }, { MODEL_MAX_INPUT_TOKENS: '-1' }, { MODEL_MAX_INPUT_TOKENS: '1e3' },
    { MODEL_USER_MONTHLY_BUDGET_MICRO_USD: '0' }, { MODEL_GLOBAL_MONTHLY_BUDGET_MICRO_USD: '1000000001' },
    { MODEL_USER_MONTHLY_BUDGET_MICRO_USD: '60000000' },
  ])('rejects unpriced or unbounded policy %j', (overrides) => {
    expect(() => hostedPolicy(hostedEnv(overrides))).toThrow(ModelCallError);
  });

  it('atomically enforces the per-user cap across simultaneous conversations', async () => {
    await concurrentBudgetCase(hostedEnv({ MODEL_USER_MONTHLY_BUDGET_MICRO_USD: '1324' }), ['u_alex', 'u_alex']);
  });

  it('atomically enforces the global cap across simultaneous users', async () => {
    await concurrentBudgetCase(hostedEnv({ MODEL_USER_MONTHLY_BUDGET_MICRO_USD: '1324', MODEL_GLOBAL_MONTHLY_BUDGET_MICRO_USD: '1324' }), ['u_alex', 'u_sam']);
  });

  it('never calls a provider if the full worst-case reservation cannot fit', async () => {
    const context = await contextFor();
    const provider = { generate: vi.fn(async () => response) };
    await expect(generateHostedReply(hostedEnv({ MODEL_USER_MONTHLY_BUDGET_MICRO_USD: '1323' }), context, request, provider))
      .rejects.toMatchObject({ code: 'model_budget_exhausted', chargePossible: false });
    expect(provider.generate).not.toHaveBeenCalled();
    expect(await attempt(context.messageId)).toBeNull();
  });
});

describe('durable hosted response and billing outcomes', () => {
  it('preserves one validated proposal in encrypted cache across lease restart without another charge', async () => {
    const context = await contextFor();
    const planningContext = { now: Date.parse('2030-06-01T12:00:00Z'), timeZone: 'America/New_York' };
    const plannedRequest = { ...request, planningContext };
    const proposed: ModelResponse = { ...response, text: '', proposal: { type: 'calendar.create', title: 'A simulated visit',
      startsAt: '2030-06-02T09:00:00-04:00', durationMinutes: 30 } };
    const provider = { generate: vi.fn(async () => proposed) };
    const first = await generateHostedReply(hostedEnv(), context, plannedRequest, provider);
    expect(first.proposal).toMatchObject({ type: 'calendar.create', startsAt: '2030-06-02T13:00:00.000Z' });
    const cached = await generateHostedReply(hostedEnv(), await renew(context), plannedRequest, provider);
    expect(cached).toEqual(first);
    expect(provider.generate).toHaveBeenCalledTimes(1);
    expect((await attempt(context.messageId))!.response_ciphertext).not.toContain('A simulated visit');
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM usage_ledgers').first()).toEqual({ n: 1 });
    expect((await attempt(context.messageId))!.budget_debit_micro_usd).toBe(30);
  });

  it('pins the source planning context in the request digest instead of regenerating with a new clock or zone', async () => {
    const context = await contextFor();
    const plannedRequest = { ...request, planningContext: { now: Date.parse('2030-06-01T12:00:00Z'), timeZone: 'America/New_York' } };
    const provider = { generate: vi.fn(async () => response) };
    await generateHostedReply(hostedEnv(), context, plannedRequest, provider);
    await expect(generateHostedReply(hostedEnv(), await renew(context), { ...plannedRequest,
      planningContext: { ...plannedRequest.planningContext, now: plannedRequest.planningContext.now + 1 } }, provider))
      .rejects.toMatchObject({ code: 'model_input_conflict', retryable: false });
    expect(provider.generate).toHaveBeenCalledTimes(1);
    expect((await attempt(context.messageId))!.budget_debit_micro_usd).toBe(30);
  });

  it('fails closed on malformed proposal cache without another generation or a refunded debit', async () => {
    const context = await contextFor();
    const provider = { generate: vi.fn(async () => response) };
    await generateHostedReply(hostedEnv(), context, request, provider);
    const corrupt = { ...response, proposal: { type: 'calendar.create', title: 'A visit', startsAt: '2030-06-02T13:00:00Z',
      durationMinutes: 30, execute: true } };
    await testEnv.DB.prepare('UPDATE model_attempts SET response_ciphertext=? WHERE message_id=?')
      .bind(await encryptText(JSON.stringify(corrupt), testEnv.CONTENT_ENCRYPTION_KEY), context.messageId).run();
    await expect(generateHostedReply(hostedEnv(), await renew(context), request, provider))
      .rejects.toMatchObject({ code: 'cached_model_response_invalid', chargePossible: true, retryable: false });
    expect(provider.generate).toHaveBeenCalledTimes(1);
    expect((await attempt(context.messageId))!.budget_debit_micro_usd).toBe(30);
  });

  it('holds the reservation and never retries a malformed proposal returned by an injected provider', async () => {
    const context = await contextFor();
    const invalid = { ...response, proposal: { type: 'save_memory', instruction: 'private fact' } } as unknown as ModelResponse;
    const provider = { generate: vi.fn(async () => invalid) };
    await expect(generateHostedReply(hostedEnv(), context, request, provider)).rejects.toMatchObject({ code: 'model_response_invalid', chargePossible: true });
    await expect(generateHostedReply(hostedEnv(), await renew(context), request, provider)).rejects.toMatchObject({ code: 'model_outcome_unknown' });
    expect(provider.generate).toHaveBeenCalledTimes(1);
    expect(await attempt(context.messageId)).toMatchObject({ state: 'unknown', budget_debit_micro_usd: 1324 });
  });

  it('reuses encrypted completed output after lease recovery without another generation or usage row', async () => {
    const env = hostedEnv();
    const context = await contextFor();
    const provider = { generate: vi.fn(async () => response) };
    const first = await generateHostedReply(env, context, request, provider);
    const cached = await generateHostedReply(env, await renew(context), request, provider);
    expect(cached).toEqual(first);
    expect(provider.generate).toHaveBeenCalledTimes(1);
    const stored = await attempt(context.messageId);
    expect(stored!.state).toBe('completed');
    expect(stored!.response_ciphertext).toMatch(/^v1:/);
    expect(stored!.response_ciphertext).not.toContain(response.text);
    expect(stored!.reservation_micro_usd).toBe(1324);
    expect(stored!.budget_debit_micro_usd).toBe(30);
    const ledgers = await testEnv.DB.prepare('SELECT model,provider_response_id,estimated_cost_micro_usd FROM usage_ledgers').all();
    expect(ledgers.results).toEqual([{ model: 'gpt-6-luna', provider_response_id: 'resp_synthetic_fixture', estimated_cost_micro_usd: 30 }]);
  });

  it('holds the full reservation for unknown charge and never automatically generates again', async () => {
    const context = await contextFor();
    const provider = { generate: vi.fn(async () => { throw new ModelCallError('model_timeout', true); }) };
    await expect(generateHostedReply(hostedEnv(), context, request, provider)).rejects.toMatchObject({ chargePossible: true });
    const recovered = await renew(context);
    await expect(generateHostedReply(hostedEnv(), recovered, request, provider)).rejects.toMatchObject({ code: 'model_outcome_unknown', retryable: false });
    expect(provider.generate).toHaveBeenCalledTimes(1);
    expect(await attempt(context.messageId)).toMatchObject({ state: 'unknown', budget_debit_micro_usd: 1324 });
  });

  it('can recover a paid response after future-call token caps are lowered', async () => {
    const context = await contextFor();
    const provider = { generate: vi.fn(async () => response) };
    await generateHostedReply(hostedEnv(), context, request, provider);
    const recovered = await generateHostedReply(hostedEnv({ MODEL_MAX_INPUT_TOKENS: '1', MODEL_MAX_OUTPUT_TOKENS: '1' }),
      await renew(context), request, provider);
    expect(recovered).toEqual(response);
    expect(provider.generate).toHaveBeenCalledTimes(1);
  });

  it('treats a dispatched attempt left by a crash as uncertain instead of issuing a free retry', async () => {
    const context = await contextFor();
    const provider = { generate: vi.fn(async () => { throw new ModelCallError('model_timeout', true); }) };
    await expect(generateHostedReply(hostedEnv(), context, request, provider)).rejects.toBeInstanceOf(ModelCallError);
    await testEnv.DB.prepare("UPDATE model_attempts SET state='dispatched' WHERE message_id=?").bind(context.messageId).run();
    await expect(generateHostedReply(hostedEnv(), await renew(context), request, provider)).rejects.toMatchObject({ code: 'model_outcome_unknown' });
    expect(provider.generate).toHaveBeenCalledTimes(1);
    expect(await attempt(context.messageId)).toMatchObject({ state: 'unknown', budget_debit_micro_usd: 1324 });
  });

  it('releases a definitive preflight rejection but keeps a terminal no-retry tombstone', async () => {
    const context = await contextFor();
    const provider = { generate: vi.fn(async () => { throw new ModelCallError('input_token_limit_exceeded', false); }) };
    await expect(generateHostedReply(hostedEnv(), context, request, provider)).rejects.toMatchObject({ chargePossible: false });
    await expect(generateHostedReply(hostedEnv(), await renew(context), request, provider)).rejects.toMatchObject({ code: 'input_token_limit_exceeded', retryable: false });
    expect(provider.generate).toHaveBeenCalledTimes(1);
    expect(await attempt(context.messageId)).toMatchObject({ state: 'failed', budget_debit_micro_usd: 0 });
  });

  it('retains real cost and encrypted output if handoff fences the later conversation reply', async () => {
    const context = await contextFor();
    const env = hostedEnv();
    const provider: ModelProvider = { generate: async () => {
      await setConversationMode(env, context.userId, context.conversationId, 'human');
      return response;
    } };
    await generateHostedReply(env, context, request, provider);
    expect(await attempt(context.messageId)).toMatchObject({ state: 'completed', budget_debit_micro_usd: 30 });
    const ledger = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM usage_ledgers').first<{ n: number }>();
    expect(ledger!.n).toBe(1);
    const output = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM outbound_jobs').first<{ n: number }>();
    expect(output!.n).toBe(0);
  });

  it('preserves real usage while purging a response whose encryption overlaps a restore lock', async () => {
    const context = await contextFor(), provider = { generate: vi.fn(async () => response) };
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void; const observed = new Promise<void>((resolve) => { entered = resolve; });
    const original = crypto.subtle.encrypt.bind(crypto.subtle);
    const encrypt = vi.spyOn(crypto.subtle, 'encrypt').mockImplementation(async (...args) => {
      entered(); await gate; return original(...args);
    });
    const pending = generateHostedReply(hostedEnv(), context, request, provider);
    try {
      await observed;
      expect(provider.generate).toHaveBeenCalledTimes(1);
      await testEnv.DB.prepare("INSERT INTO system_settings(key,value) VALUES('restore_locked','true')").run();
    } finally { release(); }
    try {
      await pending;
      expect(await attempt(context.messageId)).toMatchObject({ state: 'purged', response_ciphertext: null, budget_debit_micro_usd: 30,
        input_tokens: 100, output_tokens: 10 });
      expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n,SUM(estimated_cost_micro_usd) AS cost FROM usage_ledgers').first()).toEqual({ n: 1, cost: 30 });
      await expect(generateHostedReply(hostedEnv(), await renew(context), request, provider)).rejects.toMatchObject({ code: 'model_ownership_invalid' });
      expect(provider.generate).toHaveBeenCalledTimes(1);
      expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM outbound_jobs').first()).toEqual({ n: 0 });
      expect(fetch).not.toHaveBeenCalled();
    } finally { encrypt.mockRestore(); }
  });

  it('preserves spend debits while purging cached content after transcript deletion', async () => {
    const context = await contextFor();
    await generateHostedReply(hostedEnv(), context, request, { generate: async () => response });
    await testEnv.DB.prepare('DELETE FROM messages WHERE id=?').bind(context.messageId).run();
    expect(await attempt(context.messageId)).toMatchObject({ state: 'purged', response_ciphertext: null, budget_debit_micro_usd: 30 });
  });
});

describe('hosted authorization boundaries', () => {
  it.each(['provider','business','subject'] as const)('rejects a same-user binding with the wrong %s tuple before preflight or spend', async (field) => {
    const context = await contextFor();
    const real = await testEnv.DB.prepare('SELECT provider,business_id,subject_id FROM conversations WHERE id=?').bind(context.conversationId)
      .first<{ provider: string; business_id: string; subject_id: string }>();
    await testEnv.DB.batch([
      testEnv.DB.prepare("UPDATE bindings SET status='revoked' WHERE conversation_id=?").bind(context.conversationId),
      testEnv.DB.prepare(`INSERT INTO bindings(provider,business_id,subject_id,user_id,channel,conversation_id)
        VALUES(?,?,?,?,'web',?)`).bind(field === 'provider' ? 'mock' : real!.provider,
        field === 'business' ? 'unrelated-business' : real!.business_id,
        field === 'subject' ? 'unrelated-subject' : real!.subject_id, context.userId, context.conversationId),
    ]);
    const provider = { generate: vi.fn(async () => response) };
    await expect(generateHostedReply(hostedEnv(), context, request, provider)).rejects.toMatchObject({ code: 'model_ownership_invalid', chargePossible: false });
    // Exercise the actual adapter path as well: even token preflight must never run.
    await expect(generateHostedReply(hostedEnv(), context, request)).rejects.toMatchObject({ code: 'model_ownership_invalid', chargePossible: false });
    expect(provider.generate).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    expect(await attempt(context.messageId)).toBeNull();
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM usage_ledgers').first()).toEqual({ n: 0 });
  });

  it.each(['human', 'closed', 'revoked', 'deleted'] as const)
    ('rechecks %s ownership after a stalled token preflight and never starts paid generation', async (action) => {
      const context = await contextFor();
      const env = hostedEnv();
      let releaseCount!: () => void;
      let countStarted!: () => void;
      const started = new Promise<void>((resolve) => { countStarted = resolve; });
      const countGate = new Promise<void>((resolve) => { releaseCount = resolve; });
      let paidCalls = 0;
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString();
        if (url === 'https://api.openai.com/v1/responses/input_tokens') {
          countStarted();
          await countGate;
          return Response.json({ object: 'response.input_tokens', input_tokens: 100 });
        }
        paidCalls++;
        throw new Error('A paid generation call must not start after authorization changed.');
      });
      try {
        const pending = generateHostedReply(env, context, request);
        const rejected = expect(pending).rejects.toMatchObject({ code: 'model_ownership_invalid', chargePossible: false });
        await started;
        if (action === 'human') await setConversationMode(env, context.userId, context.conversationId, 'human');
        if (action === 'closed') await env.DB.prepare("UPDATE conversations SET status='closed',ownership_version=ownership_version+1 WHERE id=?")
          .bind(context.conversationId).run();
        if (action === 'revoked') await env.DB.prepare("UPDATE bindings SET status='revoked' WHERE conversation_id=?").bind(context.conversationId).run();
        if (action === 'deleted') await env.DB.prepare('DELETE FROM users WHERE id=?').bind(context.userId).run();
        releaseCount();
        await rejected;
        expect(paidCalls).toBe(0);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(await attempt(context.messageId)).toMatchObject({ state: 'failed', budget_debit_micro_usd: 0 });
      } finally { releaseCount(); fetchMock.mockRestore(); }
    });

  it.each([
    { LIVE_MODEL_ENABLED: 'false' }, { APP_ENV: 'production' }, { MESSAGING_PROVIDER: 'apple_business' },
    { MODEL_PROVIDER: 'mock' }, { OPENAI_API_KEY: '' },
  ])('fails closed before any provider call for %j', async (overrides) => {
    const context = await contextFor();
    const provider = { generate: vi.fn(async () => response) };
    await expect(generateHostedReply(hostedEnv(overrides), context, request, provider)).rejects.toMatchObject({ code: 'hosted_model_not_enabled' });
    expect(provider.generate).not.toHaveBeenCalled();
    expect(await attempt(context.messageId)).toBeNull();
  });

  it('rejects another tenant before reading a completed cached answer', async () => {
    const context = await contextFor();
    const provider = { generate: vi.fn(async () => response) };
    await generateHostedReply(hostedEnv(), context, request, provider);
    await expect(generateHostedReply(hostedEnv(), { ...context, userId: 'u_sam' }, request, provider))
      .rejects.toMatchObject({ code: 'model_ownership_invalid' });
    expect(provider.generate).toHaveBeenCalledTimes(1);
  });

  it('rejects changed current text without billing a new call', async () => {
    const context = await contextFor();
    const provider = { generate: vi.fn(async () => response) };
    await expect(generateHostedReply(hostedEnv(), context, { ...request, text: 'Changed text' }, provider))
      .rejects.toMatchObject({ code: 'model_input_conflict' });
    expect(provider.generate).not.toHaveBeenCalled();
  });

  it('does not call the provider after ownership was handed to a human', async () => {
    const context = await contextFor();
    await setConversationMode(testEnv, context.userId, context.conversationId, 'human');
    const provider = { generate: vi.fn(async () => response) };
    await expect(generateHostedReply(hostedEnv(), context, request, provider)).rejects.toMatchObject({ code: 'model_ownership_invalid' });
    expect(provider.generate).not.toHaveBeenCalled();
  });

  it('blocks paused dispatch without reserving spend', async () => {
    const context = await contextFor();
    await testEnv.DB.prepare("INSERT INTO system_settings(key,value) VALUES ('outbound_paused','true')").run();
    const provider = { generate: vi.fn(async () => response) };
    await expect(generateHostedReply(hostedEnv(), context, request, provider)).rejects.toMatchObject({ code: 'model_ownership_invalid' });
    expect(provider.generate).not.toHaveBeenCalled();
    expect(await attempt(context.messageId)).toBeNull();
  });

  it('releases an already-aborted attempt without generating or allowing a later retry', async () => {
    const context = await contextFor();
    const provider = { generate: vi.fn(async () => response) };
    const controller = new AbortController();
    controller.abort();
    await expect(generateHostedReply(hostedEnv(), context, { ...request, signal: controller.signal }, provider))
      .rejects.toMatchObject({ code: 'model_cancelled_before_dispatch', chargePossible: false });
    expect(provider.generate).not.toHaveBeenCalled();
    expect(await attempt(context.messageId)).toMatchObject({ state: 'failed', budget_debit_micro_usd: 0 });
  });
});
