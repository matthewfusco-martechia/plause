import { assertRuntimeProviders, replyChannelAllowed } from '../../../packages/contracts/src/runtime-policy';
import { eventSchema, ModelCallError, type Env, type MessagingEvent, type ModelProvider, type ModelResponse, type SendOutcome } from '../../../packages/contracts/src/index';
import { isSupportRequest, LOCAL_SUPPORT_NOTICE, MockModelProvider } from '../../../packages/agent-core/src/index';
import { type MessagingTransport } from '../../../packages/messaging-mock/src/index';
import { RuntimeMessagingTransport } from './transport';
import { decryptText, encryptText, sha256 } from '../../../packages/security/src/index';
import { cancellationStatements, PipelineError, resolveBinding, type ConversationRow } from './store';
import { generateHostedReply, hostedPolicy } from './model-runtime';
import { parseMemoryCommand } from '../../../packages/agent-core/src/memory-commands';
import { loadMemoryContext, memoryStatements, prepareMemoryCommand } from './memory-store';
import { parseReminderCommand } from '../../../packages/agent-core/src/reminder-commands';
import { prepareReminderCommand, reminderStatements, enqueueDueReminders } from './reminder-store';
import { parseActionCommand } from '../../../packages/agent-core/src/action-commands';
import { prepareActionCommand, actionStatements, prepareModelProposal, modelProposalCommitGuard, modelProposalStatements,
  type ModelProposalPlan } from './action-store';
import { REMINDER_SEND_ELIGIBILITY_SQL, CONVERSATION_SEND_ELIGIBILITY_SQL } from '../../../packages/contracts/src/delivery-policy';
import { getQuietHoursEnd } from '../../../packages/scheduling/src/index';
import { parseResearchCommand, RESEARCH_HELP } from '../../../packages/research/src/index';
import { runResearch } from './research';
import { parseModelProposal } from '../../../packages/agent-core/src/model-proposals';
import { parseGoogleCalendarCommand, runGoogleCalendarCommand } from './google-calendar';
import { getGoogleConnection } from './google-oauth';
import { classifyFailure, retryFailureStatements, terminalFailureStatements } from './failures';
import { getSupportCoverage } from './operator-support';
import { assertOperational, maintenanceState } from './runtime-operations';
import { setTyping } from './typing';
import { onboardingEventConflict, onboardingLifecycleStatements } from './messaging-onboarding';
import type { SunshineEvent } from '../../../packages/messaging-sunshine/src/index';

export { PipelineError } from './store';

export interface ProcessOptions {
  model?: ModelProvider;
  transport?: MessagingTransport;
  modelTimeoutMs?: number;
  leaseMs?: number;
  /** Local failure/concurrency tests can interrupt the two consequential boundaries. */
  beforeModelCommit?: () => Promise<void>;
  beforeDispatch?: () => Promise<void>;
}

interface InboxRow { sequence: number; message_id: string; body_ciphertext: string; attempt_count: number; context_revision: number; created_at: number }
interface OutboundRow {
  id: string; message_id: string; idempotency_key: string; status: string; ownership_version: number;
  attempt_count: number; attempt_token: string | null; next_attempt_at: number; expires_at: number;
  context_revision: number;
  reminder_eligible: number;
  operator_user_id: string | null;
  support_notice: number;
}
interface EligibleConversation extends ConversationRow { binding_status: string; user_status: string; context_revision: number }

function assertLocalProviders(env: Env): void {
  try { assertRuntimeProviders(env); }
  catch { throw new PipelineError('Runtime providers are not configured.', 503, 'provider_not_configured'); }
}

/** Arrival time is not part of semantic identity: browser retries get a new timestamp. */
async function fingerprint(event: MessagingEvent, verified?: VerifiedProviderIngress): Promise<string> {
  const normalized = { schemaVersion: event.schemaVersion, type: event.type, eventId: event.eventId,
    subject: { provider: event.subject.provider, businessId: event.subject.businessId, subjectId: event.subject.subjectId }, channel: event.channel,
    ...('messageId' in event ? { messageId: event.messageId } : {}),
    ...(event.type === 'message.received' ? { text: event.text } : {}),
    ...(event.type === 'delivery.updated' ? { state: event.state } : {}) };
  return sha256(JSON.stringify({ ...normalized, ...(verified ? { verified } : {}) }));
}

/** Only the authenticated provider adapter can supply routing/control metadata. */
export interface VerifiedProviderIngress { providerConversationId: string; control: 'bot' | 'human' | 'unknown'; bindingRevision: number }

/** The durable event and its pending inbox entry commit together, before any queue wakeup. */
export async function ingestEvent(env: Env, input: MessagingEvent, verified?: VerifiedProviderIngress,
  providerReceipt?: Extract<SunshineEvent, { type: 'delivery.updated' }>): Promise<{ eventId: string; conversationId: string; duplicate: boolean }> {
  return ingestAttempt(env, input, 0, verified, providerReceipt);
}

