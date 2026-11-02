import { describe, expect, it, vi } from 'vitest';
import { parseGoogleCalendarCommand, runGoogleCalendarCommand, listGoogleCalendarActions, type GoogleCalendarContext,
  type GoogleCalendarCommand } from '../apps/api/src/google-calendar';
import { generateHostedReply } from '../apps/api/src/model-runtime';
import { disconnectGoogleCalendar } from '../apps/api/src/google-oauth';
import { GOOGLE_CALENDAR_SCOPE } from '../packages/calendar-google/src/index';
import { ModelCallError, type Env, type ModelResponse } from '../packages/contracts/src/index';
import { encryptText, sha256 } from '../packages/security/src/index';
import { testEnv } from './setup';

const environment = (overrides: Partial<Env> = {}): Env => ({ ...testEnv, APP_ENV: 'local', MESSAGING_PROVIDER: 'mock',
  LIVE_GOOGLE_CALENDAR_ENABLED: 'true', GOOGLE_CLIENT_ID: 'synthetic-client.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'synthetic-client-secret', GOOGLE_REDIRECT_URI: 'http://localhost:8787/api/calendar/google/callback', ...overrides });
const future = () => new Date(Date.now() + 86_400_000).toISOString();
const creation = (at = future()) => `propose google calendar event at ${at} for 30 minutes: A private fixture visit`;
function parsed(text: string): GoogleCalendarCommand { const value = parseGoogleCalendarCommand(text); expect(value).not.toBeNull(); return value!; }
async function grant(userId = 'u_alex') {
  await testEnv.DB.prepare(`INSERT INTO google_calendar_connections(user_id,revision,connected,status,scope,access_token_ciphertext,
    refresh_token_ciphertext,expires_at,created_at,updated_at) VALUES (?,0,1,'connected',?,?,?,?,?,?)`)
    .bind(userId, GOOGLE_CALENDAR_SCOPE, await encryptText('synthetic-access', testEnv.CONTENT_ENCRYPTION_KEY),
      await encryptText('synthetic-refresh', testEnv.CONTENT_ENCRYPTION_KEY), Date.now() + 3_600_000, Date.now(), Date.now()).run();
}
async function contextFor(text: string, userId = 'u_alex', previous?: GoogleCalendarContext): Promise<GoogleCalendarContext> {
  const suffix = crypto.randomUUID(); const now = Date.now();
  const context = previous ? { ...previous, messageId: `gmsg_${suffix}` } : { userId, conversationId: `gconv_${suffix}`,
    messageId: `gmsg_${suffix}`, leaseToken: `glease_${suffix}`, ownershipVersion: 0, contextRevision: 0 };
  if (!previous) await testEnv.DB.batch([
    testEnv.DB.prepare(`INSERT INTO conversations(id,user_id,channel,provider,business_id,subject_id,lease_token,lease_until,created_at,last_activity_at)
      VALUES (?,?,'web','web','plause-local',?,?,?,?,?)`).bind(context.conversationId, userId, suffix, context.leaseToken, now + 60_000, now, now),
    testEnv.DB.prepare(`INSERT INTO bindings(provider,business_id,subject_id,user_id,channel,conversation_id)
      VALUES ('web','plause-local',?,?,'web',?)`).bind(suffix, userId, context.conversationId),
  ]);
  await testEnv.DB.prepare(`INSERT INTO messages(id,conversation_id,role,body_ciphertext,content_hash,status,created_at,context_revision,is_memory_control)
    VALUES (?,?,'user',?,?,'processing',?,0,0)`).bind(context.messageId, context.conversationId,
      await encryptText(text, testEnv.CONTENT_ENCRYPTION_KEY), await sha256(text), now).run();
  return context;
}
async function propose(env = environment(), userId = 'u_alex') {
  const text = creation(); const context = await contextFor(text, userId);
  const response = await runGoogleCalendarCommand(env, context, parsed(text));
  const actions = await listGoogleCalendarActions(env, userId);
  return { env, context, response, approval: actions.approvals[0]! };
}
function remoteEvent(body: Record<string, unknown>) {
  return { ...body, status: 'confirmed', etag: '"google-fixture-etag"', organizer: { self: true } };
}
async function executeText(env: Env, base: GoogleCalendarContext, text: string) {
  const context = await contextFor(text, base.userId, base);
  return { context, response: await runGoogleCalendarCommand(env, context, parsed(text)) };
}

describe('explicit Google Calendar command parser', () => {
  it('normalizes exact offset ranges and exact create/update drafts', () => {
    expect(parsed('google calendar events from 2030-06-01T09:00:00-04:00 to 2030-06-02T09:00:00-04:00'))
      .toEqual({ type: 'list', timeMin: '2030-06-01T13:00:00.000Z', timeMax: '2030-06-02T13:00:00.000Z' });
    expect(parsed('propose google calendar update abcde12345 etag "version_1" at 2030-06-01T09:00:00-04:00 for 30 minutes: Visit'))
      .toMatchObject({ type: 'propose_update', eventId: 'abcde12345', etag: '"version_1"', draft: { title: 'Visit', startsAt: '2030-06-01T13:00:00.000Z' } });
  });
  it.each(['"propose google calendar event at 2030-06-01T09:00:00Z for 30 minutes: Visit"', 'yes', 'Please read my Google Calendar', 'approve approval_00000000-0000-0000-0000-000000000000'])
    ('never infers authorization from %j', (text) => expect(parseGoogleCalendarCommand(text)).toBeNull());
  it.each(['google calendar events from 2030-06-01T00:00:00Z to 2030-08-01T00:00:00Z',
    'propose google calendar event at 2030-06-01T09:00:00 for 30 minutes: Visit',
    'propose google calendar event at 2030-06-01T09:00:00-00:00 for 30 minutes: Visit',
    'propose google calendar event at 2030-02-30T09:00:00Z for 30 minutes: Visit',
    'propose google calendar event at 2030-06-01T09:00:00Z for 481 minutes: Visit', 'google calendar help\n',
    'propose google calendar update abcde12345 etag * at 2030-06-01T09:00:00Z for 30 minutes: Visit'])
    ('rejects ambiguous or multiple commands %j', (text) => expect(parsed(text).type).toBe('invalid'));
});

describe('durable Google Calendar approvals and operations', () => {
  it('returns an honest disconnected response with zero network/count, even if a model is unavailable', async () => {
    const text = creation(); const context = await contextFor(text);
    const response = await runGoogleCalendarCommand(environment({ OPENAI_API_KEY: '' }), context, parsed(text));
    expect(response.text).toContain('No external calendar request or write was performed');
    expect(fetch).not.toHaveBeenCalled();
    expect(await testEnv.DB.prepare('SELECT SUM(counted) AS n FROM google_calendar_requests').first()).toEqual({ n: 0 });
  });
  it('creates only an encrypted exact approval and reuses its reply on source replay', async () => {
    await grant(); const result = await propose();
    expect(result.response).toMatchObject({ model: 'plause-google-calendar', inputTokens: 0, outputTokens: 0 });
    expect(result.response.text).toContain(`approve ${result.approval.id}`);
    expect(result.response.text).toContain(result.approval.argsHash.slice(0, 16));
    expect(result.response.text).toContain('No write has been performed');
    expect(result.approval.state).toBe('pending');
    expect(fetch).not.toHaveBeenCalled();
    const stored = await testEnv.DB.prepare('SELECT arguments_ciphertext FROM google_calendar_approvals').first<{ arguments_ciphertext: string }>();
    expect(stored!.arguments_ciphertext).toMatch(/^v1:/); expect(stored!.arguments_ciphertext).not.toContain('private fixture');
    const source = creation(result.approval.arguments.startsAt);
    expect(await runGoogleCalendarCommand(result.env, result.context, parsed(source))).toEqual(result.response);
    expect((await listGoogleCalendarActions(result.env, 'u_alex')).approvals).toHaveLength(1);
    expect((await listGoogleCalendarActions(result.env, 'u_sam')).approvals).toHaveLength(0);
  });
  it('executes one approved create, caches the result and never repeats a completed approval', async () => {
    await grant(); const result = await propose();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => Response.json(remoteEvent(JSON.parse(init!.body as string))));
    const approved = await executeText(result.env, result.context, `approve ${result.approval.id}`);
    expect(approved.response.text).toContain('created the exact approved event');
    expect(fetchMock).toHaveBeenCalledTimes(1); expect(fetchMock.mock.calls[0]![1]!.method).toBe('POST');
    expect(await runGoogleCalendarCommand(result.env, approved.context, { type: 'approve', id: result.approval.id })).toEqual(approved.response);
    await executeText(result.env, result.context, `approve ${result.approval.id}`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await listGoogleCalendarActions(result.env, 'u_alex')).approvals[0]!.state).toBe('completed');
    expect(await testEnv.DB.prepare('SELECT SUM(counted) AS n FROM google_calendar_requests').first()).toEqual({ n: 1 });
  });
  it('claims an exact approval once even if distinct approval inputs race', async () => {
    await grant(); const result = await propose();
    const first = await contextFor(`approve ${result.approval.id}`, 'u_alex', result.context);
    const second = await contextFor(`approve ${result.approval.id}`, 'u_alex', result.context);
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => { await gate; return Response.json(remoteEvent(JSON.parse(init!.body as string))); });
    const settled = Promise.all([runGoogleCalendarCommand(result.env, first, { type: 'approve', id: result.approval.id }),
      runGoogleCalendarCommand(result.env, second, { type: 'approve', id: result.approval.id })]);
    try { await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1)); } finally { release(); }
    await settled; expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await testEnv.DB.prepare('SELECT SUM(counted) AS n FROM google_calendar_requests').first()).toEqual({ n: 1 });
  });
  it('retains unknown writes and reconciles only through an explicit new GET command', async () => {
    await grant(); const result = await propose();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('SECRET_UNKNOWN_WRITE'))
      .mockResolvedValueOnce(new Response('', { status: 404 }));
    const unknown = await executeText(result.env, result.context, `approve ${result.approval.id}`);
    expect(unknown.response.text).toContain('could not confirm'); expect(fetchMock).toHaveBeenCalledTimes(2);
    await runGoogleCalendarCommand(result.env, unknown.context, { type: 'approve', id: result.approval.id });
    await executeText(result.env, result.context, `approve ${result.approval.id}`);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const record = await testEnv.DB.prepare('SELECT event_id FROM google_calendar_approvals WHERE id=?').bind(result.approval.id).first<{ event_id: string }>();
    const args = result.approval.arguments;
    fetchMock.mockResolvedValueOnce(Response.json(remoteEvent({ id: record!.event_id, summary: args.title, start: { dateTime: args.startsAt },
      end: { dateTime: new Date(Date.parse(args.startsAt) + args.durationMinutes * 60_000).toISOString() },
      extendedProperties: { private: { plauseOperationId: record!.event_id } } })));
    const checked = await executeText(result.env, result.context, `check calendar action ${result.approval.id}`);
    expect(checked.response.text).toContain('Reconciled by reading only'); expect(fetchMock.mock.calls[2]![1]!.method).toBe('GET');
    expect((await listGoogleCalendarActions(result.env, 'u_alex')).approvals[0]!.state).toBe('completed');
    expect(await testEnv.DB.prepare('SELECT SUM(counted) AS n FROM google_calendar_requests').first()).toEqual({ n: 2 });
  });
  it.each(['expired','cross_conversation','context','connection'] as const)('never dispatches an %s approval', async (change) => {
    await grant(); const result = await propose();
    let base = result.context;
    if (change === 'expired') await testEnv.DB.prepare('UPDATE google_calendar_approvals SET expires_at=0 WHERE id=?').bind(result.approval.id).run();
    if (change === 'context') await testEnv.DB.prepare('UPDATE google_calendar_approvals SET context_revision=1 WHERE id=?').bind(result.approval.id).run();
    if (change === 'connection') await testEnv.DB.prepare('UPDATE google_calendar_approvals SET connection_revision=1 WHERE id=?').bind(result.approval.id).run();
    if (change === 'cross_conversation') base = await contextFor('google calendar help');
    const response = await executeText(result.env, base, `approve ${result.approval.id}`);
    expect(response.response.text).toMatch(/expired|not found|stale/); expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects safely without a provider request', async () => {
    await grant(); const result = await propose();
    expect((await executeText(result.env, result.context, `reject ${result.approval.id}`)).response.text).toContain('rejected');
    expect((await listGoogleCalendarActions(result.env, 'u_alex')).approvals[0]!.state).toBe('rejected'); expect(fetch).not.toHaveBeenCalled();
  });
  it('rechecks expiry after a token refresh before the actual create', async () => {
    await grant(); const result = await propose();
    await testEnv.DB.prepare("UPDATE google_calendar_connections SET expires_at=0 WHERE user_id='u_alex'").run();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      await testEnv.DB.prepare('UPDATE google_calendar_approvals SET expires_at=0 WHERE id=?').bind(result.approval.id).run();
      return Response.json({ access_token: 'replacement-synthetic-access', token_type: 'Bearer', scope: GOOGLE_CALENDAR_SCOPE, expires_in: 3600 });
    });
    const response = await executeText(result.env, result.context, `approve ${result.approval.id}`);
    expect(response.response.text).toContain('failed'); expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe('https://oauth2.googleapis.com/token');
    expect((await listGoogleCalendarActions(result.env, 'u_alex')).approvals[0]!.state).toBe('failed');
  });
  it('rechecks expiry after the update GET and never issues a late PUT', async () => {
    await grant(); const first = await propose();
    const createFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => Response.json(remoteEvent(JSON.parse(init!.body as string))));
    await executeText(first.env, first.context, `approve ${first.approval.id}`);
    const body = JSON.parse(createFetch.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
    const text = `propose google calendar update ${body.id} etag "google-fixture-etag" at ${future()} for 30 minutes: An approved updated visit`;
    const proposalContext = await contextFor(text, 'u_alex', first.context);
    await runGoogleCalendarCommand(first.env, proposalContext, parsed(text));
    const update = (await listGoogleCalendarActions(first.env, 'u_alex')).approvals.find((item) => item.toolName === 'google_calendar.update')!;
    createFetch.mockImplementation(async () => {
      await testEnv.DB.prepare('UPDATE google_calendar_approvals SET expires_at=0 WHERE id=?').bind(update.id).run();
      return Response.json(remoteEvent(body));
    });
    const response = await executeText(first.env, first.context, `approve ${update.id}`);
    expect(response.response.text).toContain('failed');
    expect(createFetch.mock.calls.map(([, init]) => init!.method)).toEqual(['POST','GET']);
  });
  async function quotaCase(global: boolean) {
    await grant(); if (global) await grant('u_sam');
    const day = new Date().toISOString().slice(0, 10); const now = Date.now(); const count = global ? 499 : 19;
    await testEnv.DB.prepare(`WITH RECURSIVE seq(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM seq WHERE x<?)
      INSERT INTO google_calendar_requests(message_id,user_id,conversation_id,context_revision,operation,day,counted,state,query_digest,attempt_token,created_at,updated_at)
      SELECT 'quota_seed_'||x,?,'opaque-deleted-conversation',0,'list',?,1,'purged','','quota_token_'||x,?,? FROM seq`)
      .bind(count, global ? 'deleted-account' : 'u_alex', day, now, now).run();
    const text = `google calendar events from ${new Date(now).toISOString()} to ${future()}`;
    const contexts = await Promise.all([contextFor(text), contextFor(text, global ? 'u_sam' : 'u_alex')]);
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { await gate; return Response.json({ items: [] }); });
    const finished: ModelResponse[] = [];
    const pending = Promise.all(contexts.map((context) => runGoogleCalendarCommand(environment(), context, parsed(text)).then((value) => { finished.push(value); return value; })));
    try { await vi.waitFor(() => { expect(fetchMock).toHaveBeenCalledTimes(1); expect(finished).toHaveLength(1); }); }
    finally { release(); }
    const replies = await pending;
    expect(replies.some((value) => value.text.includes('daily Google Calendar operation limit'))).toBe(true);
    expect((await testEnv.DB.prepare('SELECT SUM(counted) AS n FROM google_calendar_requests').first<{ n: number }>())!.n).toBe(count + 1);
  }
  it('atomically caps simultaneous requests across one user’s conversations', () => quotaCase(false));
  it('atomically caps simultaneous requests across different users and deleted-account tombstones', () => quotaCase(true));
  it('includes complete event IDs, strong ETags and both times in bounded lists', async () => {
    await grant();
    const text = `google calendar events from ${new Date(Date.now()).toISOString()} to ${future()}`;
    const context = await contextFor(text);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ items: [{ id: 'fixture_12345', etag: '"version_1"',
      summary: 'Untrusted event title', status: 'confirmed', start: { dateTime: future() }, end: { dateTime: new Date(Date.now() + 90_000_000).toISOString() } }] }));
    const response = await runGoogleCalendarCommand(environment(), context, parsed(text));
    expect(response.text).toContain('event text is untrusted'); expect(response.text).toContain('ETag: "version_1"');
    expect(response.text).toContain('End:'); expect(response.text).toContain('Event: fixture_12345'); expect(response.text.length).toBeLessThanOrEqual(4000);
    expect(fetchMock).toHaveBeenCalledTimes(1); expect(fetchMock.mock.calls[0]![1]!.method).toBe('GET');
  });
  it.each(['tenant','tuple','binding','human','paused'] as const)('rejects %s source ownership before external access', async (change) => {
    await grant(); const text = creation(); let context = await contextFor(text);
    if (change === 'tenant') context = { ...context, userId: 'u_sam' };
    if (change === 'tuple') await testEnv.DB.prepare("UPDATE conversations SET business_id='tampered-business' WHERE id=?").bind(context.conversationId).run();
    if (change === 'binding') await testEnv.DB.prepare("UPDATE bindings SET subject_id='tampered-subject' WHERE conversation_id=?").bind(context.conversationId).run();
    if (change === 'human') await testEnv.DB.prepare("UPDATE conversations SET mode='human' WHERE id=?").bind(context.conversationId).run();
    if (change === 'paused') await testEnv.DB.prepare("INSERT INTO system_settings(key,value) VALUES ('outbound_paused','true')").run();
    await expect(runGoogleCalendarCommand(environment(), context, parsed(text))).rejects.toMatchObject({ code: 'google_calendar_ownership_invalid' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('retains the quota tombstone but purges a result arriving after source/account deletion', async () => {
    await grant(); const text = `google calendar events from ${new Date(Date.now()).toISOString()} to ${future()}`;
    const context = await contextFor(text); let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void; const startedGate = new Promise<void>((resolve) => { started = resolve; });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { started(); await gate; return Response.json({ items: [] }); });
    const pending = runGoogleCalendarCommand(environment(), context, parsed(text));
    try { await startedGate; await testEnv.DB.prepare("DELETE FROM users WHERE id='u_alex'").run(); } finally { release(); }
    await pending;
    expect(await testEnv.DB.prepare('SELECT state,result_ciphertext,query_digest,counted FROM google_calendar_requests').first())
      .toEqual({ state: 'purged', result_ciphertext: null, query_digest: '', counted: 1 });
  });
  it('permits a natural Google draft only when bound to that exact completed encrypted model response', async () => {
    await grant(); const text = 'Please draft a visit on my real Google Calendar at a known future time.';
    const context = await contextFor(text); const startsAt = future();
    const command: GoogleCalendarCommand = { type: 'propose_create', draft: { title: 'A known visit', startsAt, durationMinutes: 30 } };
    await expect(runGoogleCalendarCommand(environment(), context, command)).rejects.toMatchObject({ code: 'google_calendar_source_conflict' });
    const modelResponse: ModelResponse = { text: '', inputTokens: 100, outputTokens: 10, proposal: { type: 'google_calendar.create', ...command.draft } };
    await generateHostedReply({ ...environment(), MODEL_PROVIDER: 'openai', LIVE_MODEL_ENABLED: 'true', OPENAI_API_KEY: 'synthetic-key' }, context,
      { text, history: [], contextRevision: 0 }, { generate: async () => modelResponse });
    expect((await runGoogleCalendarCommand(environment(), context, command)).text).toContain('No write has been performed');
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['account','disconnect','memory','source'] as const)('never returns captured approval plaintext after %s revocation during decrypt', async (change) => {
    await grant(); const result = await propose();
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void; const startedGate = new Promise<void>((resolve) => { started = resolve; });
    const original = crypto.subtle.decrypt.bind(crypto.subtle);
    const decrypt = vi.spyOn(crypto.subtle, 'decrypt').mockImplementationOnce(async (algorithm, key, data) => {
      started(); await gate; return original(algorithm, key, data);
    });
    const pending = listGoogleCalendarActions(result.env, 'u_alex');
    const rejected = expect(pending).rejects.toMatchObject({ code: 'google_calendar_ownership_invalid' });
    try {
      await startedGate;
      if (change === 'account') await testEnv.DB.prepare("DELETE FROM users WHERE id='u_alex'").run();
      if (change === 'disconnect') await disconnectGoogleCalendar(result.env, 'u_alex', { fetchImpl: vi.fn<typeof fetch>(async () => new Response(null, { status: 200 })) });
      if (change === 'memory') await testEnv.DB.prepare("UPDATE users SET context_revision=context_revision+1 WHERE id='u_alex'").run();
      if (change === 'source') await testEnv.DB.prepare('DELETE FROM messages WHERE id=?').bind(result.context.messageId).run();
      release(); await rejected;
    } finally { release(); decrypt.mockRestore(); }
  });
});
