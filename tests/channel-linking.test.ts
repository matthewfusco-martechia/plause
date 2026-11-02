import { describe, expect, it, vi } from 'vitest';
import { confirmChannelLink, getChannelLink, listChannelBindings, parseChannelLinkCommand, recordVerifiedChannelLink,
  revokeChannelBinding, startChannelLink } from '../apps/api/src/channel-linking';
import { login } from '../apps/api/src/auth';
import { ingestEvent, processConversation } from '../apps/api/src/pipeline';
import { resolveBinding } from '../apps/api/src/store';
import { encryptText, randomToken, sha256 } from '../packages/security/src/index';
import type { Env, MessagingEvent, QueueJob } from '../packages/contracts/src/index';
import { inviteAlex, inviteSam, testEnv } from './setup';

const origin = 'http://localhost:8787';
const envFor = (overrides: Partial<Env> = {}): Env => ({ ...testEnv, PUBLIC_ORIGIN: origin,
  JOBS: { send: async (_job: QueueJob) => {} } as unknown as Queue<QueueJob>, ...overrides });
async function browser(env = envFor(), userId = 'u_alex') {
  const signed = await login(env, userId === 'u_alex' ? inviteAlex : inviteSam); expect(signed).not.toBeNull();
  const request = (method = 'POST') => new Request(`${origin}/api/channel-links`, { method,
    headers: { origin, cookie: `plause_session=${signed!.token}` } });
  return { env, userId, token: signed!.token, request };
}
async function begin(env = envFor(), userId = 'u_alex', proactiveConsent = false) {
  const owner = await browser(env, userId);
  const link = await startChannelLink(env, owner.request(), userId, { replyConsent: true, proactiveConsent });
  return { ...owner, ...link };
}
function proof(code: string, subjectId = `unbound_${crypto.randomUUID()}`) {
  return { provider: 'mock' as const, businessId: 'plause-local', subjectId, channel: 'mock' as const, eventId: crypto.randomUUID(), code };
}
async function linked(env = envFor()) {
  const link = await begin(env); const source = proof(link.code);
  await recordVerifiedChannelLink(env, source);
  const result = await confirmChannelLink(env, link.request(), link.userId, link.id);
  return { ...link, source, result };
}
const event = (subjectId: string, text: string): Extract<MessagingEvent, { type: 'message.received' }> => ({
  schemaVersion: 1, type: 'message.received', eventId: crypto.randomUUID(), messageId: crypto.randomUUID(),
  subject: { provider: 'mock', businessId: 'plause-local', subjectId }, channel: 'mock', occurredAt: new Date().toISOString(), text,
});

