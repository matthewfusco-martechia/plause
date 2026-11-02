import { assertOperational } from './runtime-operations';
import type { Env } from '../../../packages/contracts/src/index';
import { MAX_REMINDERS, REMINDER_HELP, type ReminderCommand } from '../../../packages/agent-core/src/reminder-commands';
import { getQuietHoursEnd, isValidTimeZone, isValidWallTime, nextOccurrence, type ReminderSchedule } from '../../../packages/scheduling/src/index';
import { decryptText, encryptText } from '../../../packages/security/src/index';
import { PipelineError } from './store';
import { assertRuntimeProviders, proactiveChannelAllowed } from '../../../packages/contracts/src/runtime-policy';

const DAY = 86_400_000;
const DEFER = 60_000;
interface Preferences {
  reminders_revision: number; reminders_enabled: number; reminder_timezone: string; quiet_start: string; quiet_end: string;
}
interface ReminderRow {
  id: string; user_id: string; conversation_id: string; instruction_ciphertext: string; schedule_json: string;
  next_run_at: number | null; status: 'active' | 'paused' | 'cancelled' | 'completed'; version: number; created_at: number; updated_at: number;
}
interface Settings { enabled: boolean; timeZone: string; quietStart: string; quietEnd: string }
export interface ReminderPlan {
  userId: string; conversationId: string; expectedRevision: number; replyText: string; mutation: boolean;
  command: ReminderCommand; reminderId?: string; ciphertext?: string; scheduleJson?: string; nextRunAt?: number;
  settings?: Settings; invalidatePending?: boolean;
  rescheduledTasks?: { id: string; version: number; nextRunAt: number | null }[];
}

async function preferences(env: Env, userId: string): Promise<Preferences> {
  const row = await env.DB.prepare(`SELECT reminders_revision,reminders_enabled,reminder_timezone,quiet_start,quiet_end
    FROM users WHERE id=? AND status='active'`).bind(userId).first<Preferences>();
  if (!row) throw new PipelineError('Account unavailable.', 403, 'account_unavailable');
  return row;
}

function parseSchedule(json: string): ReminderSchedule {
  try {
    const schedule = JSON.parse(json) as ReminderSchedule;
    if (!schedule || typeof schedule !== 'object' || !['once', 'daily', 'weekly'].includes(schedule.kind)) throw new Error('invalid');
    if (schedule.kind === 'once') {
      if (!Number.isSafeInteger(schedule.at) || schedule.at < 0) throw new Error('invalid');
    } else {
      if (!isValidWallTime(schedule.time) || !isValidTimeZone(schedule.timeZone)) throw new Error('invalid');
      if (schedule.kind === 'weekly' && (!Number.isInteger(schedule.weekday) || schedule.weekday < 0 || schedule.weekday > 6)) throw new Error('invalid');
    }
    return schedule;
  } catch { throw new PipelineError('Reminder schedule unavailable.', 503, 'reminder_schedule_invalid'); }
}

function safeNext(schedule: ReminderSchedule, now: number): number | null {
  const result = nextOccurrence(parseSchedule(JSON.stringify(schedule)), now);
  if (result !== null && (!Number.isSafeInteger(result) || result <= now)) throw new PipelineError('Reminder schedule unavailable.', 503, 'reminder_schedule_invalid');
  return result;
}

/** Metadata-only settings are safe for parser defaults and privacy controls. */
export async function reminderPreferencesForUser(env: Env, userId: string) {
  const state = await preferences(env, userId);
  return { enabled: state.reminders_enabled === 1, revision: state.reminders_revision, timeZone: state.reminder_timezone,
    quietStart: state.quiet_start, quietEnd: state.quiet_end };
}

