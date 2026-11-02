import { BOUND_CHANNEL_ELIGIBILITY_SQL } from '../../../packages/contracts/src/delivery-policy';
import { assertOperational, providerCircuitOpen } from './runtime-operations';
import { assertRuntimeProviders } from '../../../packages/contracts/src/runtime-policy';
import { ModelCallError, type Env, type ModelProvider, type ModelRequest, type ModelResponse } from '../../../packages/contracts/src/index';
import { OpenAIModelProvider } from '../../../packages/models-openai/src/index';
import { decryptText, encryptText, sha256 } from '../../../packages/security/src/index';
import { MODEL_PROPOSAL_CONTRACT, parseModelProposal, planningContextSchema } from '../../../packages/agent-core/src/model-proposals';

export interface HostedPolicy {
  model: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  timeoutMs: number;
  leaseMs: number;
  userMonthlyBudgetMicroUsd: number;
  globalMonthlyBudgetMicroUsd: number;
  inputRateMicroUsdPerMillion: number;
  outputRateMicroUsdPerMillion: number;
}

export interface HostedGenerationContext {
  userId: string;
  conversationId: string;
  messageId: string;
  leaseToken: string;
  ownershipVersion: number;
  contextRevision?: number;
}

interface Attempt {
  message_id: string;
  user_id: string;
  conversation_id: string;
  attempt_token: string;
  lease_token: string;
  ownership_version: number;
  input_digest: string;
  state: 'reserved' | 'dispatched' | 'completed' | 'failed' | 'unknown' | 'purged';
  error_code: string | null;
  response_ciphertext: string | null;
  reservation_micro_usd: number;
  budget_debit_micro_usd: number;
  context_revision: number;
}

const dbNow = "CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)";
const ownershipPredicate = `c.id=? AND c.user_id=? AND m.id=? AND m.conversation_id=c.id AND m.role='user'
  AND m.status NOT IN ('cancelled','failed') AND m.is_memory_control=0 AND c.lease_token=? AND c.ownership_version=?
  AND u.context_revision=? AND m.context_revision=?
  AND b.provider=c.provider AND b.business_id=c.business_id AND b.subject_id=c.subject_id
  AND ${BOUND_CHANNEL_ELIGIBILITY_SQL} AND c.mode='bot' AND c.provider_control='bot' AND c.status='active' AND u.status='active' AND b.status='active' AND b.channel=c.channel
  AND c.lease_until>${dbNow} AND NOT EXISTS (SELECT 1 FROM system_settings WHERE (key='outbound_paused' AND value!='false' OR key='restore_locked' AND value!='false'))`;

function integerSetting(value: string | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!/^[1-9][0-9]*$/.test(value)) throw new ModelCallError('invalid_hosted_policy');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) throw new ModelCallError('invalid_hosted_policy');
  return parsed;
}

/** Prices are conservative upper estimates for the sole reviewed model, not invoices. */
export function hostedPolicy(env: Env): HostedPolicy {
  const model = env.OPENAI_MODEL ?? 'gpt-6-luna';
  if (model !== 'gpt-6-luna') throw new ModelCallError('unpriced_model');
  const maxInputTokens = integerSetting(env.MODEL_MAX_INPUT_TOKENS, 4096, 20_000);
  const maxOutputTokens = integerSetting(env.MODEL_MAX_OUTPUT_TOKENS, 600, 2000);
  const timeoutMs = integerSetting(env.MODEL_TIMEOUT_MS, 20_000, 45_000);
  const userMonthlyBudgetMicroUsd = integerSetting(env.MODEL_USER_MONTHLY_BUDGET_MICRO_USD, 5_000_000, 100_000_000);
  const globalMonthlyBudgetMicroUsd = integerSetting(env.MODEL_GLOBAL_MONTHLY_BUDGET_MICRO_USD, 50_000_000, 1_000_000_000);
  if (userMonthlyBudgetMicroUsd > globalMonthlyBudgetMicroUsd) throw new ModelCallError('invalid_hosted_policy');
  return { model, maxInputTokens, maxOutputTokens, timeoutMs, leaseMs: 60_000, userMonthlyBudgetMicroUsd,
    globalMonthlyBudgetMicroUsd, inputRateMicroUsdPerMillion: 250_000, outputRateMicroUsdPerMillion: 500_000 };
}