describe('possession-proven channel linking', () => {
  it('parses only the exact unquoted single-line handshake and preserves case-sensitive secrets', () => {
    const code = 'AaZz0123_-'.repeat(4) + 'AbC';
    expect(parseChannelLinkCommand(`LINK PLAUSE ${code}`)).toEqual({ type: 'prove', code });
    expect(parseChannelLinkCommand(`link plause ${code}\n`)).toEqual({ type: 'invalid' });
    expect(parseChannelLinkCommand('link plause bad')).toEqual({ type: 'invalid' });
    expect(parseChannelLinkCommand(`"link plause ${code}"`)).toBeNull();
    expect(parseChannelLinkCommand(`Please link plause ${code}`)).toBeNull();
  });

  it('grants no channel privilege until both a verified event and original web-session confirmation exist', async () => {
    const link = await begin(); const source = { ...proof(link.code), providerConversationId: 'trusted-mock-thread' };
    expect(link.expiresAt - Date.now()).toBeGreaterThan(290_000);
    const row = await link.env.DB.prepare('SELECT code_hash FROM channel_link_challenges WHERE id=?').bind(link.id).first<{ code_hash: string }>();
    expect(row!.code_hash).toBe(await sha256(link.code)); expect(JSON.stringify(row)).not.toContain(link.code);
    await expect(resolveBinding(link.env, source, 'mock')).rejects.toMatchObject({ code: 'unknown_sender' });
    await expect(confirmChannelLink(link.env, link.request(), link.userId, link.id)).rejects.toMatchObject({ code: 'channel_link_conflict' });
    await recordVerifiedChannelLink(link.env, source);
    const status = await getChannelLink(link.env, link.request('GET'), link.userId, link.id);
    expect(status).toMatchObject({ id: link.id, status: 'proved', replyConsent: true, proactiveConsent: false,
      proof: { provider: 'mock', channel: 'mock', businessId: 'plause-local' } });
    expect(JSON.stringify(status)).not.toContain(link.code); expect(JSON.stringify(status)).not.toContain(source.subjectId);
    await expect(resolveBinding(link.env, source, 'mock')).rejects.toMatchObject({ code: 'unknown_sender' });
    expect(await link.env.DB.prepare('SELECT COUNT(*) AS n FROM messages').first()).toEqual({ n: 0 });
    const confirmed = await confirmChannelLink(link.env, link.request(), link.userId, link.id);
    const conversation = await resolveBinding(link.env, source, 'mock'); expect(conversation.user_id).toBe(link.userId);
    expect(await link.env.DB.prepare('SELECT provider_conversation_id,proactive_consent_at FROM bindings WHERE id=?').bind(confirmed.bindingId).first())
      .toEqual({ provider_conversation_id: 'trusted-mock-thread', proactive_consent_at: null });
    expect(await recordVerifiedChannelLink(link.env, source)).toMatchObject({ duplicate: true });
    expect(await confirmChannelLink(link.env, link.request(), link.userId, link.id)).toEqual(confirmed);
    await link.env.DB.prepare('UPDATE channel_link_challenges SET expires_at=0 WHERE id=?').bind(link.id).run();
    expect(await recordVerifiedChannelLink(link.env, source)).toMatchObject({ duplicate: true });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('records proactive consent separately from reply consent', async () => {
    const link = await begin(envFor(), 'u_alex', true); await recordVerifiedChannelLink(link.env, proof(link.code));
    const confirmed = await confirmChannelLink(link.env, link.request(), link.userId, link.id);
    const bindings = await listChannelBindings(link.env, 'u_alex'); const item = bindings.bindings.find((row) => row.id === confirmed.bindingId)!;
    expect(item.replyConsentAt).toBeTypeOf('number'); expect(item.proactiveConsentAt).toBeTypeOf('number');
  });

  it.each(['other_account', 'other_session', 'expired', 'logged_out', 'stale_confirmation'] as const)
    ('rejects %s confirmation without binding or account reassignment', async (condition) => {
      const link = await begin(); await recordVerifiedChannelLink(link.env, proof(link.code));
      let userId = link.userId; let request = link.request();
      if (condition === 'other_account' || condition === 'other_session') {
        const other = await browser(link.env, condition === 'other_account' ? 'u_sam' : 'u_alex'); userId = other.userId; request = other.request();
      }
      if (condition === 'expired') await link.env.DB.prepare('UPDATE channel_link_challenges SET expires_at=0 WHERE id=?').bind(link.id).run();
      if (condition === 'logged_out') await link.env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await sha256(link.token)).run();
      if (condition === 'stale_confirmation') await link.env.DB.prepare('UPDATE sessions SET authenticated_at=0 WHERE token_hash=?').bind(await sha256(link.token)).run();
      await expect(confirmChannelLink(link.env, request, userId, link.id)).rejects.toMatchObject({ code: expect.stringMatching(/^(channel_|identity_)/) });
      expect(await link.env.DB.prepare('SELECT COUNT(*) AS n FROM bindings WHERE verified_at IS NOT NULL').first()).toEqual({ n: 0 });
    });

  it('never takes an active or revoked channel away from another account', async () => {
    for (const status of ['active', 'revoked']) {
      const link = await begin();
      await link.env.DB.prepare("UPDATE bindings SET status=? WHERE subject_id='mock-sam'").bind(status).run();
      await expect(recordVerifiedChannelLink(link.env, proof(link.code, 'mock-sam'))).rejects.toMatchObject({ code: 'channel_proof_conflict' });
      expect(await link.env.DB.prepare("SELECT user_id,status FROM bindings WHERE subject_id='mock-sam'").first()).toEqual({ user_id: 'u_sam', status });
    }
  });

  it('invalidates earlier link codes and never replaces the first proved subject with a second event', async () => {
    const link = await begin(); const first = proof(link.code); await recordVerifiedChannelLink(link.env, first);
    await expect(recordVerifiedChannelLink(link.env, proof(link.code))).rejects.toMatchObject({ code: 'channel_proof_conflict' });
    const replacement = await startChannelLink(link.env, link.request(), link.userId, { replyConsent: true, proactiveConsent: false });
    await expect(recordVerifiedChannelLink(link.env, first)).rejects.toMatchObject({ code: 'channel_link_expired' });
    expect((await getChannelLink(link.env, link.request('GET'), link.userId, replacement.id)).status).toBe('pending');
  });

  it('does not permit consent omission, cross-origin starts, or locally fabricated Sunshine proof', async () => {
    const owner = await browser();
    await expect(startChannelLink(owner.env, owner.request(), owner.userId, { replyConsent: false, proactiveConsent: false })).rejects.toMatchObject({ code: 'channel_consent_required' });
    const request = new Request(owner.request(), { headers: { origin: 'https://attacker.invalid', cookie: `plause_session=${owner.token}` } });
    await expect(startChannelLink(owner.env, request, owner.userId, { replyConsent: true, proactiveConsent: false })).rejects.toMatchObject({ code: 'origin_rejected' });
    const link = await begin();
    await expect(recordVerifiedChannelLink(link.env, { ...proof(link.code), provider: 'sunshine', channel: 'apple_business', providerConversationId: 'provider-thread' }))
      .rejects.toMatchObject({ code: 'channel_proof_invalid' });
  });

  it('atomically confirms one binding under concurrent retries', async () => {
    const link = await begin(); const source = proof(link.code); await recordVerifiedChannelLink(link.env, source);
    const results = await Promise.allSettled([confirmChannelLink(link.env, link.request(), link.userId, link.id), confirmChannelLink(link.env, link.request(), link.userId, link.id)]);
    expect(results.some((result) => result.status === 'fulfilled')).toBe(true);
    expect(await link.env.DB.prepare('SELECT COUNT(*) AS n FROM bindings WHERE subject_id=?').bind(source.subjectId).first()).toEqual({ n: 1 });
    expect(await link.env.DB.prepare('SELECT status FROM channel_link_challenges WHERE id=?').bind(link.id).first()).toEqual({ status: 'consumed' });
  });

  it('does not confirm a binding when restore lock arrives during asynchronous session proof', async () => {
    const link = await begin(); await recordVerifiedChannelLink(link.env, proof(link.code));
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void; const observed = new Promise<void>((resolve) => { entered = resolve; });
    const original = crypto.subtle.digest.bind(crypto.subtle);
    const digest = vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (...args) => { entered(); await gate; return original(...args); });
    const pending = confirmChannelLink(link.env, link.request(), link.userId, link.id).catch((cause: unknown) => cause);
    try {
      await observed;
      await link.env.DB.prepare("INSERT INTO system_settings(key,value) VALUES('restore_locked','true')").run();
    } finally { release(); }
    try {
      expect(await pending).toMatchObject({ code: 'channel_link_conflict' });
      expect(await link.env.DB.prepare('SELECT COUNT(*) AS n FROM bindings WHERE verified_at IS NOT NULL').first()).toEqual({ n: 0 });
      expect(await link.env.DB.prepare('SELECT status FROM channel_link_challenges WHERE id=?').bind(link.id).first()).toEqual({ status: 'proved' });
    } finally { digest.mockRestore(); }
  });

  it('deduplicates concurrent verified events and sanitizes an event reused for another challenge', async () => {
    const link = await begin(); const source = proof(link.code);
    const replies = await Promise.all([recordVerifiedChannelLink(link.env, source), recordVerifiedChannelLink(link.env, source)]);
    expect(replies.every((reply) => reply.proved)).toBe(true);
    expect(replies.filter((reply) => !reply.duplicate)).toHaveLength(1);
    const other = await begin(link.env, 'u_sam');
    await expect(recordVerifiedChannelLink(link.env, { ...proof(other.code), eventId: source.eventId }))
      .rejects.toMatchObject({ code: 'channel_proof_conflict', status: 409 });
    expect((await getChannelLink(link.env, other.request('GET'), other.userId, other.id)).status).toBe('pending');
  });

  it.each(['webhook','lifecycle'] as const)('rejects a link proof whose event ID already belongs to a %s event', async (kind) => {
    const link = await begin(), source = proof(link.code);
    if (kind === 'webhook') await ingestEvent(link.env, { ...event('mock-alex', 'Ordinary previously accepted text.'), eventId: source.eventId });
    else {
      const conversation = await resolveBinding(link.env, { provider: 'mock', businessId: 'plause-local', subjectId: 'mock-alex' }, 'mock');
      await link.env.DB.prepare(`INSERT INTO provider_lifecycle_events(provider,business_id,event_id,conversation_id,payload_hash,mutation_token,received_at)
        VALUES('mock','plause-local',?,?,'opaque-digest','opaque-operation',?)`).bind(source.eventId, conversation.id, Date.now()).run();
    }
    await expect(recordVerifiedChannelLink(link.env, source)).rejects.toMatchObject({ code: 'provider_event_conflict', status: 409 });
    expect((await getChannelLink(link.env, link.request('GET'), link.userId, link.id)).status).toBe('pending');
    await expect(resolveBinding(link.env, source, 'mock')).rejects.toMatchObject({ code: 'unknown_sender' });
  });

  it('revokes a linked channel while model work is inflight and never commits its stale result', async () => {
    const link = await linked(); const accepted = await ingestEvent(link.env, event(link.source.subjectId, 'An ordinary private question.'));
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    const model = { generate: vi.fn(async () => { await gate; return { text: 'This stale result must never appear.', inputTokens: 1, outputTokens: 1 }; }) };
    const pending = processConversation(link.env, accepted.conversationId, { model });
    try { await vi.waitFor(() => expect(model.generate).toHaveBeenCalledTimes(1));
      await revokeChannelBinding(link.env, link.request('DELETE'), link.userId, link.result.bindingId);
    } finally { release(); }
    await pending;
    expect(await link.env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE conversation_id=? AND role='assistant'").bind(accepted.conversationId).first()).toEqual({ n: 0 });
    await expect(ingestEvent(link.env, event(link.source.subjectId, 'A later request.'))).rejects.toMatchObject({ code: 'unknown_sender' });
    expect((await listChannelBindings(link.env, link.userId)).bindings.find((row) => row.id === link.result.bindingId)).toMatchObject({ status: 'revoked' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('revokes immediately before dispatch with honest inflight status and no accepted mock receipt', async () => {
    const link = await linked(); const source = event(link.source.subjectId, 'Queue one answer.');
    const accepted = await ingestEvent(link.env, source); let observedUnknown = false;
    const model = { generate: vi.fn(async () => ({ text: 'A queued answer.', inputTokens: 1, outputTokens: 1 })) };
    await processConversation(link.env, accepted.conversationId, { model, beforeDispatch: async () => {
      await revokeChannelBinding(link.env, link.request('DELETE'), link.userId, link.result.bindingId);
      const row = await link.env.DB.prepare("SELECT status FROM messages WHERE conversation_id=? AND role='assistant'").bind(accepted.conversationId).first<{ status: string }>();
      observedUnknown = row?.status === 'delivery_unknown';
    } });
    expect(observedUnknown).toBe(true);
    expect(await link.env.DB.prepare('SELECT COUNT(*) AS n FROM mock_receipts').first()).toEqual({ n: 0 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fences an inflight model when the same account proves a new provider destination', async () => {
    const link = await linked(); const accepted = await ingestEvent(link.env, event(link.source.subjectId, 'Private request from the old thread.'));
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    const model = { generate: vi.fn(async () => { await gate; return { text: 'Old private result.', inputTokens: 1, outputTokens: 1 }; }) };
    const pending = processConversation(link.env, accepted.conversationId, { model });
    try {
      await vi.waitFor(() => expect(model.generate).toHaveBeenCalledTimes(1));
      const changed = await startChannelLink(link.env, link.request(), link.userId, { replyConsent: true, proactiveConsent: false });
      await recordVerifiedChannelLink(link.env, { ...proof(changed.code, link.source.subjectId), providerConversationId: 'new-provider-thread' });
      await confirmChannelLink(link.env, link.request(), link.userId, changed.id);
    } finally { release(); }
    await pending;
    expect(await link.env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE conversation_id=? AND role='assistant'").bind(accepted.conversationId).first()).toEqual({ n: 0 });
    expect(await link.env.DB.prepare('SELECT status FROM conversations WHERE id=?').bind(accepted.conversationId).first()).toEqual({ status: 'closed' });
    const fresh = await ingestEvent(link.env, event(link.source.subjectId, 'A fresh request in the new thread.'));
    await processConversation(link.env, fresh.conversationId, { model: { generate: async () => ({ text: 'Fresh answer.', inputTokens: 1, outputTokens: 1 }) } });
    expect(await link.env.DB.prepare('SELECT COUNT(*) AS n FROM mock_receipts').first()).toEqual({ n: 1 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('never redirects an already queued reply during a same-account destination change, and clears claims/frozen provider data', async () => {
    const link = await linked(), accepted = await ingestEvent(link.env, event(link.source.subjectId, 'Private old-thread request.'));
    const original = await link.env.DB.prepare('SELECT ownership_version FROM conversations WHERE id=?').bind(accepted.conversationId).first<{ ownership_version: number }>();
    await link.env.DB.prepare(`INSERT INTO support_claims(conversation_id,operator_user_id,grant_revision,claim_version,expires_at,mutation_token,created_at,updated_at)
      VALUES(?,'u_sam',1,1,?,'old-claim',0,0)`).bind(accepted.conversationId, Date.now() + 300_000).run();
    let observedUnknown = false;
    await processConversation(link.env, accepted.conversationId, { model: { generate: async () => ({ text: 'Private old-thread answer.', inputTokens: 1, outputTokens: 1 }) },
      beforeDispatch: async () => {
        await link.env.DB.prepare('UPDATE outbound_jobs SET provider_request_ciphertext=? WHERE conversation_id=?')
          .bind(await encryptText('Old frozen provider request.', link.env.CONTENT_ENCRYPTION_KEY), accepted.conversationId).run();
        const changed = await startChannelLink(link.env, link.request(), link.userId, { replyConsent: true, proactiveConsent: false });
        await recordVerifiedChannelLink(link.env, { ...proof(changed.code, link.source.subjectId), providerConversationId: 'replacement-thread' });
        await confirmChannelLink(link.env, link.request(), link.userId, changed.id);
        const queued = await link.env.DB.prepare('SELECT status,provider_request_ciphertext FROM outbound_jobs WHERE conversation_id=?')
          .bind(accepted.conversationId).first<{ status: string; provider_request_ciphertext: string | null }>();
        observedUnknown = queued?.status === 'delivery_unknown'; expect(queued?.provider_request_ciphertext).toBeNull();
      } });
    expect(observedUnknown).toBe(true);
    expect(await link.env.DB.prepare('SELECT COUNT(*) AS n FROM mock_receipts').first()).toEqual({ n: 0 });
    expect(await link.env.DB.prepare('SELECT operator_user_id,expires_at,claim_version FROM support_claims WHERE conversation_id=?').bind(accepted.conversationId).first())
      .toEqual({ operator_user_id: null, expires_at: 0, claim_version: 2 });
    const fenced = await link.env.DB.prepare('SELECT ownership_version,status FROM conversations WHERE id=?').bind(accepted.conversationId).first<{ ownership_version: number; status: string }>();
    expect(fenced!.ownership_version).toBeGreaterThan(original!.ownership_version); expect(fenced!.status).toBe('closed');
    const fresh = await ingestEvent(link.env, event(link.source.subjectId, 'Fresh replacement-thread request.'));
    await processConversation(link.env, fresh.conversationId, { model: { generate: async () => ({ text: 'Fresh reply.', inputTokens: 1, outputTokens: 1 }) } });
    expect(await link.env.DB.prepare('SELECT COUNT(*) AS n FROM mock_receipts').first()).toEqual({ n: 1 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uses recent OIDC proof and trusted provider destination in cloud mode, with no phone/email identity claim', async () => {
    const env = envFor({ APP_ENV: 'production', PUBLIC_ORIGIN: 'https://plause.example.com', MESSAGING_PROVIDER: 'sunshine',
      LIVE_MESSAGING_ENABLED: 'true', APPLE_CHANNEL_APPROVED: 'true', SUNSHINE_APP_ID: 'trusted-app-id' });
    const token = randomToken(); const identityId = `identity_${crypto.randomUUID()}`;
    await env.DB.batch([
      env.DB.prepare("INSERT INTO external_identities(id,user_id,issuer,subject,subject_digest,created_at) VALUES (?,'u_alex','https://accounts.google.com','cloud-subject','synthetic-cloud-digest',?)").bind(identityId, Date.now()),
      env.DB.prepare("INSERT INTO sessions(token_hash,user_id,expires_at,auth_method,authenticated_at,identity_id) VALUES (?,'u_alex',?,'google',?,?)")
        .bind(await sha256(token), Date.now() + 3_600_000, Date.now(), identityId),
    ]);
    const request = new Request('https://plause.example.com/api/channel-links', { method: 'POST', headers: { origin: 'https://plause.example.com', cookie: `plause_session=${token}` } });
    const link = await startChannelLink(env, request, 'u_alex', { replyConsent: true, proactiveConsent: false });
    const source = { provider: 'sunshine', businessId: 'trusted-app-id', subjectId: 'trusted-provider-user-id', channel: 'apple_business' as const,
      eventId: 'trusted-event-id', code: link.code, providerConversationId: 'trusted-provider-conversation-id', occurredAt: new Date().toISOString() };
    await expect(recordVerifiedChannelLink(env, { ...source, businessId: 'different-app-id' })).rejects.toMatchObject({ code: 'channel_proof_invalid' });
    await recordVerifiedChannelLink(env, source);
    const result = await confirmChannelLink(env, request, 'u_alex', link.id);
    expect(await env.DB.prepare('SELECT user_id,subject_id,provider_conversation_id FROM bindings WHERE id=?').bind(result.bindingId).first())
      .toEqual({ user_id: 'u_alex', subject_id: source.subjectId, provider_conversation_id: source.providerConversationId });
    expect(fetch).not.toHaveBeenCalled();
  });
});
