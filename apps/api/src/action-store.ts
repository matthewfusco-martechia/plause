import { assertOperational } from './runtime-operations';
import { BOUND_CHANNEL_ELIGIBILITY_SQL } from '../../../packages/contracts/src/delivery-policy';
import { assertRuntimeProviders, mockMessagingAllowed } from '../../../packages/contracts/src/runtime-policy';
import { z } from 'zod';
import type { Env } from '../../../packages/contracts/src/index';
import { decryptText, encryptText, sha256 } from '../../../packages/security/src/index';
import { ACTION_HELP, APPROVAL_LIFETIME_MS, MAX_CALENDAR_TITLE_CHARACTERS, MAX_DEMO_CALENDAR_EVENTS,
  MAX_EVENT_FUTURE_MS, MAX_PENDING_ACTION_APPROVALS, type ActionCommand } from '../../../packages/agent-core/src/action-commands';
import { parseModelProposal, type ModelProposal } from '../../../packages/agent-core/src/model-proposals';
import { MAX_REMINDERS } from '../../../packages/agent-core/src/reminder-commands';
import { isValidTimeZone, isValidWallTime, nextOccurrence, type ReminderSchedule } from '../../../packages/scheduling/src/index';
import { PipelineError } from './store';
import { prepareReminderCommand } from './reminder-store';

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const dbNow = "CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)";
const thirtyDays = 30 * 24 * 60 * 60 * 1000;
export const calendarCreateArgumentsSchema = z.object({
  title: z.string().min(1).max(MAX_CALENDAR_TITLE_CHARACTERS).refine((value) => value.trim() === value && !/[\x00-\x1f\x7f-\x9f\u2028-\u202e\u2066-\u2069]/.test(value)),
  startsAt: z.string().datetime().refine((value) => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value),
  durationMinutes: z.number().int().min(1).max(480),
}).strict();
type CalendarArguments = z.infer<typeof calendarCreateArgumentsSchema>;
const reminderScheduleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('once'), at: z.number().int().safe().nonnegative() }).strict(),
  z.object({ kind: z.literal('daily'), time: z.string().refine(isValidWallTime), timeZone: z.string().refine(isValidTimeZone) }).strict(),
  z.object({ kind: z.literal('weekly'), weekday: z.number().int().min(0).max(6),
    time: z.string().refine(isValidWallTime), timeZone: z.string().refine(isValidTimeZone) }).strict(),
]);
export const reminderCreateArgumentsSchema = z.object({
  instruction: z.string().min(1).max(300).refine((value) => value.trim() === value && !/[\x00-\x1f\x7f-\x9f\u2028-\u202e\u2066-\u2069]/.test(value)),
  schedule: reminderScheduleSchema,
}).strict();
type ReminderArguments = z.infer<typeof reminderCreateArgumentsSchema>;

/** Fixed write permissions. Model proposals never execute these tools directly. */
export const ACTION_TOOL_DEFINITIONS = Object.freeze({
  'calendar.list': { name: 'calendar.list', sideEffect: 'read', requiredScopes: ['calendar:read'], requiresApproval: false,
    argumentsSchema: z.object({}).strict() },
  'calendar.create': { name: 'calendar.create', sideEffect: 'write', requiredScopes: ['calendar:write'], requiresApproval: true,
    argumentsSchema: calendarCreateArgumentsSchema },
  'calendar.cancel': { name: 'calendar.cancel', sideEffect: 'write', requiredScopes: ['calendar:write'], requiresApproval: false,
    argumentsSchema: z.object({ eventId: z.string().regex(new RegExp(`^event_${uuid}$`)) }).strict() },
  'reminder.create': { name: 'reminder.create', sideEffect: 'write', requiredScopes: ['reminder:write'], requiresApproval: true,
    argumentsSchema: reminderCreateArgumentsSchema },
} as const);

interface ActionState { revision: number; connected: boolean; connectionRevision: number; remindersRevision: number; contextRevision: number }
interface ApprovalRow {
  id: string; user_id: string; conversation_id: string; args_ciphertext: string; args_hash: string;
  connection_revision: number; expires_at: number; state: 'pending' | 'approved' | 'rejected' | 'expired' | 'revoked'; created_at: number;
  tool_name: 'calendar.create' | 'reminder.create'; model_generated: number; actions_revision: number | null;
  reminders_revision: number | null; context_revision: number | null;
}
interface EventRow { id: string; approval_id: string; args_ciphertext: string; starts_at: number; ends_at: number; status: 'scheduled' | 'cancelled'; created_at: number }

export interface ActionPlan {
  userId: string;
  conversationId: string;
  expectedRevision: number;
  replyText: string;
  mutation: boolean;
  command: ActionCommand;
  connectionRevision: number;
  approvalId?: string;
  eventId?: string;
  argsCiphertext?: string;
  argsHash?: string;
  args?: CalendarArguments;
  expiresAt?: number;
  expireApproval?: boolean;
  revokeApproval?: boolean;
  toolName?: 'calendar.create' | 'reminder.create';
  reminderArgs?: ReminderArguments;
  reminderId?: string;
  reminderCiphertext?: string;
  reminderNextRunAt?: number;
  expectedReminderRevision?: number;
  expectedContextRevision?: number;
  pinnedActionRevision?: number;
}

function assertLocal(env: Env): void {
  try { assertRuntimeProviders(env); }
  catch { throw new PipelineError('Actions are unavailable in this runtime.', 503, 'actions_unavailable'); }
}

