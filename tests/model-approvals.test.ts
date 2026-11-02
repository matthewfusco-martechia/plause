import { describe, expect, it, vi } from 'vitest';
import { ingestEvent, processConversation } from '../apps/api/src/pipeline';
import { actionStatements, listActionsForUser, modelProposalStatements, prepareActionCommand, prepareModelProposal } from '../apps/api/src/action-store';
import { listRemindersForUser } from '../apps/api/src/reminder-store';
import { getConversationView, getWebConversation, resolveBinding } from '../apps/api/src/store';
import type { ModelProposal } from '../packages/agent-core/src/model-proposals';
import type { Env, MessagingEvent, ModelRequest, QueueJob } from '../packages/contracts/src/index';
import { decryptText, encryptText, sha256 } from '../packages/security/src/index';
import { testEnv } from './setup';

const runtime = (): Env => ({ ...testEnv, JOBS: { send: async (_job: QueueJob) => {} } as unknown as Queue<QueueJob> });
const input = (text: string, subjectId = 'mock-alex'): Extract<MessagingEvent, { type: 'message.received' }> => ({
  schemaVersion: 1, type: 'message.received', eventId: crypto.randomUUID(), messageId: crypto.randomUUID(),
  subject: { provider: 'mock', businessId: 'plause-local', subjectId }, channel: 'mock', occurredAt: new Date().toISOString(), text,
});
const reminderProposal = (): ModelProposal => ({ type: 'reminder.create', instruction: 'Call the fictional project team.',
  schedule: { kind: 'once', at: Date.now() + 3_600_000 } });
async function send(env: Env, text: string, subjectId = 'mock-alex') {
  const accepted = await ingestEvent(env, input(text, subjectId));
  await processConversation(env, accepted.conversationId);
  return accepted;
}
async function propose(env: Env, proposal: ModelProposal = reminderProposal()) {
  const event = input('Please draft this requested task for review.');
  const accepted = await ingestEvent(env, event);
  const model = { generate: vi.fn(async (_request: ModelRequest) => ({ text: 'I already executed everything without asking.',
    proposal, inputTokens: 1, outputTokens: 1 })) };
  await processConversation(env, accepted.conversationId, { model });
  const state = await listActionsForUser(env, 'u_alex');
  const approval = state.approvals.find((item) => item.state === 'pending');
  return { ...accepted, event, model, approval };
}

