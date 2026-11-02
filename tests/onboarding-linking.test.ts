import { beforeEach, describe, expect, it, vi } from 'vitest';
import { startChannelLink, recordVerifiedChannelLink, confirmChannelLink, revokeChannelBinding } from '../apps/api/src/channel-linking';
import { recordOnboardingContact, processOnboarding } from '../apps/api/src/messaging-onboarding';
import { createSessionDeletionIntent } from '../apps/api/src/account';
import { requestErasure, recoverPrivacyOperations } from '../apps/api/src/privacy-ledger';
import { decryptText, randomToken, sha256 } from '../packages/security/src/index';
import type { Env } from '../packages/contracts/src/index';
import type { SunshineEvent } from '../packages/messaging-sunshine/src/index';
import { testEnv } from './setup';

const origin = 'https://staging.plause.app';
type OnboardingEnv = Env & { ONBOARDING_MESSAGES_ENABLED: string };
function configured(): OnboardingEnv {
  return { ...testEnv, APP_ENV: 'staging', PUBLIC_ORIGIN: origin, MODEL_PROVIDER: 'mock', MESSAGING_PROVIDER: 'sunshine',
    LIVE_MESSAGING_ENABLED: 'true', APPLE_CHANNEL_APPROVED: 'true', ONBOARDING_MESSAGES_ENABLED: 'true',
    AUTH_GOOGLE_ENABLED: 'true', AUTH_SIGNUP_ENABLED: 'true', AUTH_SIGNUP_SUBJECTS: '["synthetic-u_alex","synthetic-u_sam"]', AUTH_GOOGLE_CLIENT_ID: 'synthetic-onboarding.apps.googleusercontent.com',
    AUTH_GOOGLE_CLIENT_SECRET: 'synthetic-onboarding-client-secret', SUNSHINE_APP_ID: 'onboarding_app', SUNSHINE_SUBDOMAIN: 'plause-fixture',
    SUNSHINE_APPLE_INTEGRATION_ID: 'onboarding_apple', SUNSHINE_WEBHOOK_ID: 'onboarding_webhook',
    SUNSHINE_WEBHOOK_SECRET: 'synthetic-onboarding-webhook-secret', SUNSHINE_KEY_ID: 'onboarding_key',
    SUNSHINE_KEY_SECRET: 'synthetic-onboarding-provider-secret', SUNSHINE_BOT_SWITCHBOARD_ID: 'onboarding_bot' };
}
async function owner(env = configured(), userId = 'u_alex') {
  const token = randomToken(), identityId = `identity_${crypto.randomUUID()}`, now = Date.now();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO external_identities(id,user_id,issuer,subject,subject_digest,created_at) VALUES(?,?,'https://accounts.google.com',?,?,?)")
      .bind(identityId, userId, `synthetic-${userId}`, await sha256(`synthetic-${userId}`), now),
    env.DB.prepare("INSERT INTO sessions(token_hash,user_id,expires_at,auth_method,authenticated_at,identity_id) VALUES(?,?,?,'google',?,?)")
      .bind(await sha256(token), userId, now + 3_600_000, now, identityId),
  ]);
  return { env, userId, request: (method = 'POST') => new Request(`${origin}/api/channel-links`, { method,
    headers: { origin, cookie: `plause_session=${token}` } }) };
}
const source = (subjectId = 'opaque_onboarding_subject', providerConversationId = 'opaque_onboarding_thread', text = 'Hello from Messages.'):
  Extract<SunshineEvent, { type: 'message.received' }> => ({ type: 'message.received', eventId: crypto.randomUUID(),
    messageId: crypto.randomUUID(), businessId: 'onboarding_app', subject: { provider: 'sunshine', businessId: 'onboarding_app', subjectId },
    providerConversationId, channel: 'apple_business', occurredAt: new Date().toISOString(), control: 'bot', text });
async function prove(who: Awaited<ReturnType<typeof owner>>, event = source()) {
  const challenge = await startChannelLink(who.env, who.request(), who.userId, { replyConsent: true, proactiveConsent: false });
  const proof = { ...event.subject, channel: event.channel, eventId: event.eventId, code: challenge.code,
    providerConversationId: event.providerConversationId, occurredAt: event.occurredAt, control: event.control };
  await recordVerifiedChannelLink(who.env, proof);
  return { challenge, proof, event };
}
const notices = (env: Env) => env.DB.prepare('SELECT * FROM messaging_onboarding_notices ORDER BY rowid').all<Record<string, unknown>>();
function ledger(available: boolean): R2Bucket {
  const records = new Map<string, string>();
  return { put: async (key: string, value: string) => { if (!available) throw new Error('Fixture ledger unavailable.'); records.set(key, value); return {}; },
    get: async (key: string) => { const value = records.get(key); return value ? { size: value.length, json: async () => JSON.parse(value) as unknown } : null; },
  } as unknown as R2Bucket;
}
beforeEach(async () => { await testEnv.DB.batch([
  testEnv.DB.prepare('DELETE FROM messaging_onboarding_notices'), testEnv.DB.prepare('DELETE FROM messaging_onboarding_events'),
  testEnv.DB.prepare('DELETE FROM messaging_onboarding_contacts'), testEnv.DB.prepare('DELETE FROM messaging_onboarding_subjects'),
]); });