async function actionState(env: Env, userId: string): Promise<ActionState> {
  assertLocal(env);
  const row = await env.DB.prepare(`SELECT u.actions_revision,u.reminders_revision,u.context_revision,COALESCE(c.connected,0) AS connected,COALESCE(c.revision,0) AS connection_revision
    FROM users u LEFT JOIN demo_calendar_connections c ON c.user_id=u.id WHERE u.id=? AND u.status='active'`)
    .bind(userId).first<{ actions_revision: number; reminders_revision: number; context_revision: number; connected: number; connection_revision: number }>();
  if (!row) throw new PipelineError('Account unavailable.', 403, 'account_unavailable');
  return { revision: row.actions_revision, connected: row.connected === 1, connectionRevision: row.connection_revision,
    remindersRevision: row.reminders_revision, contextRevision: row.context_revision };
}

function canonicalArguments(args: CalendarArguments): string {
  return JSON.stringify({ title: args.title, startsAt: args.startsAt, durationMinutes: args.durationMinutes });
}

function canonicalReminderArguments(args: ReminderArguments): string {
  const schedule: ReminderSchedule = args.schedule.kind === 'once' ? { kind: 'once', at: args.schedule.at }
    : args.schedule.kind === 'daily' ? { kind: 'daily', time: args.schedule.time, timeZone: args.schedule.timeZone }
      : { kind: 'weekly', weekday: args.schedule.weekday, time: args.schedule.time, timeZone: args.schedule.timeZone };
  return JSON.stringify({ instruction: args.instruction, schedule });
}

async function decodeReminderArguments(env: Env, ciphertext: string, hash: string): Promise<ReminderArguments> {
  try {
    const args = reminderCreateArgumentsSchema.parse(JSON.parse(await decryptText(ciphertext, env.CONTENT_ENCRYPTION_KEY)) as unknown);
    if (await sha256(canonicalReminderArguments(args)) !== hash) throw new Error('digest_mismatch');
    return args;
  } catch { throw new PipelineError('Reminder proposal details are unavailable. Reject this approval.', 503, 'action_content_invalid'); }
}

function isStaleApproval(row: ApprovalRow, state: ActionState): boolean {
  return row.model_generated === 1 && (row.actions_revision !== state.revision || row.reminders_revision !== state.remindersRevision
    || row.context_revision !== state.contextRevision);
}

export interface ModelProposalPlan {
  userId: string;
  conversationId: string;
  expectedActionRevision: number;
  expectedReminderRevision: number;
  contextRevision: number;
  replyText: string;
  connectionRevision: number;
  approvalId?: string;
  toolName?: 'calendar.create' | 'reminder.create';
  argsCiphertext?: string;
  argsHash?: string;
  expiresAt?: number;
  nextRunAt?: number;
}

/** Validate a model's suggestion and prepare a review; never create the requested task/event. */
export async function prepareModelProposal(env: Env, userId: string, conversationId: string, value: ModelProposal): Promise<ModelProposalPlan> {
  const state = await actionState(env, userId);
  if (!await env.DB.prepare('SELECT id FROM conversations WHERE id=? AND user_id=?').bind(conversationId, userId).first()) {
    throw new PipelineError('Conversation unavailable.', 404, 'conversation_not_found');
  }
  const plan: ModelProposalPlan = { userId, conversationId, expectedActionRevision: state.revision,
    expectedReminderRevision: state.remindersRevision, contextRevision: state.contextRevision,
    connectionRevision: state.connectionRevision, replyText: 'The proposed action was invalid. Nothing was created. Please give an explicit future time and request a new proposal.' };
  const proposal = parseModelProposal(value);
  if (!proposal) return plan;
  const now = Date.now();
  let canonical: string;
  let details: string;
  if (proposal.type === 'calendar.create') {
    if (!mockMessagingAllowed(env)) { plan.replyText = 'The simulated calendar is available only in development and staging. No approval or event was created.'; return plan; }
    const args = calendarCreateArgumentsSchema.safeParse({ title: proposal.title, startsAt: proposal.startsAt, durationMinutes: proposal.durationMinutes });
    const startsAt = Date.parse(proposal.startsAt);
    if (!args.success || startsAt <= now || startsAt > now + MAX_EVENT_FUTURE_MS) return plan;
    if (!state.connected) {
      plan.replyText = 'The simulated demo calendar is not connected. No event or approval was created. Send connect demo calendar before requesting a proposal. No real calendar is connected.';
      return plan;
    }
    canonical = canonicalArguments(args.data); plan.nextRunAt = startsAt;
    details = `Simulated calendar event proposal; nothing has been created.\nTitle: ${args.data.title}\nStart: ${args.data.startsAt}\nDuration: ${args.data.durationMinutes} minutes`;
  } else if (proposal.type === 'reminder.create') {
    const args = reminderCreateArgumentsSchema.safeParse({ instruction: proposal.instruction, schedule: proposal.schedule });
    if (!args.success) return plan;
    const delivery = await prepareReminderCommand(env, userId, conversationId, { type: 'create', ...args.data });
    if (!delivery.mutation) { plan.replyText = delivery.replyText; return plan; }
    let next: number | null;
    try { next = nextOccurrence(args.data.schedule, now); } catch { return plan; }
    if (next === null) return plan;
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM reminders WHERE user_id=? AND status IN ('active','paused')")
      .bind(userId).first<{ n: number }>();
    if ((count?.n ?? 0) >= MAX_REMINDERS) {
      plan.replyText = 'There are already 20 active or paused reminders. No reminder or approval was created. Cancel one before requesting another proposal.';
      return plan;
    }
    canonical = canonicalReminderArguments(args.data); plan.nextRunAt = next;
    details = `Reminder proposal; nothing has been created.\nInstruction: ${args.data.instruction}\nSchedule: ${JSON.stringify(args.data.schedule)}\nNext scheduled time: ${new Date(next).toISOString()}\nApproval turns account-wide reminder notifications on; quiet hours still apply.${env.MESSAGING_PROVIDER === 'mock' ? ' Delivery is simulated in this local preview.' : ' Delivery depends on the approved channel and your notification consent.'}`;
  } else return plan;
  const pending = await env.DB.prepare("SELECT COUNT(*) AS n FROM action_approvals WHERE user_id=? AND state='pending' AND expires_at>?")
    .bind(userId, now).first<{ n: number }>();
  if ((pending?.n ?? 0) >= MAX_PENDING_ACTION_APPROVALS) {
    plan.replyText = 'There are already 20 pending approvals. Nothing was created. Reject an approval or wait for expiry before requesting another proposal.';
    return plan;
  }
  plan.approvalId = `approval_${crypto.randomUUID()}`; plan.toolName = proposal.type;
  plan.argsCiphertext = await encryptText(canonical, env.CONTENT_ENCRYPTION_KEY); plan.argsHash = await sha256(canonical);
  plan.expiresAt = now + APPROVAL_LIFETIME_MS;
  plan.replyText = `${details}\nApproval: ${plan.approvalId}\nExpires: ${new Date(plan.expiresAt).toISOString()}\nSend approve ${plan.approvalId} to create this exact ${proposal.type === 'reminder.create' ? 'reminder' : 'simulated event'}, or reject ${plan.approvalId}. A bare yes does not approve it.`;
  return plan;
}