async function ingestAttempt(env: Env, input: MessagingEvent, retry: number, verified?: VerifiedProviderIngress,
  providerReceipt?: Extract<SunshineEvent, { type: 'delivery.updated' }>): Promise<{ eventId: string; conversationId: string; duplicate: boolean }> {
  assertLocalProviders(env);
  await assertOperational(env);
  const event = eventSchema.parse(input);
  if (event.subject.provider === 'sunshine' && await onboardingEventConflict(env, event.subject.businessId, event.eventId)) {
    throw new PipelineError('Provider event conflict.', 409, 'event_conflict');
  }
  if (await env.DB.prepare(`SELECT 1 FROM channel_link_challenges WHERE provider=? AND business_id=? AND provider_event_id=?`)
    .bind(event.subject.provider, event.subject.businessId, event.eventId).first()) throw new PipelineError('Event identifier was used for channel verification.', 409, 'event_conflict');
  if (!replyChannelAllowed(env, event.channel)) throw new PipelineError('Channel is not enabled.', 403, 'channel_not_enabled');
  const conversation = await resolveBinding(env, event.subject, event.channel);
  const now = Date.now();
  const token = crypto.randomUUID();
  const payloadHash = await fingerprint(event, verified);
  if (event.channel === 'apple_business' && event.type === 'message.received' && !verified) throw new PipelineError('Verified provider metadata required.', 403, 'provider_proof_required');
  const encryptedPayload = await encryptText(JSON.stringify(event), env.CONTENT_ENCRYPTION_KEY);
  const messageId = `msg_${crypto.randomUUID()}`;
  const support = event.type === 'message.received' && isSupportRequest(event.text);
  const memoryCommand = event.type === 'message.received' ? parseMemoryCommand(event.text) : null;
  const reminderCommand = event.type === 'message.received' && !memoryCommand
    ? parseReminderCommand(event.text, now, { naturalLanguageFallback: true }) : null;
  const googleCommand = event.type === 'message.received' && !memoryCommand && !reminderCommand ? parseGoogleCalendarCommand(event.text) : null;
  const actionCommand = event.type === 'message.received' && !memoryCommand && !reminderCommand && !googleCommand ? parseActionCommand(event.text, now) : null;
  let memoryPlan;
  let reminderPlan;
  let actionPlan;
  try {
    memoryPlan = memoryCommand ? await prepareMemoryCommand(env, conversation.user_id, memoryCommand) : null;
    reminderPlan = reminderCommand ? await prepareReminderCommand(env, conversation.user_id, conversation.id, reminderCommand) : null;
    actionPlan = actionCommand ? await prepareActionCommand(env, conversation.user_id, conversation.id, actionCommand) : null;
  } catch (error) {
    if (error instanceof PipelineError && ['memory_conflict', 'reminder_conflict', 'action_conflict', 'actions_conflict'].includes(error.code) && retry < 4) return ingestAttempt(env, input, retry + 1, verified, providerReceipt);
    throw error;
  }
  const controlPlan = memoryPlan ?? reminderPlan ?? actionPlan;
  // These are fixed column names, never derived from message content.
  const revisionColumn = memoryPlan ? 'context_revision' : reminderPlan ? 'reminders_revision' : 'actions_revision';
  const eventGate = `EXISTS (SELECT 1 FROM webhook_events WHERE provider=? AND business_id=? AND event_id=? AND ingest_token=?)`;
  const gateBindings = [event.subject.provider, event.subject.businessId, event.eventId, token];
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(`INSERT INTO webhook_events (provider,business_id,event_id,subject_id,conversation_id,event_type,provider_message_id,
      delivery_state,payload_hash,payload_ciphertext,ingest_token,occurred_at,received_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM bindings b JOIN users u ON u.id=b.user_id
      WHERE b.conversation_id=? AND b.status='active' AND u.status='active' AND (? IS NULL OR b.provider_conversation_id=?)
      AND (? IS NULL OR b.revision=?))
      AND NOT EXISTS (SELECT 1 FROM provider_lifecycle_events WHERE provider=? AND business_id=? AND event_id=?)
      AND NOT EXISTS (SELECT 1 FROM channel_link_challenges WHERE provider=? AND business_id=? AND provider_event_id=?)
      AND NOT EXISTS (SELECT 1 FROM messaging_onboarding_events WHERE provider=? AND business_id=? AND event_id=?)
      AND NOT EXISTS (SELECT 1 FROM system_settings WHERE key='restore_locked' AND value!='false')
      AND (? IS NULL OR EXISTS (SELECT 1 FROM users WHERE id=? AND ${revisionColumn}=?)) AND
      (? != 'message.received' OR ?=1 OR EXISTS (SELECT 1 FROM messages WHERE conversation_id=? AND provider_message_id=? AND role='user')
      OR (SELECT COUNT(*) FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.user_id=? AND m.role='user' AND m.is_memory_control=0 AND m.created_at>=?)
      < (SELECT daily_message_limit FROM users WHERE id=?)) ON CONFLICT(provider,business_id,event_id) DO NOTHING`)
      .bind(event.subject.provider, event.subject.businessId, event.eventId, event.subject.subjectId, conversation.id, event.type,
        'messageId' in event ? event.messageId : null, event.type === 'delivery.updated' ? event.state : null,
        payloadHash, encryptedPayload, token, Date.parse(event.occurredAt), now, conversation.id, verified?.providerConversationId ?? null, verified?.providerConversationId ?? null,
        verified?.bindingRevision ?? null, verified?.bindingRevision ?? null,
        event.subject.provider, event.subject.businessId, event.eventId,
        event.subject.provider, event.subject.businessId, event.eventId,
        event.subject.provider, event.subject.businessId, event.eventId,
        controlPlan?.expectedRevision ?? null, conversation.user_id, controlPlan?.expectedRevision ?? null, event.type, support || controlPlan || googleCommand ? 1 : 0,
        conversation.id, 'messageId' in event ? event.messageId : null, conversation.user_id, Math.floor(now / 86_400_000) * 86_400_000, conversation.user_id),
  ];
  if (verified) {
    const at = Date.parse(event.occurredAt);
    statements.push(env.DB.prepare(`UPDATE conversations SET provider_control=?,provider_event_at=?,
      ownership_version=ownership_version+CASE WHEN provider_control!=? THEN 1 ELSE 0 END,
      lease_token=CASE WHEN provider_control!=? THEN NULL ELSE lease_token END,
      lease_until=CASE WHEN provider_control!=? THEN 0 ELSE lease_until END,
      mode=CASE WHEN ?!='bot' THEN 'human' WHEN handoff_reason='provider' THEN 'bot' ELSE mode END,
      handoff_reason=CASE WHEN ?!='bot' AND (handoff_reason IS NULL OR handoff_reason='provider') THEN 'provider'
        WHEN ?='bot' AND handoff_reason='provider' THEN NULL ELSE handoff_reason END
      WHERE id=? AND (provider_event_at<? OR provider_event_at=? AND (?!='bot' OR provider_control='bot')) AND ${eventGate}`)
      .bind(verified.control, at, verified.control, verified.control, verified.control, verified.control, verified.control, verified.control,
        conversation.id, at, at, verified.control, ...gateBindings));
  }
  if (event.type === 'message.received') {
    const body = await encryptText(event.text, env.CONTENT_ENCRYPTION_KEY);
    const contentHash = await sha256(event.text);
    statements.push(
      env.DB.prepare(`INSERT INTO messages (id,conversation_id,provider_message_id,role,body_ciphertext,content_hash,status,created_at,is_memory_control,context_revision)
        SELECT ?,?,?,'user',?,?,'received',?,?,(SELECT context_revision FROM users WHERE id=?) WHERE ${eventGate} ON CONFLICT DO NOTHING`)
        .bind(messageId, conversation.id, event.messageId, body, contentHash, now, controlPlan || support ? 1 : 0, conversation.user_id, ...gateBindings),
      env.DB.prepare(`UPDATE conversations SET status=CASE WHEN ? IS NULL OR provider_event_at<=? THEN 'active' ELSE status END,
        mode=CASE WHEN ?=1 THEN 'human' ELSE mode END,handoff_reason=CASE WHEN ?=1 THEN 'customer' ELSE handoff_reason END,
        ownership_version=ownership_version+CASE WHEN status='closed' OR ?=1 THEN 1 ELSE 0 END,
        lease_token=CASE WHEN status='closed' OR ?=1 THEN NULL ELSE lease_token END,
        lease_until=CASE WHEN status='closed' OR ?=1 THEN 0 ELSE lease_until END,last_activity_at=?
        WHERE id=? AND EXISTS (SELECT 1 FROM messages WHERE id=?)`)
        .bind(verified?.providerConversationId ?? null, Date.parse(event.occurredAt), support ? 1 : 0, support ? 1 : 0,
          support ? 1 : 0, support ? 1 : 0, support ? 1 : 0, now, conversation.id, messageId),
      env.DB.prepare(`INSERT INTO inbox (conversation_id,message_id,status,accepted_at,completed_at)
        SELECT id,?,CASE WHEN mode='bot' AND provider_control='bot' AND status='active' THEN 'pending' ELSE 'cancelled' END,?,
        CASE WHEN mode='bot' AND provider_control='bot' AND status='active' THEN NULL ELSE ? END FROM conversations
        WHERE id=? AND EXISTS (SELECT 1 FROM messages WHERE id=?)`)
        .bind(messageId, now, now, conversation.id, messageId),
    );
    if (support) {
      statements.push(env.DB.prepare(`INSERT INTO messages (id,conversation_id,role,body_ciphertext,status,created_at)
        SELECT ?,?,'system',?,'local_only',? WHERE EXISTS (SELECT 1 FROM messages WHERE id=?)`)
        .bind(`msg_${crypto.randomUUID()}`, conversation.id, await encryptText(supportNotice(env), env.CONTENT_ENCRYPTION_KEY), now, messageId));
      if (env.APP_ENV !== 'local') {
        const replyId = `msg_${crypto.randomUUID()}`;
        statements.push(
          env.DB.prepare(`INSERT INTO messages(id,conversation_id,role,body_ciphertext,status,created_at,model,context_revision,
            is_memory_control,support_notice,in_reply_to_message_id) SELECT ?,c.id,'assistant',?,'queued',?,'plause-support',u.context_revision,1,1,?
            FROM conversations c JOIN users u ON u.id=c.user_id WHERE c.id=? AND EXISTS (SELECT 1 FROM messages WHERE id=?)`)
            .bind(replyId, await encryptText(supportNotice(env), env.CONTENT_ENCRYPTION_KEY), now, messageId, conversation.id, messageId),
          env.DB.prepare(`INSERT INTO outbound_jobs(id,conversation_id,message_id,idempotency_key,status,ownership_version,next_attempt_at,created_at,updated_at,expires_at)
            SELECT ?,c.id,m.id,?,'queued',c.ownership_version,?,?,?,? FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.id=?`)
            .bind(`out_${crypto.randomUUID()}`, `support:${messageId}`, now, now, now, now + 86_400_000, replyId));
      }
    }
  } else if (event.type === 'handoff.requested' || event.type === 'conversation.closed') {
    statements.push(env.DB.prepare(`UPDATE conversations SET ${event.type === 'conversation.closed' ? "status='closed'" : "mode='human',handoff_reason='customer'"},
      ownership_version=ownership_version+1,lease_token=NULL,lease_until=0,last_activity_at=? WHERE id=? AND ${eventGate}`)
      .bind(now, conversation.id, ...gateBindings));
    const notice = event.type === 'handoff.requested' ? supportNotice(env) : 'This channel conversation is closed. Pending replies have been cancelled.';
    statements.push(env.DB.prepare(`INSERT INTO messages (id,conversation_id,role,body_ciphertext,status,created_at)
      SELECT ?,?,'system',?,'local_only',? WHERE ${eventGate}`)
      .bind(`msg_${crypto.randomUUID()}`, conversation.id, await encryptText(notice, env.CONTENT_ENCRYPTION_KEY), now, ...gateBindings));
  } else {
    // Receipts are events, not inbound turns. Repeated states share a message ID legitimately.
    statements.push(env.DB.prepare(`UPDATE outbound_jobs SET status=CASE WHEN status='delivered' THEN 'delivered'
      WHEN ?='delivered' THEN 'delivered' WHEN status='failed' THEN 'failed' ELSE ? END,updated_at=?
      WHERE conversation_id=? AND provider_message_id=? AND ${eventGate}`)
      .bind(event.state, event.state, now, conversation.id, event.messageId, ...gateBindings));
    statements.push(env.DB.prepare(`UPDATE messages SET status=(SELECT status FROM outbound_jobs WHERE message_id=messages.id)
      WHERE id IN (SELECT message_id FROM outbound_jobs WHERE conversation_id=? AND provider_message_id=?) AND ${eventGate}`)
      .bind(conversation.id, event.messageId, ...gateBindings));
  }
  statements.push(...cancellationStatements(env, conversation.id, now));
  if (providerReceipt) statements.push(...await onboardingLifecycleStatements(env, providerReceipt,
    { gate: eventGate, gateBindings, now }));
  const controlContext = { messageId, conversationId: conversation.id, replyId: `msg_${crypto.randomUUID()}`, eventGate, eventGateBindings: gateBindings, now };
  if (memoryPlan) statements.push(...await memoryStatements(env, memoryPlan, controlContext));
  if (reminderPlan) statements.push(...await reminderStatements(env, reminderPlan, controlContext));
  if (actionPlan) statements.push(...await actionStatements(env, actionPlan, controlContext));
  await env.DB.batch(statements);
  const stored = await env.DB.prepare('SELECT payload_hash,ingest_token FROM webhook_events WHERE provider=? AND business_id=? AND event_id=?')
    .bind(event.subject.provider, event.subject.businessId, event.eventId).first<{ payload_hash: string; ingest_token: string }>();
  if (!stored) {
    if (event.subject.provider === 'sunshine' && await onboardingEventConflict(env, event.subject.businessId, event.eventId)) {
      throw new PipelineError('Provider event conflict.', 409, 'event_conflict');
    }
    const stillActive = await eligibleConversation(env, conversation.id);
    if (!stillActive || stillActive.binding_status !== 'active' || stillActive.user_status !== 'active') {
      throw new PipelineError('Channel identity revoked.', 403, 'unknown_sender');
    }
    if (controlPlan) {
      if (retry < 4) return ingestAttempt(env, input, retry + 1, verified, providerReceipt);
      throw new PipelineError('Controls changed. Please retry.', 409, memoryPlan ? 'memory_conflict' : reminderPlan ? 'reminder_conflict' : 'actions_conflict');
    }
    throw new PipelineError('Daily local demo message limit reached.', 429, 'daily_limit');
  }
  if (stored.payload_hash !== payloadHash) throw new PipelineError('Event identifier was reused with different content.', 409, 'event_conflict');
  let duplicate = stored.ingest_token !== token;
  if (event.type === 'message.received') {
    const logical = await env.DB.prepare(`SELECT id,content_hash FROM messages WHERE conversation_id=? AND provider_message_id=? AND role='user'`)
      .bind(conversation.id, event.messageId).first<{ id: string; content_hash: string }>();
    if (logical?.content_hash !== await sha256(event.text)) throw new PipelineError('Message identifier was reused with different content.', 409, 'message_conflict');
    duplicate ||= logical.id !== messageId;
  }
  // Queue failure cannot roll back acceptance. The scheduled scanner finds the inbox/outbox.
  try { await env.JOBS.send({ kind: 'conversation', conversationId: conversation.id }); }
  catch { console.warn(JSON.stringify({ code: 'queue_wakeup_failed', recoverable: true })); }
  return { eventId: event.eventId, conversationId: conversation.id, duplicate };
}

