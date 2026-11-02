import { describe, it, expect, vi } from 'vitest';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../apps/api/src/index';
import { createDeletionIntent, eraseAccount, exportAccountPage, getAccountSummary } from '../apps/api/src/account';
import { ingestEvent } from '../apps/api/src/pipeline';
import { encryptText } from '../packages/security/src/index';
import type { Env, MessagingEvent, QueueJob } from '../packages/contracts/src/index';
import { inviteAlex, inviteSam, testEnv } from './setup';

const origin = 'http://localhost';
function runtime(): Env { return { ...testEnv, JOBS: { send: async (_job: QueueJob) => {} } as unknown as Queue<QueueJob> }; }
async function inbound(env: Env, text: string, subjectId = 'mock-alex') {
  const event: MessagingEvent = { schemaVersion: 1, type: 'message.received', eventId: crypto.randomUUID(), messageId: crypto.randomUUID(),
    subject: { provider: 'mock', businessId: 'plause-local', subjectId }, channel: 'mock', occurredAt: new Date().toISOString(), text };
  return ingestEvent(env, event);
}
async function call(env: Env, path: string, init: RequestInit = {}) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(origin + path, init) as Request<unknown, IncomingRequestCfProperties>, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
async function session(env: Env, inviteToken = inviteAlex) {
  const result = await call(env, '/api/session', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ inviteToken }) });
  expect(result.status).toBe(200);
  return result.headers.get('set-cookie')!.split(';')[0]!;
}