/** Append to a fenced assistant INSERT using its existing c/u aliases. */
export function modelProposalCommitGuard(plan: ModelProposalPlan): { sql: string; bindings: (string | number)[] } {
  let sql = `c.id=? AND c.user_id=? AND u.actions_revision=? AND u.reminders_revision=? AND u.context_revision=?`;
  const bindings: (string | number)[] = [plan.conversationId, plan.userId, plan.expectedActionRevision, plan.expectedReminderRevision, plan.contextRevision];
  if (plan.approvalId) {
    sql += ` AND ?>${dbNow} AND ?>${dbNow}
      AND (SELECT COUNT(*) FROM action_approvals WHERE user_id=u.id AND state='pending' AND expires_at>${dbNow})<${MAX_PENDING_ACTION_APPROVALS}`;
    bindings.push(plan.expiresAt!, plan.nextRunAt!);
    if (plan.toolName === 'calendar.create') {
      sql += ' AND EXISTS (SELECT 1 FROM demo_calendar_connections dc WHERE dc.user_id=u.id AND dc.connected=1 AND dc.revision=?)';
      bindings.push(plan.connectionRevision);
    } else sql += ` AND (SELECT COUNT(*) FROM reminders WHERE user_id=u.id AND status IN ('active','paused'))<${MAX_REMINDERS}`;
  }
  return { sql, bindings };
}

export interface ModelProposalCommitContext {
  sourceMessageId: string; replyId: string; leaseToken: string; ownershipVersion: number; contextRevision: number; now: number;
}

/** Join the assistant/outbox/inbox D1 batch. A model suggestion only inserts a pending approval. */
export async function modelProposalStatements(env: Env, plan: ModelProposalPlan, context: ModelProposalCommitContext): Promise<D1PreparedStatement[]> {
  assertLocal(env);
  if (context.contextRevision !== plan.contextRevision) throw new PipelineError('Proposal context changed.', 409, 'actions_conflict');
  if (!plan.approvalId) return [];
  const guard = modelProposalCommitGuard(plan);
  const gate = `EXISTS (SELECT 1 FROM conversations c JOIN users u ON u.id=c.user_id
    JOIN bindings b ON b.conversation_id=c.id AND b.user_id=c.user_id
    JOIN messages sm ON sm.conversation_id=c.id JOIN messages am ON am.conversation_id=c.id
    WHERE ${guard.sql} AND sm.id=? AND sm.role='user' AND sm.is_memory_control=0 AND sm.context_revision=u.context_revision
    AND sm.status='processing' AND am.id=? AND am.role='assistant' AND am.in_reply_to_message_id=sm.id
    AND am.context_revision=u.context_revision AND c.lease_token=? AND c.ownership_version=? AND c.lease_until>${dbNow}
    AND c.mode='bot' AND c.provider_control='bot' AND c.status='active' AND u.status='active' AND b.status='active'
    AND b.provider=c.provider AND b.business_id=c.business_id AND b.subject_id=c.subject_id AND b.channel=c.channel
    AND ${BOUND_CHANNEL_ELIGIBILITY_SQL} AND NOT EXISTS (SELECT 1 FROM system_settings WHERE (key='outbound_paused' AND value!='false' OR key='restore_locked' AND value!='false')))`;
  const gateValues = [...guard.bindings, context.sourceMessageId, context.replyId, context.leaseToken, context.ownershipVersion];
  const fallback = await encryptText('The proposal could not be saved because its context, time, or settings changed. Nothing was created. Please request a new proposal.', env.CONTENT_ENCRYPTION_KEY);
  return [
    env.DB.prepare(`INSERT INTO action_approvals(id,user_id,conversation_id,source_message_id,tool_name,args_ciphertext,args_hash,
      connection_revision,expires_at,state,created_at,model_generated,proposal_message_id,actions_revision,reminders_revision,context_revision)
      SELECT ?,?,?,?,?,?,?,?,?,'pending',?,1,?,?,?,? WHERE ${gate} ON CONFLICT DO NOTHING`)
      .bind(plan.approvalId, plan.userId, plan.conversationId, context.sourceMessageId, plan.toolName!, plan.argsCiphertext!, plan.argsHash!,
        plan.connectionRevision, plan.expiresAt!, context.now, context.replyId, plan.expectedActionRevision + 1, plan.expectedReminderRevision,
        plan.contextRevision, ...gateValues),
    env.DB.prepare(`UPDATE users SET actions_revision=actions_revision+1 WHERE id=? AND actions_revision=? AND EXISTS
      (SELECT 1 FROM action_approvals WHERE id=? AND user_id=users.id AND proposal_message_id=? AND source_message_id=?)`)
      .bind(plan.userId, plan.expectedActionRevision, plan.approvalId, context.replyId, context.sourceMessageId),
    env.DB.prepare(`INSERT INTO audit_events(id,actor_user_id,conversation_id,action,outcome,created_at)
      SELECT ?,?,?,'actions.model_proposal','pending',? WHERE EXISTS
      (SELECT 1 FROM action_approvals WHERE id=? AND proposal_message_id=?)`)
      .bind(crypto.randomUUID(), plan.userId, plan.conversationId, context.now, plan.approvalId, context.replyId),
    env.DB.prepare(`UPDATE messages SET body_ciphertext=? WHERE id=? AND conversation_id=? AND in_reply_to_message_id=? AND role='assistant'
      AND NOT EXISTS (SELECT 1 FROM action_approvals WHERE id=? AND proposal_message_id=messages.id AND user_id=?)`)
      .bind(fallback, context.replyId, plan.conversationId, context.sourceMessageId, plan.approvalId, plan.userId),
  ];
}