export async function listRemindersForUser(env: Env, userId: string) {
  const state = await reminderPreferencesForUser(env, userId);
  const rows = await env.DB.prepare('SELECT * FROM reminders WHERE user_id=? ORDER BY created_at DESC,id LIMIT 100')
    .bind(userId).all<ReminderRow>();
  const reminders = await Promise.all(rows.results.map(async (row) => {
    const instruction = await decryptText(row.instruction_ciphertext, env.CONTENT_ENCRYPTION_KEY);
    if (!instruction.trim() || instruction.length > 300) throw new PipelineError('Reminder unavailable.', 503, 'reminder_invalid');
    return { id: row.id, conversationId: row.conversation_id, instruction, schedule: parseSchedule(row.schedule_json),
      nextRunAt: row.next_run_at, status: row.status, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at };
  }));
  await assertOperational(env);
  if ((await preferences(env, userId)).reminders_revision !== state.revision) throw new PipelineError('Reminders changed. Please retry.', 409, 'reminder_conflict');
  return { ...state, reminders };
}

export async function prepareReminderCommand(env: Env, userId: string, conversationId: string, command: ReminderCommand): Promise<ReminderPlan> {
  const state = await preferences(env, userId);
  const owner = await env.DB.prepare(`SELECT c.id,c.channel,b.proactive_consent_at FROM conversations c JOIN bindings b ON b.conversation_id=c.id
    AND b.user_id=c.user_id AND b.provider=c.provider AND b.business_id=c.business_id AND b.subject_id=c.subject_id
    WHERE c.id=? AND c.user_id=? AND b.status='active'`).bind(conversationId, userId).first<{ id: string; channel: string; proactive_consent_at: number | null }>();
  if (!owner) throw new PipelineError('Conversation unavailable.', 404, 'conversation_not_found');
  const plan: ReminderPlan = { userId, conversationId, expectedRevision: state.reminders_revision, command, mutation: false, replyText: REMINDER_HELP };
  const now = Date.now();
  if (command.type === 'invalid') { plan.replyText = command.reason; return plan; }
  if (command.type === 'help') return plan;
  if (command.type === 'list') {
    const list = await listRemindersForUser(env, userId);
    if (list.revision !== plan.expectedRevision) throw new PipelineError('Reminders changed. Please retry.', 409, 'reminder_conflict');
    const live = list.reminders.filter((reminder) => reminder.status === 'active' || reminder.status === 'paused').slice(0, MAX_REMINDERS);
    plan.replyText = `Reminder notifications are ${list.enabled ? 'on' : 'off'}. Quiet hours: ${list.quietStart}–${list.quietEnd} ${list.timeZone}.\n${live.length
      ? live.map((reminder) => `${reminder.id}: ${reminder.status}; ${reminder.nextRunAt === null ? 'awaiting outcome' : new Date(reminder.nextRunAt).toISOString()}; ${reminder.instruction.slice(0, 65)}`).join('\n')
      : 'No active or paused reminders.'}\nUse reminder help for controls.`;
    return plan;
  }
  if (command.type === 'create') {
    if (!proactiveChannelAllowed(env, owner.channel) || owner.channel === 'apple_business' && !owner.proactive_consent_at) {
      plan.replyText = 'Proactive reminders are unavailable on this channel. Create the reminder in your signed-in Plause web conversation, or enable the supported channel and its separate reminder consent first.';
      return plan;
    }
    if (typeof command.instruction !== 'string' || !command.instruction.trim() || command.instruction.length > 300) {
      plan.replyText = 'Use a reminder instruction of 1–300 characters.'; return plan;
    }
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM reminders WHERE user_id=? AND status IN ('active','paused')")
      .bind(userId).first<{ n: number }>();
    if ((count?.n ?? 0) >= MAX_REMINDERS) { plan.replyText = `You have reached the ${MAX_REMINDERS}-reminder limit. Cancel a reminder before adding another.`; return plan; }
    const next = safeNext(command.schedule, now);
    if (next === null) { plan.replyText = 'Choose a future time for this reminder.'; return plan; }
    plan.mutation = true; plan.reminderId = `rem_${crypto.randomUUID()}`;
    plan.ciphertext = await encryptText(command.instruction.trim(), env.CONTENT_ENCRYPTION_KEY);
    plan.scheduleJson = JSON.stringify(command.schedule); plan.nextRunAt = next;
    plan.replyText = `Created ${plan.reminderId}. Next scheduled time: ${new Date(next).toISOString()}. Reminder notifications are on; quiet hours and channel availability may delay delivery.`;
    return plan;
  }
  if (command.type === 'settings') {
    const settings: Settings = { enabled: command.notifications ?? state.reminders_enabled === 1,
      timeZone: command.timeZone ?? state.reminder_timezone, quietStart: command.quietStart ?? state.quiet_start, quietEnd: command.quietEnd ?? state.quiet_end };
    try {
      if (!isValidTimeZone(settings.timeZone) || ![settings.quietStart, settings.quietEnd].every(isValidWallTime)) throw new Error('invalid');
    } catch { plan.replyText = 'Use a supported IANA time zone and quiet hours in HH:MM format.'; return plan; }
    const changed = settings.enabled !== (state.reminders_enabled === 1) || settings.timeZone !== state.reminder_timezone || settings.quietStart !== state.quiet_start || settings.quietEnd !== state.quiet_end;
    if (!changed) { plan.replyText = 'Those reminder settings are already selected.'; return plan; }
    plan.mutation = true; plan.settings = settings;
    plan.invalidatePending = !settings.enabled || settings.timeZone !== state.reminder_timezone || settings.quietStart !== state.quiet_start || settings.quietEnd !== state.quiet_end;
    if (plan.invalidatePending) {
      const tasks = await env.DB.prepare("SELECT * FROM reminders WHERE user_id=? AND status='active' LIMIT ?").bind(userId, MAX_REMINDERS).all<ReminderRow>();
      plan.rescheduledTasks = tasks.results.map((task) => {
        let nextRunAt: number | null = null;
        try { nextRunAt = safeNext(parseSchedule(task.schedule_json), now); }
        catch { /* A corrupt task must not prevent notifications-off or safe settings changes. */ }
        return { id: task.id, version: task.version, nextRunAt };
      });
    }
    plan.replyText = `Reminder notifications are ${settings.enabled ? 'on' : 'off'}. Quiet hours: ${settings.quietStart}–${settings.quietEnd} ${settings.timeZone}.${plan.invalidatePending
      ? ' Older pending reminder notices were cancelled. Recurring tasks keep their next future time; a past one-time reminder needs rescheduling.' : ''}`;
    return plan;
  }
  const target = await env.DB.prepare('SELECT * FROM reminders WHERE id=? AND user_id=?').bind(command.id, userId).first<ReminderRow>();
  if (!target) { plan.replyText = 'That reminder is unavailable. Say reminders to see your tasks.'; return plan; }
  plan.reminderId = target.id;
  if (command.type === 'cancel') {
    if (target.status === 'cancelled') { plan.replyText = 'That reminder is already cancelled.'; return plan; }
    plan.mutation = true; plan.replyText = `Cancelled ${target.id}. Pending notices were suppressed; an already delivered message cannot be recalled.`;
  } else if (command.type === 'pause') {
    if (target.status !== 'active') { plan.replyText = 'Only an active reminder can be paused.'; return plan; }
    plan.mutation = true; plan.replyText = `Paused ${target.id}. Pending notices were suppressed.`;
  } else {
    if (command.type === 'resume' && target.status !== 'paused') { plan.replyText = 'Only a paused reminder can be resumed. Use reschedule for a new future time.'; return plan; }
    const schedule = command.type === 'reschedule' ? command.schedule : parseSchedule(target.schedule_json);
    const next = safeNext(schedule, now);
    if (next === null) { plan.replyText = 'That one-time reminder is in the past. Reschedule it to a future time.'; return plan; }
    plan.mutation = true; plan.scheduleJson = JSON.stringify(schedule); plan.nextRunAt = next;
    plan.replyText = `${command.type === 'resume' ? 'Resumed' : 'Rescheduled'} ${target.id}. Next scheduled time: ${new Date(next).toISOString()}.`;
  }
  return plan;
}