function assertHostedEnvironment(env: Env): void {
  try { assertRuntimeProviders(env); } catch { throw new ModelCallError('hosted_model_not_enabled'); }
  if (env.MODEL_PROVIDER !== 'openai'
    || env.LIVE_MODEL_ENABLED !== 'true' || !env.OPENAI_API_KEY?.trim()) {
    throw new ModelCallError('hosted_model_not_enabled');
  }
}

function scopeBindings(context: HostedGenerationContext): (string | number)[] {
  return [context.conversationId, context.userId, context.messageId, context.leaseToken, context.ownershipVersion,
    context.contextRevision ?? 0, context.contextRevision ?? 0];
}

async function assertOwnership(env: Env, context: HostedGenerationContext, text: string, minimumLeaseMs = 0): Promise<void> {
  const contentHash = await sha256(text);
  const row = await env.DB.prepare(`SELECT m.content_hash,c.lease_until,c.provider,c.business_id FROM conversations c JOIN users u ON u.id=c.user_id
    JOIN bindings b ON b.conversation_id=c.id AND b.user_id=c.user_id JOIN messages m ON m.conversation_id=c.id
    WHERE ${ownershipPredicate} AND c.lease_until>${dbNow}+?`)
    .bind(...scopeBindings(context), minimumLeaseMs).first<{ content_hash: string | null; lease_until: number; provider: string; business_id: string }>();
  if (!row) throw new ModelCallError('model_ownership_invalid');
  if (row.provider === 'sunshine' && (env.MESSAGING_PROVIDER !== 'sunshine' || row.business_id !== env.SUNSHINE_APP_ID)) throw new ModelCallError('model_ownership_invalid');
  if (!row.content_hash || row.content_hash !== contentHash) throw new ModelCallError('model_input_conflict');
}

function costUpperEstimate(policy: HostedPolicy, inputTokens: number, outputTokens: number): number {
  return Math.ceil(inputTokens * policy.inputRateMicroUsdPerMillion / 1_000_000)
    + Math.ceil(outputTokens * policy.outputRateMicroUsdPerMillion / 1_000_000);
}

async function findAttempt(env: Env, messageId: string): Promise<Attempt | null> {
  return env.DB.prepare('SELECT * FROM model_attempts WHERE message_id=?').bind(messageId).first<Attempt>();
}

function validResponse(response: ModelResponse, policy: HostedPolicy): boolean {
  return typeof response.text === 'string' && (response.text.trim().length > 0 || response.proposal !== undefined) && response.text.length <= 4000
    && (response.proposal === undefined || parseModelProposal(response.proposal) !== null)
    && Number.isSafeInteger(response.inputTokens) && response.inputTokens >= 0 && response.inputTokens <= policy.maxInputTokens
    && Number.isSafeInteger(response.outputTokens) && response.outputTokens >= 0 && response.outputTokens <= policy.maxOutputTokens
    && (response.model === undefined || (typeof response.model === 'string' && response.model.length > 0 && response.model.length <= 200))
    && (response.responseId === undefined || (typeof response.responseId === 'string' && response.responseId.length > 0 && response.responseId.length <= 200));
}