async function decodeArguments(env: Env, ciphertext: string, hash?: string): Promise<CalendarArguments> {
  try {
    const args = calendarCreateArgumentsSchema.parse(JSON.parse(await decryptText(ciphertext, env.CONTENT_ENCRYPTION_KEY)) as unknown);
    if (hash !== undefined && await sha256(canonicalArguments(args)) !== hash) throw new Error('digest_mismatch');
    return args;
  } catch { throw new PipelineError('Simulated calendar details are unavailable. Reject the approval or disconnect the demo calendar.', 503, 'action_content_invalid'); }
}

export async function listActionsForUser(env: Env, userId: string) {
  const state = await actionState(env, userId);
  const now = Date.now();
  const [approvalRows, eventRows] = await Promise.all([
    env.DB.prepare(`SELECT * FROM action_approvals WHERE user_id=?
      ORDER BY CASE WHEN state='pending' AND expires_at>? THEN 0 ELSE 1 END,created_at DESC,id LIMIT 20`)
      .bind(userId, now).all<ApprovalRow>(),
    env.DB.prepare(`SELECT * FROM demo_calendar_events WHERE user_id=? AND ends_at>? AND starts_at<?
      ORDER BY CASE WHEN status='scheduled' THEN 0 ELSE 1 END,starts_at,id LIMIT 20`)
      .bind(userId, now, now + thirtyDays).all<EventRow>(),
  ]);
  const approvals = await Promise.all(approvalRows.results.map(async (row) => ({ id: row.id, conversationId: row.conversation_id,
    ...(row.tool_name === 'reminder.create'
      ? { toolName: 'reminder.create' as const, arguments: await decodeReminderArguments(env, row.args_ciphertext, row.args_hash) }
      : { toolName: 'calendar.create' as const, arguments: await decodeArguments(env, row.args_ciphertext, row.args_hash) }),
    argsHash: row.args_hash, expiresAt: row.expires_at, state: row.state === 'pending'
      ? row.expires_at <= now ? 'expired' : isStaleApproval(row, state) ? 'revoked' : row.state : row.state,
    simulated: row.tool_name === 'calendar.create' || env.MESSAGING_PROVIDER === 'mock', createdAt: row.created_at })));
  const events = await Promise.all(eventRows.results.map(async (row) => ({ id: row.id, approvalId: row.approval_id,
    ...await decodeArguments(env, row.args_ciphertext), endsAt: new Date(row.ends_at).toISOString(), status: row.status,
    simulated: true as const, createdAt: row.created_at })));
  await assertOperational(env);
  const current = await actionState(env, userId);
  if (current.revision !== state.revision || current.remindersRevision !== state.remindersRevision || current.contextRevision !== state.contextRevision) {
    throw new PipelineError('Actions changed. Please retry.', 409, 'actions_conflict');
  }
  return { calendar: { connected: state.connected, simulated: true as const }, approvals, events };
}