describe('Messages onboarding linked to explicit account authorization', () => {
  it('moves welcome to proof guidance to one confirmed linked acknowledgment without storing the private message or link code', async () => {
    const who = await owner(), first = source(undefined, undefined, 'PRIVATE MESSAGE NOT FOR A MODEL');
    await recordOnboardingContact(who.env, first);
    const { challenge, proof } = await prove(who, { ...first, eventId: crypto.randomUUID(), messageId: crypto.randomUUID() });
    expect(await who.env.DB.prepare("SELECT COUNT(*) AS n FROM bindings WHERE provider='sunshine'").first()).toEqual({ n: 0 });
    expect((await notices(who.env)).results.map((row) => [row.kind, row.status])).toEqual([['welcome','cancelled'],['proof_received','pending']]);
    expect(await who.env.DB.prepare('SELECT COUNT(*) AS n FROM messages').first()).toEqual({ n: 0 });
    const linked = await confirmChannelLink(who.env, who.request(), who.userId, challenge.id);
    await confirmChannelLink(who.env, who.request(), who.userId, challenge.id);
    expect((await notices(who.env)).results.map((row) => [row.kind, row.status])).toEqual([['welcome','cancelled'],['proof_received','cancelled'],['linked','pending']]);
    const contacts = await who.env.DB.prepare('SELECT * FROM messaging_onboarding_contacts').all<Record<string, unknown>>();
    expect(contacts.results).toHaveLength(1); expect(contacts.results[0]).toMatchObject({ user_id: who.userId, binding_id: linked.bindingId });
    const stored = JSON.stringify({ notices: (await notices(who.env)).results, contacts: contacts.results,
      events: (await who.env.DB.prepare('SELECT * FROM messaging_onboarding_events').all()).results });
    for (const privateValue of [challenge.code, first.text, proof.subjectId, proof.providerConversationId]) expect(stored).not.toContain(privateValue);
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ messages: [{ id: 'provider_linked_notice', author: { type: 'business' } }] }));
    expect(await processOnboarding(who.env, { fetchImpl })).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body)) as { content: { text: string } };
    expect(sent.content.text).toContain('is linked'); expect(sent.content.text).toContain(`${origin}/?onboarding=messages`);
    expect(sent.content.text).not.toContain(challenge.code); expect(sent.content.text).not.toContain(first.text);
    expect(await who.env.DB.prepare('SELECT COUNT(*) AS n FROM users').first()).toEqual({ n: 2 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('deduplicates its own proved event and rejects changed proof control without queuing another notice', async () => {
    const who = await owner(), { proof } = await prove(who);
    expect(await recordVerifiedChannelLink(who.env, proof)).toMatchObject({ duplicate: true });
    await expect(recordVerifiedChannelLink(who.env, { ...proof, control: 'human' })).rejects.toMatchObject({ status: 409 });
    expect((await notices(who.env)).results).toHaveLength(1);
    expect(await who.env.DB.prepare('SELECT COUNT(*) AS n FROM messaging_onboarding_events').first()).toEqual({ n: 1 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects reuse of a public welcome event as a possession proof', async () => {
    const who = await owner(), event = source(); await recordOnboardingContact(who.env, event);
    const challenge = await startChannelLink(who.env, who.request(), who.userId, { replyConsent: true, proactiveConsent: false });
    await expect(recordVerifiedChannelLink(who.env, { ...event.subject, channel: event.channel, eventId: event.eventId,
      code: challenge.code, providerConversationId: event.providerConversationId, occurredAt: event.occurredAt, control: event.control }))
      .rejects.toMatchObject({ code: 'provider_event_conflict', status: 409 });
    expect(await who.env.DB.prepare('SELECT status FROM channel_link_challenges WHERE id=?').bind(challenge.id).first()).toEqual({ status: 'pending' });
    expect((await notices(who.env)).results.map((row) => row.kind)).toEqual(['welcome']);
  });

  it.each(['human','unknown'] as const)('records possession under %s provider control without sending proof or linked notices', async (control) => {
    const who = await owner(), event = { ...source(), control }, { challenge } = await prove(who, event);
    await confirmChannelLink(who.env, who.request(), who.userId, challenge.id);
    const fetchImpl = vi.fn<typeof fetch>(async () => { throw new Error('No provider request should occur.'); });
    expect(await processOnboarding(who.env, { fetchImpl })).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled(); expect((await notices(who.env)).results).toHaveLength(0);
    expect(await who.env.DB.prepare("SELECT COUNT(*) AS n FROM bindings WHERE provider='sunshine' AND status='active'").first()).toEqual({ n: 1 });
  });

  it('revokes a claimed linked notice before HTTP while preserving unknown delivery and the consumed quota tombstone', async () => {
    const who = await owner(), { challenge } = await prove(who);
    const linked = await confirmChannelLink(who.env, who.request(), who.userId, challenge.id);
    const fetchImpl = vi.fn<typeof fetch>(async () => { throw new Error('No provider request should occur.'); }); let observedUnknown = false;
    await processOnboarding(who.env, { fetchImpl, beforeDispatch: async () => {
      await revokeChannelBinding(who.env, who.request('DELETE'), who.userId, linked.bindingId);
      observedUnknown = (await notices(who.env)).results.find((row) => row.kind === 'linked')!.status === 'delivery_unknown';
    } });
    expect(observedUnknown).toBe(true); expect(fetchImpl).not.toHaveBeenCalled();
    const retained = (await notices(who.env)).results.find((row) => row.kind === 'linked')!;
    expect(retained.status).toBe('delivery_unknown'); expect(retained.dispatched_at).toBeTypeOf('number');
    expect(await who.env.DB.prepare('SELECT routing_ciphertext,status FROM messaging_onboarding_contacts').first())
      .toEqual({ routing_ciphertext: null, status: 'revoked' });
    await processOnboarding(who.env, { fetchImpl }); expect(fetchImpl).not.toHaveBeenCalled();
    expect(await who.env.DB.prepare('SELECT COUNT(*) AS n FROM messaging_onboarding_events').first()).toEqual({ n: 1 });
  });

  it('purges unconfirmed proof routing immediately when independent erasure recording is pending', async () => {
    const who = await owner(), { challenge } = await prove(who);
    const intent = await createSessionDeletionIntent(who.env, who.request(), who.userId, 'DELETE MY PLAUSE ACCOUNT');
    const pendingEnv = { ...who.env, PRIVACY_LEDGER: ledger(false) };
    expect(await requestErasure(pendingEnv, who.userId, intent.confirmationToken)).toMatchObject({ deleted: false, pending: true });
    expect(await who.env.DB.prepare("SELECT status FROM users WHERE id='u_alex'").first()).toEqual({ status: 'disabled' });
    expect(await who.env.DB.prepare('SELECT routing_ciphertext,status FROM messaging_onboarding_contacts').first())
      .toEqual({ routing_ciphertext: null, status: 'revoked' });
    expect((await notices(who.env)).results.find((row) => row.kind === 'proof_received')!.status).toBe('cancelled');
    const fetchImpl = vi.fn<typeof fetch>(async () => { throw new Error('No provider request should occur.'); });
    await processOnboarding(pendingEnv, { fetchImpl }); expect(fetchImpl).not.toHaveBeenCalled();
    expect(await recoverPrivacyOperations({ ...who.env, PRIVACY_LEDGER: ledger(true) })).toBe(1);
    expect(await who.env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE id='u_alex'").first()).toEqual({ n: 0 });
    expect(await who.env.DB.prepare('SELECT COUNT(*) AS n FROM messaging_onboarding_events').first()).toEqual({ n: 1 });
    expect((await notices(who.env)).results).toHaveLength(1);
    expect(JSON.stringify((await notices(who.env)).results)).not.toContain(challenge.code);
  });

  it('fences erasure during linked dispatch and does not resurrect routing or welcome after a late ordinary callback', async () => {
    const who = await owner(), { challenge, event } = await prove(who);
    await confirmChannelLink(who.env, who.request(), who.userId, challenge.id);
    const intent = await createSessionDeletionIntent(who.env, who.request(), who.userId, 'DELETE MY PLAUSE ACCOUNT');
    const env = { ...who.env, PRIVACY_LEDGER: ledger(true) };
    const fetchImpl = vi.fn<typeof fetch>(async () => { throw new Error('No provider request should occur.'); });
    await processOnboarding(env, { fetchImpl, beforeDispatch: async () => {
      expect(await requestErasure(env, who.userId, intent.confirmationToken)).toMatchObject({ deleted: true, pending: false });
      expect((await notices(env)).results.find((row) => row.kind === 'linked')!.status).toBe('delivery_unknown');
    } });
    expect(fetchImpl).not.toHaveBeenCalled();
    await recordOnboardingContact(env, { ...event, eventId: crypto.randomUUID(), messageId: crypto.randomUUID(),
      text: 'PRIVATE LATE CALLBACK', occurredAt: new Date(Date.parse(event.occurredAt) + 1).toISOString() });
    await processOnboarding(env, { fetchImpl }); expect(fetchImpl).not.toHaveBeenCalled();
    const contacts = await env.DB.prepare('SELECT routing_ciphertext,status FROM messaging_onboarding_contacts').all();
    expect(contacts.results.every((row) => row.routing_ciphertext === null && row.status === 'revoked')).toBe(true);
    expect((await notices(env)).results.filter((row) => row.kind === 'welcome')).toHaveLength(0);
    expect((await notices(env)).results.find((row) => row.kind === 'linked')!.dispatched_at).toBeTypeOf('number');
  });

  it('revokes only the selected binding and leaves another channel subject on the same account untouched', async () => {
    const who = await owner(), first = await prove(who, source('first_subject','first_thread'));
    const firstBinding = await confirmChannelLink(who.env, who.request(), who.userId, first.challenge.id);
    const second = await prove(who, source('second_subject','second_thread'));
    const secondBinding = await confirmChannelLink(who.env, who.request(), who.userId, second.challenge.id);
    await revokeChannelBinding(who.env, who.request('DELETE'), who.userId, firstBinding.bindingId);
    const contacts = await who.env.DB.prepare('SELECT binding_id,routing_ciphertext,status FROM messaging_onboarding_contacts ORDER BY rowid')
      .all<{ binding_id: string; routing_ciphertext: string | null; status: string }>();
    expect(contacts.results[0]).toMatchObject({ binding_id: firstBinding.bindingId, routing_ciphertext: null, status: 'revoked' });
    expect(contacts.results[1]).toMatchObject({ binding_id: secondBinding.bindingId, status: 'active' });
    expect(contacts.results[1]!.routing_ciphertext).toBeTypeOf('string');
    expect(JSON.parse(await decryptText(contacts.results[1]!.routing_ciphertext!, who.env.CONTENT_ENCRYPTION_KEY)))
      .toMatchObject({ subjectId: 'second_subject', providerConversationId: 'second_thread' });
  });

  it('does not let a losing proof claimant erase the authoritative account’s linked routing', async () => {
    const firstOwner = await owner(), otherOwner = await owner(firstOwner.env, 'u_sam');
    const shared = source('shared_proof_subject','shared_proof_thread');
    const first = await prove(firstOwner, shared);
    const other = await prove(otherOwner, { ...shared, eventId: crypto.randomUUID(), messageId: crypto.randomUUID(),
      occurredAt: new Date(Date.parse(shared.occurredAt) + 1).toISOString() });
    const linked = await confirmChannelLink(firstOwner.env, firstOwner.request(), firstOwner.userId, first.challenge.id);
    await expect(confirmChannelLink(otherOwner.env, otherOwner.request(), otherOwner.userId, other.challenge.id))
      .rejects.toMatchObject({ status: 409 });
    const intent = await createSessionDeletionIntent(otherOwner.env, otherOwner.request(), otherOwner.userId, 'DELETE MY PLAUSE ACCOUNT');
    expect(await requestErasure({ ...otherOwner.env, PRIVACY_LEDGER: ledger(true) }, otherOwner.userId, intent.confirmationToken))
      .toMatchObject({ deleted: true, pending: false });
    const contacts = await firstOwner.env.DB.prepare('SELECT user_id,binding_id,routing_ciphertext,status FROM messaging_onboarding_contacts')
      .all<{ user_id: string; binding_id: string; routing_ciphertext: string | null; status: string }>();
    expect(contacts.results).toHaveLength(1);
    expect(contacts.results[0]).toMatchObject({ user_id: firstOwner.userId, binding_id: linked.bindingId, status: 'active' });
    expect(contacts.results[0]!.routing_ciphertext).toBeTypeOf('string');
    expect((await notices(firstOwner.env)).results.find((row) => row.kind === 'linked')).toMatchObject({ user_id: firstOwner.userId, status: 'pending' });
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ messages: [{ id: 'provider_authoritative_link', author: { type: 'business' } }] }));
    expect(await processOnboarding(firstOwner.env, { fetchImpl })).toBe(1); expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(await firstOwner.env.DB.prepare("SELECT user_id,status FROM bindings WHERE id=?").bind(linked.bindingId).first())
      .toEqual({ user_id: firstOwner.userId, status: 'active' });
    expect(fetch).not.toHaveBeenCalled();
  });
});