async function existingResult(env: Env, context: HostedGenerationContext, digest: string, attempt: Attempt, policy: HostedPolicy, sourceText: string): Promise<ModelResponse> {
  if (attempt.user_id !== context.userId || attempt.conversation_id !== context.conversationId || attempt.input_digest !== digest) {
    throw new ModelCallError('model_input_conflict');
  }
  if (attempt.context_revision !== (context.contextRevision ?? 0)) throw new ModelCallError('model_context_revoked', true);
  if (attempt.state === 'completed' && attempt.response_ciphertext) {
    let cached: ModelResponse;
    try {
      const response: unknown = JSON.parse(await decryptText(attempt.response_ciphertext, env.CONTENT_ENCRYPTION_KEY));
      // Lowering a future-call cap must not invalidate output already generated
      // and paid for under an earlier valid policy.
      if (!response || typeof response !== 'object'
        || !validResponse(response as ModelResponse, { ...policy, maxInputTokens: 20_000, maxOutputTokens: 2000 })) throw new Error('invalid_cache');
      cached = response as ModelResponse;
    } catch { throw new ModelCallError('cached_model_response_invalid', true); }
    await assertOwnership(env, context, sourceText);
    return cached;
  }
  if (attempt.state === 'reserved' && attempt.lease_token !== context.leaseToken) {
    // Its owner lost the lease before any billable dispatch. Keep a tombstone so
    // automatic recovery cannot turn a failed input into another generation.
    await env.DB.prepare(`UPDATE model_attempts SET state='failed',budget_debit_micro_usd=0,error_code='model_reservation_abandoned',updated_at=?
      WHERE message_id=? AND attempt_token=? AND state='reserved'`).bind(Date.now(), context.messageId, attempt.attempt_token).run();
    throw new ModelCallError('model_reservation_abandoned');
  }
  if (attempt.state === 'dispatched' && attempt.lease_token !== context.leaseToken) {
    await env.DB.prepare(`UPDATE model_attempts SET state='unknown',error_code='model_outcome_unknown',updated_at=?
      WHERE message_id=? AND attempt_token=? AND state='dispatched'`).bind(Date.now(), context.messageId, attempt.attempt_token).run();
  }
  if (attempt.state === 'failed') throw new ModelCallError(attempt.error_code ?? 'model_attempt_failed');
  if (attempt.state === 'purged') throw new ModelCallError('model_cache_purged', true);
  if (attempt.state === 'reserved') throw new ModelCallError('model_attempt_in_progress');
  throw new ModelCallError('model_outcome_unknown', true);
}

async function failAttempt(env: Env, context: HostedGenerationContext, attemptToken: string, error: ModelCallError): Promise<void> {
  const code = /^[a-z0-9_]{1,80}$/.test(error.code) ? error.code : 'model_failed';
  await env.DB.prepare(`UPDATE model_attempts SET state=?,error_code=?,
    budget_debit_micro_usd=CASE WHEN ?=1 THEN reservation_micro_usd ELSE 0 END,updated_at=?
    WHERE message_id=? AND attempt_token=? AND state IN ('reserved','dispatched','unknown')`)
    .bind(error.chargePossible ? 'unknown' : 'failed', code, error.chargePossible ? 1 : 0, Date.now(), context.messageId, attemptToken).run();
}