interface CommitContext { messageId: string; conversationId: string; replyId: string; eventGate: string; eventGateBindings: (string | number)[]; now: number }

function cancellationStatements(env: Env, userId: string, reminderId: string | null, gate: string, gateValues: (string | number)[], now: number): D1PreparedStatement[] {
  const target = 'ro.user_id=? AND (? IS NULL OR ro.reminder_id=?)';
  const values = [userId, reminderId, reminderId];
  return [
    env.DB.prepare(`UPDATE messages SET status=CASE WHEN EXISTS (SELECT 1 FROM outbound_jobs sending_job
      WHERE sending_job.message_id=messages.id AND sending_job.status='sending') THEN 'delivery_unknown' ELSE 'cancelled' END
      WHERE id IN (SELECT ro.message_id FROM reminder_occurrences ro WHERE ${target} AND ro.status IN ('queued','deferred'))
      AND status IN ('queued','retryable_failed','sending') AND ${gate}`).bind(...values, ...gateValues),
    env.DB.prepare(`UPDATE outbound_jobs SET status=CASE WHEN status='sending' THEN 'delivery_unknown' ELSE 'cancelled' END,
      error_code='reminder_changed',updated_at=? WHERE message_id IN (SELECT ro.message_id FROM reminder_occurrences ro
      WHERE ${target} AND ro.status IN ('queued','deferred')) AND status IN ('queued','retryable_failed','sending') AND ${gate}`)
      .bind(now, ...values, ...gateValues),
    env.DB.prepare(`UPDATE reminder_occurrences AS ro SET status='cancelled' WHERE ${target} AND status IN ('queued','deferred') AND ${gate}`)
      .bind(...values, ...gateValues),
  ];
}