function supportNotice(env: Env): string {
  if (env.APP_ENV === 'local') return LOCAL_SUPPORT_NOTICE;
  const coverage = getSupportCoverage(env);
  return `Automatic replies are paused while this conversation awaits human support.${coverage.configured
    ? ` Published support hours: ${coverage.hours} (${coverage.timeZone}). Contact: ${coverage.contact}.` : ' Staff availability has not been configured.'} A response time is not guaranteed.`;
}

async function eligibleConversation(env: Env, id: string): Promise<EligibleConversation | null> {
  return env.DB.prepare(`SELECT c.*,b.status AS binding_status,u.status AS user_status,u.context_revision FROM conversations c
    JOIN bindings b ON b.conversation_id=c.id AND b.user_id=c.user_id JOIN users u ON u.id=c.user_id WHERE c.id=?`)
    .bind(id).first<EligibleConversation>();
}

async function paused(env: Env): Promise<boolean> {
  const state = await maintenanceState(env); return state.locked || state.outboundPaused;
}

function canDispatch(conversation: EligibleConversation | null, token: string, version: number, contextRevision: number, human = false): boolean {
  return !!conversation && conversation.user_status === 'active' && conversation.binding_status === 'active'
    && conversation.status === 'active' && (conversation.mode === 'bot' || human && conversation.mode === 'human')
    && conversation.provider_control === 'bot' && conversation.ownership_version === version
    && conversation.lease_token === token && conversation.lease_until > Date.now() && conversation.context_revision === contextRevision;
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, controller?: AbortController, timeoutError?: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => {
      controller?.abort();
      reject(timeoutError ? timeoutError() : controller ? new ModelCallError('model_timeout', true, false) : new Error('operation_timeout'));
    }, timeoutMs); })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

