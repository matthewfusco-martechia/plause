import { assertOperational } from './runtime-operations';
import type { Env } from '../../../packages/contracts/src/index';
import { encryptText, decryptText } from '../../../packages/security/src/index';
import { MAX_MEMORIES, MAX_MEMORY_CHARACTERS, MEMORY_HELP, type MemoryCommand } from '../../../packages/agent-core/src/memory-commands';
import { PipelineError } from './store';

interface MemoryUser { memory_enabled: number; context_revision: number; memory_history_after_sequence: number }
export interface MemoryPlan {
  userId: string;
  expectedRevision: number;
  replyText: string;
  mutation: boolean;
  resetHistory: boolean;
  command: MemoryCommand;
  memoryId?: string;
  ciphertext?: string;
}

async function memoryUser(env: Env, userId: string): Promise<MemoryUser> {
  const user = await env.DB.prepare(`SELECT memory_enabled,context_revision,memory_history_after_sequence FROM users WHERE id=? AND status='active'`)
    .bind(userId).first<MemoryUser>();
  if (!user) throw new PipelineError('Account unavailable.', 403, 'account_unavailable');
  return user;
}

/** A single SELECT gives settings and facts from the same database snapshot. */
export async function listMemoriesForUser(env: Env, userId: string) {
  const result = await env.DB.prepare(`SELECT u.memory_enabled,u.context_revision,m.id,m.body_ciphertext,m.created_at,m.updated_at
    FROM users u LEFT JOIN memories m ON m.user_id=u.id WHERE u.id=? AND u.status='active'
    ORDER BY m.created_at,m.id LIMIT ?`).bind(userId, MAX_MEMORIES + 1)
    .all<MemoryUser & { id: string | null; body_ciphertext: string | null; created_at: number | null; updated_at: number | null }>();
  const first = result.results[0];
  if (!first) throw new PipelineError('Account unavailable.', 403, 'account_unavailable');
  const memories = await Promise.all(result.results.filter((row) => row.id !== null).map(async (row) => ({
    id: row.id!, text: await decryptText(row.body_ciphertext!, env.CONTENT_ENCRYPTION_KEY),
    createdAt: row.created_at!, updatedAt: row.updated_at!,
  })));
  if (memories.length > MAX_MEMORIES || memories.some((fact) => fact.text.length > MAX_MEMORY_CHARACTERS)) {
    throw new PipelineError('Saved memory is unavailable.', 503, 'memory_invalid');
  }
  // Decryption can yield to a concurrent privacy change. Never return the old snapshot afterward.
  await assertOperational(env);
  const current = await memoryUser(env, userId);
  if (current.context_revision !== first.context_revision) throw new PipelineError('Memory changed. Please retry.', 409, 'memory_conflict');
  return { enabled: first.memory_enabled === 1, revision: first.context_revision, memories };
}

export async function loadMemoryContext(env: Env, userId: string) {
  const listed = await listMemoriesForUser(env, userId);
  await assertOperational(env);
  const current = await memoryUser(env, userId);
  if (current.context_revision !== listed.revision) throw new PipelineError('Memory changed. Please retry.', 409, 'memory_conflict');
  return { revision: listed.revision, historyAfterSequence: current.memory_history_after_sequence,
    enabled: listed.enabled, memories: listed.enabled ? listed.memories.map(({ id, text }) => ({ id, text })) : [] };
}

/** Privacy controls and correction must remain usable even if a stored fact cannot decrypt. */
async function memoryCommandState(env: Env, userId: string, command: MemoryCommand) {
  if (command.type === 'save' || command.type === 'list') return listMemoriesForUser(env, userId);
  const targetId = command.type === 'forget' || command.type === 'update' ? command.id : '';
  const rows = await env.DB.prepare(`SELECT u.memory_enabled,u.context_revision,m.id
    FROM users u LEFT JOIN memories m ON m.user_id=u.id AND m.id=? WHERE u.id=? AND u.status='active'`)
    .bind(targetId, userId).all<MemoryUser & { id: string | null }>();
  const first = rows.results[0];
  if (!first) throw new PipelineError('Account unavailable.', 403, 'account_unavailable');
  return { enabled: first.memory_enabled === 1, revision: first.context_revision,
    memories: rows.results.filter((row) => row.id !== null).map((row) => ({ id: row.id!, text: '' })) };
}