/** All statements join the ingress transaction; only a newly accepted logical command can apply them. */
export async function reminderStatements(env: Env, plan: ReminderPlan, context: CommitContext): Promise<D1PreparedStatement[]> {
  const { messageId, conversationId, replyId, now } = context;
  const gate = `EXISTS (SELECT 1 FROM messages WHERE id=? AND conversation_id=? AND is_memory_control=1) AND ${context.eventGate}`;
  const values = [messageId, conversationId, ...context.eventGateBindings];
  const statements: D1PreparedStatement[] = [];
  if (plan.mutation) {
    const command = plan.command;
    if (command.type === 'create') {
      statements.push(env.DB.prepare(`INSERT INTO reminders(id,user_id,conversation_id,instruction_ciphertext,schedule_json,next_run_at,status,version,created_at,updated_at)
        SELECT ?,?,?,?,?,?,'active',1,?,? WHERE ${gate}`)
        .bind(plan.reminderId!, plan.userId, plan.conversationId, plan.ciphertext!, plan.scheduleJson!, plan.nextRunAt!, now, now, ...values));
    } else if (command.type === 'settings') {
      for (const task of plan.rescheduledTasks ?? []) statements.push(env.DB.prepare(`UPDATE reminders SET version=version+1,next_run_at=?,
        status=CASE WHEN ? IS NULL THEN 'paused' ELSE status END,updated_at=? WHERE id=? AND user_id=? AND version=? AND status='active' AND ${gate}`)
        .bind(task.nextRunAt, task.nextRunAt, now, task.id, plan.userId, task.version, ...values));
      if (plan.invalidatePending) statements.push(...cancellationStatements(env, plan.userId, null, gate, values, now));
    } else {
      if (command.type === 'cancel' || command.type === 'pause') statements.push(env.DB.prepare(`UPDATE reminders SET status=?,version=version+1,
        next_run_at=CASE WHEN ?='cancelled' THEN NULL ELSE next_run_at END,updated_at=? WHERE id=? AND user_id=? AND ${gate}`)
        .bind(command.type === 'cancel' ? 'cancelled' : 'paused', command.type === 'cancel' ? 'cancelled' : 'paused', now, plan.reminderId!, plan.userId, ...values));
      else if (command.type === 'resume' || command.type === 'reschedule') statements.push(env.DB.prepare(`UPDATE reminders SET status='active',version=version+1,
        schedule_json=?,next_run_at=?,updated_at=? WHERE id=? AND user_id=? AND ${gate}`)
        .bind(plan.scheduleJson!, plan.nextRunAt!, now, plan.reminderId!, plan.userId, ...values));
      statements.push(...cancellationStatements(env, plan.userId, plan.reminderId!, gate, values, now));
    }
    statements.push(env.DB.prepare(`UPDATE users SET reminders_revision=reminders_revision+1,
      reminders_enabled=CASE WHEN ?='create' THEN 1 WHEN ?='settings' THEN ? ELSE reminders_enabled END,
      reminder_timezone=CASE WHEN ?='settings' THEN ? ELSE reminder_timezone END,
      quiet_start=CASE WHEN ?='settings' THEN ? ELSE quiet_start END,quiet_end=CASE WHEN ?='settings' THEN ? ELSE quiet_end END
      WHERE id=? AND reminders_revision=? AND ${gate}`)
      .bind(command.type, command.type, plan.settings?.enabled ? 1 : 0, command.type, plan.settings?.timeZone ?? '',
        command.type, plan.settings?.quietStart ?? '', command.type, plan.settings?.quietEnd ?? '', plan.userId, plan.expectedRevision, ...values));
  }
  const reply = await encryptText(plan.replyText, env.CONTENT_ENCRYPTION_KEY);
  statements.push(
    env.DB.prepare(`INSERT INTO messages(id,conversation_id,in_reply_to_message_id,role,body_ciphertext,status,created_at,model,context_revision,is_memory_control)
      SELECT ?,c.id,?,'assistant',?,CASE WHEN c.mode='bot' AND c.status='active' THEN 'queued' ELSE 'local_only' END,?,'plause-reminder-control',u.context_revision,1
      FROM conversations c JOIN users u ON u.id=c.user_id WHERE c.id=? AND u.status='active' AND ${gate} ON CONFLICT DO NOTHING`)
      .bind(replyId, messageId, reply, now, conversationId, ...values),
    env.DB.prepare(`INSERT INTO outbound_jobs(id,conversation_id,message_id,idempotency_key,status,ownership_version,next_attempt_at,created_at,updated_at,expires_at)
      SELECT ?,c.id,m.id,?,'queued',c.ownership_version,?,?,?,? FROM messages m JOIN conversations c ON c.id=m.conversation_id
      WHERE m.id=? AND m.status='queued' AND ${gate}`)
      .bind(`out_${crypto.randomUUID()}`, `reply:${messageId}`, now, now, now, now + DAY, replyId, ...values),
    env.DB.prepare(`UPDATE inbox SET status='completed',completed_at=?,last_error=NULL WHERE message_id=? AND ${gate}`).bind(now, messageId, ...values),
    env.DB.prepare(`UPDATE messages SET status='processed' WHERE id=? AND ${gate}`).bind(messageId, ...values),
    env.DB.prepare(`INSERT INTO audit_events(id,actor_user_id,conversation_id,action,outcome,created_at)
      SELECT ?,?,?,'reminder.'||?,'acknowledged',? WHERE ${gate}`).bind(crypto.randomUUID(), plan.userId, conversationId, plan.command.type, now, ...values),
  );
  return statements;
}

