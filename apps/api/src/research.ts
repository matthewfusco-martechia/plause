import { BOUND_CHANNEL_ELIGIBILITY_SQL } from '../../../packages/contracts/src/delivery-policy';
import { assertOperational, providerCircuitOpen } from './runtime-operations';
import { assertRuntimeProviders } from '../../../packages/contracts/src/runtime-policy';
import { ModelCallError, type Env, type ModelResponse } from '../../../packages/contracts/src/index';
import { formatResearchResults, parseResearchCommand, TavilySearchProvider } from '../../../packages/research/src/index';
import { decryptText, encryptText, sha256 } from '../../../packages/security/src/index';

export interface ResearchContext {
  userId: string; conversationId: string; messageId: string; leaseToken: string; ownershipVersion: number; contextRevision: number;
  signal?: AbortSignal;
}
interface SearchAttempt {
  user_id: string; conversation_id: string; context_revision: number; query_digest: string; result_ciphertext: string | null;
  state: 'dispatched' | 'completed' | 'failed' | 'unknown' | 'purged'; error_code: string | null; attempt_token: string;
}
const dbNow = "CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)";
const predicate = `c.id=? AND c.user_id=? AND m.id=? AND m.conversation_id=c.id AND m.role='user' AND m.is_memory_control=0
  AND m.status NOT IN ('cancelled','failed') AND c.lease_token=? AND c.ownership_version=? AND c.mode='bot' AND c.provider_control='bot' AND c.status='active'
  AND u.status='active' AND b.status='active' AND b.channel=c.channel AND u.context_revision=? AND m.context_revision=?
  AND b.provider=c.provider AND b.business_id=c.business_id AND b.subject_id=c.subject_id AND ${BOUND_CHANNEL_ELIGIBILITY_SQL}
  AND c.lease_until>${dbNow} AND NOT EXISTS (SELECT 1 FROM system_settings WHERE (key='outbound_paused' AND value!='false' OR key='restore_locked' AND value!='false'))`;

function scope(context: ResearchContext): (string | number)[] {
  return [context.conversationId, context.userId, context.messageId, context.leaseToken, context.ownershipVersion, context.contextRevision, context.contextRevision];
}

function limit(value: string | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > maximum) throw new ModelCallError('research_config_invalid');
  return Number(value);
}

function policy(env: Env) {
  const provider = env.SEARCH_PROVIDER ?? 'disabled';
  if (provider !== 'disabled' && provider !== 'tavily') throw new ModelCallError('research_config_invalid');
  return { provider, userLimit: limit(env.SEARCH_USER_DAILY_LIMIT, 20, 100), globalLimit: limit(env.SEARCH_GLOBAL_DAILY_LIMIT, 500, 5000) };
}

export function researchDailyLimit(env: Env): number { return policy(env).userLimit; }

export function researchReadiness(env: Env): { ready: boolean; status: 'disabled' | 'not_configured' | 'ready' | 'invalid_config'; provider: string } {
  try {
    const settings = policy(env);
    assertRuntimeProviders(env);
    if (settings.provider === 'disabled' || env.LIVE_SEARCH_ENABLED !== 'true') return { ready: false, status: 'disabled', provider: settings.provider };
    if (!env.TAVILY_API_KEY) return { ready: false, status: 'not_configured', provider: settings.provider };
    if (/\s/.test(env.TAVILY_API_KEY)) return { ready: false, status: 'invalid_config', provider: settings.provider };
    return { ready: true, status: 'ready', provider: settings.provider };
  } catch { return { ready: false, status: 'invalid_config', provider: 'disabled' }; }
}

async function assertOwnership(env: Env, context: ResearchContext): Promise<void> {
  const row = await env.DB.prepare(`SELECT 1 AS ok FROM conversations c JOIN users u ON u.id=c.user_id
    JOIN bindings b ON b.conversation_id=c.id AND b.user_id=c.user_id JOIN messages m ON m.conversation_id=c.id WHERE ${predicate}`)
    .bind(...scope(context)).first();
  if (!row) throw new ModelCallError('research_ownership_invalid');
}

async function verifyQuerySource(env: Env, context: ResearchContext, query: string): Promise<void> {
  const row = await env.DB.prepare(`SELECT m.body_ciphertext,m.content_hash FROM conversations c JOIN users u ON u.id=c.user_id
    JOIN bindings b ON b.conversation_id=c.id AND b.user_id=c.user_id JOIN messages m ON m.conversation_id=c.id WHERE ${predicate}`)
    .bind(...scope(context)).first<{ body_ciphertext: string; content_hash: string | null }>();
  if (!row) throw new ModelCallError('research_ownership_invalid');
  const text = await decryptText(row.body_ciphertext, env.CONTENT_ENCRYPTION_KEY);
  const command = parseResearchCommand(text);
  if (command?.type !== 'search' || command.query !== query || row.content_hash !== await sha256(text)) throw new ModelCallError('research_query_conflict');
  await assertOwnership(env, context);
}

function reply(text: string): ModelResponse { return { text, inputTokens: 0, outputTokens: 0, model: 'plause-research' }; }

function validCached(value: unknown): value is ModelResponse {
  if (!value || typeof value !== 'object') return false;
  const response = value as ModelResponse;
  return response.model === 'plause-research' && response.inputTokens === 0 && response.outputTokens === 0
    && typeof response.text === 'string' && response.text.length > 0 && response.text.length <= 4000;
}

