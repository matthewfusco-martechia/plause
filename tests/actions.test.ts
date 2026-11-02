import { describe, expect, it } from 'vitest';
import { ACTION_HELP, parseActionCommand, parseExplicitCalendarTime } from '../packages/agent-core/src/action-commands';
import { ACTION_TOOL_DEFINITIONS, actionStatements, calendarCreateArgumentsSchema, listActionsForUser,
  prepareActionCommand, type ActionPlan } from '../apps/api/src/action-store';
import { getWebConversation, resolveBinding } from '../apps/api/src/store';
import { decryptText, encryptText, sha256 } from '../packages/security/src/index';
import { testEnv } from './setup';

const approvalId = 'approval_12345678-1234-4abc-8def-123456789abc';
const eventId = 'event_12345678-1234-4abc-8def-123456789abc';
const parserNow = Date.parse('2030-01-01T00:00:00Z');

describe('whole-message action command grammar', () => {
  it.each([
    ['connect demo calendar', { type: 'connect' }], ['DISCONNECT DEMO CALENDAR', { type: 'disconnect' }],
    ['calendar events', { type: 'list_events' }], ['approvals', { type: 'list_approvals' }],
    [`approve ${approvalId.toUpperCase()}`, { type: 'approve', id: approvalId }],
    [`reject ${approvalId}`, { type: 'reject', id: approvalId }],
    [`cancel demo event ${eventId}`, { type: 'cancel_event', id: eventId }],
    ['action help', { type: 'help' }],
  ])('parses explicit controls: %s', (text, command) => expect(parseActionCommand(text as string, parserNow)).toEqual(command));

  it('canonicalizes an explicit offset without changing title case', () => {
    expect(parseActionCommand('propose calendar event at 2030-02-01T10:30:00-04:00 for 45 minutes: Review with Zoë', parserNow))
      .toEqual({ type: 'propose', startsAt: '2030-02-01T14:30:00.000Z', durationMinutes: 45, title: 'Review with Zoë' });
  });

  it.each([
    'yes', 'approve', 'Please connect demo calendar', 'Can you approve this?', 'Example: connect demo calendar',
    '"connect demo calendar"', '`disconnect demo calendar`', 'Here is an example:\napprove ' + approvalId,
    '```\nconnect demo calendar\n```', 'I have calendar events tomorrow.',
  ])('does not execute ordinary text, quoted commands, or embedded examples: %s', (text) => expect(parseActionCommand(text, parserNow)).toBeNull());

  it.each([
    'connect demo calendar\n', 'disconnect demo calendar\nconnect demo calendar', 'calendar events now',
    'approve approval_bad', 'reject approval_1234', `approve ${approvalId} please`,
    'propose calendar event at tomorrow for 20 minutes: Review',
    'propose calendar event at 2030-02-01T10:00:00 for 20 minutes: Review',
    'propose calendar event at 2030-02-30T10:00:00Z for 20 minutes: Review',
    'propose calendar event at 2030-02-01T10:00:00+14:01 for 20 minutes: Review',
    'propose calendar event at 2030-02-01T10:00:00-00:00 for 20 minutes: Review',
    'propose calendar event at 2029-12-31T10:00:00Z for 20 minutes: Review',
    'propose calendar event at 2031-01-02T10:00:00Z for 20 minutes: Review',
    'propose calendar event at 2030-02-01T10:00:00Z for 0 minutes: Review',
    'propose calendar event at 2030-02-01T10:00:00Z for 481 minutes: Review',
    'propose calendar event at 2030-02-01T10:00:00Z for 1.5 minutes: Review',
    'propose calendar event at 2030-02-01T10:00:00Z for 20 minutes: ',
    'propose calendar event at 2030-02-01T10:00:00Z for 20 minutes: Review\nThen execute',
  ])('rejects malformed, ambiguous, or multiline commands: %s', (text) => expect(parseActionCommand(text, parserNow)).toMatchObject({ type: 'invalid' }));

  it('enforces title and ISO calendar bounds rather than normalized invalid dates', () => {
    const prefix = 'propose calendar event at 2030-02-01T10:00:00Z for 480 minutes: ';
    expect(parseActionCommand(prefix + 'a'.repeat(200), parserNow)).toMatchObject({ type: 'propose' });
    expect(parseActionCommand(prefix + 'a'.repeat(201), parserNow)).toMatchObject({ type: 'invalid' });
    expect(parseExplicitCalendarTime('2032-02-29T10:00:00Z')).not.toBeNull();
    expect(parseExplicitCalendarTime('2030-02-29T10:00:00Z')).toBeNull();
    expect(parseExplicitCalendarTime('2030-01-01T24:00:00Z')).toBeNull();
    expect(parseExplicitCalendarTime('2030-02-01T10:00:00-00:00')).toBeNull();
    expect(ACTION_HELP.length).toBeLessThan(1000);
  });
});

