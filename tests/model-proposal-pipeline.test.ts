import { describe, expect, it, vi } from 'vitest';
import { ingestEvent, processConversation } from '../apps/api/src/pipeline';
import { getConversationView } from '../apps/api/src/store';
import { listActionsForUser } from '../apps/api/src/action-store';
import { listRemindersForUser } from '../apps/api/src/reminder-store';
import type { Env, MessagingEvent, ModelProvider, QueueJob } from '../packages/contracts/src/index';
import type { ModelProposal } from '../packages/agent-core/src/model-proposals';
import { testEnv } from './setup';

function runtime(): Env {
  return { ...testEnv, APP_ENV: 'local', MODEL_PROVIDER: 'openai', MESSAGING_PROVIDER: 'mock',
    LIVE_MODEL_ENABLED: 'true', OPENAI_API_KEY: 'sk-fixture-no-network',
    JOBS: { send: async (_job: QueueJob) => {} } as unknown as Queue<QueueJob> };
}
function inbound(text: string, subjectId = 'mock-alex'): MessagingEvent {
  return { schemaVersion: 1, type: 'message.received', eventId: crypto.randomUUID(), messageId: crypto.randomUUID(),
    subject: { provider: 'mock', businessId: 'plause-local', subjectId },
    channel: 'mock', occurredAt: new Date().toISOString(), text };
}
function fixture(proposal: ModelProposal) {
  return { generate: vi.fn<ModelProvider['generate']>(async () => ({ text: 'I created everything already.',
    proposal, inputTokens: 150, outputTokens: 50, model: 'gpt-6-luna', responseId: 'resp_proposal_fixture' })) };
}
async function command(env: Env, text: string, subjectId = 'mock-alex') {
  const accepted = await ingestEvent(env, inbound(text, subjectId));
  await processConversation(env, accepted.conversationId);
  return accepted.conversationId;
}

describe('natural-language drafts through the durable conversation processor', () => {
  it('shows exact server review and only creates a reminder after its bound approval', async () => {
    const env = runtime();
    const at = Date.now() + 3_600_000;
    const model = fixture({ type: 'reminder.create', instruction: 'Check the fictional oven', schedule: { kind: 'once', at } });
    const event = inbound('Could you remind me to check the oven in an hour?');
    const accepted = await ingestEvent(env, event);
    await processConversation(env, accepted.conversationId, { model });
    const actions = await listActionsForUser(env, 'u_alex');
    expect(actions.approvals).toHaveLength(1);
    const approval = actions.approvals[0]!;
    expect(approval).toMatchObject({ toolName: 'reminder.create', state: 'pending',
      arguments: { instruction: 'Check the fictional oven', schedule: { kind: 'once', at } } });
    expect((await listRemindersForUser(env, 'u_alex')).reminders).toHaveLength(0);
    const view = await getConversationView(env, 'u_alex', accepted.conversationId);
    const reply = view!.messages.find((message) => message.role === 'assistant')!;
    expect(reply.text).toContain(`approve ${approval.id}`);
    expect(reply.text).toContain(new Date(at).toISOString());
    expect(reply.text).not.toContain('I created everything already');
    expect(reply.status).toBe('delivered');
    const request = model.generate.mock.calls[0]![0];
    expect(request.planningContext?.timeZone).toBe('America/New_York');
    expect(request.planningContext?.now).toBeGreaterThan(0);
    // Ordinary affirmations cannot consume an approval at trusted ingress.
    await ingestEvent(env, inbound('yes'));
    expect((await listRemindersForUser(env, 'u_alex')).reminders).toHaveLength(0);
    const approveEvent = inbound(`approve ${approval.id}`);
    await ingestEvent(env, approveEvent);
    await ingestEvent(env, approveEvent);
    expect((await listRemindersForUser(env, 'u_alex')).reminders).toHaveLength(1);
    expect((await listRemindersForUser(env, 'u_alex')).enabled).toBe(true);
    expect(model.generate).toHaveBeenCalledTimes(1);
  });

  it('recovers an interrupted proposal commit from encrypted cache without generating twice', async () => {
    const env = runtime();
    const model = fixture({ type: 'reminder.create', instruction: 'Fictional recovery',
      schedule: { kind: 'daily', time: '09:30', timeZone: 'America/New_York' } });
    const accepted = await ingestEvent(env, inbound('Remind me each day at 9:30 New York time.'));
    await processConversation(env, accepted.conversationId, { model, beforeModelCommit: async () => { throw new Error('interrupted'); } });
    expect((await listActionsForUser(env, 'u_alex')).approvals).toHaveLength(0);
    await processConversation(env, accepted.conversationId, { model });
    await processConversation(env, accepted.conversationId, { model });
    expect(await env.DB.prepare('SELECT status,last_error FROM inbox').all()).toMatchObject({ results: [{ status: 'completed', last_error: null }] });
    expect((await getConversationView(env, 'u_alex', accepted.conversationId))!.messages.filter((item) => item.role === 'assistant').map((item) => item.text)).toEqual([expect.stringContaining('Send approve approval_')]);
    expect((await listActionsForUser(env, 'u_alex')).approvals).toHaveLength(1);
    expect(model.generate).toHaveBeenCalledTimes(1);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM usage_ledgers').first()).toEqual({ n: 1 });
  });

  it('fences stale proposal persistence and reuses the paid draft under the new settings', async () => {
    const env = runtime();
    const model = fixture({ type: 'reminder.create', instruction: 'Fictional settings race',
      schedule: { kind: 'once', at: Date.now() + 3_600_000 } });
    const accepted = await ingestEvent(env, inbound('Please remind me later.'));
    await processConversation(env, accepted.conversationId, { model, beforeModelCommit: async () => {
      await env.DB.prepare('UPDATE users SET reminders_revision=reminders_revision+1 WHERE id=?').bind('u_alex').run();
    } });
    expect((await listActionsForUser(env, 'u_alex')).approvals).toHaveLength(0);
    await processConversation(env, accepted.conversationId, { model });
    expect((await listActionsForUser(env, 'u_alex')).approvals).toHaveLength(1);
    expect(model.generate).toHaveBeenCalledTimes(1);
  });

  it('never creates a simulated calendar event without connecting and approving', async () => {
    const env = runtime();
    await command(env, 'connect demo calendar');
    const model = fixture({ type: 'calendar.create', title: 'Fictional planning',
      startsAt: new Date(Date.now() + 86_400_000).toISOString(), durationMinutes: 30 });
    const accepted = await ingestEvent(env, inbound('Plan a half-hour meeting tomorrow.'));
    await processConversation(env, accepted.conversationId, { model });
    const actions = await listActionsForUser(env, 'u_alex');
    expect(actions.events).toHaveLength(0);
    expect(actions.approvals).toHaveLength(1);
    const id = actions.approvals[0]!.id;
    await command(env, `approve ${id}`, 'mock-sam');
    expect((await listActionsForUser(env, 'u_alex')).events).toHaveLength(0);
    await command(env, `approve ${id}`);
    expect((await listActionsForUser(env, 'u_alex')).events).toHaveLength(1);
  });
});