/** At most one generation attempt per accepted input. Queued recovery reuses encrypted results. */
export async function generateHostedReply(env: Env, context: HostedGenerationContext, request: ModelRequest,
  provider?: ModelProvider): Promise<ModelResponse> {
  assertHostedEnvironment(env);
  const policy = hostedPolicy(env);
  if (typeof request.text !== 'string' || !request.text.trim() || request.text.length > 4000 || !Array.isArray(request.history)
    || request.history.length > 24 || request.history.some((item) => !item || (item.role !== 'user' && item.role !== 'assistant')
      || typeof item.text !== 'string' || item.text.length > 4000)) throw new ModelCallError('invalid_model_request');
  const contextRevision = context.contextRevision ?? 0;
  const memories = request.memories ?? [];
  if (!Number.isSafeInteger(contextRevision) || contextRevision < 0
    || (request.contextRevision !== undefined && request.contextRevision !== contextRevision)
    || !Array.isArray(memories) || memories.length > 10 || memories.some((fact) => !fact || typeof fact.id !== 'string'
      || fact.id.length < 1 || fact.id.length > 50 || typeof fact.text !== 'string' || !fact.text.trim() || fact.text.length > 300)) {
    throw new ModelCallError('invalid_model_memory');
  }
  if (request.planningContext !== undefined && !planningContextSchema.safeParse(request.planningContext).success) {
    throw new ModelCallError('invalid_model_planning_context');
  }
  await assertOwnership(env, context, request.text);
  const digest = await sha256(JSON.stringify({ text: request.text, history: request.history.map(({ role, text }) => ({ role, text })),
    memories: memories.map(({ id, text }) => ({ id, text })), contextRevision, proposalContract: MODEL_PROPOSAL_CONTRACT,
    planningContext: request.planningContext ? { now: request.planningContext.now, timeZone: request.planningContext.timeZone,
      realGoogleCalendarConnected: request.planningContext.realGoogleCalendarConnected ?? false } : null }));
  const existing = await findAttempt(env, context.messageId);
  if (existing) return existingResult(env, context, digest, existing, policy, request.text);
  await assertOperational(env, { outbound: true });
  if (await providerCircuitOpen(env, 'model')) throw new ModelCallError('model_circuit_open');
  await assertOwnership(env, context, request.text, policy.timeoutMs + 1000);
  const attemptToken = crypto.randomUUID();
  const now = Date.now();
  const month = new Date(now).toISOString().slice(0, 7);
  const reservation = costUpperEstimate(policy, policy.maxInputTokens, policy.maxOutputTokens);
  const reserved = await env.DB.prepare(`INSERT INTO model_attempts
    (message_id,user_id,conversation_id,attempt_token,lease_token,ownership_version,input_digest,model,budget_month,
    reservation_micro_usd,budget_debit_micro_usd,state,created_at,updated_at,context_revision)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,'reserved',?,?,? WHERE EXISTS
    (SELECT 1 FROM conversations c JOIN users u ON u.id=c.user_id JOIN bindings b ON b.conversation_id=c.id AND b.user_id=c.user_id
    JOIN messages m ON m.conversation_id=c.id WHERE ${ownershipPredicate} AND c.lease_until>${dbNow}+?)
    AND COALESCE((SELECT SUM(budget_debit_micro_usd) FROM model_attempts WHERE budget_month=? AND user_id=?),0)+?<=?
    AND COALESCE((SELECT SUM(budget_debit_micro_usd) FROM model_attempts WHERE budget_month=?),0)+?<=?
    ON CONFLICT(message_id) DO NOTHING`)
    .bind(context.messageId, context.userId, context.conversationId, attemptToken, context.leaseToken, context.ownershipVersion,
      digest, policy.model, month, reservation, reservation, now, now, contextRevision, ...scopeBindings(context), policy.timeoutMs + 1000,
      month, context.userId, reservation, policy.userMonthlyBudgetMicroUsd, month, reservation, policy.globalMonthlyBudgetMicroUsd).run();
  if (reserved.meta.changes !== 1) {
    await assertOwnership(env, context, request.text);
    const winner = await findAttempt(env, context.messageId);
    if (winner) return existingResult(env, context, digest, winner, policy, request.text);
    throw new ModelCallError('model_budget_exhausted');
  }
  try {
    if (request.signal?.aborted) throw new ModelCallError('model_cancelled_before_dispatch');
    const dispatch = await env.DB.prepare(`UPDATE model_attempts SET state='dispatched',dispatched_at=?,updated_at=?
      WHERE message_id=? AND attempt_token=? AND state='reserved' AND EXISTS
      (SELECT 1 FROM conversations c JOIN users u ON u.id=c.user_id JOIN bindings b ON b.conversation_id=c.id AND b.user_id=c.user_id
      JOIN messages m ON m.conversation_id=c.id WHERE ${ownershipPredicate} AND c.lease_until>${dbNow}+?)`)
      .bind(Date.now(), Date.now(), context.messageId, attemptToken, ...scopeBindings(context), policy.timeoutMs + 1000).run();
    if (dispatch.meta.changes !== 1) throw new ModelCallError('model_ownership_invalid');
    if (request.signal?.aborted) throw new ModelCallError('model_cancelled_before_dispatch');
    const model = provider ?? new OpenAIModelProvider({ apiKey: env.OPENAI_API_KEY!.trim(), model: policy.model,
      maxInputTokens: policy.maxInputTokens, maxOutputTokens: policy.maxOutputTokens, timeoutMs: policy.timeoutMs,
      beforeGenerate: () => assertOwnership(env, context, request.text) });
    const response = await model.generate(request);
    if (!validResponse(response, policy)) throw new ModelCallError('model_response_invalid', true);
    const normalized: ModelResponse = { text: response.text.trim(), inputTokens: response.inputTokens, outputTokens: response.outputTokens,
      model: response.model ?? policy.model, ...(response.responseId ? { responseId: response.responseId } : {}),
      ...(response.proposal ? { proposal: parseModelProposal(response.proposal)! } : {}) };
    const ciphertext = await encryptText(JSON.stringify(normalized), env.CONTENT_ENCRYPTION_KEY);
    const cost = costUpperEstimate(policy, response.inputTokens, response.outputTokens);
    const completedAt = Date.now();
    // Cost/cache persistence deliberately does not require the original lease:
    // provider work can finish after handoff, closure or cancellation.
    await env.DB.batch([
      env.DB.prepare(`UPDATE model_attempts SET state=CASE WHEN EXISTS (SELECT 1 FROM messages m JOIN conversations c ON c.id=m.conversation_id
        JOIN users u ON u.id=c.user_id WHERE m.id=model_attempts.message_id AND c.user_id=model_attempts.user_id AND u.status='active'
        AND u.context_revision=model_attempts.context_revision AND NOT EXISTS (SELECT 1 FROM system_settings WHERE key='restore_locked' AND value!='false'))
        THEN 'completed' ELSE 'purged' END,response_ciphertext=CASE WHEN EXISTS
        (SELECT 1 FROM messages m JOIN conversations c ON c.id=m.conversation_id JOIN users u ON u.id=c.user_id
        WHERE m.id=model_attempts.message_id AND c.user_id=model_attempts.user_id AND u.status='active'
        AND u.context_revision=model_attempts.context_revision AND NOT EXISTS (SELECT 1 FROM system_settings WHERE key='restore_locked' AND value!='false')) THEN ? ELSE NULL END,
        input_tokens=?,output_tokens=?,provider_response_id=?,budget_debit_micro_usd=?,error_code=NULL,updated_at=?,completed_at=?
        WHERE message_id=? AND attempt_token=? AND state IN ('dispatched','unknown')`)
        .bind(ciphertext, normalized.inputTokens, normalized.outputTokens, normalized.responseId ?? null, cost,
          completedAt, completedAt, context.messageId, attemptToken),
      env.DB.prepare(`INSERT INTO usage_ledgers (id,user_id,conversation_id,input_tokens,output_tokens,estimated_cost_micro_usd,created_at,model,provider_response_id)
        SELECT ?,a.user_id,a.conversation_id,a.input_tokens,a.output_tokens,a.budget_debit_micro_usd,?,a.model,a.provider_response_id
        FROM model_attempts a JOIN users u ON u.id=a.user_id JOIN conversations c ON c.id=a.conversation_id
        WHERE a.message_id=? AND a.attempt_token=? AND a.state IN ('completed','purged') AND a.input_tokens IS NOT NULL AND a.output_tokens IS NOT NULL
        ON CONFLICT(id) DO NOTHING`)
        .bind(`hosted:${context.messageId}`, completedAt, context.messageId, attemptToken),
    ]);
    return normalized;
  } catch (cause) {
    const error = cause instanceof ModelCallError ? cause : new ModelCallError('model_outcome_unknown', true);
    try { await failAttempt(env, context, attemptToken, error); }
    catch { throw new ModelCallError('model_outcome_unknown', true); }
    throw error;
  }
}