function validModelResponse(response: ModelResponse): boolean {
  return typeof response.text === 'string' && (response.text.trim().length > 0 || response.proposal !== undefined) && response.text.length <= 4000
    && (response.proposal === undefined || parseModelProposal(response.proposal) !== null)
    && Number.isSafeInteger(response.inputTokens) && response.inputTokens >= 0 && response.inputTokens <= 100_000
    && Number.isSafeInteger(response.outputTokens) && response.outputTokens >= 0 && response.outputTokens <= 10_000;
}

export async function processConversation(env: Env, conversationId: string, options: ProcessOptions = {}): Promise<void> {
  assertLocalProviders(env);
  if ((await maintenanceState(env)).locked) return;
  const token = crypto.randomUUID();
  let livePolicy = null;
  if (env.MODEL_PROVIDER === 'openai') {
    try { livePolicy = hostedPolicy(env); } catch { /* Deterministic controls and prior delivery remain available. */ }
  }
  const leaseMs = Math.max(100, options.leaseMs ?? livePolicy?.leaseMs ?? 15_000);
  const timeoutMs = Math.max(1, Math.min(options.modelTimeoutMs ?? livePolicy?.timeoutMs ?? 5_000, leaseMs - 50));
  const model = options.model ?? new MockModelProvider();
  const transport = options.transport ?? new RuntimeMessagingTransport(env);
  const now = Date.now();
  const claim = await env.DB.prepare(`UPDATE conversations SET lease_token=?,lease_until=? WHERE id=?
    AND (lease_token IS NULL OR lease_until<=?)`).bind(token, now + leaseMs, conversationId, now).run();
  if (claim.meta.changes !== 1) return;
  try {
    for (let turn = 0; turn < 20; turn++) {
      let conversation = await eligibleConversation(env, conversationId);
      if (!conversation) return;
      if (!replyChannelAllowed(env, conversation.channel)) return;
      if (conversation.provider === 'sunshine' && conversation.business_id !== env.SUNSHINE_APP_ID) return;
      if (conversation.user_status !== 'active' || conversation.binding_status !== 'active') {
        await cancelUnsent(env, conversationId, 'identity_inactive');
        return;
      }
      if (conversation.lease_token !== token || conversation.lease_until <= Date.now()) return;
      await env.DB.prepare('UPDATE conversations SET lease_until=? WHERE id=? AND lease_token=? AND lease_until>?')
        .bind(Date.now() + leaseMs, conversationId, token, Date.now()).run();
      conversation = await eligibleConversation(env, conversationId);
      if (!conversation) return;
      const outbound = await env.DB.prepare(`SELECT o.*,m.context_revision,m.operator_user_id,m.support_notice,CASE WHEN ${REMINDER_SEND_ELIGIBILITY_SQL} AND ${CONVERSATION_SEND_ELIGIBILITY_SQL} THEN 1 ELSE 0 END AS reminder_eligible FROM outbound_jobs o JOIN messages m ON m.id=o.message_id
        JOIN conversations c ON c.id=o.conversation_id JOIN users u ON u.id=c.user_id WHERE o.conversation_id=?
        AND o.status IN ('queued','sending','retryable_failed','delivery_unknown')
        AND (m.context_revision=u.context_revision OR o.status NOT IN ('sending','delivery_unknown'))
        AND (o.ownership_version=c.ownership_version OR o.status NOT IN ('sending','delivery_unknown'))
        AND ((${REMINDER_SEND_ELIGIBILITY_SQL} AND ${CONVERSATION_SEND_ELIGIBILITY_SQL}) OR o.status NOT IN ('sending','delivery_unknown'))
        AND (m.reminder_occurrence_id IS NULL OR o.next_attempt_at<=?) ORDER BY o.rowid LIMIT 1`)
        .bind(conversationId, Date.now()).first<OutboundRow>();
      if (outbound) {
        const progressed = await dispatchOne(env, conversation, outbound, token, transport, timeoutMs, options.beforeDispatch);
        if (!progressed) return;
        continue;
      }
      if (conversation.mode !== 'bot' || conversation.provider_control !== 'bot' || conversation.status !== 'active' || await paused(env)) return;
      const inbox = await env.DB.prepare(`SELECT i.sequence,i.message_id,i.attempt_count,m.body_ciphertext,m.context_revision,m.created_at FROM inbox i
        JOIN messages m ON m.id=i.message_id WHERE i.conversation_id=? AND i.status IN ('pending','processing') AND m.is_memory_control=0 ORDER BY i.sequence LIMIT 1`)
        .bind(conversationId).first<InboxRow>();
      if (!inbox) return;
      await env.DB.batch([
        env.DB.prepare(`UPDATE inbox SET status='processing',attempt_count=attempt_count+1 WHERE sequence=?
          AND EXISTS (SELECT 1 FROM conversations WHERE id=? AND lease_token=? AND lease_until>?)`)
          .bind(inbox.sequence, conversationId, token, Date.now()),
        env.DB.prepare(`UPDATE messages SET status='processing' WHERE id=? AND EXISTS
          (SELECT 1 FROM conversations WHERE id=? AND lease_token=? AND lease_until>?)`)
          .bind(inbox.message_id, conversationId, token, Date.now()),
      ]);
      let response: ModelResponse;
      let proposalPlan: ModelProposalPlan | undefined;
      let contextRevision = inbox.context_revision;
      const typingContext = { conversationId, leaseToken: token, ownershipVersion: conversation.ownership_version };
      await setTyping(env, typingContext, true);
      try {
        const memoryContext = await loadMemoryContext(env, conversation.user_id);
        contextRevision = memoryContext.revision;
        if (inbox.context_revision !== contextRevision) return;
        // Arrival order can be A, B, assistant(A). Associate each assistant with
        // its input turn so B still receives A's completed reply in its history.
        const historyRows = await env.DB.prepare(`SELECT role,body_ciphertext FROM (
          SELECT i.sequence AS turn_order,0 AS role_order,m.role,m.body_ciphertext FROM inbox i JOIN messages m ON m.id=i.message_id
          WHERE i.conversation_id=? AND i.sequence<? AND i.sequence>? AND m.is_memory_control=0 AND m.role='user' AND m.status NOT IN ('cancelled','failed')
          UNION ALL
          SELECT i.sequence AS turn_order,1 AS role_order,m.role,m.body_ciphertext FROM inbox i JOIN messages m ON m.in_reply_to_message_id=i.message_id
          WHERE i.conversation_id=? AND i.sequence<? AND i.sequence>? AND m.is_memory_control=0 AND m.role='assistant' AND m.status NOT IN ('cancelled','failed')
          ORDER BY turn_order DESC,role_order DESC LIMIT 12) ORDER BY turn_order,role_order`)
          .bind(conversationId, inbox.sequence, memoryContext.historyAfterSequence, conversationId, inbox.sequence, memoryContext.historyAfterSequence)
          .all<{ role: 'user' | 'assistant'; body_ciphertext: string }>();
        const history = await Promise.all(historyRows.results.map(async (row) => ({ role: row.role, text: (await decryptText(row.body_ciphertext, env.CONTENT_ENCRYPTION_KEY)).slice(0, 1500) })));
        const settings = await env.DB.prepare('SELECT reminder_timezone FROM users WHERE id=?').bind(conversation.user_id)
          .first<{ reminder_timezone: string }>();
        const googleConnection = await getGoogleConnection(env, conversation.user_id);
        const request = { text: await decryptText(inbox.body_ciphertext, env.CONTENT_ENCRYPTION_KEY), history,
          memories: memoryContext.memories, contextRevision,
          planningContext: { now: inbox.created_at, timeZone: settings?.reminder_timezone ?? null,
            realGoogleCalendarConnected: googleConnection.connected } };
        const current = await eligibleConversation(env, conversationId);
        if (!canDispatch(current, token, conversation.ownership_version, contextRevision)) return;
        const research = parseResearchCommand(request.text);
        const google = parseGoogleCalendarCommand(request.text);
        if (google) {
          const controller = new AbortController();
          response = await withTimeout(runGoogleCalendarCommand(env, { userId: conversation.user_id, conversationId,
            messageId: inbox.message_id, leaseToken: token, ownershipVersion: conversation.ownership_version,
            contextRevision, signal: controller.signal }, google), Math.min(12_000, leaseMs - 50), controller,
            () => new ModelCallError('google_calendar_timeout'));
        } else if (research) {
          if (research.type !== 'search') response = { text: research.type === 'help' ? RESEARCH_HELP : research.reason, inputTokens: 0, outputTokens: 0, model: 'plause-research' };
          else {
            const controller = new AbortController();
            response = await withTimeout(runResearch(env, { userId: conversation.user_id, conversationId, messageId: inbox.message_id,
              leaseToken: token, ownershipVersion: conversation.ownership_version, contextRevision, signal: controller.signal }, research.query),
              Math.min(12_000, leaseMs - 50), controller, () => new ModelCallError('research_timeout'));
          }
        } else if (env.MODEL_PROVIDER === 'openai') {
          const controller = new AbortController();
          response = await withTimeout(generateHostedReply(env, {
            userId: conversation.user_id, conversationId, messageId: inbox.message_id,
            leaseToken: token, ownershipVersion: conversation.ownership_version, contextRevision,
          }, { ...request, signal: controller.signal }, options.model), Math.min(timeoutMs + 5000, leaseMs - 50), controller);
        } else {
          response = await withTimeout(model.generate(request), timeoutMs);
        }
        if (!validModelResponse(response)) throw new Error('invalid_model_response');
        if (response.proposal?.type === 'google_calendar.create' || response.proposal?.type === 'google_calendar.list') {
          const controller = new AbortController();
          const proposal = response.proposal;
          const result = await withTimeout(runGoogleCalendarCommand(env, { userId: conversation.user_id, conversationId,
            messageId: inbox.message_id, leaseToken: token, ownershipVersion: conversation.ownership_version,
            contextRevision, signal: controller.signal }, proposal.type === 'google_calendar.create'
              ? { type: 'propose_create', draft: { title: proposal.title, startsAt: proposal.startsAt, durationMinutes: proposal.durationMinutes } }
              : { type: 'list', timeMin: proposal.timeMin, timeMax: proposal.timeMax }), Math.min(12_000, leaseMs - 50), controller,
              () => new ModelCallError('google_calendar_timeout'));
          // Preserve the paid model accounting; only server-verified text becomes the reply.
          response = { ...response, text: result.text };
        } else if (response.proposal) {
          proposalPlan = await prepareModelProposal(env, conversation.user_id, conversationId, response.proposal);
          // Model text is never a claim of completion or the approval review copy.
          response = { ...response, text: proposalPlan.replyText };
        }
        await options.beforeModelCommit?.();
      } catch (error) {
        const terminal = inbox.attempt_count + 1 >= 3 || error instanceof ModelCallError && !error.retryable;
        const failure = classifyFailure(error);
        if (terminal) {
          const recorded = await env.DB.batch(await terminalFailureStatements(env, { userId: conversation.user_id, conversationId,
            messageId: inbox.message_id, inboxSequence: inbox.sequence, leaseToken: token,
            ownershipVersion: conversation.ownership_version, contextRevision, now: Date.now() }, failure));
          if (recorded[0]?.meta.changes !== 1) return;
          // Dispatch the durable status reply through the normal ownership/privacy gates.
          continue;
        }
        await env.DB.batch(retryFailureStatements(env, { userId: conversation.user_id, conversationId,
          messageId: inbox.message_id, inboxSequence: inbox.sequence, leaseToken: token,
          ownershipVersion: conversation.ownership_version, contextRevision, now: Date.now() }, failure.code));
        return;
      } finally { await setTyping(env, typingContext, false); }
      const generatedId = `msg_${crypto.randomUUID()}`;
      const ciphertext = await encryptText(response.text, env.CONTENT_ENCRYPTION_KEY);
      const createdAt = Date.now();
      const proposalGuard = proposalPlan ? modelProposalCommitGuard(proposalPlan) : { sql: '1=1', bindings: [] };
      const proposalWrites = proposalPlan ? await modelProposalStatements(env, proposalPlan, {
        sourceMessageId: inbox.message_id, replyId: generatedId, leaseToken: token,
        ownershipVersion: conversation.ownership_version, contextRevision, now: createdAt,
      }) : [];
      // All three writes are one transaction. A fenced or expired turn creates none of them.
      const committed = await env.DB.batch([
        env.DB.prepare(`INSERT INTO messages (id,conversation_id,in_reply_to_message_id,role,body_ciphertext,status,created_at,model,context_revision,is_memory_control)
          SELECT ?,c.id,?,'assistant',?,'queued',?,?,?,? FROM conversations c JOIN users u ON u.id=c.user_id
          JOIN bindings b ON b.conversation_id=c.id AND b.user_id=c.user_id WHERE c.id=? AND c.lease_token=? AND c.lease_until>?
          AND c.lease_until>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
          AND c.ownership_version=? AND u.context_revision=? AND c.mode='bot' AND c.provider_control='bot' AND c.status='active' AND b.status='active' AND u.status='active'
          AND b.provider=c.provider AND b.business_id=c.business_id AND b.subject_id=c.subject_id AND b.channel=c.channel
          AND NOT EXISTS (SELECT 1 FROM system_settings WHERE key='restore_locked' AND value!='false')
          AND (${proposalGuard.sql}) ON CONFLICT DO NOTHING`)
          .bind(generatedId, inbox.message_id, ciphertext, createdAt, response.model ?? 'mock', contextRevision, proposalPlan ? 1 : 0,
            conversationId, token, createdAt, conversation.ownership_version, contextRevision, ...proposalGuard.bindings),
        ...proposalWrites,
        env.DB.prepare(`INSERT INTO outbound_jobs (id,conversation_id,message_id,idempotency_key,status,ownership_version,next_attempt_at,created_at,updated_at,expires_at)
          SELECT ?,conversation_id,id,?,'queued',?,?,?, ?,? FROM messages WHERE id=?`)
          .bind(`out_${crypto.randomUUID()}`, `reply:${inbox.message_id}`, conversation.ownership_version, createdAt, createdAt, createdAt, createdAt + 86_400_000, generatedId),
        env.DB.prepare(`UPDATE inbox SET status='completed',completed_at=?,last_error=NULL WHERE sequence=?
          AND EXISTS (SELECT 1 FROM messages WHERE id=?)`).bind(createdAt, inbox.sequence, generatedId),
        env.DB.prepare(`UPDATE messages SET status='processed' WHERE id=? AND EXISTS (SELECT 1 FROM messages WHERE id=?)`)
          .bind(inbox.message_id, generatedId),
        ...(env.MODEL_PROVIDER === 'mock' && !response.model?.startsWith('plause-') ? [env.DB.prepare(`INSERT INTO usage_ledgers (id,user_id,conversation_id,input_tokens,output_tokens,created_at)
          SELECT ?,c.user_id,c.id,?,?,? FROM conversations c WHERE c.id=? AND EXISTS (SELECT 1 FROM messages WHERE id=?)`)
          .bind(crypto.randomUUID(), response.inputTokens, response.outputTokens, createdAt, conversationId, generatedId)] : []),
      ]);
      if (committed[0]?.meta.changes !== 1) return;
    }
  } finally {
    await env.DB.prepare('UPDATE conversations SET lease_token=NULL,lease_until=0 WHERE id=? AND lease_token=?').bind(conversationId, token).run();
  }
}