export async function prepareMemoryCommand(env: Env, userId: string, command: MemoryCommand): Promise<MemoryPlan> {
  const state = await memoryCommandState(env, userId, command);
  const plan: MemoryPlan = { userId, expectedRevision: state.revision, replyText: MEMORY_HELP,
    mutation: false, resetHistory: false, command };
  const privacyNotice = ' Future AI context has been reset and older pending replies cancelled. Earlier messages remain in the transcript; this does not erase messages already delivered.';
  if (command.type === 'invalid') plan.replyText = command.reason;
  else if (command.type === 'list') {
    plan.replyText = `${state.enabled ? 'Saved memory is on.' : 'Saved memory is off; facts are retained but not used.'}\n${state.memories.length
      ? state.memories.map((fact) => `${fact.id}: ${fact.text}`).join('\n') : 'No saved facts.'}\nUse memory help for controls.`;
  } else if (command.type === 'save' || command.type === 'update') {
    if (!state.enabled) plan.replyText = 'Saved memory is off. Say enable memory before saving or updating facts. You can still list or forget them.';
    else if (command.type === 'update' && !state.memories.some((fact) => fact.id === command.id)) plan.replyText = 'That saved memory is unavailable. Say memories to see your facts.';
    else if (command.type === 'save' && state.memories.some((fact) => fact.text === command.content)) plan.replyText = `That fact is already saved as ${state.memories.find((fact) => fact.text === command.content)!.id}.`;
    else if (command.type === 'save' && state.memories.length >= MAX_MEMORIES) plan.replyText = `You have reached the ${MAX_MEMORIES}-fact limit. Forget a fact before saving another.`;
    else {
      plan.mutation = true;
      plan.resetHistory = command.type === 'update';
      plan.memoryId = command.type === 'update' ? command.id : `mem_${crypto.randomUUID()}`;
      plan.ciphertext = await encryptText(command.content, env.CONTENT_ENCRYPTION_KEY);
      plan.replyText = command.type === 'save' ? `Saved as ${plan.memoryId}. You can view it with memories, correct it with update memory ${plan.memoryId}: <fact>, or remove it with forget memory ${plan.memoryId}.`
        : `Updated ${plan.memoryId}.${privacyNotice}`;
    }
  } else if (command.type === 'forget') {
    if (!state.memories.some((fact) => fact.id === command.id)) plan.replyText = 'That saved memory is unavailable. Say memories to see your facts.';
    else { plan.mutation = true; plan.resetHistory = true; plan.memoryId = command.id; plan.replyText = `Forgot ${command.id}.${privacyNotice}`; }
  } else if (command.type === 'forget_all') {
    plan.mutation = true; plan.resetHistory = true; plan.replyText = `All saved facts have been removed.${privacyNotice}`;
  } else if (command.type === 'disable' || command.type === 'enable') {
    const enable = command.type === 'enable';
    if (state.enabled === enable) plan.replyText = `Saved memory is already ${enable ? 'on' : 'off'}.`;
    else {
      plan.mutation = true; plan.resetHistory = true;
      plan.replyText = enable ? `Saved memory is on. Retained facts can be used again; erased facts are not restored.${privacyNotice}`
        : `Saved memory is off. Retained facts will not be read by the model or changed by remember/update commands. You can still view, export, or forget them.${privacyNotice}`;
    }
  }
  return plan;
}

interface MemoryCommitContext {
  messageId: string;
  conversationId: string;
  replyId: string;
  eventGate: string;
  eventGateBindings: (string | number)[];
  now: number;
}

