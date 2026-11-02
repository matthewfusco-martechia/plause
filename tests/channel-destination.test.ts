import { describe, expect, it } from 'vitest';
import { confirmChannelLink, getChannelLink, recordVerifiedChannelLink, revokeChannelBinding, startChannelLink,
  type VerifiedChannelLink } from '../apps/api/src/channel-linking';
import { ingestSunshineEvent } from '../apps/api/src/sunshine-ingress';
import { getConversationView, resolveBinding } from '../apps/api/src/store';
import { encryptText, randomToken, sha256 } from '../packages/security/src/index';
import type { Env, QueueJob } from '../packages/contracts/src/index';
import { testEnv } from './setup';

const origin = 'https://staging.plause.app'; const businessId = 'fixture_apple_application';
function runtime(): Env {
  return { ...testEnv, APP_ENV: 'staging', PUBLIC_ORIGIN: origin, MESSAGING_PROVIDER: 'sunshine', MODEL_PROVIDER: 'mock',
    LIVE_MESSAGING_ENABLED: 'true', APPLE_CHANNEL_APPROVED: 'true', SUNSHINE_APP_ID: businessId,
    JOBS: { send: async (_job: QueueJob) => {} } as unknown as Queue<QueueJob> };
}
async function browser(env: Env, userId: string) {
  const token = randomToken(); const identityId = `identity_${crypto.randomUUID()}`; const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO external_identities(id,user_id,issuer,subject,subject_digest,created_at)
      VALUES(?,?,'https://accounts.google.com',?,?,?)`).bind(identityId, userId, `fixture_${identityId}`, await sha256(identityId), now),
    env.DB.prepare(`INSERT INTO sessions(token_hash,user_id,expires_at,auth_method,authenticated_at,identity_id)
      VALUES(?,?,?,'google',?,?)`).bind(await sha256(token), userId, now + 300_000, now, identityId),
  ]);
  return { userId, request: (method = 'POST') => new Request(`${origin}/api/channel-links`, {
    method, headers: { origin, cookie: `plause_session=${token}` } }) };
}
async function link(env: Env, userId: string, subjectId: string, destination = 'provider_shared_destination', occurredAt = new Date().toISOString()) {
  const owner = await browser(env, userId);
  const challenge = await startChannelLink(env, owner.request(), userId, { replyConsent: true, proactiveConsent: false });
  const proof: VerifiedChannelLink = { provider: 'sunshine', businessId, subjectId, channel: 'apple_business',
    eventId: `event_${crypto.randomUUID()}`, code: challenge.code, providerConversationId: destination, occurredAt };
  return { ...owner, ...challenge, proof };
}
async function confirmed(env: Env, userId = 'u_alex', subjectId = 'provider_alex', destination = 'provider_shared_destination') {
  const pending = await link(env, userId, subjectId, destination); await recordVerifiedChannelLink(env, pending.proof);
  const result = await confirmChannelLink(env, pending.request(), userId, pending.id);
  return { ...pending, result };
}

describe('One active account binding per provider conversation destination', () => {
  it('rejects a second account proof without exposing the owner or binding private work to it', async () => {
    const env = runtime(); const alex = await confirmed(env);
    const conversation = await resolveBinding(env, { provider: 'sunshine', businessId, subjectId: alex.proof.subjectId }, 'apple_business');
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO messages(id,conversation_id,role,body_ciphertext,status,created_at)
        VALUES('old_private_reply',?,'assistant',?,'queued',?)`).bind(conversation.id, await encryptText('Private Alex reply before another account links.', env.CONTENT_ENCRYPTION_KEY), now),
      env.DB.prepare(`INSERT INTO outbound_jobs(id,conversation_id,message_id,idempotency_key,status,ownership_version,next_attempt_at,created_at,updated_at,expires_at)
        VALUES('old_private_outbox',?,'old_private_reply','old-private-key','queued',0,?,?,?,?)`).bind(conversation.id, now, now, now, now + 60_000),
    ]);
    const sam = await link(env, 'u_sam', 'provider_sam');
    let error: unknown;
    try { await recordVerifiedChannelLink(env, sam.proof); } catch (cause) { error = cause; }
    expect(error).toMatchObject({ status: 409, code: 'channel_destination_in_use' });
    expect(String(error)).not.toContain('u_alex'); expect(String(error)).not.toContain('provider_alex');
    expect((await getChannelLink(env, sam.request('GET'), sam.userId, sam.id)).proof).toBeNull();
    expect(await getConversationView(env, 'u_sam', conversation.id)).toBeNull();
    await expect(resolveBinding(env, { provider: 'sunshine', businessId, subjectId: 'provider_sam' }, 'apple_business')).rejects.toMatchObject({ code: 'unknown_sender' });
    expect(await env.DB.prepare(`SELECT c.user_id,b.provider_conversation_id,o.status FROM outbound_jobs o
      JOIN conversations c ON c.id=o.conversation_id JOIN bindings b ON b.conversation_id=c.id WHERE o.id='old_private_outbox'`).first())
      .toEqual({ user_id: 'u_alex', provider_conversation_id: 'provider_shared_destination', status: 'queued' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('atomically allows one winner when two cloud proofs precede concurrent confirmations', async () => {
    const env = runtime(); const alex = await link(env, 'u_alex', 'provider_alex'); const sam = await link(env, 'u_sam', 'provider_sam');
    await Promise.all([recordVerifiedChannelLink(env, alex.proof), recordVerifiedChannelLink(env, sam.proof)]);
    const outcomes = await Promise.allSettled([
      confirmChannelLink(env, alex.request(), alex.userId, alex.id), confirmChannelLink(env, sam.request(), sam.userId, sam.id),
    ]);
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({ status: 'rejected', reason: { status: 409, code: 'channel_destination_in_use' } });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM bindings WHERE provider='sunshine' AND provider_conversation_id='provider_shared_destination' AND status='active'").first())
      .toEqual({ n: 1 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM channel_link_challenges WHERE status='consumed'").first()).toEqual({ n: 1 });
    expect(await env.DB.prepare("SELECT consumed_by FROM channel_link_challenges WHERE status='proved'").first()).toEqual({ consumed_by: null });
  });

  it('requires explicit revocation before a different subject/account can move the destination', async () => {
    const env = runtime(); const alex = await confirmed(env);
    const conversation = await resolveBinding(env, { provider: 'sunshine', businessId, subjectId: alex.proof.subjectId }, 'apple_business');
    const sam = await link(env, 'u_sam', 'provider_sam');
    await expect(recordVerifiedChannelLink(env, sam.proof)).rejects.toMatchObject({ code: 'channel_destination_in_use' });
    await revokeChannelBinding(env, alex.request('DELETE'), alex.userId, alex.result.bindingId);
    await recordVerifiedChannelLink(env, sam.proof); await confirmChannelLink(env, sam.request(), sam.userId, sam.id);
    expect(await env.DB.prepare('SELECT status FROM conversations WHERE id=?').bind(conversation.id).first()).toEqual({ status: 'closed' });
    expect(await env.DB.prepare("SELECT user_id,status FROM bindings WHERE provider='sunshine' ORDER BY user_id").all())
      .toMatchObject({ results: [{ user_id: 'u_alex', status: 'revoked' }, { user_id: 'u_sam', status: 'active' }] });
  });

  it('preserves same-subject owner retries while refusing another active subject of the same account', async () => {
    const env = runtime(); const alex = await confirmed(env);
    expect(await recordVerifiedChannelLink(env, alex.proof)).toMatchObject({ duplicate: true });
    expect(await confirmChannelLink(env, alex.request(), alex.userId, alex.id)).toEqual(alex.result);
    const another = await link(env, 'u_alex', 'different_provider_alex');
    await expect(recordVerifiedChannelLink(env, another.proof)).rejects.toMatchObject({ code: 'channel_destination_in_use' });
  });

  it('enforces the same invariant in SQLite while keeping distinct business scopes isolated', async () => {
    const env = runtime(); await confirmed(env);
    await expect(env.DB.prepare(`INSERT INTO bindings(provider,business_id,subject_id,user_id,channel,status,provider_conversation_id)
      VALUES('sunshine',?,'another_subject','u_sam','apple_business','active','provider_shared_destination')`).bind(businessId).run()).rejects.toThrow(/UNIQUE/);
    await env.DB.prepare(`INSERT INTO bindings(provider,business_id,subject_id,user_id,channel,status,provider_conversation_id)
      VALUES('sunshine','different_business','another_subject','u_sam','apple_business','active','provider_shared_destination')`).run();
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM bindings WHERE provider='sunshine' AND status='active'").first()).toEqual({ n: 2 });
  });

  it('fails the actual unique-index migration on legacy duplicates without silently modifying them', async () => {
    const migration = testEnv.TEST_MIGRATIONS.find((item) => item.name.includes('0018'))!;
    const query = migration.queries.join('\n').match(/CREATE UNIQUE INDEX active_provider_destination[\s\S]*?(?:;|$)/)![0]
      .replace('active_provider_destination', 'fixture_unique_provider_destination').replace(/ON bindings\b/, 'ON legacy_destination_fixture');
    await testEnv.DB.exec(`CREATE TABLE legacy_destination_fixture(provider TEXT,business_id TEXT,provider_conversation_id TEXT,status TEXT);
      INSERT INTO legacy_destination_fixture VALUES('sunshine','legacy-app','same-conversation','active'),('sunshine','legacy-app','same-conversation','active');`);
    try {
      await expect(testEnv.DB.prepare(query).run()).rejects.toThrow(/UNIQUE/);
      expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM legacy_destination_fixture').first()).toEqual({ n: 2 });
    } finally { await testEnv.DB.exec('DROP TABLE legacy_destination_fixture;'); }
  });
});

describe('Provider-clock linking replay bound', () => {
  it('stores the provider proof timestamp separately from server verification audit time', async () => {
    const env = runtime(); const providerAt = Date.now() - 120_000;
    const pending = await link(env, 'u_alex', 'provider_alex', 'provider_destination', new Date(providerAt).toISOString());
    await recordVerifiedChannelLink(env, pending.proof); await confirmChannelLink(env, pending.request(), pending.userId, pending.id);
    const row = await env.DB.prepare("SELECT verified_at,provider_proved_at FROM bindings WHERE provider='sunshine' AND subject_id='provider_alex'")
      .first<{ verified_at: number; provider_proved_at: number }>();
    expect(row!.provider_proved_at).toBe(providerAt); expect(row!.verified_at).toBeGreaterThan(providerAt + 100_000);
  });

  it.each([-120_000, 120_000])('accepts post-proof input and ignores older replays with provider clock skew %i', async (skew) => {
    const env = runtime(); const providerAt = Date.now() + skew;
    const pending = await link(env, 'u_alex', 'provider_clock_subject', 'provider_clock_destination', new Date(providerAt).toISOString());
    await recordVerifiedChannelLink(env, pending.proof); await confirmChannelLink(env, pending.request(), pending.userId, pending.id);
    const event = (at: number) => ({ type: 'message.received' as const, eventId: `event_${crypto.randomUUID()}`, occurredAt: new Date(at).toISOString(),
      businessId, channel: 'apple_business' as const, subject: { provider: 'sunshine' as const, businessId, subjectId: pending.proof.subjectId },
      providerConversationId: 'provider_clock_destination', messageId: `source_${crypto.randomUUID()}`, text: 'A new user turn after proving the link.', control: 'bot' as const });
    expect(await ingestSunshineEvent(env, event(providerAt - 1))).toMatchObject({ ignored: true });
    expect(await ingestSunshineEvent(env, event(providerAt + 1))).toMatchObject({ duplicate: false });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE role='user'").first()).toEqual({ n: 1 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('requires a valid authenticated provider timestamp and treats changed proof time as conflict', async () => {
    const env = runtime(); const pending = await link(env, 'u_alex', 'provider_alex');
    const missing = { ...pending.proof }; delete missing.occurredAt;
    await expect(recordVerifiedChannelLink(env, missing)).rejects.toMatchObject({ code: 'channel_proof_invalid' });
    await expect(recordVerifiedChannelLink(env, { ...pending.proof, occurredAt: 'not-a-date' })).rejects.toMatchObject({ code: 'channel_proof_invalid' });
    await recordVerifiedChannelLink(env, pending.proof);
    await expect(recordVerifiedChannelLink(env, { ...pending.proof, occurredAt: new Date(Date.parse(pending.proof.occurredAt!) + 1000).toISOString() }))
      .rejects.toMatchObject({ code: 'channel_proof_conflict' });
  });
});