async function cancelUnsent(env: Env, conversationId: string, code: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("UPDATE inbox SET status='cancelled',completed_at=? WHERE conversation_id=? AND status IN ('pending','processing')").bind(Date.now(), conversationId),
    env.DB.prepare(`UPDATE messages SET status='cancelled' WHERE id IN (SELECT message_id FROM outbound_jobs
      WHERE conversation_id=? AND status IN ('queued','retryable_failed'))`).bind(conversationId),
    env.DB.prepare(`UPDATE outbound_jobs SET status='cancelled',error_code=?,updated_at=? WHERE conversation_id=? AND status IN ('queued','retryable_failed')`)
      .bind(code, Date.now(), conversationId),
  ]);
}

async function dispatchOne(env: Env, conversation: EligibleConversation, job: OutboundRow, leaseToken: string,
  transport: MessagingTransport, timeoutMs: number, beforeDispatch?: () => Promise<void>): Promise<boolean> {
  if (job.next_attempt_at > Date.now()) return false;
  if (job.status === 'sending' || job.status === 'delivery_unknown') {
    // A previous attempt may have reached the provider. Reconcile; never blindly resend.
    let result: SendOutcome | null;
    try { result = await withTimeout(transport.reconcile(job.idempotency_key), timeoutMs); }
    catch { result = null; }
    // A missing receipt permits retry only when this adapter explicitly guarantees
    // durable idempotency. The mock also fences acceptance by the exact attempt.
    if (!result && (transport.supportsIdempotentRetry || transport.supportsIdempotentRetryFor?.(conversation.channel)) && job.attempt_count < 5 &&
        canDispatch(conversation, leaseToken, job.ownership_version, job.context_revision, job.operator_user_id !== null || job.support_notice === 1) && !await paused(env)) {
      const retried = await env.DB.prepare(`UPDATE outbound_jobs SET status='queued',attempt_token=NULL,
        error_code='idempotent_recovery',next_attempt_at=?,updated_at=? WHERE id=? AND attempt_token IS ?
        AND status IN ('sending','delivery_unknown') AND EXISTS (SELECT 1 FROM messages m
          JOIN conversations c ON c.id=m.conversation_id JOIN users u ON u.id=c.user_id WHERE m.id=outbound_jobs.message_id
          AND m.context_revision=u.context_revision AND c.lease_token=? AND c.ownership_version=? AND ${REMINDER_SEND_ELIGIBILITY_SQL} AND ${CONVERSATION_SEND_ELIGIBILITY_SQL})`)
          .bind(Date.now(), Date.now(), job.id, job.attempt_token, leaseToken, job.ownership_version).run();
      return retried.meta.changes === 1;
    }
    if (!result || result.state === 'delivery_unknown' || result.state === 'retryable_failed') {
      await env.DB.batch([
        env.DB.prepare(`UPDATE outbound_jobs SET status='delivery_unknown',error_code='reconciliation_pending',next_attempt_at=?,updated_at=?
          WHERE id=? AND status IN ('sending','delivery_unknown')`).bind(Date.now() + 30_000, Date.now(), job.id),
        env.DB.prepare(`UPDATE messages SET status='delivery_unknown' WHERE id=? AND EXISTS
          (SELECT 1 FROM outbound_jobs WHERE id=? AND status='delivery_unknown')`).bind(job.message_id, job.id),
      ]);
      return false;
    }
    await recordOutcome(env, job, result, job.attempt_token);
    return true;
  }
  if (job.reminder_eligible === 0) {
    await env.DB.batch([
      env.DB.prepare(`UPDATE outbound_jobs SET status='cancelled',error_code='reminder_changed',updated_at=?
        WHERE id=? AND status IN ('queued','retryable_failed')`).bind(Date.now(), job.id),
      env.DB.prepare(`UPDATE messages SET status=(SELECT status FROM outbound_jobs WHERE id=?) WHERE id=?`).bind(job.id, job.message_id),
      env.DB.prepare(`UPDATE reminder_occurrences SET status='cancelled' WHERE message_id=? AND status='queued'`).bind(job.message_id),
    ]);
    return true;
  }
  if (!canDispatch(conversation, leaseToken, job.ownership_version, job.context_revision, job.operator_user_id !== null || job.support_notice === 1)) {
    await cancelUnsent(env, conversation.id, 'ownership_changed');
    return false;
  }
  if (job.expires_at <= Date.now()) {
    await env.DB.batch([
      env.DB.prepare("UPDATE outbound_jobs SET status='cancelled',error_code='expired',updated_at=? WHERE id=?").bind(Date.now(), job.id),
      env.DB.prepare("UPDATE messages SET status='cancelled' WHERE id=?").bind(job.message_id),
    ]);
    return true;
  }
  if (await paused(env)) return false;
  const reminderPolicy = await env.DB.prepare(`SELECT m.reminder_occurrence_id,u.reminder_timezone,u.quiet_start,u.quiet_end
    FROM messages m JOIN conversations c ON c.id=m.conversation_id JOIN users u ON u.id=c.user_id WHERE m.id=?`)
    .bind(job.message_id).first<{ reminder_occurrence_id: string | null; reminder_timezone: string; quiet_start: string; quiet_end: string }>();
  if (reminderPolicy?.reminder_occurrence_id) {
    const quietUntil = getQuietHoursEnd(Date.now(), reminderPolicy.reminder_timezone, reminderPolicy.quiet_start, reminderPolicy.quiet_end);
    if (quietUntil !== null) {
      await env.DB.prepare(`UPDATE outbound_jobs SET next_attempt_at=?,error_code='quiet_hours',updated_at=?
        WHERE id=? AND status IN ('queued','retryable_failed')`).bind(quietUntil, Date.now(), job.id).run();
      return false;
    }
  }
  const attempt = crypto.randomUUID();
  const claimed = await env.DB.prepare(`UPDATE outbound_jobs SET status='sending',attempt_token=?,attempt_count=attempt_count+1,updated_at=?
    WHERE id=? AND status IN ('queued','retryable_failed') AND EXISTS (SELECT 1 FROM conversations c JOIN users u ON u.id=c.user_id
    JOIN bindings b ON b.conversation_id=c.id AND b.user_id=c.user_id JOIN messages m ON m.id=outbound_jobs.message_id
    WHERE c.id=? AND c.lease_token=? AND c.lease_until>?
    AND c.lease_until>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
    AND c.ownership_version=? AND m.context_revision=? AND m.context_revision=u.context_revision
    AND ${CONVERSATION_SEND_ELIGIBILITY_SQL} AND c.status='active' AND b.status='active' AND u.status='active' AND ${REMINDER_SEND_ELIGIBILITY_SQL})
    AND NOT EXISTS (SELECT 1 FROM system_settings WHERE (key='outbound_paused' AND value!='false' OR key='restore_locked' AND value!='false'))`)
    .bind(attempt, Date.now(), job.id, conversation.id, leaseToken, Date.now(), job.ownership_version, job.context_revision).run();
  if (claimed.meta.changes !== 1) return false;
  const body = await env.DB.prepare('SELECT body_ciphertext FROM messages WHERE id=?').bind(job.message_id).first<{ body_ciphertext: string }>();
  let text: string;
  try {
    if (!body) throw new Error('missing_message');
    text = await decryptText(body.body_ciphertext, env.CONTENT_ENCRYPTION_KEY);
  } catch {
    await recordOutcome(env, { ...job, attempt_count: job.attempt_count + 1 }, { state: 'failed', code: 'content_unavailable' }, attempt);
    return true;
  }
  await beforeDispatch?.();
  // Prepare content first. This final DB snapshot checks ownership, pause and the
  // exact send attempt immediately before invoking transport, with no intervening await.
  const latest = await env.DB.prepare(`SELECT c.*,b.status AS binding_status,u.status AS user_status,u.context_revision,m.context_revision AS message_context_revision,
    CASE WHEN ${REMINDER_SEND_ELIGIBILITY_SQL} AND ${CONVERSATION_SEND_ELIGIBILITY_SQL} THEN 1 ELSE 0 END AS reminder_eligible,
    (SELECT value FROM system_settings WHERE key='outbound_paused') AS paused,o.status AS job_status,o.attempt_token AS job_attempt
    FROM conversations c JOIN bindings b ON b.conversation_id=c.id AND b.user_id=c.user_id
    JOIN users u ON u.id=c.user_id JOIN outbound_jobs o ON o.conversation_id=c.id JOIN messages m ON m.id=o.message_id WHERE c.id=? AND o.id=?`)
    .bind(conversation.id, job.id).first<EligibleConversation & { paused: string | null; job_status: string; job_attempt: string | null; message_context_revision: number; reminder_eligible: number }>();
  const isPaused = latest?.paused !== null && latest?.paused !== undefined && latest.paused !== 'false';
  if (isPaused || !canDispatch(latest, leaseToken, job.ownership_version, job.context_revision, job.operator_user_id !== null || job.support_notice === 1) || latest?.message_context_revision !== job.context_revision
    || latest?.reminder_eligible !== 1 || latest?.job_status !== 'sending' || latest.job_attempt !== attempt) {
    await env.DB.prepare(`UPDATE outbound_jobs SET status=?,attempt_token=NULL,error_code=?,updated_at=?
      WHERE id=? AND attempt_token=? AND status IN ('sending','delivery_unknown')`)
      .bind(isPaused ? 'queued' : 'cancelled', isPaused ? 'globally_paused' : 'ownership_changed', Date.now(), job.id, attempt).run();
    await env.DB.prepare(`UPDATE messages SET status=(SELECT status FROM outbound_jobs WHERE id=?) WHERE id=?`)
      .bind(job.id, job.message_id).run();
    return false;
  }
  let outcome: SendOutcome;
  try {
    outcome = await withTimeout(transport.send({ jobId: job.id, conversationId: conversation.id, idempotencyKey: job.idempotency_key,
      leaseToken, attemptToken: attempt, ownershipVersion: job.ownership_version,
      recipient: { provider: conversation.provider, businessId: conversation.business_id, subjectId: conversation.subject_id },
      channel: conversation.channel, text }), timeoutMs);
  } catch { outcome = { state: 'delivery_unknown', code: 'send_outcome_unknown' }; }
  await recordOutcome(env, { ...job, attempt_count: job.attempt_count + 1 }, outcome, attempt);
  return outcome.state === 'sent' || outcome.state === 'delivered' || outcome.state === 'failed';
}