describe('exact approval of model-proposed local writes', () => {
  it.each([
    { kind: 'once', at: Date.now() + 3_600_000 },
    { kind: 'daily', time: '09:00', timeZone: 'America/New_York' },
    { kind: 'weekly', weekday: 1, time: '10:30', timeZone: 'Europe/London' },
  ] as const)('stores only a pending encrypted proposal, then creates exactly one approved %j reminder', async (schedule) => {
    const env = runtime();
    const proposal: ModelProposal = { type: 'reminder.create', instruction: 'An explicit fictional task.', schedule };
    const prepared = await propose(env, proposal);
    expect(prepared.approval).toMatchObject({ toolName: 'reminder.create', arguments: { instruction: proposal.instruction, schedule } });
    expect((await listRemindersForUser(env, 'u_alex')).reminders).toHaveLength(0);
    expect((await listRemindersForUser(env, 'u_alex')).enabled).toBe(false);
    const stored = await env.DB.prepare('SELECT * FROM action_approvals WHERE id=?').bind(prepared.approval!.id)
      .first<{ args_ciphertext: string; args_hash: string; expires_at: number; created_at: number; actions_revision: number; reminders_revision: number; context_revision: number }>();
    expect(stored!.args_ciphertext).toMatch(/^v1:/);
    expect(stored!.args_ciphertext).not.toContain(proposal.instruction);
    expect(stored!.args_hash).toBe(await sha256(JSON.stringify({ instruction: proposal.instruction, schedule })));
    expect(stored!.expires_at - stored!.created_at).toBeGreaterThan(590_000);
    expect(stored!.expires_at - stored!.created_at).toBeLessThanOrEqual(600_000);
    expect(stored).toMatchObject({ actions_revision: 1, reminders_revision: 0, context_revision: 0 });
    const review = (await getConversationView(env, 'u_alex', prepared.conversationId))!.messages.find((item) => item.role === 'assistant')!;
    expect(review.text).toContain(prepared.approval!.id);
    expect(review.text).toContain('nothing has been created');
    expect(review.text).toContain('account-wide reminder notifications on');
    expect(review.text).not.toContain('I already executed');
    expect(review.status).toBe('delivered');

    const approvalEvent = input(`approve ${prepared.approval!.id}`);
    await ingestEvent(env, approvalEvent);
    await processConversation(env, prepared.conversationId);
    await ingestEvent(env, approvalEvent);
    await ingestEvent(env, { ...approvalEvent, eventId: crypto.randomUUID() });
    await send(env, `approve ${prepared.approval!.id}`);
    const reminders = await listRemindersForUser(env, 'u_alex');
    expect(reminders.enabled).toBe(true);
    expect(reminders.reminders).toHaveLength(1);
    expect(reminders.reminders[0]).toMatchObject({ instruction: proposal.instruction, schedule, status: 'active' });
    expect(await env.DB.prepare('SELECT approval_id FROM reminders WHERE id=?').bind(reminders.reminders[0]!.id).first())
      .toEqual({ approval_id: prepared.approval!.id });
    expect((await listActionsForUser(env, 'u_alex')).approvals[0]!.state).toBe('approved');
    expect(prepared.model.generate).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('requires the exact ID in the same user and conversation; a bare yes creates nothing', async () => {
    const env = runtime();
    const prepared = await propose(env);
    await send(env, 'yes');
    await send(env, `approve ${prepared.approval!.id}`, 'mock-sam');
    const web = await getWebConversation(env, 'u_alex');
    const plan = await prepareActionCommand(env, 'u_alex', web, { type: 'approve', id: prepared.approval!.id });
    expect(plan.mutation).toBe(false);
    expect(plan.replyText).toContain('unavailable in this conversation');
    expect((await listRemindersForUser(env, 'u_alex')).reminders).toHaveLength(0);
    expect((await listRemindersForUser(env, 'u_sam')).reminders).toHaveLength(0);
    expect((await listActionsForUser(env, 'u_alex')).approvals[0]!.state).toBe('pending');
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['reject', 'expired', 'tampered'] as const)('does not execute a %s approval and keeps rejection usable without decryption', async (condition) => {
    const env = runtime();
    const prepared = await propose(env);
    if (condition === 'expired') await env.DB.prepare('UPDATE action_approvals SET expires_at=? WHERE id=?')
      .bind(Date.now() - 1000, prepared.approval!.id).run();
    if (condition === 'tampered') await env.DB.prepare('UPDATE action_approvals SET args_ciphertext=? WHERE id=?')
      .bind(await encryptText(JSON.stringify({ instruction: 'Substituted task.', schedule: { kind: 'once', at: Date.now() + 3_600_000 } }), env.CONTENT_ENCRYPTION_KEY), prepared.approval!.id).run();
    await send(env, `${condition === 'reject' ? 'reject' : 'approve'} ${prepared.approval!.id}`);
    expect((await listRemindersForUser(env, 'u_alex')).reminders).toHaveLength(0);
    if (condition === 'tampered') await send(env, `reject ${prepared.approval!.id}`);
    expect(await env.DB.prepare('SELECT state FROM action_approvals WHERE id=?').bind(prepared.approval!.id).first())
      .toEqual({ state: condition === 'expired' ? 'expired' : 'rejected' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['privacy', 'notifications', 'actions'] as const)('revokes a pending model approval after a %s change', async (change) => {
    const env = runtime();
    if (change === 'notifications') await send(env, 'reminder notifications on');
    const prepared = await propose(env);
    await send(env, change === 'privacy' ? 'disable memory' : change === 'notifications' ? 'reminder notifications off' : 'connect demo calendar');
    expect((await listActionsForUser(env, 'u_alex')).approvals[0]!.state).toBe('revoked');
    await send(env, `approve ${prepared.approval!.id}`);
    expect((await listRemindersForUser(env, 'u_alex')).reminders).toHaveLength(0);
    expect(await env.DB.prepare('SELECT state FROM action_approvals WHERE id=?').bind(prepared.approval!.id).first()).toEqual({ state: 'revoked' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rechecks reminder revision after approval preparation and records an honest failed commit', async () => {
    const env = runtime();
    const prepared = await propose(env);
    const plan = await prepareActionCommand(env, 'u_alex', prepared.conversationId, { type: 'approve', id: prepared.approval!.id });
    const messageId = `msg_${crypto.randomUUID()}`;
    const replyId = `msg_${crypto.randomUUID()}`;
    const body = await encryptText(`approve ${prepared.approval!.id}`, env.CONTENT_ENCRYPTION_KEY);
    const statements = await actionStatements(env, plan, { messageId, conversationId: prepared.conversationId, replyId,
      eventGate: '1=1', eventGateBindings: [], now: Date.now() });
    await env.DB.prepare('UPDATE users SET reminders_revision=reminders_revision+1 WHERE id=?').bind('u_alex').run();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO messages(id,conversation_id,role,body_ciphertext,status,created_at,is_memory_control,context_revision)
        VALUES (?,?,'user',?,'received',?,1,0)`).bind(messageId, prepared.conversationId, body, Date.now()), ...statements,
    ]);
    expect((await listRemindersForUser(env, 'u_alex')).reminders).toHaveLength(0);
    const reply = await env.DB.prepare('SELECT body_ciphertext FROM messages WHERE id=?').bind(replyId).first<{ body_ciphertext: string }>();
    expect(await decryptText(reply!.body_ciphertext, env.CONTENT_ENCRYPTION_KEY)).toContain('could not be applied');
    expect(await env.DB.prepare('SELECT state FROM action_approvals WHERE id=?').bind(prepared.approval!.id).first()).toEqual({ state: 'pending' });
  });

  it('keeps explicit reminder commands immediate and records approvals locally during human handoff', async () => {
    const env = runtime();
    await send(env, 'remind me in 5 minutes: Explicit deterministic task.');
    expect((await listRemindersForUser(env, 'u_alex')).reminders).toHaveLength(1);
    const prepared = await propose(env);
    const handoff: MessagingEvent = { schemaVersion: 1, type: 'handoff.requested', eventId: crypto.randomUUID(),
      subject: { provider: 'mock', businessId: 'plause-local', subjectId: 'mock-alex' }, channel: 'mock', occurredAt: new Date().toISOString() };
    await ingestEvent(env, handoff);
    await send(env, `approve ${prepared.approval!.id}`);
    expect((await listRemindersForUser(env, 'u_alex')).reminders).toHaveLength(2);
    const rows = await env.DB.prepare("SELECT status FROM messages WHERE model='plause-actions' ORDER BY rowid DESC LIMIT 1").first();
    expect(rows).toEqual({ status: 'local_only' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('requires a connected simulated calendar and creates its model-proposed event only on exact approval', async () => {
    const env = runtime();
    const proposal: ModelProposal = { type: 'calendar.create', title: 'Fictional project meeting',
      startsAt: new Date(Date.now() + 86_400_000).toISOString(), durationMinutes: 30 };
    const disconnected = await propose(env, proposal);
    expect(disconnected.approval).toBeUndefined();
    expect((await getConversationView(env, 'u_alex', disconnected.conversationId))!.messages.some((item) => item.text.includes('not connected'))).toBe(true);
    await send(env, 'connect demo calendar');
    const prepared = await propose(env, proposal);
    expect(prepared.approval).toMatchObject({ toolName: 'calendar.create', arguments: { title: proposal.title } });
    expect((await listActionsForUser(env, 'u_alex')).events).toHaveLength(0);
    await send(env, `approve ${prepared.approval!.id}`);
    const listed = await listActionsForUser(env, 'u_alex');
    expect(listed.events).toHaveLength(1);
    expect(listed.events[0]).toMatchObject({ title: proposal.title, startsAt: proposal.startsAt, durationMinutes: proposal.durationMinutes, simulated: true });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['actions_revision', 'reminders_revision'] as const)('does not publish an approval review if %s changes before model commit', async (column) => {
    const env = runtime();
    const accepted = await ingestEvent(env, input('Please draft a task.'));
    const model = { generate: vi.fn(async () => ({ text: 'Incorrect completion claim.', proposal: reminderProposal(), inputTokens: 1, outputTokens: 1 })) };
    await processConversation(env, accepted.conversationId, { model, beforeModelCommit: async () => {
      await env.DB.prepare(`UPDATE users SET ${column}=${column}+1 WHERE id='u_alex'`).run();
    } });
    expect((await listActionsForUser(env, 'u_alex')).approvals).toHaveLength(0);
    expect((await getConversationView(env, 'u_alex', accepted.conversationId))!.messages.filter((item) => item.role === 'assistant')).toHaveLength(0);
    expect((await listRemindersForUser(env, 'u_alex')).reminders).toHaveLength(0);
  });

  it('replaces a review with deterministic failure text when the helper cannot materialize its approval', async () => {
    const env = runtime();
    const conversation = await resolveBinding(env, { provider: 'mock', businessId: 'plause-local', subjectId: 'mock-alex' }, 'mock');
    const plan = await prepareModelProposal(env, 'u_alex', conversation.id, reminderProposal());
    const sourceMessageId = `msg_${crypto.randomUUID()}`;
    const replyId = `msg_${crypto.randomUUID()}`;
    const leaseToken = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare('UPDATE conversations SET lease_token=?,lease_until=? WHERE id=?').bind(leaseToken, Date.now() + 60_000, conversation.id),
      env.DB.prepare(`INSERT INTO messages(id,conversation_id,role,body_ciphertext,status,created_at,context_revision,is_memory_control)
        VALUES (?,?,'user',?,'processing',?,0,0)`).bind(sourceMessageId, conversation.id, await encryptText('Draft my reminder.', env.CONTENT_ENCRYPTION_KEY), Date.now()),
      env.DB.prepare(`INSERT INTO messages(id,conversation_id,in_reply_to_message_id,role,body_ciphertext,status,created_at,context_revision,is_memory_control)
        VALUES (?,?,?,'assistant',?,'queued',?,0,1)`).bind(replyId, conversation.id, sourceMessageId, await encryptText(plan.replyText, env.CONTENT_ENCRYPTION_KEY), Date.now()),
    ]);
    const statements = await modelProposalStatements(env, plan, { sourceMessageId, replyId, leaseToken, ownershipVersion: 0, contextRevision: 0, now: Date.now() });
    await env.DB.prepare("UPDATE users SET reminders_revision=reminders_revision+1 WHERE id='u_alex'").run();
    await env.DB.batch(statements);
    const saved = await env.DB.prepare('SELECT body_ciphertext FROM messages WHERE id=?').bind(replyId).first<{ body_ciphertext: string }>();
    const reply = await decryptText(saved!.body_ciphertext, env.CONTENT_ENCRYPTION_KEY);
    expect(reply).toContain('proposal could not be saved');
    expect(reply).not.toContain('approve approval_');
    expect((await listActionsForUser(env, 'u_alex')).approvals).toHaveLength(0);
    expect((await listRemindersForUser(env, 'u_alex')).reminders).toHaveLength(0);
  });
});