describe('local account privacy controls', () => {
  it('exports only the authenticated account with personal controls and no credentials', async () => {
    const env = runtime();
    await inbound(env, 'remember: A fictional Alex fact.');
    await inbound(env, 'remember: A fictional Sam fact.', 'mock-sam');
    const cookie = await session(env);
    const summary = await call(env, '/api/account?userId=u_sam', { headers: { cookie } });
    expect(summary.status).toBe(200);
    expect(await summary.json()).toMatchObject({ user: { id: 'u_alex' }, counts: { memories: 1 }, authentication: 'development_invitation' });
    const response = await call(env, '/api/account/export?userId=u_sam', { headers: { cookie } });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toContain('attachment');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const text = await response.text();
    expect(text).toContain('A fictional Alex fact.');
    expect(text).not.toContain('A fictional Sam fact.');
    for (const secret of [inviteAlex, inviteSam, env.OPERATOR_TOKEN, env.MOCK_WEBHOOK_SECRET, env.CONTENT_ENCRYPTION_KEY]) expect(text).not.toContain(secret);
    expect(text).not.toContain('token_hash');
    expect((await call(env, '/api/account/export')).status).toBe(401);
    expect((await call(env, '/api/account/export?after=-1', { headers: { cookie } })).status).toBe(400);
  });

  it('paginates transcript content in bounded pages without leaking another user', async () => {
    const env = runtime();
    const accepted = await inbound(env, 'Pagination starts here.');
    const encrypted = await encryptText('A fictional exported message.', env.CONTENT_ENCRYPTION_KEY);
    await env.DB.batch(Array.from({ length: 104 }, (_, index) => env.DB.prepare(`INSERT INTO messages(id,conversation_id,role,body_ciphertext,status,created_at)
      VALUES (?,?,'user',?,'processed',?)`).bind(`export_fixture_${index}`, accepted.conversationId, encrypted, Date.now())));
    const first = await exportAccountPage(env, 'u_alex');
    expect(first.messages).toHaveLength(100);
    expect(first.nextCursor).not.toBeNull();
    const second = await exportAccountPage(env, 'u_alex', first.nextCursor!);
    expect(second.messages).toHaveLength(5);
    expect(second.nextCursor).toBeNull();
    expect(second).not.toHaveProperty('controls');
    expect(new Set([...first.messages, ...second.messages].map((message) => message.id)).size).toBe(105);
  });
  it('does not return captured plaintext if privacy changes during export decryption', async () => {
    const env = runtime();
    await inbound(env, 'remember: A fictional fact before the export.');
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const reached = new Promise<void>((resolve) => { entered = resolve; });
    const original = crypto.subtle.decrypt.bind(crypto.subtle);
    const decrypt = vi.spyOn(crypto.subtle, 'decrypt').mockImplementationOnce(async (...args) => {
      entered(); await blocked; return original(...args);
    });
    const pending = exportAccountPage(env, 'u_alex');
    try {
      await reached;
      await inbound(env, 'disable memory');
      release();
      await expect(pending).rejects.toMatchObject({ code: 'account_export_changed' });
    } finally { release(); decrypt.mockRestore(); }
  });

  it('requires exact confirmation and the same user invitation before issuing an erasure token', async () => {
    const env = runtime();
    await expect(createDeletionIntent(env, 'u_alex', inviteAlex, 'yes')).rejects.toMatchObject({ code: 'deletion_confirmation_required' });
    await expect(createDeletionIntent(env, 'u_alex', inviteSam, 'DELETE MY PLAUSE ACCOUNT')).rejects.toMatchObject({ code: 'reauthentication_required' });
    expect(await eraseAccount(env, 'u_alex', 'unissued-confirmation-token')).toBe(false);
    expect((await getAccountSummary(env, 'u_alex')).user.id).toBe('u_alex');
    const intent = await createDeletionIntent(env, 'u_alex', inviteAlex, 'DELETE MY PLAUSE ACCOUNT');
    expect(intent.confirmationToken.length).toBeGreaterThanOrEqual(32);
    expect(await eraseAccount(env, 'u_sam', intent.confirmationToken)).toBe(false);
    await env.DB.prepare('UPDATE account_deletion_intents SET expires_at=0').run();
    expect(await eraseAccount(env, 'u_alex', intent.confirmationToken)).toBe(false);
  });

  it('atomically erases local data and access while retaining only purged billing metadata', async () => {
    const env = runtime();
    const accepted = await inbound(env, 'remember: A local fact to erase.');
    await inbound(env, 'remind me in 5 minutes: A local reminder to erase.');
    await inbound(env, 'connect demo calendar');
    await inbound(env, `propose calendar event at ${new Date(Date.now() + 3_600_000).toISOString()} for 30 minutes: A local event to erase.`);
    const source = await env.DB.prepare("SELECT id FROM messages WHERE conversation_id=? AND role='user' ORDER BY rowid LIMIT 1").bind(accepted.conversationId).first<{ id: string }>();
    await env.DB.prepare(`INSERT INTO model_attempts(message_id,user_id,conversation_id,attempt_token,lease_token,ownership_version,input_digest,model,budget_month,
      reservation_micro_usd,budget_debit_micro_usd,state,response_ciphertext,input_tokens,output_tokens,created_at,updated_at)
      VALUES (?,'u_alex',?,'account-attempt','account-lease',0,'private-input-digest','gpt-6-luna','2026-10',1000,25,'completed',?,100,0,0,0)`)
      .bind(source!.id, accepted.conversationId, await encryptText('An obsolete personalized response.', env.CONTENT_ENCRYPTION_KEY)).run();
    const cookie = await session(env);
    const samCookie = await session(env, inviteSam);
    const intent = await call(env, '/api/account/deletion-intent', { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' },
      body: JSON.stringify({ inviteToken: inviteAlex, confirmation: 'DELETE MY PLAUSE ACCOUNT' }) });
    expect(intent.status).toBe(200);
    const { confirmationToken } = await intent.json() as { confirmationToken: string };
    const deleted = await call(env, '/api/account', { method: 'DELETE', headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify({ confirmationToken }) });
    expect(deleted.status).toBe(200);
    expect(deleted.headers.get('set-cookie')).toContain('Max-Age=0');
    for (const table of ['users', 'conversations', 'memories', 'reminders', 'action_approvals', 'demo_calendar_connections', 'demo_calendar_events']) {
      const ownerColumn = table === 'users' ? 'id' : 'user_id';
      expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${ownerColumn}='u_alex'`).first()).toEqual({ n: 0 });
    }
    expect(await env.DB.prepare('SELECT response_ciphertext,input_digest,state,budget_debit_micro_usd FROM model_attempts WHERE message_id=?').bind(source!.id).first())
      .toEqual({ response_ciphertext: null, input_digest: '', state: 'purged', budget_debit_micro_usd: 25 });
    expect((await call(env, '/api/me', { headers: { cookie } })).status).toBe(401);
    expect((await call(env, '/api/me', { headers: { cookie: samCookie } })).status).toBe(200);
    const login = await call(env, '/api/session', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ inviteToken: inviteAlex }) });
    expect(login.status).toBe(401);
    await expect(inbound(env, 'No longer enrolled.')).rejects.toMatchObject({ code: 'unknown_sender' });
  });

  it('rejects deletion requests from another origin before touching any state', async () => {
    const env = runtime();
    const cookie = await session(env);
    const response = await call(env, '/api/account/deletion-intent', { method: 'POST', headers: { cookie, origin: 'https://attacker.invalid', 'content-type': 'application/json' },
      body: JSON.stringify({ inviteToken: inviteAlex, confirmation: 'DELETE MY PLAUSE ACCOUNT' }) });
    expect(response.status).toBe(403);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM account_deletion_intents').first()).toEqual({ n: 0 });
  });

  it('erases Google grants and approval content while retaining a purged operation-quota tombstone', async () => {
    const env = runtime();
    const accepted = await inbound(env, 'Fictional Google source for erasure.');
    const source = await env.DB.prepare("SELECT id FROM messages WHERE conversation_id=? AND role='user'")
      .bind(accepted.conversationId).first<{ id: string }>();
    const args = JSON.stringify({ title: 'Fictional Google event to erase', startsAt: new Date(Date.now() + 86_400_000).toISOString(), durationMinutes: 30 });
    const { sha256 } = await import('../packages/security/src/index');
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO google_calendar_connections(user_id,revision,connected,status,scope,access_token_ciphertext,refresh_token_ciphertext,expires_at,created_at,updated_at)
        VALUES ('u_alex',0,1,'connected','https://www.googleapis.com/auth/calendar.events.owned',?,?,?,0,0)`)
        .bind(await encryptText('private-google-access', env.CONTENT_ENCRYPTION_KEY), await encryptText('private-google-refresh', env.CONTENT_ENCRYPTION_KEY), Date.now() + 3_600_000),
      env.DB.prepare(`INSERT INTO google_calendar_approvals(id,user_id,conversation_id,source_message_id,tool_name,arguments_ciphertext,arguments_digest,event_id,
        connection_revision,context_revision,state,expires_at,created_at,updated_at) VALUES ('gapproval_erasure','u_alex',?,?,'google_calendar.create',?,?,'p00000',0,0,'pending',?,0,0)`)
        .bind(accepted.conversationId, source!.id, await encryptText(args, env.CONTENT_ENCRYPTION_KEY), await sha256(args), Date.now() + 600_000),
      env.DB.prepare(`INSERT INTO google_calendar_requests(message_id,user_id,conversation_id,context_revision,connection_revision,approval_id,operation,day,counted,state,
        query_digest,result_ciphertext,attempt_token,created_at,updated_at) VALUES (?,'u_alex',?,0,0,'gapproval_erasure','list',?,1,'completed','private-digest',?,'erasure-request',0,0)`)
        .bind(source!.id, accepted.conversationId, new Date().toISOString().slice(0, 10), await encryptText('Private calendar result.', env.CONTENT_ENCRYPTION_KEY)),
    ]);
    expect((await getAccountSummary(env, 'u_alex')).counts.pendingApprovals).toBe(1);
    const archive = JSON.stringify(await exportAccountPage(env, 'u_alex'));
    expect(archive).toContain('Fictional Google event to erase');
    expect(archive).not.toContain('private-google-access');
    expect(archive).not.toContain('private-google-refresh');
    const intent = await createDeletionIntent(env, 'u_alex', inviteAlex, 'DELETE MY PLAUSE ACCOUNT');
    expect(intent.effect).toContain('cannot revoke a Google provider grant');
    expect(await eraseAccount(env, 'u_alex', intent.confirmationToken)).toBe(true);
    for (const table of ['google_calendar_connections', 'google_oauth_pending', 'google_calendar_approvals']) {
      expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id='u_alex'`).first()).toEqual({ n: 0 });
    }
    expect(await env.DB.prepare('SELECT counted,state,result_ciphertext,query_digest FROM google_calendar_requests WHERE message_id=?').bind(source!.id).first())
      .toEqual({ counted: 1, state: 'purged', result_ciphertext: null, query_digest: '' });
    expect(fetch).not.toHaveBeenCalled();
  });
});