async function recordOutcome(env: Env, job: OutboundRow, outcome: SendOutcome, attemptToken: string | null): Promise<void> {
  const now = Date.now();
  const status = outcome.state === 'retryable_failed' && job.attempt_count >= 5 ? 'failed' : outcome.state;
  const providerId = 'providerMessageId' in outcome ? outcome.providerMessageId : null;
  const error = 'code' in outcome ? outcome.code.slice(0, 100) : null;
  const next = status === 'delivery_unknown' ? now + 30_000 : now + Math.min(60_000, 1000 * 2 ** job.attempt_count);
  await env.DB.batch([
    env.DB.prepare(`UPDATE outbound_jobs SET status=?,provider_message_id=COALESCE(?,provider_message_id),error_code=?,next_attempt_at=?,updated_at=?
      WHERE id=? AND attempt_token IS ? AND status IN ('sending','delivery_unknown')`)
      .bind(status, providerId, error, next, now, job.id, attemptToken),
    env.DB.prepare(`UPDATE messages SET status=(SELECT status FROM outbound_jobs WHERE id=?),
      provider_message_id=COALESCE((SELECT provider_message_id FROM outbound_jobs WHERE id=?),provider_message_id) WHERE id=?`)
      .bind(job.id, job.id, job.message_id),
    // An earlier receipt may have arrived before the send result supplied its provider ID.
    env.DB.prepare(`UPDATE outbound_jobs SET status=CASE WHEN status='delivered' OR EXISTS
      (SELECT 1 FROM webhook_events e WHERE e.conversation_id=outbound_jobs.conversation_id AND e.provider_message_id=outbound_jobs.provider_message_id
      AND e.event_type='delivery.updated' AND e.delivery_state='delivered') THEN 'delivered' WHEN EXISTS
      (SELECT 1 FROM webhook_events e WHERE e.conversation_id=outbound_jobs.conversation_id AND e.provider_message_id=outbound_jobs.provider_message_id
      AND e.event_type='delivery.updated' AND e.delivery_state='failed') THEN 'failed' WHEN status IN ('sending','delivery_unknown','retryable_failed') AND EXISTS
      (SELECT 1 FROM webhook_events e WHERE e.conversation_id=outbound_jobs.conversation_id AND e.provider_message_id=outbound_jobs.provider_message_id
      AND e.event_type='delivery.updated' AND e.delivery_state='sent') THEN 'sent' ELSE status END,updated_at=? WHERE id=?`)
      .bind(now, job.id),
    env.DB.prepare('UPDATE messages SET status=(SELECT status FROM outbound_jobs WHERE id=?) WHERE id=?').bind(job.id, job.message_id),
    env.DB.prepare(`UPDATE reminder_occurrences SET status='delivered' WHERE message_id=?
      AND EXISTS (SELECT 1 FROM outbound_jobs WHERE id=? AND status='delivered')`).bind(job.message_id, job.id),
    env.DB.prepare(`UPDATE reminders SET status='completed' WHERE next_run_at IS NULL AND status='active'
      AND json_extract(schedule_json,'$.kind')='once' AND id IN (SELECT reminder_id FROM reminder_occurrences
      WHERE message_id=? AND status='delivered' AND reminder_version=reminders.version)`).bind(job.message_id),
  ]);
}