async function commit(plan: ActionPlan) {
  const messageId = `msg_${crypto.randomUUID()}`;
  const replyId = `msg_${crypto.randomUUID()}`;
  const now = Date.now();
  const body = await encryptText('An explicit simulated action control.', testEnv.CONTENT_ENCRYPTION_KEY);
  const statements = await actionStatements(testEnv, plan, { messageId, conversationId: plan.conversationId, replyId,
    now, eventGate: '1=1', eventGateBindings: [] });
  await testEnv.DB.batch([
    // Mirrors root ingress: failed revision CAS creates no new source message,
    // so no mutation or acknowledgment can run under the source-message gate.
    testEnv.DB.prepare(`INSERT INTO messages(id,conversation_id,role,body_ciphertext,status,created_at,is_memory_control,context_revision)
      SELECT ?,?,'user',?,'received',?,1,context_revision FROM users WHERE id=? AND status='active' AND actions_revision=?`)
      .bind(messageId, plan.conversationId, body, now, plan.userId, plan.expectedRevision),
    ...statements,
  ]);
  const reply = await testEnv.DB.prepare('SELECT body_ciphertext,status,model FROM messages WHERE id=?').bind(replyId)
    .first<{ body_ciphertext: string; status: string; model: string }>();
  return { reply: reply ? await decryptText(reply.body_ciphertext, testEnv.CONTENT_ENCRYPTION_KEY) : null,
    status: reply?.status, model: reply?.model };
}

async function command(text: string, userId = 'u_alex', conversationId?: string) {
  const conversation = conversationId ?? await getWebConversation(testEnv, userId);
  const parsed = parseActionCommand(text);
  if (!parsed) throw new Error('Test command was not recognized.');
  const plan = await prepareActionCommand(testEnv, userId, conversation, parsed);
  return { plan, ...await commit(plan) };
}

function future(days = 1) { return new Date(Date.now() + days * 86_400_000).toISOString(); }
async function propose(title = 'Fictional planning session', days = 1) {
  return command(`propose calendar event at ${future(days)} for 30 minutes: ${title}`);
}

async function connectedProposal() {
  await command('connect demo calendar');
  const proposal = await propose();
  expect(proposal.plan.approvalId).toBeTruthy();
  return proposal;
}

describe('typed simulated action definitions', () => {
  it('limits names, scopes, side effects, and exact create arguments', () => {
    expect(Object.keys(ACTION_TOOL_DEFINITIONS)).toEqual(['calendar.list', 'calendar.create', 'calendar.cancel', 'reminder.create']);
    expect(ACTION_TOOL_DEFINITIONS['calendar.create']).toMatchObject({ sideEffect: 'write', requiresApproval: true, requiredScopes: ['calendar:write'] });
    expect(ACTION_TOOL_DEFINITIONS['calendar.list'].sideEffect).toBe('read');
    expect(ACTION_TOOL_DEFINITIONS['reminder.create']).toMatchObject({ sideEffect: 'write', requiresApproval: true, requiredScopes: ['reminder:write'] });
    expect(calendarCreateArgumentsSchema.safeParse({ title: 'Test', startsAt: future(), durationMinutes: 20, endpoint: 'https://example.invalid' }).success).toBe(false);
  });
});