/** Reconciliation records outcomes; it never retries or sends a notification. */
export async function reconcileReminderOccurrences(env: Env, now = Date.now()): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`UPDATE reminder_occurrences SET status='delivered' WHERE id IN
      (SELECT ro.id FROM reminder_occurrences ro JOIN outbound_jobs o ON o.message_id=ro.message_id
      WHERE ro.status='queued' AND o.status='delivered' LIMIT 100)`),
    env.DB.prepare(`UPDATE reminders SET status='completed',updated_at=? WHERE status='active' AND json_extract(schedule_json,'$.kind')='once'
      AND EXISTS (SELECT 1 FROM reminder_occurrences ro WHERE ro.reminder_id=reminders.id AND ro.reminder_version=reminders.version AND ro.status='delivered')`).bind(now),
    env.DB.prepare(`UPDATE reminder_occurrences SET status='cancelled' WHERE id IN
      (SELECT ro.id FROM reminder_occurrences ro JOIN outbound_jobs o ON o.message_id=ro.message_id
      WHERE ro.status='queued' AND o.status IN ('failed','cancelled') LIMIT 100)`),
    env.DB.prepare(`UPDATE reminders SET status='paused',updated_at=? WHERE status='active' AND next_run_at IS NULL
      AND json_extract(schedule_json,'$.kind')='once' AND EXISTS
      (SELECT 1 FROM reminder_occurrences ro WHERE ro.reminder_id=reminders.id AND ro.reminder_version=reminders.version AND ro.status='cancelled')`).bind(now),
  ]);
}