/** Queue jobs are wakeups, not the only record of accepted work. Safe to run repeatedly. */
export async function recoverPending(env: Env): Promise<number> {
  assertLocalProviders(env);
  if (await paused(env)) return 0;
  await enqueueDueReminders(env);
  const rows = await env.DB.prepare(`SELECT DISTINCT c.id FROM conversations c WHERE c.lease_until<=? AND (
    EXISTS (SELECT 1 FROM inbox i WHERE i.conversation_id=c.id AND i.status IN ('pending','processing')) OR
    EXISTS (SELECT 1 FROM outbound_jobs o JOIN messages m ON m.id=o.message_id JOIN users u ON u.id=c.user_id
    WHERE o.conversation_id=c.id AND o.status IN ('queued','sending','retryable_failed','delivery_unknown')
    AND (m.context_revision=u.context_revision OR o.status NOT IN ('sending','delivery_unknown'))
        AND (o.ownership_version=c.ownership_version OR o.status NOT IN ('sending','delivery_unknown'))
    AND ((${REMINDER_SEND_ELIGIBILITY_SQL} AND ${CONVERSATION_SEND_ELIGIBILITY_SQL}) OR o.status NOT IN ('sending','delivery_unknown'))
    AND o.next_attempt_at<=?)) ORDER BY c.last_activity_at LIMIT 50`).bind(Date.now(), Date.now()).all<{ id: string }>();
  const wakeups = await Promise.allSettled(rows.results.map((row) => env.JOBS.send({ kind: 'conversation', conversationId: row.id })));
  return wakeups.filter((result) => result.status === 'fulfilled').length;
}