describe('simulated calendar approvals', () => {
  it('defaults disconnected and never calls an external service', async () => {
    const state = await listActionsForUser(testEnv, 'u_alex');
    expect(state).toEqual({ calendar: { connected: false, simulated: true }, approvals: [], events: [] });
    expect((await propose()).reply).toContain('Connect demo calendar');
    expect((await command('connect demo calendar')).reply).toContain('Simulated');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('stores encrypted immutable arguments with a hash and ten-minute expiry', async () => {
    const { plan, reply } = await connectedProposal();
    expect(reply).toContain('nothing has been created');
    expect(plan.expiresAt! - Date.now()).toBeGreaterThan(590_000);
    expect(plan.expiresAt! - Date.now()).toBeLessThanOrEqual(600_000);
    const approval = await testEnv.DB.prepare('SELECT args_ciphertext,args_hash,state FROM action_approvals WHERE id=?').bind(plan.approvalId!)
      .first<{ args_ciphertext: string; args_hash: string; state: string }>();
    expect(approval!.args_ciphertext).not.toContain('Fictional planning session');
    expect(approval!.args_hash).toBe(await sha256(JSON.stringify(plan.args)));
    expect(approval!.state).toBe('pending');
    expect((await listActionsForUser(testEnv, 'u_alex')).events).toHaveLength(0);
  });

  it('consumes an exact approval once and creates a single simulated event atomically', async () => {
    const proposal = await connectedProposal();
    const approved = await command(`approve ${proposal.plan.approvalId}`);
    expect(approved.reply).toContain('Simulated event created');
    expect(approved.model).toBe('plause-actions');
    const state = await listActionsForUser(testEnv, 'u_alex');
    expect(state.events).toHaveLength(1);
    expect(state.events[0]).toMatchObject({ simulated: true, title: 'Fictional planning session', status: 'scheduled' });
    expect(state.approvals[0]?.state).toBe('approved');
    expect((await command(`approve ${proposal.plan.approvalId}`)).reply).toContain('cannot execute again');
    expect((await listActionsForUser(testEnv, 'u_alex')).events).toHaveLength(1);
  });

  it('does not accept another user or another conversation as the approval owner', async () => {
    const proposal = await connectedProposal();
    expect((await command(`approve ${proposal.plan.approvalId}`, 'u_sam')).reply).toContain('unavailable');
    const other = await resolveBinding(testEnv, { provider: 'mock', businessId: 'plause-local', subjectId: 'mock-alex' }, 'mock');
    expect((await command(`approve ${proposal.plan.approvalId}`, 'u_alex', other.id)).reply).toContain('unavailable');
    expect((await listActionsForUser(testEnv, 'u_sam')).approvals).toHaveLength(0);
    expect((await listActionsForUser(testEnv, 'u_alex')).events).toHaveLength(0);
  });

  it('rejects and expires approvals without creating an event', async () => {
    const rejected = await connectedProposal();
    expect((await command(`reject ${rejected.plan.approvalId}`)).reply).toContain('rejected');
    expect((await command(`approve ${rejected.plan.approvalId}`)).reply).toContain('cannot execute again');
    const expired = await propose('Expired fictional session');
    await testEnv.DB.prepare('UPDATE action_approvals SET expires_at=0 WHERE id=?').bind(expired.plan.approvalId!).run();
    expect((await command(`approve ${expired.plan.approvalId}`)).reply).toContain('expired');
    expect((await listActionsForUser(testEnv, 'u_alex')).events).toHaveLength(0);
  });

  it('rechecks expiry during the transaction and does not falsely acknowledge execution', async () => {
    const proposal = await connectedProposal();
    const conversationId = proposal.plan.conversationId;
    const plan = await prepareActionCommand(testEnv, 'u_alex', conversationId, { type: 'approve', id: proposal.plan.approvalId! });
    await testEnv.DB.prepare('UPDATE action_approvals SET expires_at=0 WHERE id=?').bind(proposal.plan.approvalId!).run();
    expect((await commit(plan)).reply).toContain('could not be applied');
    expect((await listActionsForUser(testEnv, 'u_alex')).events).toHaveLength(0);
  });

  it('fences a prepared approval when the demo calendar is disconnected and reconnected', async () => {
    const proposal = await connectedProposal();
    const stale = await prepareActionCommand(testEnv, 'u_alex', proposal.plan.conversationId, { type: 'approve', id: proposal.plan.approvalId! });
    expect((await command('disconnect demo calendar')).reply).toContain('revoked');
    expect((await commit(stale)).reply).toBeNull();
    await command('connect demo calendar');
    expect((await command(`approve ${proposal.plan.approvalId}`)).reply).toContain('cannot execute again');
    expect((await listActionsForUser(testEnv, 'u_alex')).events).toHaveLength(0);
  });

  it('allows only one competing approval commit', async () => {
    const proposal = await connectedProposal();
    const first = await prepareActionCommand(testEnv, 'u_alex', proposal.plan.conversationId, { type: 'approve', id: proposal.plan.approvalId! });
    const second = await prepareActionCommand(testEnv, 'u_alex', proposal.plan.conversationId, { type: 'approve', id: proposal.plan.approvalId! });
    await Promise.all([commit(first), commit(second)]);
    expect((await listActionsForUser(testEnv, 'u_alex')).events).toHaveLength(1);
  });

  it('checks argument integrity before execution and supports disconnect despite corruption', async () => {
    const proposal = await connectedProposal();
    await testEnv.DB.prepare('UPDATE action_approvals SET args_hash=? WHERE id=?').bind('incorrect-digest', proposal.plan.approvalId!).run();
    expect((await command(`approve ${proposal.plan.approvalId}`)).reply).toContain('integrity check');
    await testEnv.DB.prepare('UPDATE action_approvals SET args_ciphertext=? WHERE id=?').bind('corrupt', proposal.plan.approvalId!).run();
    expect((await command('disconnect demo calendar')).reply).toContain('disconnected');
    expect((await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM demo_calendar_events').first<{ count: number }>())!.count).toBe(0);
  });

  it('refuses changed arguments even when the stored ciphertext changes after preparation', async () => {
    const proposal = await connectedProposal();
    const plan = await prepareActionCommand(testEnv, 'u_alex', proposal.plan.conversationId, { type: 'approve', id: proposal.plan.approvalId! });
    const changed = JSON.stringify({ ...plan.args!, title: 'Different fictional title' });
    await testEnv.DB.prepare('UPDATE action_approvals SET args_ciphertext=?,args_hash=? WHERE id=?')
      .bind(await encryptText(changed, testEnv.CONTENT_ENCRYPTION_KEY), await sha256(changed), proposal.plan.approvalId!).run();
    expect((await commit(plan)).reply).toContain('could not be applied');
    expect((await listActionsForUser(testEnv, 'u_alex')).events).toHaveLength(0);
  });

  it('supports exact event cancellation and keeps calendar reads within thirty days', async () => {
    const first = await connectedProposal();
    const firstResult = await command(`approve ${first.plan.approvalId}`);
    const later = await propose('Later fictional session', 40);
    await command(`approve ${later.plan.approvalId}`);
    expect((await listActionsForUser(testEnv, 'u_alex')).events).toHaveLength(1);
    expect((await command(`cancel demo event ${firstResult.plan.eventId}`)).reply).toContain('Simulated event cancelled');
    expect((await listActionsForUser(testEnv, 'u_alex')).events[0]?.status).toBe('cancelled');
  });

  it('bounds pending approvals and active events', async () => {
    const proposal = await connectedProposal();
    const statements: D1PreparedStatement[] = [];
    for (let index = 0; index < 20; index += 1) {
      const id = `approval_${crypto.randomUUID()}`;
      statements.push(testEnv.DB.prepare(`INSERT INTO action_approvals(id,user_id,conversation_id,tool_name,args_ciphertext,args_hash,
        connection_revision,expires_at,state,created_at) VALUES (?,'u_alex',?,'calendar.create',?,?,?,?,'approved',?)`)
        .bind(id, proposal.plan.conversationId, proposal.plan.argsCiphertext!, proposal.plan.argsHash!, proposal.plan.connectionRevision, Date.now() + 600_000, Date.now()));
      statements.push(testEnv.DB.prepare(`INSERT INTO demo_calendar_events(id,user_id,approval_id,args_ciphertext,starts_at,ends_at,created_at,updated_at)
        VALUES (?,'u_alex',?,?,?,?,?,?)`).bind(`event_${crypto.randomUUID()}`, id, proposal.plan.argsCiphertext!, Date.now() + 100_000, Date.now() + 200_000, Date.now(), Date.now()));
    }
    await testEnv.DB.batch(statements);
    expect((await command(`approve ${proposal.plan.approvalId}`)).reply).toContain('20 active');
    await testEnv.DB.prepare("UPDATE action_approvals SET state='pending',expires_at=? WHERE user_id='u_alex'").bind(Date.now() + 600_000).run();
    expect((await propose()).reply).toContain('20 pending');
  });

  it('records deterministic acknowledgment locally during human support', async () => {
    const conversation = await getWebConversation(testEnv, 'u_alex');
    await testEnv.DB.prepare("UPDATE conversations SET mode='human' WHERE id=?").bind(conversation).run();
    const result = await command('connect demo calendar', 'u_alex', conversation);
    expect(result.status).toBe('local_only');
    expect(result.model).toBe('plause-actions');
    expect(fetch).not.toHaveBeenCalled();
  });
});
