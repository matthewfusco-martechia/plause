import { describe, expect, it } from 'vitest';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../apps/api/src/index';
import { ingestEvent } from '../apps/api/src/pipeline';
import { getUserUsage } from '../apps/api/src/operations';
import type { Env, MessagingEvent, QueueJob } from '../packages/contracts/src/index';
import { inviteAlex, testEnv } from './setup';

function runtime(): Env { return { ...testEnv, JOBS: { send: async (_job: QueueJob) => {} } as unknown as Queue<QueueJob> }; }
async function inbound(env: Env, text: string) {
  const event: MessagingEvent = { schemaVersion: 1, type: 'message.received', eventId: crypto.randomUUID(), messageId: crypto.randomUUID(),
    subject: { provider: 'mock', businessId: 'plause-local', subjectId: 'mock-alex' }, channel: 'mock', occurredAt: new Date().toISOString(), text };
  return ingestEvent(env, event);
}
async function call(env: Env, path: string, init: RequestInit = {}) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request('http://localhost' + path, init) as Request<unknown, IncomingRequestCfProperties>, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

describe('bounded usage and operational visibility', () => {
  it('does not consume normal conversation quota for deterministic control messages', async () => {
    const env = runtime();
    await env.DB.prepare("UPDATE users SET daily_message_limit=1 WHERE id='u_alex'").run();
    for (const command of ['memory help', 'reminder help', 'action help']) await inbound(env, command);
    expect((await getUserUsage(env, 'u_alex')).chat).toEqual({ acceptedToday: 0, dailyLimit: 1, controlsExcluded: true });
    await inbound(env, 'A normal conversation request.');
    await expect(inbound(env, 'Another normal request.')).rejects.toMatchObject({ code: 'daily_limit' });
    expect((await getUserUsage(env, 'u_alex')).chat.acceptedToday).toBe(1);
  });

  it('keeps user estimates scoped and held charges visible without exposing another user', async () => {
    const env = runtime();
    const month = new Date().toISOString().slice(0, 7);
    await env.DB.prepare(`INSERT INTO model_attempts(message_id,user_id,conversation_id,attempt_token,lease_token,ownership_version,input_digest,model,budget_month,
      reservation_micro_usd,budget_debit_micro_usd,state,created_at,updated_at) VALUES ('opaque-billing','u_alex','opaque-conv','opaque-attempt','opaque-lease',0,'digest','gpt-6-luna',?,1324,1324,'unknown',0,0)`).bind(month).run();
    const alex = await getUserUsage(env, 'u_alex');
    expect(alex).toMatchObject({ estimateOnly: true, providerBillingAuthoritative: true, model: { attempts: 1, heldMicroUsd: 1324, debitedMicroUsd: 1324, remainingMicroUsd: 5_000_000 - 1324 } });
    expect((await getUserUsage(env, 'u_sam')).model).toMatchObject({ attempts: 0, heldMicroUsd: 0, debitedMicroUsd: 0 });
  });

  it('separates operator access from customer sessions and returns no content or credentials', async () => {
    const env = runtime();
    await inbound(env, 'A fictional secret message which must not be operational telemetry.');
    const login = await call(env, '/api/session', { method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/json' }, body: JSON.stringify({ inviteToken: inviteAlex }) });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    expect((await call(env, '/api/operator/status', { headers: { cookie } })).status).toBe(403);
    expect((await call(env, '/api/usage', { headers: { cookie } })).status).toBe(200);
    expect((await call(env, '/api/usage')).status).toBe(401);
    const status = await call(env, '/api/operator/status', { headers: { authorization: `Bearer ${env.OPERATOR_TOKEN}` } });
    expect(status.status).toBe(200);
    const text = await status.text();
    expect(text).toContain('oldestPendingAgeMs');
    expect(text).not.toContain('fictional secret message');
    for (const secret of [env.OPERATOR_TOKEN, env.CONTENT_ENCRYPTION_KEY, inviteAlex]) expect(text).not.toContain(secret);
  });
});