interface DueRow extends ReminderRow, Preferences {
  user_status: string; binding_status: string; channel: string; provider: string; conversation_status: string; mode: string;
  ownership_version: number; context_revision: number;
  provider_control: string; proactive_consent_at: number | null;
}
interface OccurrenceRow { id: string; scheduled_for: number; status: string; message_id: string | null }

function schedulingGate(env: Env): string { return `EXISTS (SELECT 1 FROM reminders r JOIN users u ON u.id=r.user_id JOIN conversations c ON c.id=r.conversation_id
  JOIN bindings b ON b.conversation_id=c.id AND b.user_id=u.id WHERE r.id=? AND r.version=? AND r.status='active' AND r.next_run_at=?
  AND u.reminders_revision=? AND u.status='active' AND c.user_id=u.id AND b.status='active' AND b.channel=c.channel
  AND b.provider=c.provider AND b.business_id=c.business_id AND b.subject_id=c.subject_id AND c.status='active' AND c.mode='bot'
  AND c.provider_control='bot' AND u.reminders_enabled=1 AND ((c.channel='web' AND c.provider='web')
    OR (c.channel='mock' AND c.provider='mock' AND ${proactiveChannelAllowed(env, 'mock') ? '1' : '0'})
    OR (c.channel='apple_business' AND c.provider='sunshine' AND b.proactive_consent_at IS NOT NULL
      AND ${proactiveChannelAllowed(env, 'apple_business') ? '1' : '0'}))
  AND NOT EXISTS (SELECT 1 FROM system_settings WHERE (key='outbound_paused' AND value!='false' OR key='restore_locked' AND value!='false')))`; }