export async function prepareActionCommand(env: Env, userId: string, conversationId: string, command: ActionCommand): Promise<ActionPlan> {
  const state = await actionState(env, userId);
  if (!await env.DB.prepare('SELECT id FROM conversations WHERE id=? AND user_id=?').bind(conversationId, userId).first()) {
    throw new PipelineError('Conversation unavailable.', 404, 'conversation_not_found');
  }
  const plan: ActionPlan = { userId, conversationId, expectedRevision: state.revision, replyText: ACTION_HELP,
    mutation: false, connectionRevision: state.connectionRevision, command };
  const now = Date.now();
  if (!mockMessagingAllowed(env) && ['connect','disconnect','propose','cancel_event'].includes(command.type)) {
    plan.replyText = 'Simulated calendar changes are unavailable in this runtime. Use the real Google Calendar connection controls.'; return plan;
  }
  if (command.type === 'invalid') plan.replyText = command.reason;
  else if (command.type === 'connect') {
    if (state.connected) plan.replyText = 'The simulated demo calendar is already connected. No real calendar account is connected.';
    else { plan.mutation = true; plan.connectionRevision += 1; plan.replyText = 'Simulated demo calendar connected. No real calendar account or OAuth permission was added.'; }
  } else if (command.type === 'disconnect') {
    plan.mutation = true; plan.connectionRevision += 1;
    plan.replyText = 'Simulated demo calendar disconnected. Pending approvals were revoked and stale writes cannot execute. Existing simulated event records remain.';
  } else if (command.type === 'list_events' || command.type === 'list_approvals') {
    const listed = await listActionsForUser(env, userId);
    if (command.type === 'list_events') {
      plan.replyText = `Simulated calendar (${listed.calendar.connected ? 'connected' : 'disconnected'}), next 30 days:\n${listed.events.length
        ? listed.events.map((event) => `${event.id} | ${event.startsAt} | ${event.durationMinutes} min | ${event.title.slice(0, 60)} | ${event.status}`).join('\n') : 'No simulated events.'}`;
    } else {
      const pending = listed.approvals.filter((approval) => approval.state === 'pending');
      plan.replyText = `Pending local approvals:\n${pending.length ? pending.map((approval) =>
        `${approval.id} | ${approval.toolName} | ${approval.toolName === 'calendar.create'
          ? `${approval.arguments.startsAt} | ${approval.arguments.durationMinutes} min | ${approval.arguments.title.slice(0, 48)}`
          : `${JSON.stringify(approval.arguments.schedule)} | ${approval.arguments.instruction.slice(0, 48)}`} | expires ${new Date(approval.expiresAt).toISOString()}`).join('\n') : 'None.'}\nApprove or reject the exact ID. Review the full original proposal; this list shortens long text.`;
    }
  } else if (command.type === 'propose') {
    const parsed = calendarCreateArgumentsSchema.safeParse({ title: command.title, startsAt: command.startsAt, durationMinutes: command.durationMinutes });
    if (!parsed.success || Date.parse(command.startsAt) <= now || Date.parse(command.startsAt) - now > MAX_EVENT_FUTURE_MS) {
      plan.replyText = 'Use a valid future event within 365 days, a 1–480 minute duration, and a title up to 200 characters. No simulated event was created.';
    } else if (!state.connected) plan.replyText = 'Connect demo calendar before proposing a simulated event. No real calendar is connected.';
    else {
      const pending = await env.DB.prepare("SELECT COUNT(*) AS count FROM action_approvals WHERE user_id=? AND state='pending' AND expires_at>?")
        .bind(userId, now).first<{ count: number }>();
      if ((pending?.count ?? 0) >= MAX_PENDING_ACTION_APPROVALS) plan.replyText = 'There are already 20 pending simulated approvals. Reject or wait for an approval to expire before proposing another.';
      else {
        plan.mutation = true; plan.approvalId = `approval_${crypto.randomUUID()}`; plan.args = parsed.data;
        const canonical = canonicalArguments(parsed.data);
        plan.argsCiphertext = await encryptText(canonical, env.CONTENT_ENCRYPTION_KEY); plan.argsHash = await sha256(canonical);
        plan.expiresAt = now + APPROVAL_LIFETIME_MS;
        plan.replyText = `Simulated event proposal; nothing has been created.\nTitle: ${parsed.data.title}\nStart: ${parsed.data.startsAt}\nDuration: ${parsed.data.durationMinutes} minutes\nApproval: ${plan.approvalId}\nExpires: ${new Date(plan.expiresAt).toISOString()}\nSend approve ${plan.approvalId} to create this exact simulated event, or reject ${plan.approvalId}.`;
      }
    }
  } else if (command.type === 'approve' || command.type === 'reject') {
    const approval = await env.DB.prepare('SELECT * FROM action_approvals WHERE id=? AND user_id=? AND conversation_id=?')
      .bind(command.id, userId, conversationId).first<ApprovalRow>();
    if (approval) plan.toolName = approval.tool_name;
    if (!approval) plan.replyText = 'That approval is unavailable in this conversation. No action was created.';
    else if (approval.state !== 'pending') plan.replyText = `This approval is already ${approval.state}. It cannot execute again.`;
    else if (approval.expires_at <= now) {
      plan.mutation = true; plan.expireApproval = true; plan.approvalId = approval.id;
      plan.replyText = 'This approval expired. No action was created. Propose a new action if needed.';
    } else if (command.type === 'reject') {
      plan.mutation = true; plan.approvalId = approval.id; plan.replyText = 'Approval rejected. No action was created.';
    } else if (isStaleApproval(approval, state)) {
      plan.mutation = true; plan.approvalId = approval.id; plan.revokeApproval = true;
      plan.replyText = 'The account context or action/reminder settings changed. This approval was revoked. Request a new proposal; no action was created.';
    } else if (approval.tool_name === 'reminder.create') {
      let args: ReminderArguments;
      try { args = await decodeReminderArguments(env, approval.args_ciphertext, approval.args_hash); }
      catch { plan.replyText = 'This reminder approval failed its content integrity check. Reject it; no reminder was created.'; return plan; }
      let next: number | null = null;
      try { next = nextOccurrence(args.schedule, now); } catch { /* Invalid schedules cannot execute. */ }
      plan.reminderArgs = args;
      if (next === null) {
        plan.mutation = true; plan.approvalId = approval.id; plan.expireApproval = true;
        plan.replyText = 'The proposed one-time reminder is in the past. This approval expired without creating a reminder.';
      } else {
        const active = await env.DB.prepare("SELECT COUNT(*) AS count FROM reminders WHERE user_id=? AND status IN ('active','paused')")
          .bind(userId).first<{ count: number }>();
        if ((active?.count ?? 0) >= MAX_REMINDERS) plan.replyText = 'There are already 20 active or paused reminders. Cancel one before approving another.';
        else {
          plan.mutation = true; plan.approvalId = approval.id; plan.toolName = 'reminder.create'; plan.reminderArgs = args;
          plan.reminderId = `rem_${crypto.randomUUID()}`; plan.reminderNextRunAt = next;
          plan.reminderCiphertext = await encryptText(args.instruction, env.CONTENT_ENCRYPTION_KEY);
          plan.argsCiphertext = approval.args_ciphertext; plan.argsHash = approval.args_hash;
          plan.expectedReminderRevision = state.remindersRevision; plan.expectedContextRevision = state.contextRevision;
          if (approval.actions_revision !== null) plan.pinnedActionRevision = approval.actions_revision;
          plan.replyText = `Reminder created: ${plan.reminderId}\n${args.instruction}\nSchedule: ${JSON.stringify(args.schedule)}\nNext scheduled time: ${new Date(next).toISOString()}. Reminder notifications are on; quiet hours and channel availability may delay delivery. No real Apple message was sent.`;
        }
      }
    } else if (!state.connected || approval.connection_revision !== state.connectionRevision) {
      plan.replyText = 'The demo connection was revoked or changed. This approval cannot create a simulated event.';
    } else {
      let args: CalendarArguments;
      try { args = await decodeArguments(env, approval.args_ciphertext, approval.args_hash); }
      catch { plan.replyText = 'This simulated approval failed its content integrity check. Reject it or disconnect the demo calendar; no event was created.'; return plan; }
      if (Date.parse(args.startsAt) <= now) {
        plan.mutation = true; plan.expireApproval = true; plan.approvalId = approval.id; plan.args = args;
        plan.replyText = 'The proposed start time has passed. This approval expired without creating a simulated event.';
      } else {
        const active = await env.DB.prepare("SELECT COUNT(*) AS count FROM demo_calendar_events WHERE user_id=? AND status='scheduled' AND ends_at>?")
          .bind(userId, now).first<{ count: number }>();
        if ((active?.count ?? 0) >= MAX_DEMO_CALENDAR_EVENTS) plan.replyText = 'There are already 20 active simulated events. Cancel an event before approving another.';
        else {
          plan.mutation = true; plan.approvalId = approval.id; plan.eventId = `event_${crypto.randomUUID()}`;
          plan.args = args; plan.argsCiphertext = approval.args_ciphertext; plan.argsHash = approval.args_hash;
          if (approval.model_generated === 1) {
            plan.expectedReminderRevision = state.remindersRevision; plan.expectedContextRevision = state.contextRevision;
            if (approval.actions_revision !== null) plan.pinnedActionRevision = approval.actions_revision;
          }
          plan.replyText = `Simulated event created: ${plan.eventId}\n${args.title}\n${args.startsAt}, ${args.durationMinutes} minutes. No real calendar was changed.`;
        }
      }
    }
  } else if (command.type === 'cancel_event') {
    const event = await env.DB.prepare('SELECT id,status FROM demo_calendar_events WHERE id=? AND user_id=?')
      .bind(command.id, userId).first<{ id: string; status: string }>();
    if (!event) plan.replyText = 'That simulated event is unavailable.';
    else if (event.status === 'cancelled') plan.replyText = 'That simulated event is already cancelled.';
    else if (!state.connected) plan.replyText = 'Connect demo calendar before changing a simulated event. No real calendar is connected.';
    else { plan.mutation = true; plan.eventId = event.id; plan.replyText = `Simulated event cancelled: ${event.id}. No real calendar was changed.`; }
  }
  if (plan.replyText.length > 4000) plan.replyText = plan.replyText.slice(0, 3950) + '\nUse the account actions view for the complete bounded list.';
  return plan;
}

