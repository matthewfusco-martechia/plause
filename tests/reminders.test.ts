import { afterEach, describe, expect, it, vi } from 'vitest';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../apps/api/src/index';
import { ingestEvent, processConversation } from '../apps/api/src/pipeline';
import { enqueueDueReminders, listRemindersForUser, reconcileReminderOccurrences } from '../apps/api/src/reminder-store';
import { MockMessagingTransport, type MessagingTransport } from '../packages/messaging-mock/src/index';
import type { Env, MessagingEvent, ModelProvider, QueueJob } from '../packages/contracts/src/index';
import { decryptText } from '../packages/security/src/index';
import { inviteAlex, inviteSam, testEnv } from './setup';

const DAY = 86_400_000;
const origin = 'http://localhost';

function clock(at = Math.floor(Date.now() / DAY) * DAY + DAY + 17 * 3_600_000): number {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(at);
  return at;
}
function runtime(): Env {
  return { ...testEnv, JOBS: { send: async (_job: QueueJob) => {} } as unknown as Queue<QueueJob> };
}
function event(text: string, subjectId = 'mock-alex'): Extract<MessagingEvent, { type: 'message.received' }> {
  return { schemaVersion: 1, type: 'message.received', eventId: crypto.randomUUID(), messageId: crypto.randomUUID(),
    subject: { provider: 'mock', businessId: 'plause-local', subjectId }, channel: 'mock', occurredAt: new Date().toISOString(), text };
}
function unusedModel() {
  return { generate: vi.fn(async () => ({ text: 'A reminder control must not call a model.', inputTokens: 1, outputTokens: 1 })) };
}
async function command(env: Env, text: string, subjectId = 'mock-alex', model: ModelProvider = unusedModel()) {
  const accepted = await ingestEvent(env, event(text, subjectId));
  await processConversation(env, accepted.conversationId, { model });
  return accepted;
}
async function call(env: Env, path: string, init: RequestInit = {}) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(origin + path, init) as Request<unknown, IncomingRequestCfProperties>, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
async function session(env: Env, inviteToken: string) {
  const response = await call(env, '/api/session', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ inviteToken }) });
  expect(response.status).toBe(200);
  return response.headers.get('set-cookie')!.split(';')[0]!;
}
async function occurrence(env: Env, reminderId: string) {
  return env.DB.prepare('SELECT * FROM reminder_occurrences WHERE reminder_id=? ORDER BY scheduled_for DESC LIMIT 1').bind(reminderId)
    .first<{ id: string; scheduled_for: number; reminder_version: number; message_id: string | null; status: string }>();
}
async function receipt(env: Env, occurrenceId: string) {
  return env.DB.prepare('SELECT provider_message_id FROM mock_receipts WHERE idempotency_key=?').bind(`reminder:${occurrenceId}`).first();
}

afterEach(() => vi.useRealTimers());