async function existingResult(env: Env, context: ResearchContext, digest: string, attempt: SearchAttempt): Promise<ModelResponse> {
  if (attempt.user_id !== context.userId || attempt.conversation_id !== context.conversationId || attempt.context_revision !== context.contextRevision) {
    throw new ModelCallError('research_ownership_invalid');
  }
  if (attempt.state === 'purged') throw new ModelCallError('research_cache_purged', true);
  if (attempt.query_digest !== digest) throw new ModelCallError('research_query_conflict');
  if (attempt.state === 'completed' && attempt.result_ciphertext) {
    let response: unknown;
    try { response = JSON.parse(await decryptText(attempt.result_ciphertext, env.CONTENT_ENCRYPTION_KEY)); }
    catch { throw new ModelCallError('research_cache_invalid', true); }
    if (!validCached(response)) throw new ModelCallError('research_cache_invalid', true);
    await assertOwnership(env, context);
    return response;
  }
  if (attempt.state === 'failed') throw new ModelCallError(attempt.error_code ?? 'research_failed');
  await env.DB.prepare("UPDATE search_attempts SET state='unknown',error_code='research_outcome_unknown',updated_at=? WHERE message_id=? AND state='dispatched'")
    .bind(Date.now(), context.messageId).run();
  throw new ModelCallError('research_outcome_unknown', true);
}

/** Exactly one bounded provider attempt per accepted search input; no automatic paid retry. */
export async function runResearch(env: Env, context: ResearchContext, query: string): Promise<ModelResponse> {
  try { assertRuntimeProviders(env); } catch { throw new ModelCallError('research_not_enabled'); }
  if (!Number.isSafeInteger(context.contextRevision) || context.contextRevision < 0 || !query || query.length > 300) throw new ModelCallError('research_query_invalid');
  await verifyQuerySource(env, context, query);
  const readiness = researchReadiness(env);
  if (!readiness.ready) return reply('Web research is not connected or enabled in this local preview. No external search was performed. Use research help for the supported public-query format.');
  const settings = policy(env);
  const digest = await sha256(query);
  const previous = await env.DB.prepare('SELECT * FROM search_attempts WHERE message_id=?').bind(context.messageId).first<SearchAttempt>();
  if (previous) return existingResult(env, context, digest, previous);
  await assertOperational(env, { outbound: true });
  if (await providerCircuitOpen(env, 'search')) throw new ModelCallError('research_circuit_open');
  const now = Date.now();
  const day = new Date(now).toISOString().slice(0, 10);
  const token = crypto.randomUUID();
  const reserved = await env.DB.prepare(`INSERT INTO search_attempts
    (message_id,user_id,conversation_id,context_revision,day,state,query_digest,attempt_token,created_at,updated_at)
    SELECT ?,?,?,?,?,'dispatched',?,?,?,? WHERE EXISTS
    (SELECT 1 FROM conversations c JOIN users u ON u.id=c.user_id JOIN bindings b ON b.conversation_id=c.id AND b.user_id=c.user_id
    JOIN messages m ON m.conversation_id=c.id WHERE ${predicate})
    AND (SELECT COUNT(*) FROM search_attempts WHERE user_id=? AND day=?)<?
    AND (SELECT COUNT(*) FROM search_attempts WHERE day=?)<? ON CONFLICT(message_id) DO NOTHING`)
    .bind(context.messageId, context.userId, context.conversationId, context.contextRevision, day, digest, token, now, now,
      ...scope(context), context.userId, day, settings.userLimit, day, settings.globalLimit).run();
  if (reserved.meta.changes !== 1) {
    await assertOwnership(env, context);
    const winner = await env.DB.prepare('SELECT * FROM search_attempts WHERE message_id=?').bind(context.messageId).first<SearchAttempt>();
    if (winner) return existingResult(env, context, digest, winner);
    throw new ModelCallError('research_daily_limit');
  }
  try {
    const provider = new TavilySearchProvider({ apiKey: env.TAVILY_API_KEY! });
    await assertOwnership(env, context);
    if (context.signal?.aborted) throw new ModelCallError('research_cancelled_before_dispatch');
    const results = await provider.search(query, context.signal);
    const response = reply(formatResearchResults(results));
    const ciphertext = await encryptText(JSON.stringify(response), env.CONTENT_ENCRYPTION_KEY);
    const currentSource = `EXISTS (SELECT 1 FROM messages m JOIN conversations c ON c.id=m.conversation_id JOIN users u ON u.id=c.user_id
      WHERE m.id=search_attempts.message_id AND c.user_id=search_attempts.user_id AND u.status='active' AND u.context_revision=search_attempts.context_revision
      AND NOT EXISTS (SELECT 1 FROM system_settings WHERE key='restore_locked' AND value!='false'))`;
    await env.DB.prepare(`UPDATE search_attempts SET state=CASE WHEN ${currentSource} THEN 'completed' ELSE 'purged' END,
      result_ciphertext=CASE WHEN ${currentSource} THEN ? ELSE NULL END,
      error_code=CASE WHEN ${currentSource} THEN NULL ELSE 'research_context_revoked' END,updated_at=?
      WHERE message_id=? AND attempt_token=? AND state IN ('dispatched','unknown')`)
      .bind(ciphertext, Date.now(), context.messageId, token).run();
    return response;
  } catch (cause) {
    const error = cause instanceof ModelCallError ? cause : new ModelCallError('research_outcome_unknown', true);
    const code = /^[a-z0-9_]{1,80}$/.test(error.code) ? error.code : 'research_failed';
    try {
      await env.DB.prepare(`UPDATE search_attempts SET state=?,error_code=?,updated_at=? WHERE message_id=? AND attempt_token=? AND state IN ('dispatched','unknown')`)
        .bind(error.chargePossible ? 'unknown' : 'failed', code, Date.now(), context.messageId, token).run();
    } catch { throw new ModelCallError('research_outcome_unknown', true); }
    throw error;
  }
}