export interface ActionCommitContext {
  messageId: string;
  conversationId: string;
  replyId: string;
  eventGate: string;
  eventGateBindings: (string | number)[];
  now: number;
}

/** Join these statements to the caller's ingress transaction after its revision CAS. */
export async function actionStatements(env: Env, plan: ActionPlan, context: ActionCommitContext): Promise<D1PreparedStatement[]> {
  assertLocal(env);
  if (context.conversationId !== plan.conversationId) throw new PipelineError('Action scope unavailable.', 403, 'actions_scope_invalid');
  const { messageId, conversationId, replyId, now } = context;
  const gate = `EXISTS (SELECT 1 FROM messages am JOIN conversations ac ON ac.id=am.conversation_id JOIN users au ON au.id=ac.user_id
    WHERE am.id=? AND am.conversation_id=? AND am.is_memory_control=1 AND ac.user_id=? AND au.status='active') AND (${context.eventGate})`;
  const gateValues = [messageId, conversationId, plan.userId, ...context.eventGateBindings];
  const pinned = plan.expectedReminderRevision !== undefined && plan.expectedContextRevision !== undefined;
  const mutationGate = `${gate} AND EXISTS (SELECT 1 FROM users WHERE id=? AND actions_revision=?${pinned ? ' AND reminders_revision=? AND context_revision=?' : ''})`;
  const mutationValues = [...gateValues, plan.userId, plan.expectedRevision,
    ...(pinned ? [plan.expectedReminderRevision!, plan.expectedContextRevision!] : [])];
  const statements: D1PreparedStatement[] = [];
  let success = '1=1';
  let successValues: (string | number)[] = [];
  const mutation = (sql: string, values: (string | number | null)[]) => env.DB.prepare(sql).bind(...values, ...mutationValues);
  if (plan.mutation) {
    const command = plan.command;
    if (command.type === 'connect' || command.type === 'disconnect') {
      statements.push(mutation(`INSERT INTO demo_calendar_connections(user_id,connected,revision,created_at,updated_at)
        SELECT ?,?,?,?,? WHERE ${mutationGate} ON CONFLICT(user_id) DO UPDATE SET connected=excluded.connected,
        revision=excluded.revision,updated_at=excluded.updated_at`, [plan.userId, command.type === 'connect' ? 1 : 0, plan.connectionRevision, now, now]));
      if (command.type === 'disconnect') statements.push(mutation(`UPDATE action_approvals SET state='revoked',decided_at=?
        WHERE user_id=? AND tool_name='calendar.create' AND state='pending' AND ${mutationGate}`, [now, plan.userId]));
      success = 'EXISTS (SELECT 1 FROM demo_calendar_connections WHERE user_id=? AND connected=? AND revision=?)';
      successValues = [plan.userId, command.type === 'connect' ? 1 : 0, plan.connectionRevision];
    } else if (command.type === 'propose') {
      const startsAt = Date.parse(plan.args!.startsAt);
      statements.push(mutation(`INSERT INTO action_approvals(id,user_id,conversation_id,source_message_id,tool_name,args_ciphertext,args_hash,
        connection_revision,expires_at,state,created_at) SELECT ?,?,?,?,'calendar.create',?,?,?,?,'pending',?
        WHERE EXISTS (SELECT 1 FROM demo_calendar_connections WHERE user_id=? AND connected=1 AND revision=?)
        AND (SELECT COUNT(*) FROM action_approvals WHERE user_id=? AND state='pending' AND expires_at>${dbNow})<20
        AND ?>${dbNow} AND ?>${dbNow} AND ?<=${dbNow}+${MAX_EVENT_FUTURE_MS} AND ${mutationGate}`,
      [plan.approvalId!, plan.userId, conversationId, messageId, plan.argsCiphertext!, plan.argsHash!, plan.connectionRevision, plan.expiresAt!, now,
        plan.userId, plan.connectionRevision, plan.userId, plan.expiresAt!, startsAt, startsAt]));
      success = 'EXISTS (SELECT 1 FROM action_approvals WHERE id=? AND user_id=? AND source_message_id=?)';
      successValues = [plan.approvalId!, plan.userId, messageId];
    } else if (command.type === 'approve' || command.type === 'reject') {
      statements.push(mutation(`UPDATE action_approvals SET state='expired',decided_at=? WHERE id=? AND user_id=? AND conversation_id=?
        AND state='pending' AND expires_at<=${dbNow} AND ${mutationGate}`, [now, plan.approvalId!, plan.userId, conversationId]));
      if (plan.revokeApproval) {
        statements.push(mutation(`UPDATE action_approvals SET state='revoked',decided_at=? WHERE id=? AND user_id=? AND conversation_id=?
          AND state='pending' AND model_generated=1 AND ${mutationGate}`, [now, plan.approvalId!, plan.userId, conversationId]));
        success = "EXISTS (SELECT 1 FROM action_approvals WHERE id=? AND user_id=? AND state='revoked')";
        successValues = [plan.approvalId!, plan.userId];
      } else if (plan.expireApproval) {
        const eventStart = plan.args ? Date.parse(plan.args.startsAt)
          : plan.reminderArgs?.schedule.kind === 'once' ? plan.reminderArgs.schedule.at : Number.MAX_SAFE_INTEGER;
        statements.push(mutation(`UPDATE action_approvals SET state='expired',decided_at=? WHERE id=? AND user_id=? AND conversation_id=?
          AND state='pending' AND (expires_at<=${dbNow} OR ?<=${dbNow}) AND ${mutationGate}`,
        [now, plan.approvalId!, plan.userId, conversationId, eventStart]));
        success = "EXISTS (SELECT 1 FROM action_approvals WHERE id=? AND user_id=? AND state='expired')";
        successValues = [plan.approvalId!, plan.userId];
      } else if (command.type === 'reject') {
        statements.push(mutation(`UPDATE action_approvals SET state='rejected',decided_at=? WHERE id=? AND user_id=? AND conversation_id=?
          AND state='pending' AND expires_at>${dbNow} AND ${mutationGate}`, [now, plan.approvalId!, plan.userId, conversationId]));
        success = "EXISTS (SELECT 1 FROM action_approvals WHERE id=? AND user_id=? AND state='rejected')";
        successValues = [plan.approvalId!, plan.userId];
      } else if (plan.toolName === 'reminder.create') {
        statements.push(mutation(`INSERT INTO reminders(id,user_id,conversation_id,instruction_ciphertext,schedule_json,next_run_at,
          status,version,created_at,updated_at,approval_id)
          SELECT ?,a.user_id,a.conversation_id,?,?,?,'active',1,?,?,a.id FROM action_approvals a JOIN users ru ON ru.id=a.user_id
          WHERE a.id=? AND a.user_id=? AND a.conversation_id=? AND a.state='pending' AND a.expires_at>${dbNow}
          AND a.tool_name='reminder.create' AND a.model_generated=1 AND a.args_hash=? AND a.args_ciphertext=?
          AND a.actions_revision=ru.actions_revision AND a.reminders_revision=ru.reminders_revision AND a.context_revision=ru.context_revision
          AND ?>${dbNow} AND (SELECT COUNT(*) FROM reminders WHERE user_id=a.user_id AND status IN ('active','paused'))<${MAX_REMINDERS}
          AND ${mutationGate} ON CONFLICT(approval_id) WHERE approval_id IS NOT NULL DO NOTHING`,
        [plan.reminderId!, plan.reminderCiphertext!, JSON.stringify(plan.reminderArgs!.schedule), plan.reminderNextRunAt!, now, now,
          plan.approvalId!, plan.userId, conversationId, plan.argsHash!, plan.argsCiphertext!, plan.reminderNextRunAt!]));
        statements.push(mutation(`UPDATE action_approvals SET state='approved',decided_at=? WHERE id=? AND user_id=? AND conversation_id=? AND state='pending'
          AND EXISTS (SELECT 1 FROM reminders WHERE id=? AND approval_id=? AND user_id=?) AND ${mutationGate}`,
        [now, plan.approvalId!, plan.userId, conversationId, plan.reminderId!, plan.approvalId!, plan.userId]));
        statements.push(mutation(`UPDATE users SET reminders_revision=reminders_revision+1,reminders_enabled=1 WHERE id=?
          AND EXISTS (SELECT 1 FROM reminders r JOIN action_approvals a ON a.id=r.approval_id
            WHERE r.id=? AND r.user_id=users.id AND a.id=? AND a.state='approved') AND ${mutationGate}`,
        [plan.userId, plan.reminderId!, plan.approvalId!]));
        success = "EXISTS (SELECT 1 FROM reminders r JOIN action_approvals aa ON aa.id=r.approval_id WHERE r.id=? AND aa.id=? AND r.user_id=? AND aa.state='approved')";
        successValues = [plan.reminderId!, plan.approvalId!, plan.userId];
      } else {
        const startsAt = Date.parse(plan.args!.startsAt);
        const endsAt = startsAt + plan.args!.durationMinutes * 60_000;
        statements.push(mutation(`INSERT INTO demo_calendar_events(id,user_id,approval_id,args_ciphertext,starts_at,ends_at,status,simulated,created_at,updated_at)
          SELECT ?,a.user_id,a.id,a.args_ciphertext,?,?,'scheduled',1,?,? FROM action_approvals a JOIN demo_calendar_connections dc ON dc.user_id=a.user_id
          WHERE a.id=? AND a.user_id=? AND a.conversation_id=? AND a.state='pending' AND a.expires_at>${dbNow}
          AND a.tool_name='calendar.create' AND a.args_hash=? AND a.args_ciphertext=? AND dc.connected=1
          AND dc.revision=a.connection_revision AND dc.revision=? AND ?>${dbNow}
          AND (SELECT COUNT(*) FROM demo_calendar_events WHERE user_id=? AND status='scheduled' AND ends_at>${dbNow})<20
          AND ${mutationGate} ON CONFLICT(approval_id) DO NOTHING`,
        [plan.eventId!, startsAt, endsAt, now, now, plan.approvalId!, plan.userId, conversationId, plan.argsHash!, plan.argsCiphertext!,
          plan.connectionRevision, startsAt, plan.userId]));
        statements.push(mutation(`UPDATE action_approvals SET state='approved',decided_at=? WHERE id=? AND user_id=? AND conversation_id=? AND state='pending'
          AND EXISTS (SELECT 1 FROM demo_calendar_events WHERE id=? AND approval_id=? AND user_id=?) AND ${mutationGate}`,
        [now, plan.approvalId!, plan.userId, conversationId, plan.eventId!, plan.approvalId!, plan.userId]));
        success = "EXISTS (SELECT 1 FROM demo_calendar_events de JOIN action_approvals aa ON aa.id=de.approval_id WHERE de.id=? AND aa.id=? AND de.user_id=? AND aa.state='approved')";
        successValues = [plan.eventId!, plan.approvalId!, plan.userId];
      }
    } else if (command.type === 'cancel_event') {
      statements.push(mutation(`UPDATE demo_calendar_events SET status='cancelled',updated_at=? WHERE id=? AND user_id=? AND status='scheduled'
        AND EXISTS (SELECT 1 FROM demo_calendar_connections WHERE user_id=? AND connected=1 AND revision=?) AND ${mutationGate}`,
      [now, plan.eventId!, plan.userId, plan.userId, plan.connectionRevision]));
      success = "EXISTS (SELECT 1 FROM demo_calendar_events WHERE id=? AND user_id=? AND status='cancelled')";
      successValues = [plan.eventId!, plan.userId];
    }
    // Reminder execution advances its reminder revision above. The source/expected
    // action revision still fence this final action increment in the same batch.
    statements.push(env.DB.prepare(`UPDATE users SET actions_revision=actions_revision+1 WHERE id=? AND actions_revision=? AND ${gate}`)
      .bind(plan.userId, plan.expectedRevision, ...gateValues));
  }
  const reply = await encryptText(plan.replyText, env.CONTENT_ENCRYPTION_KEY);
  const failed = await encryptText('The action could not be applied because its approval, context, settings, time, or capacity changed. No new action was confirmed. Check approvals and your tasks before retrying.', env.CONTENT_ENCRYPTION_KEY);
  statements.push(
    env.DB.prepare(`INSERT INTO messages(id,conversation_id,in_reply_to_message_id,role,body_ciphertext,status,created_at,model,context_revision,is_memory_control)
      SELECT ?,c.id,?,'assistant',CASE WHEN ${success} THEN ? ELSE ? END,CASE WHEN c.mode='bot' AND c.provider_control='bot' AND c.status='active' THEN 'queued' ELSE 'local_only' END,
      ?,'plause-actions',u.context_revision,1 FROM conversations c JOIN users u ON u.id=c.user_id WHERE c.id=? AND ${gate} ON CONFLICT DO NOTHING`)
      .bind(replyId, messageId, ...successValues, reply, failed, now, conversationId, ...gateValues),
    env.DB.prepare(`INSERT INTO outbound_jobs(id,conversation_id,message_id,idempotency_key,status,ownership_version,next_attempt_at,created_at,updated_at,expires_at)
      SELECT ?,c.id,m.id,?,'queued',c.ownership_version,?,?,?,? FROM messages m JOIN conversations c ON c.id=m.conversation_id
      WHERE m.id=? AND m.status='queued' AND ${gate}`)
      .bind(`out_${crypto.randomUUID()}`, `reply:${messageId}`, now, now, now, now + 86_400_000, replyId, ...gateValues),
    env.DB.prepare(`UPDATE inbox SET status='completed',completed_at=?,last_error=NULL WHERE message_id=? AND ${gate}`).bind(now, messageId, ...gateValues),
    env.DB.prepare(`UPDATE messages SET status='processed' WHERE id=? AND ${gate}`).bind(messageId, ...gateValues),
    env.DB.prepare(`INSERT INTO audit_events(id,actor_user_id,conversation_id,action,outcome,created_at)
      SELECT ?,?,?,'actions.'||?,CASE WHEN ${success} THEN 'acknowledged' ELSE 'not_applied' END,? WHERE ${gate}`)
      .bind(crypto.randomUUID(), plan.userId, conversationId, plan.command.type, ...successValues, now, ...gateValues),
  );
  return statements;
}