/** The newly inserted input is the mutation token. Replayed logical messages cannot run again. */
export async function memoryStatements(env: Env, plan: MemoryPlan, context: MemoryCommitContext): Promise<D1PreparedStatement[]> {
  const { messageId, conversationId, replyId, now } = context;
  const gate = `EXISTS (SELECT 1 FROM messages WHERE id=? AND conversation_id=? AND is_memory_control=1) AND ${context.eventGate}`;
  const gateValues = [messageId, conversationId, ...context.eventGateBindings];
  const statements: D1PreparedStatement[] = [];
  if (plan.mutation) {
    if (plan.command.type === 'save') statements.push(env.DB.prepare(`INSERT INTO memories(id,user_id,body_ciphertext,source_message_id,created_at,updated_at)
      SELECT ?,?,?,?,?,? WHERE ${gate}`).bind(plan.memoryId!, plan.userId, plan.ciphertext!, messageId, now, now, ...gateValues));
    if (plan.command.type === 'update') statements.push(env.DB.prepare(`UPDATE memories SET body_ciphertext=?,source_message_id=?,updated_at=?
      WHERE id=? AND user_id=? AND ${gate}`).bind(plan.ciphertext!, messageId, now, plan.memoryId!, plan.userId, ...gateValues));
    if (plan.command.type === 'forget') statements.push(env.DB.prepare(`DELETE FROM memories WHERE id=? AND user_id=? AND ${gate}`)
      .bind(plan.memoryId!, plan.userId, ...gateValues));
    if (plan.command.type === 'forget_all') statements.push(env.DB.prepare(`DELETE FROM memories WHERE user_id=? AND ${gate}`).bind(plan.userId, ...gateValues));
    statements.push(env.DB.prepare(`UPDATE users SET context_revision=context_revision+1,
      memory_enabled=CASE WHEN ?='disable' THEN 0 WHEN ?='enable' THEN 1 ELSE memory_enabled END,
      memory_history_after_sequence=CASE WHEN ?=1 THEN COALESCE((SELECT MAX(sequence) FROM inbox),0) ELSE memory_history_after_sequence END
      WHERE id=? AND context_revision=? AND ${gate}`)
      .bind(plan.command.type, plan.command.type, plan.resetHistory ? 1 : 0, plan.userId, plan.expectedRevision, ...gateValues));
    statements.push(
      env.DB.prepare(`UPDATE messages SET status='cancelled' WHERE id IN (SELECT i.message_id FROM inbox i JOIN conversations c ON c.id=i.conversation_id
        WHERE c.user_id=? AND i.status IN ('pending','processing') AND i.message_id!=?) AND ${gate}`)
        .bind(plan.userId, messageId, ...gateValues),
      env.DB.prepare(`UPDATE inbox SET status='cancelled',last_error='memory_context_changed',completed_at=?
        WHERE conversation_id IN (SELECT id FROM conversations WHERE user_id=?) AND status IN ('pending','processing') AND message_id!=? AND ${gate}`)
        .bind(now, plan.userId, messageId, ...gateValues),
      env.DB.prepare(`UPDATE messages SET status=CASE WHEN EXISTS (SELECT 1 FROM outbound_jobs active_send
        WHERE active_send.message_id=messages.id AND active_send.status='sending') THEN 'delivery_unknown' ELSE 'cancelled' END
        WHERE id IN (SELECT o.message_id FROM outbound_jobs o JOIN conversations c ON c.id=o.conversation_id
        WHERE c.user_id=? AND o.status IN ('queued','retryable_failed','sending')) AND ${gate}`).bind(plan.userId, ...gateValues),
      env.DB.prepare(`UPDATE outbound_jobs SET status=CASE WHEN status='sending' THEN 'delivery_unknown' ELSE 'cancelled' END,
        provider_request_ciphertext=NULL,error_code='memory_context_changed',updated_at=? WHERE conversation_id IN (SELECT id FROM conversations WHERE user_id=?)
        AND status IN ('queued','retryable_failed','sending') AND ${gate}`).bind(now, plan.userId, ...gateValues),
      env.DB.prepare(`UPDATE conversations SET ownership_version=ownership_version+1,lease_token=NULL,lease_until=0
        WHERE user_id=? AND ${gate}`).bind(plan.userId, ...gateValues),
      env.DB.prepare(`UPDATE search_attempts SET result_ciphertext=NULL,query_digest='',
        state=CASE WHEN state='completed' THEN 'purged' ELSE state END,updated_at=? WHERE user_id=? AND ${gate}`)
        .bind(now, plan.userId, ...gateValues),
      env.DB.prepare(`UPDATE google_calendar_requests SET result_ciphertext=NULL,query_digest='',
        state=CASE WHEN state='completed' THEN 'purged' WHEN state='dispatched' THEN 'unknown' ELSE state END,
        updated_at=? WHERE user_id=? AND ${gate}`).bind(now, plan.userId, ...gateValues),
      env.DB.prepare(`UPDATE google_calendar_approvals SET state=CASE WHEN state='pending' THEN 'revoked' ELSE 'unknown' END,
        updated_at=? WHERE user_id=? AND state IN ('pending','executing') AND ${gate}`).bind(now, plan.userId, ...gateValues),
      env.DB.prepare(`UPDATE model_attempts SET response_ciphertext=NULL,input_digest='',
        state=CASE WHEN state='completed' THEN 'purged' WHEN state='reserved' THEN 'failed' WHEN state='dispatched' THEN 'unknown' ELSE state END,
        budget_debit_micro_usd=CASE WHEN state='reserved' THEN 0 ELSE budget_debit_micro_usd END,
        error_code='memory_context_changed',updated_at=? WHERE user_id=? AND ${gate}`).bind(now, plan.userId, ...gateValues),
    );
  }
  const reply = await encryptText(plan.replyText, env.CONTENT_ENCRYPTION_KEY);
  statements.push(
    env.DB.prepare(`INSERT INTO messages(id,conversation_id,in_reply_to_message_id,role,body_ciphertext,status,created_at,model,context_revision,is_memory_control)
      SELECT ?,c.id,?,'assistant',?,CASE WHEN c.mode='bot' AND c.status='active' THEN 'queued' ELSE 'local_only' END,?,'plause-memory',u.context_revision,1
      FROM conversations c JOIN users u ON u.id=c.user_id WHERE c.id=? AND u.status='active' AND ${gate} ON CONFLICT DO NOTHING`)
      .bind(replyId, messageId, reply, now, conversationId, ...gateValues),
    env.DB.prepare(`INSERT INTO outbound_jobs(id,conversation_id,message_id,idempotency_key,status,ownership_version,next_attempt_at,created_at,updated_at,expires_at)
      SELECT ?,c.id,m.id,?,'queued',c.ownership_version,?,?,?,? FROM messages m JOIN conversations c ON c.id=m.conversation_id
      WHERE m.id=? AND m.status='queued' AND ${gate}`)
      .bind(`out_${crypto.randomUUID()}`, `reply:${messageId}`, now, now, now, now + 86_400_000, replyId, ...gateValues),
    env.DB.prepare(`UPDATE inbox SET status='completed',completed_at=?,last_error=NULL WHERE message_id=? AND ${gate}`).bind(now, messageId, ...gateValues),
    env.DB.prepare(`UPDATE messages SET status='processed' WHERE id=? AND ${gate}`).bind(messageId, ...gateValues),
    env.DB.prepare(`INSERT INTO audit_events(id,actor_user_id,conversation_id,action,outcome,created_at)
      SELECT ?,?,?,'memory.'||?,'acknowledged',? WHERE ${gate}`)
      .bind(crypto.randomUUID(), plan.userId, conversationId, plan.command.type, now, ...gateValues),
  );
  return statements;
}