/** A bounded durable scan, safe after restart and under concurrent scheduler invocations. */
export async function enqueueDueReminders(env: Env, now = Date.now()): Promise<number> {
  try { assertRuntimeProviders(env); } catch { return 0; }
  if (!Number.isSafeInteger(now) || now < 0) return 0;
  const scheduleGate = schedulingGate(env);
  await reconcileReminderOccurrences(env, now);
  if ((await env.DB.prepare("SELECT value FROM system_settings WHERE key='outbound_paused'").first<{ value: string }>())?.value === 'true') return 0;
  const due = await env.DB.prepare(`SELECT r.*,u.reminders_revision,u.reminders_enabled,u.reminder_timezone,u.quiet_start,u.quiet_end,u.context_revision,
    u.status AS user_status,b.status AS binding_status,c.channel,c.provider,c.status AS conversation_status,c.mode,c.ownership_version,
    c.provider_control,b.proactive_consent_at
    FROM reminders r JOIN users u ON u.id=r.user_id JOIN conversations c ON c.id=r.conversation_id
    JOIN bindings b ON b.conversation_id=c.id AND b.user_id=r.user_id AND b.provider=c.provider
      AND b.business_id=c.business_id AND b.subject_id=c.subject_id AND b.channel=c.channel
    WHERE r.status='active' AND r.next_run_at<=? ORDER BY r.next_run_at,r.id LIMIT 100`).bind(now).all<DueRow>();
  let queued = 0;
  for (const task of due.results) {
    if (!proactiveChannelAllowed(env, task.channel) || task.channel === 'apple_business' && !task.proactive_consent_at
      || task.user_status !== 'active' || task.binding_status !== 'active' || task.conversation_status !== 'active') {
      await env.DB.prepare("UPDATE reminders SET status='paused',version=version+1,updated_at=? WHERE id=? AND version=? AND next_run_at=?")
        .bind(now, task.id, task.version, task.next_run_at).run();
      continue;
    }
    const deferred = await env.DB.prepare(`SELECT id,scheduled_for,status,message_id FROM reminder_occurrences
      WHERE reminder_id=? AND reminder_version=? AND status='deferred' ORDER BY scheduled_for LIMIT 1`).bind(task.id, task.version).first<OccurrenceRow>();
    const scheduledFor = deferred?.scheduled_for ?? task.next_run_at!;
    let schedule: ReminderSchedule;
    let quietEnd: number | null;
    try { schedule = parseSchedule(task.schedule_json); quietEnd = getQuietHoursEnd(now, task.reminder_timezone, task.quiet_start, task.quiet_end); }
    catch {
      await env.DB.prepare("UPDATE reminders SET status='paused',version=version+1,updated_at=? WHERE id=? AND version=?")
        .bind(now, task.id, task.version).run();
      continue;
    }
    const gateValues = [task.id, task.version, task.next_run_at!, task.reminders_revision];
    if (scheduledFor + DAY <= now) {
      await env.DB.batch([
        env.DB.prepare("UPDATE reminder_occurrences SET status='cancelled' WHERE reminder_id=? AND reminder_version=? AND status='deferred'").bind(task.id, task.version),
        env.DB.prepare(`UPDATE reminders SET next_run_at=?,status=CASE WHEN ?='once' THEN 'paused' ELSE status END,updated_at=?
          WHERE id=? AND version=? AND next_run_at=?`).bind(safeNext(schedule, now), schedule.kind, now, task.id, task.version, task.next_run_at),
      ]);
      continue;
    }
    if (!task.reminders_enabled || task.mode !== 'bot' || task.provider_control !== 'bot' || quietEnd !== null) {
      const occurrenceId = deferred?.id ?? `occ_${crypto.randomUUID()}`;
      const release = quietEnd ?? now + DEFER;
      const deferGate = `EXISTS (SELECT 1 FROM reminders r JOIN users u ON u.id=r.user_id WHERE r.id=? AND r.version=? AND r.status='active'
        AND r.next_run_at=? AND u.reminders_revision=?)`;
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO reminder_occurrences(id,reminder_id,user_id,conversation_id,scheduled_for,reminder_version,status,created_at)
          SELECT ?,?,?,?,?,?,'deferred',? WHERE ${deferGate} ON CONFLICT(reminder_id,scheduled_for) DO NOTHING`)
          .bind(occurrenceId, task.id, task.user_id, task.conversation_id, scheduledFor, task.version, now, ...gateValues),
        env.DB.prepare(`UPDATE reminders SET next_run_at=?,updated_at=? WHERE id=? AND version=? AND next_run_at=? AND EXISTS
          (SELECT 1 FROM reminder_occurrences WHERE id=? AND reminder_version=? AND status='deferred')`)
          .bind(release, now, task.id, task.version, task.next_run_at, occurrenceId, task.version),
      ]);
      continue;
    }
    const pending = await env.DB.prepare("SELECT id FROM reminder_occurrences WHERE reminder_id=? AND reminder_version=? AND status='queued' LIMIT 1")
      .bind(task.id, task.version).first();
    if (pending) {
      await env.DB.prepare('UPDATE reminders SET next_run_at=?,updated_at=? WHERE id=? AND version=? AND next_run_at=?')
        .bind(now + DEFER, now, task.id, task.version, task.next_run_at).run();
      continue;
    }
    let instruction: string;
    try {
      instruction = await decryptText(task.instruction_ciphertext, env.CONTENT_ENCRYPTION_KEY);
      if (!instruction.trim() || instruction.length > 300) throw new Error('invalid');
    } catch {
      await env.DB.prepare("UPDATE reminders SET status='paused',version=version+1,updated_at=? WHERE id=? AND version=?")
        .bind(now, task.id, task.version).run();
      continue;
    }
    const occurrenceId = deferred?.id ?? `occ_${crypto.randomUUID()}`;
    const messageId = `msg_${crypto.randomUUID()}`;
    const enqueueToken = crypto.randomUUID();
    const ciphertext = await encryptText(`Reminder: ${instruction}`, env.CONTENT_ENCRYPTION_KEY);
    const ownedOccurrence = "EXISTS (SELECT 1 FROM reminder_occurrences WHERE id=? AND enqueue_token=? AND status='queued')";
    const statements: D1PreparedStatement[] = [];
    if (deferred) statements.push(env.DB.prepare(`UPDATE reminder_occurrences SET status='queued',enqueue_token=? WHERE id=? AND status='deferred' AND ${scheduleGate}`)
      .bind(enqueueToken, occurrenceId, ...gateValues));
    else statements.push(env.DB.prepare(`INSERT INTO reminder_occurrences(id,reminder_id,user_id,conversation_id,scheduled_for,reminder_version,enqueue_token,status,created_at)
      SELECT ?,?,?,?,?,?,?,'queued',? WHERE ${scheduleGate} ON CONFLICT(reminder_id,scheduled_for) DO NOTHING`)
      .bind(occurrenceId, task.id, task.user_id, task.conversation_id, scheduledFor, task.version, enqueueToken, now, ...gateValues));
    statements.push(
      env.DB.prepare(`INSERT INTO messages(id,conversation_id,role,body_ciphertext,status,created_at,model,context_revision,is_memory_control,reminder_occurrence_id)
        SELECT ?,c.id,'assistant',?,'queued',?,'plause-reminder',u.context_revision,1,? FROM conversations c JOIN users u ON u.id=c.user_id
        WHERE c.id=? AND ${ownedOccurrence}`)
        .bind(messageId, ciphertext, now, occurrenceId, task.conversation_id, occurrenceId, enqueueToken),
      env.DB.prepare(`UPDATE reminder_occurrences SET message_id=? WHERE id=? AND enqueue_token=? AND EXISTS (SELECT 1 FROM messages WHERE id=?)`)
        .bind(messageId, occurrenceId, enqueueToken, messageId),
      env.DB.prepare(`INSERT INTO outbound_jobs(id,conversation_id,message_id,idempotency_key,status,ownership_version,next_attempt_at,created_at,updated_at,expires_at)
        SELECT ?,c.id,m.id,?,'queued',c.ownership_version,?,?,?,? FROM messages m JOIN conversations c ON c.id=m.conversation_id
        WHERE m.id=? AND ${ownedOccurrence}`)
        .bind(`out_${crypto.randomUUID()}`, `reminder:${occurrenceId}`, now, now, now, scheduledFor + DAY, messageId, occurrenceId, enqueueToken),
      env.DB.prepare(`UPDATE reminders SET next_run_at=?,updated_at=? WHERE id=? AND version=? AND next_run_at=? AND ${ownedOccurrence}`)
        .bind(safeNext(schedule, now), now, task.id, task.version, task.next_run_at, occurrenceId, enqueueToken),
    );
    const result = await env.DB.batch(statements);
    if (result[1]?.meta.changes === 1) {
      queued++;
      try { await env.JOBS.send({ kind: 'conversation', conversationId: task.conversation_id }); }
      catch { /* The durable outbox is sufficient for the normal recovery scanner. */ }
    }
  }
  return queued;
}
