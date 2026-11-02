import { describe, expect, it, vi } from 'vitest';
import { ingestEvent, processConversation } from '../apps/api/src/pipeline';
import { getConversationView } from '../apps/api/src/store';
import { listGoogleCalendarActions } from '../apps/api/src/google-calendar';
import { disconnectGoogleCalendar } from '../apps/api/src/google-oauth';
import { GOOGLE_CALENDAR_SCOPE } from '../packages/calendar-google/src/index';
import { encryptText } from '../packages/security/src/index';
import type { Env, MessagingEvent, ModelProvider, QueueJob } from '../packages/contracts/src/index';
import type { ModelProposal } from '../packages/agent-core/src/model-proposals';
import { testEnv } from './setup';

function runtime(overrides: Partial<Env> = {}): Env {
  return { ...testEnv, APP_ENV: 'local', MODEL_PROVIDER: 'openai', MESSAGING_PROVIDER: 'mock',
    LIVE_MODEL_ENABLED: 'true', OPENAI_API_KEY: 'sk-fixture-no-network',
    JOBS: { send: async (_job: QueueJob) => {} } as unknown as Queue<QueueJob>, ...overrides };
}
function inbound(text: string): MessagingEvent {
  return { schemaVersion: 1, type: 'message.received', eventId: crypto.randomUUID(), messageId: crypto.randomUUID(),
    subject: { provider: 'mock', businessId: 'plause-local', subjectId: 'mock-alex' }, channel: 'mock', occurredAt: new Date().toISOString(), text };
}
function model(proposal: ModelProposal) {
  return { generate: vi.fn<ModelProvider['generate']>(async () => ({ text: 'Unverified model completion claim.', proposal,
    inputTokens: 100, outputTokens: 30, model: 'gpt-6-luna', responseId: 'resp_google_fixture' })) };
}
async function connected(env: Env) {
  await env.DB.prepare(`INSERT INTO google_calendar_connections(user_id,revision,connected,status,scope,access_token_ciphertext,
    refresh_token_ciphertext,expires_at,created_at,updated_at) VALUES ('u_alex',0,1,'connected',?,?,?,?,0,0)`)
    .bind(GOOGLE_CALENDAR_SCOPE, await encryptText('fixture-access-token', env.CONTENT_ENCRYPTION_KEY),
      await encryptText('fixture-refresh-token', env.CONTENT_ENCRYPTION_KEY), Date.now() + 3_600_000).run();
}