describe('durable reminders through messaging', () => {
  it('creates an encrypted reminder once on replay and durably queues one occurrence after restart and concurrent scans', async () => {
    const now = clock();
    const env = runtime();
    const model = unusedModel();
    await command(env, 'reminder quiet hours 00:00-00:00', 'mock-alex', model);
    const input = event('remind me in 5 minutes: Call my fictional teammate.');
    const accepted = await ingestEvent(env, input);
    const saved = await listRemindersForUser(env, 'u_alex');
    expect(saved.enabled).toBe(true);
    expect(saved.reminders).toHaveLength(1);
    const task = saved.reminders[0]!;
    expect(task).toMatchObject({ instruction: 'Call my fictional teammate.', status: 'active', nextRunAt: now + 300_000 });
    expect(task.id).toMatch(/^rem_[0-9a-f-]{36}$/);
    const row = await env.DB.prepare('SELECT instruction_ciphertext,schedule_json FROM reminders WHERE id=?').bind(task.id)
      .first<{ instruction_ciphertext: string; schedule_json: string }>();
    expect(row!.instruction_ciphertext).toMatch(/^v1:/);
    expect(JSON.stringify(row)).not.toContain('Call my fictional teammate.');
    expect(await decryptText(row!.instruction_ciphertext, env.CONTENT_ENCRYPTION_KEY)).toBe(task.instruction);
    expect((await ingestEvent(env, input)).duplicate).toBe(true);
    expect((await ingestEvent(env, { ...input, eventId: crypto.randomUUID() })).duplicate).toBe(true);
    expect(await listRemindersForUser(env, 'u_alex')).toEqual(saved);
    await processConversation(env, accepted.conversationId, { model });
    expect(await enqueueDueReminders(env, now + 299_999)).toBe(0);
    vi.setSystemTime(now + 300_000);
    const restarted = runtime();
    const scans = await Promise.all([enqueueDueReminders(restarted), enqueueDueReminders(restarted)]);
    expect(scans.reduce((total, queued) => total + queued, 0)).toBe(1);
    const due = await occurrence(env, task.id);
    expect(due).toMatchObject({ scheduled_for: now + 300_000, status: 'queued' });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM reminder_occurrences WHERE reminder_id=?').bind(task.id).first()).toEqual({ n: 1 });
    await processConversation(restarted, accepted.conversationId, { model });
    expect(await receipt(env, due!.id)).not.toBeNull();
    expect((await occurrence(env, task.id))!.status).toBe('delivered');
    expect((await listRemindersForUser(env, 'u_alex')).reminders[0]!.status).toBe('completed');
    expect(await enqueueDueReminders(restarted)).toBe(0);
    expect(model.generate).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('cancels immediately before provider acceptance and does not strand later conversation work', async () => {
    const now = clock();
    const env = runtime();
    await command(env, 'reminder quiet hours 00:00-00:00');
    const accepted = await command(env, 'remind me in 1 minute: A notice that will be cancelled.');
    const task = (await listRemindersForUser(env, 'u_alex')).reminders[0]!;
    vi.setSystemTime(now + 60_000);
    expect(await enqueueDueReminders(env)).toBe(1);
    const due = await occurrence(env, task.id);
    let observedUncertain = false;
    await processConversation(env, accepted.conversationId, { beforeDispatch: async () => {
      await ingestEvent(env, event(`cancel reminder ${task.id}`));
      const pending = await env.DB.prepare('SELECT status FROM messages WHERE id=?').bind(due!.message_id).first<{ status: string }>();
      observedUncertain = pending?.status === 'delivery_unknown';
    } });
    expect(observedUncertain).toBe(true);
    expect(await receipt(env, due!.id)).toBeNull();
    expect((await listRemindersForUser(env, 'u_alex')).reminders[0]!.status).toBe('cancelled');
    const model = { generate: vi.fn(async () => ({ text: 'A new answer after cancellation.', inputTokens: 1, outputTokens: 1 })) };
    await ingestEvent(env, event('Can we continue chatting?'));
    await processConversation(env, accepted.conversationId, { model });
    expect(model.generate).toHaveBeenCalledTimes(1);
  });

  it('rechecks quiet-hour changes inside the transport callback and records uncertain inflight state honestly', async () => {
    const now = clock();
    const env = runtime();
    await command(env, 'reminder quiet hours 00:00-00:00');
    const accepted = await command(env, 'remind me in 1 minute: This must respect changed quiet hours.');
    const task = (await listRemindersForUser(env, 'u_alex')).reminders[0]!;
    vi.setSystemTime(now + 60_000);
    await enqueueDueReminders(env);
    const due = await occurrence(env, task.id);
    const durable = new MockMessagingTransport(env);
    let observedUncertain = false;
    const transport: MessagingTransport = {
      supportsIdempotentRetry: true,
      send: async (request) => {
        if (request.idempotencyKey === `reminder:${due!.id}`) {
          await ingestEvent(env, event('reminder quiet hours 00:00-23:59'));
          const row = await env.DB.prepare('SELECT status FROM messages WHERE id=?').bind(due!.message_id).first<{ status: string }>();
          observedUncertain = row?.status === 'delivery_unknown';
        }
        return durable.send(request);
      },
      reconcile: (key) => durable.reconcile(key),
    };
    await processConversation(env, accepted.conversationId, { transport });
    expect(observedUncertain).toBe(true);
    expect(await receipt(env, due!.id)).toBeNull();
    expect((await occurrence(env, task.id))!.status).toBe('cancelled');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not accept a reminder when quiet hours begin during the transport digest await', async () => {
    const year = new Date().getUTCFullYear() + 2;
    const start = clock(Date.UTC(year, 0, 7, 2, 58, 59));
    const quietStart = Date.UTC(year, 0, 7, 3, 0, 0);
    const env = runtime();
    const accepted = await command(env, 'remind me in 1 minute: Respect the exact quiet boundary.');
    const task = (await listRemindersForUser(env, 'u_alex')).reminders[0]!;
    vi.setSystemTime(start + 60_000);
    expect(await enqueueDueReminders(env)).toBe(1);
    const due = await occurrence(env, task.id);
    const durable = new MockMessagingTransport(env);
    const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
    let crossedBoundary = false;
    const transport: MessagingTransport = {
      send: async (request) => {
        if (request.idempotencyKey !== `reminder:${due!.id}`) return durable.send(request);
        const digest = vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async (algorithm, data) => {
          const result = await originalDigest(algorithm, data);
          vi.setSystemTime(quietStart);
          crossedBoundary = true;
          return result;
        });
        try { return await durable.send(request); }
        finally { digest.mockRestore(); }
      },
      reconcile: (key) => durable.reconcile(key),
    };
    await processConversation(env, accepted.conversationId, { transport });
    expect(crossedBoundary).toBe(true);
    expect(await receipt(env, due!.id)).toBeNull();
    expect((await occurrence(env, task.id))!.status).not.toBe('delivered');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('holds the original occurrence through a DST-changing quiet window and releases it once', async () => {
    const now = clock(Date.parse('2027-03-14T06:58:00Z'));
    const env = runtime();
    await ingestEvent(env, event('remind me in 1 minute: A fictional early-morning task.'));
    const task = (await listRemindersForUser(env, 'u_alex')).reminders[0]!;
    vi.setSystemTime(now + 60_000);
    expect(await enqueueDueReminders(env)).toBe(0);
    const held = await occurrence(env, task.id);
    expect(held).toMatchObject({ scheduled_for: Date.parse('2027-03-14T06:59:00Z'), status: 'deferred', message_id: null });
    expect((await listRemindersForUser(env, 'u_alex')).reminders[0]!.nextRunAt).toBe(Date.parse('2027-03-14T12:00:00Z'));
    expect(await enqueueDueReminders(env)).toBe(0);
    vi.setSystemTime(Date.parse('2027-03-14T12:00:00Z'));
    expect(await enqueueDueReminders(env)).toBe(1);
    expect(await enqueueDueReminders(env)).toBe(0);
    expect(await occurrence(env, task.id)).toMatchObject({ id: held!.id, scheduled_for: held!.scheduled_for, status: 'queued' });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM reminder_occurrences WHERE reminder_id=?').bind(task.id).first()).toEqual({ n: 1 });
  });

  it('continues ordinary chat while an earlier reminder waits for quiet hours to end', async () => {
    const year = new Date().getUTCFullYear() + 2;
    const start = clock(Date.UTC(year, 0, 7, 2, 58, 59));
    const env = runtime();
    const accepted = await command(env, 'remind me in 1 minute: Wait quietly until morning.');
    const task = (await listRemindersForUser(env, 'u_alex')).reminders[0]!;
    vi.setSystemTime(start + 60_000);
    expect(await enqueueDueReminders(env)).toBe(1);
    const due = await occurrence(env, task.id);
    vi.setSystemTime(Date.UTC(year, 0, 7, 3, 0, 0));
    await processConversation(env, accepted.conversationId);
    const held = await env.DB.prepare('SELECT status,next_attempt_at FROM outbound_jobs WHERE message_id=?')
      .bind(due!.message_id).first<{ status: string; next_attempt_at: number }>();
    expect(held).toMatchObject({ status: 'queued', next_attempt_at: Date.UTC(year, 0, 7, 13, 0, 0) });

    const input = event('Can you answer this now?');
    const model = { generate: vi.fn(async () => ({ text: 'Yes, ordinary chat is available during quiet hours.', inputTokens: 1, outputTokens: 1 })) };
    await ingestEvent(env, input);
    await processConversation(env, accepted.conversationId, { model });
    expect(model.generate).toHaveBeenCalledTimes(1);
    expect(await env.DB.prepare(`SELECT reply.status FROM messages reply JOIN messages source ON source.id=reply.in_reply_to_message_id
      WHERE source.provider_message_id=? AND source.conversation_id=? AND reply.role='assistant'`)
      .bind(input.messageId, accepted.conversationId).first()).toEqual({ status: 'delivered' });
    expect(await receipt(env, due!.id)).toBeNull();
    expect((await occurrence(env, task.id))!.status).toBe('queued');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('advances recurrence strictly beyond the current instant and skips a stale outage backlog', async () => {
    clock();
    const env = runtime();
    await command(env, 'reminder quiet hours 00:00-00:00');
    const accepted = await command(env, 'remind me every day at 18:00 UTC: Plan tomorrow.');
    const task = (await listRemindersForUser(env, 'u_alex')).reminders[0]!;
    const late = task.nextRunAt! + 10 * 60_000;
    vi.setSystemTime(late);
    expect(await enqueueDueReminders(env)).toBe(1);
    await processConversation(env, accepted.conversationId);
    const next = (await listRemindersForUser(env, 'u_alex')).reminders[0]!.nextRunAt!;
    expect(next).toBeGreaterThan(late);
    vi.setSystemTime(next + 4 * DAY);
    expect(await enqueueDueReminders(env)).toBe(0);
    expect((await listRemindersForUser(env, 'u_alex')).reminders[0]!.nextRunAt!).toBeGreaterThan(Date.now());
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM reminder_occurrences WHERE reminder_id=?').bind(task.id).first()).toEqual({ n: 1 });
  });

  it('pauses, resumes and reschedules without reviving an older queued occurrence', async () => {
    const now = clock();
    const env = runtime();
    await command(env, 'reminder quiet hours 00:00-00:00');
    await command(env, 'remind me in 5 minutes: A rescheduled task.');
    const task = (await listRemindersForUser(env, 'u_alex')).reminders[0]!;
    await command(env, `pause reminder ${task.id}`);
    expect((await listRemindersForUser(env, 'u_alex')).reminders[0]!.status).toBe('paused');
    expect(await enqueueDueReminders(env, now + 60_000)).toBe(0);
    await command(env, `resume reminder ${task.id}`);
    const rescheduledAt = now + 10 * 60_000;
    await command(env, `reschedule reminder ${task.id} at ${new Date(rescheduledAt).toISOString()}`);
    const updated = (await listRemindersForUser(env, 'u_alex')).reminders[0]!;
    expect(updated.nextRunAt).toBe(rescheduledAt);
    expect(updated.version).toBeGreaterThan(task.version);
    vi.setSystemTime(now + 5 * 60_000);
    expect(await enqueueDueReminders(env)).toBe(0);
    vi.setSystemTime(rescheduledAt);
    expect(await enqueueDueReminders(env)).toBe(1);
  });

  it('turns notifications off atomically, suppresses pending notices and leaves a missed one-shot paused', async () => {
    const now = clock();
    const env = runtime();
    const model = unusedModel();
    await command(env, 'reminder quiet hours 00:00-00:00', 'mock-alex', model);
    const accepted = await command(env, 'remind me in 1 minute: Do not send this while off.', 'mock-alex', model);
    const task = (await listRemindersForUser(env, 'u_alex')).reminders[0]!;
    vi.setSystemTime(now + 60_000);
    await enqueueDueReminders(env);
    const due = await occurrence(env, task.id);
    await command(env, 'reminder notifications off', 'mock-alex', model);
    expect((await listRemindersForUser(env, 'u_alex')).enabled).toBe(false);
    expect((await occurrence(env, task.id))!.status).toBe('cancelled');
    await processConversation(env, accepted.conversationId, { model });
    expect(await receipt(env, due!.id)).toBeNull();
    await command(env, 'reminder notifications on', 'mock-alex', model);
    expect(await enqueueDueReminders(env)).toBe(0);
    expect((await listRemindersForUser(env, 'u_alex')).reminders[0]!.status).toBe('paused');
    expect(model.generate).not.toHaveBeenCalled();
  });

  it.each(['revoked', 'closed', 'inactive', 'apple'])('does not schedule against a %s channel/account', async (condition) => {
    const now = clock();
    const env = runtime();
    await command(env, 'reminder quiet hours 00:00-00:00');
    const accepted = await command(env, 'remind me in 1 minute: An ineligible notification.');
    const task = (await listRemindersForUser(env, 'u_alex')).reminders[0]!;
    if (condition === 'revoked') await env.DB.prepare("UPDATE bindings SET status='revoked' WHERE conversation_id=?").bind(accepted.conversationId).run();
    if (condition === 'closed') await env.DB.prepare("UPDATE conversations SET status='closed' WHERE id=?").bind(accepted.conversationId).run();
    if (condition === 'inactive') await env.DB.prepare("UPDATE users SET status='disabled' WHERE id='u_alex'").run();
    if (condition === 'apple') await env.DB.batch([
      env.DB.prepare("UPDATE conversations SET channel='apple_business' WHERE id=?").bind(accepted.conversationId),
      env.DB.prepare("UPDATE bindings SET channel='apple_business' WHERE conversation_id=?").bind(accepted.conversationId),
    ]);
    vi.setSystemTime(now + 60_000);
    expect(await enqueueDueReminders(env)).toBe(0);
    expect(await occurrence(env, task.id)).toBeNull();
    expect(await env.DB.prepare('SELECT status FROM reminders WHERE id=?').bind(task.id).first()).toEqual({ status: 'paused' });
  });

  it('defers temporary human ownership and global pause without losing a one-time reminder', async () => {
    const now = clock();
    const env = runtime();
    await command(env, 'reminder quiet hours 00:00-00:00');
    const accepted = await command(env, 'remind me in 1 minute: Wait until automated replies resume.');
    const task = (await listRemindersForUser(env, 'u_alex')).reminders[0]!;
    await env.DB.prepare("INSERT INTO system_settings(key,value) VALUES ('outbound_paused','true')").run();
    vi.setSystemTime(now + 60_000);
    expect(await enqueueDueReminders(env)).toBe(0);
    expect(await occurrence(env, task.id)).toBeNull();
    await env.DB.prepare("UPDATE system_settings SET value='false' WHERE key='outbound_paused'").run();
    await env.DB.prepare("UPDATE conversations SET mode='human' WHERE id=?").bind(accepted.conversationId).run();
    expect(await enqueueDueReminders(env)).toBe(0);
    expect((await occurrence(env, task.id))!.status).toBe('deferred');
    await env.DB.prepare("UPDATE conversations SET mode='bot' WHERE id=?").bind(accepted.conversationId).run();
    vi.setSystemTime(now + 120_000);
    expect(await enqueueDueReminders(env)).toBe(1);
  });

  it('never queues a stale one-time reminder after its 24-hour safety window', async () => {
    const now = clock();
    const env = runtime();
    await command(env, 'remind me in 1 minute: A stale task.');
    const task = (await listRemindersForUser(env, 'u_alex')).reminders[0]!;
    vi.setSystemTime(now + DAY + 60_000);
    expect(await enqueueDueReminders(env)).toBe(0);
    expect((await listRemindersForUser(env, 'u_alex')).reminders[0]!.status).toBe('paused');
    expect(await occurrence(env, task.id)).toBeNull();
  });

  it('isolates commands and authenticated lists and cascades reminder data on account deletion', async () => {
    clock();
    const env = runtime();
    await command(env, 'remind me in 5 minutes: Alex fictional task.');
    await command(env, 'remind me in 10 minutes: Sam fictional task.', 'mock-sam');
    const sam = await listRemindersForUser(env, 'u_sam');
    await command(env, `cancel reminder ${sam.reminders[0]!.id}`);
    expect(await listRemindersForUser(env, 'u_sam')).toEqual(sam);
    expect((await call(env, '/api/reminders')).status).toBe(401);
    const alexCookie = await session(env, inviteAlex);
    const samCookie = await session(env, inviteSam);
    const response = await call(env, '/api/reminders?userId=u_alex', { headers: { cookie: samCookie } });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('Sam fictional task.');
    expect(body).not.toContain('Alex fictional task.');
    expect(body).not.toContain('instruction_ciphertext');
    expect((await call(env, '/api/reminders', { headers: { cookie: alexCookie } })).status).toBe(200);
    await env.DB.prepare("DELETE FROM users WHERE id='u_alex'").run();
    await reconcileReminderOccurrences(env);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM reminders WHERE user_id='u_alex'").first()).toEqual({ n: 0 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM reminder_occurrences WHERE user_id='u_alex'").first()).toEqual({ n: 0 });
    expect((await listRemindersForUser(env, 'u_sam')).reminders).toHaveLength(1);
  });
});