describe('natural-language Google requests retain server authorization boundaries', () => {
  it('does not turn a disconnected Google draft into a simulated event or an external request', async () => {
    const env = runtime();
    const provider = model({ type: 'google_calendar.create', title: 'Fictional meeting',
      startsAt: new Date(Date.now() + 86_400_000).toISOString(), durationMinutes: 30 });
    const accepted = await ingestEvent(env, inbound('Create a half-hour Google calendar meeting tomorrow.'));
    await processConversation(env, accepted.conversationId, { model: provider });
    const view = await getConversationView(env, 'u_alex', accepted.conversationId);
    const reply = view!.messages.find((message) => message.role === 'assistant')!;
    expect(reply.text).toContain('Real Google Calendar is not connected');
    expect(reply.text).not.toContain('Unverified model completion');
    expect((await listGoogleCalendarActions(env, 'u_alex')).approvals).toHaveLength(0);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM demo_calendar_events').first()).toEqual({ n: 0 });
    expect(provider.generate.mock.calls[0]![0].planningContext?.realGoogleCalendarConnected).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('publishes a real-target draft from the exact cached model source without writing to Google', async () => {
    const env = runtime({ LIVE_GOOGLE_CALENDAR_ENABLED: 'true', GOOGLE_CLIENT_ID: 'fixture-client.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 'fixture-secret', GOOGLE_REDIRECT_URI: 'http://localhost:8787/api/calendar/google/callback' });
    await connected(env);
    const provider = model({ type: 'google_calendar.create', title: 'Fictional real-target draft',
      startsAt: new Date(Date.now() + 86_400_000).toISOString(), durationMinutes: 30 });
    const accepted = await ingestEvent(env, inbound('Please plan a half-hour meeting in my Google calendar.'));
    await processConversation(env, accepted.conversationId, { model: provider, beforeModelCommit: async () => { throw new Error('fixture interruption'); } });
    await processConversation(env, accepted.conversationId, { model: provider });
    const actions = await listGoogleCalendarActions(env, 'u_alex');
    expect(actions.approvals).toHaveLength(1);
    expect(actions.approvals[0]).toMatchObject({ state: 'pending', toolName: 'google_calendar.create',
      arguments: { title: 'Fictional real-target draft' } });
    const reply = (await getConversationView(env, 'u_alex', accepted.conversationId))!.messages.find((item) => item.role === 'assistant')!;
    expect(reply.text).toContain('REAL Google Calendar');
    expect(reply.text).toContain(`approve ${actions.approvals[0]!.id}`);
    expect(provider.generate).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('executes one bounded read from a natural request and recovers its result without another provider call', async () => {
    const env = runtime({ LIVE_GOOGLE_CALENDAR_ENABLED: 'true', GOOGLE_CLIENT_ID: 'fixture-client.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 'fixture-secret', GOOGLE_REDIRECT_URI: 'http://localhost:8787/api/calendar/google/callback' });
    await connected(env);
    const timeMin = new Date(Date.now() + 86_400_000).toISOString();
    const timeMax = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const provider = model({ type: 'google_calendar.list', timeMin, timeMax });
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ items: [{ id: 'fictionalevent123', etag: '"fixture-etag"',
      summary: 'Fictional lunch', status: 'confirmed', start: { dateTime: timeMin },
      end: { dateTime: new Date(Date.parse(timeMin) + 3_600_000).toISOString() } }] }));
    vi.stubGlobal('fetch', fetchImpl);
    const accepted = await ingestEvent(env, inbound('What is on my Google calendar tomorrow?'));
    await processConversation(env, accepted.conversationId, { model: provider, beforeModelCommit: async () => { throw new Error('fixture interruption'); } });
    await processConversation(env, accepted.conversationId, { model: provider });
    const view = await getConversationView(env, 'u_alex', accepted.conversationId);
    const reply = view!.messages.find((message) => message.role === 'assistant')!;
    expect(reply.text).toContain('Fictional lunch');
    expect(reply.text).toContain('untrusted');
    expect(reply.status).toBe('delivered');
    expect(provider.generate).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]![0])).toContain('https://www.googleapis.com/calendar/v3/calendars/primary/events?');
    expect(fetchImpl.mock.calls[0]![1]?.method).toBe('GET');
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM usage_ledgers').first()).toEqual({ n: 1 });
  });

  it.each(['commit', 'dispatch'] as const)('cannot deliver captured Google data after disconnect at %s', async (boundary) => {
    const env = runtime({ LIVE_GOOGLE_CALENDAR_ENABLED: 'true', GOOGLE_CLIENT_ID: 'fixture-client.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 'fixture-secret', GOOGLE_REDIRECT_URI: 'http://localhost:8787/api/calendar/google/callback' });
    await connected(env);
    const timeMin = new Date(Date.now() + 86_400_000).toISOString();
    const timeMax = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const provider = model({ type: 'google_calendar.list', timeMin, timeMax });
    const fetchImpl = vi.fn<typeof fetch>(async (url) => String(url).includes('oauth2.googleapis.com/revoke')
      ? new Response(null, { status: 200 }) : Response.json({ items: [{ id: 'privateevent123', etag: '"private-etag"',
        summary: 'Private Google data caught before delivery', status: 'confirmed', start: { dateTime: timeMin },
        end: { dateTime: new Date(Date.parse(timeMin) + 3_600_000).toISOString() } }] }));
    vi.stubGlobal('fetch', fetchImpl);
    const accepted = await ingestEvent(env, inbound('What is on my Google calendar tomorrow?'));
    const revoke = async () => { await disconnectGoogleCalendar(env, 'u_alex'); };
    await processConversation(env, accepted.conversationId, { model: provider,
      ...(boundary === 'commit' ? { beforeModelCommit: revoke } : { beforeDispatch: revoke }) });
    await processConversation(env, accepted.conversationId, { model: provider });
    const view = await getConversationView(env, 'u_alex', accepted.conversationId);
    const replies = view!.messages.filter((message) => message.role === 'assistant');
    expect(replies.every((message) => message.status !== 'delivered' && message.status !== 'queued')).toBe(true);
    if (boundary === 'commit') expect(replies).toHaveLength(0);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM mock_receipts').first()).toEqual({ n: 0 });
    expect(await env.DB.prepare('SELECT result_ciphertext,query_digest FROM google_calendar_requests').first())
      .toEqual({ result_ciphertext: null, query_digest: '' });
    expect(await env.DB.prepare("SELECT response_ciphertext FROM model_attempts WHERE user_id='u_alex'").first())
      .toEqual({ response_ciphertext: null });
    expect(provider.generate).toHaveBeenCalledTimes(1);
  });
});
