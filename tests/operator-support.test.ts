import { describe, expect, it, vi } from 'vitest';
import { getSessionProof, login, type SessionProof } from '../apps/api/src/auth';
import { claimSupportConversation, enqueueSupportReply, getOperatorCapabilities, getSupportConversation,
  getSupportCoverage, listOperatorGrants, listSupportInbox, releaseSupportClaim, renewSupportClaim,
  requireOperatorActor, resumeSupportConversation, setOperatorGrant, type OperatorActor } from '../apps/api/src/operator-support';
import { getWebConversation, setConversationMode } from '../apps/api/src/store';
import { processConversation } from '../apps/api/src/pipeline';
import { decryptText, encryptText, sha256 } from '../packages/security/src/index';
import { inviteAlex, inviteSam, testEnv } from './setup';

async function proof(userId = 'u_alex'): Promise<SessionProof> {
  const result = await login(testEnv, userId === 'u_alex' ? inviteAlex : inviteSam);
  return (await getSessionProof(testEnv, new Request('http://localhost/api/me', { headers: { cookie: `plause_session=${result!.token}` } })))!;
}
async function operator(userId = 'u_alex', role: 'admin' | 'support' = 'admin') {
  await testEnv.DB.prepare(`INSERT INTO operator_grants(user_id,role,revision,status,mutation_token,created_at,updated_at)
    VALUES (?,?,1,'active',?,0,0)`).bind(userId, role, crypto.randomUUID()).run();
  return requireOperatorActor(testEnv, await proof(userId));
}
async function human() {
  const conversationId = await getWebConversation(testEnv, 'u_sam');
  await setConversationMode(testEnv, 'u_sam', conversationId, 'human');
  return conversationId;
}
async function fixture() {
  const actor = await operator(), conversationId = await human();
  const claim = await claimSupportConversation(testEnv, actor, conversationId);
  return { actor, conversationId, claim };
}
const reply = (claimVersion: number, text = 'A fictional staff response.') => ({ text, claimVersion, clientMessageId: crypto.randomUUID() });

describe('operator identity and role capabilities', () => {
  it('defaults to no staff role and no claim access', async () => {
    expect(await getOperatorCapabilities(testEnv, null)).toMatchObject({ canSupport: false, role: null });
    expect(await getOperatorCapabilities(testEnv, await proof())).toMatchObject({ canSupport: false });
    await expect(requireOperatorActor(testEnv, await proof())).rejects.toMatchObject({ status: 403 });
    expect(getSupportCoverage(testEnv)).toEqual({ configured: false, hours: null, timeZone: null, contact: null, liveStaffingVerified: false });
  });
  it('requires a recent DB session and rejects forged proof data', async () => {
    const actor = await operator();
    await testEnv.DB.prepare('UPDATE sessions SET authenticated_at=0').run();
    await expect(requireOperatorActor(testEnv, { ...actor.proof, authenticatedAt: Date.now() })).rejects.toMatchObject({ code: 'identity_reauthentication_required' });
    expect(await getOperatorCapabilities(testEnv, actor.proof)).toMatchObject({ reauthenticationRequired: true });
    await expect(requireOperatorActor(testEnv, { ...actor.proof, tokenHash: 'forged' })).rejects.toMatchObject({ status: 401 });
  });
  it('accepts invitation fixtures only locally', async () => {
    const actor = await operator();
    await expect(requireOperatorActor({ ...testEnv, APP_ENV: 'production' }, actor.proof)).rejects.toMatchObject({ status: 401 });
  });
  it('bootstraps only verified exact Google subjects and never revives a revoked grant', async () => {
    const p = await proof(), identityId = crypto.randomUUID();
    await testEnv.DB.prepare(`INSERT INTO external_identities(id,user_id,issuer,subject,subject_digest,created_at)
      VALUES (?,'u_alex','https://accounts.google.com','GoogleCaseSensitive',?,0)`).bind(identityId, await sha256('fixture subject')).run();
    await testEnv.DB.prepare("UPDATE sessions SET auth_method='google',identity_id=? WHERE token_hash=?").bind(identityId, p.tokenHash).run();
    const cloud = { ...testEnv, APP_ENV: 'production', OPERATOR_BOOTSTRAP_SUBJECTS: '["googlecasesensitive"]' };
    await expect(requireOperatorActor(cloud, { ...p, identity: { issuer: 'https://accounts.google.com', subject: 'googlecasesensitive' } })).rejects.toMatchObject({ status: 403 });
    cloud.OPERATOR_BOOTSTRAP_SUBJECTS = '["GoogleCaseSensitive"]';
    const actor = await requireOperatorActor(cloud, p);
    expect(actor.role).toBe('admin');
    await setOperatorGrant(cloud, actor, { userId: actor.userId, role: null });
    await expect(requireOperatorActor(cloud, p)).rejects.toMatchObject({ status: 403 });
    expect(await testEnv.DB.prepare("SELECT status FROM operator_grants WHERE user_id='u_alex'").first()).toEqual({ status: 'revoked' });
  });
  it('allows admins to change roles but blocks support users and stale admin snapshots', async () => {
    const admin = await operator();
    expect(await setOperatorGrant(testEnv, admin, { userId: 'u_sam', role: 'support' })).toMatchObject({ revision: 1, role: 'support' });
    const staff = await requireOperatorActor(testEnv, await proof('u_sam'));
    await expect(listOperatorGrants(testEnv, staff)).rejects.toMatchObject({ status: 403 });
    await expect(setOperatorGrant(testEnv, staff, { userId: 'u_alex', role: 'support' })).rejects.toMatchObject({ status: 403 });
    expect((await listOperatorGrants(testEnv, admin)).grants).toHaveLength(2);
    await setOperatorGrant(testEnv, admin, { userId: 'u_alex', role: 'support' });
    await expect(listSupportInbox(testEnv, admin)).rejects.toMatchObject({ code: 'operator_access_changed' });
  });
  it('reports configured coverage without claiming actual live staffing', () => {
    expect(getSupportCoverage({ ...testEnv, SUPPORT_COVERAGE_ENABLED: 'true', SUPPORT_HOURS: 'Weekdays 09:00–17:00', SUPPORT_TIME_ZONE: 'America/New_York', SUPPORT_CONTACT: 'Local fixture support' }))
      .toMatchObject({ configured: true, liveStaffingVerified: false });
    expect(getSupportCoverage({ ...testEnv, SUPPORT_COVERAGE_ENABLED: 'true', SUPPORT_HOURS: 'hours', SUPPORT_TIME_ZONE: 'Invalid/Zone', SUPPORT_CONTACT: 'contact' }).configured).toBe(false);
  });
});
describe('leased support ownership and durable replies', () => {
  it.each(['human', 'unknown'])('keeps provider-%s conversations metadata-only and rejects a claim', async (control) => {
    const actor = await operator(), conversationId = await human();
    await testEnv.DB.prepare('UPDATE conversations SET provider_control=? WHERE id=?').bind(control, conversationId).run();
    expect((await listSupportInbox(testEnv, actor)).conversations[0]).toMatchObject({ providerControl: control, replyAvailable: false });
    await expect(claimSupportConversation(testEnv, actor, conversationId)).rejects.toMatchObject({ status: 409, code: 'support_provider_control_unavailable' });
    await expect(getSupportConversation(testEnv, actor, conversationId)).rejects.toMatchObject({ code: 'support_claim_unavailable' });
  });
  it.each(['human', 'unknown'])('blocks private reads, replies, renewal and resume when provider control becomes %s', async (control) => {
    const { actor, conversationId, claim } = await fixture();
    await testEnv.DB.prepare('UPDATE conversations SET provider_control=? WHERE id=?').bind(control, conversationId).run();
    for (const operation of [
      () => getSupportConversation(testEnv, actor, conversationId),
      () => enqueueSupportReply(testEnv, actor, conversationId, reply(claim.claimVersion)),
      () => renewSupportClaim(testEnv, actor, conversationId, claim.claimVersion),
      () => resumeSupportConversation(testEnv, actor, conversationId, claim.claimVersion),
    ]) await expect(operation()).rejects.toMatchObject({ status: 409, code: 'support_provider_control_unavailable' });
    expect(await testEnv.DB.prepare('SELECT mode FROM conversations WHERE id=?').bind(conversationId).first()).toEqual({ mode: 'human' });
    expect(await testEnv.DB.prepare("SELECT COUNT(*) AS count FROM messages WHERE model='plause-human'").first()).toEqual({ count: 0 });
  });
  it('lists human conversations only and requires claim before private transcript access', async () => {
    const actor = await operator();
    const bot = await getWebConversation(testEnv, 'u_alex'), conversationId = await human();
    expect((await listSupportInbox(testEnv, actor)).conversations.map((row) => row.conversationId)).toEqual([conversationId]);
    await expect(claimSupportConversation(testEnv, actor, bot)).rejects.toMatchObject({ code: 'support_claim_unavailable' });
    await expect(getSupportConversation(testEnv, actor, conversationId)).rejects.toMatchObject({ status: 409 });
    const claim = await claimSupportConversation(testEnv, actor, conversationId);
    expect(claim.expiresAt - Date.now()).toBeGreaterThan(295_000);
    expect(await claimSupportConversation(testEnv, actor, conversationId)).toEqual(claim);
    expect((await getSupportConversation(testEnv, actor, conversationId)).messages).toHaveLength(1);
  });
  it('prevents competing claims and permits a new monotonic claim after expiration', async () => {
    const { actor, conversationId, claim } = await fixture();
    await setOperatorGrant(testEnv, actor, { userId: 'u_sam', role: 'support' });
    const other = await requireOperatorActor(testEnv, await proof('u_sam'));
    await expect(claimSupportConversation(testEnv, other, conversationId)).rejects.toMatchObject({ status: 409 });
    await testEnv.DB.prepare('UPDATE support_claims SET expires_at=0 WHERE conversation_id=?').bind(conversationId).run();
    const taken = await claimSupportConversation(testEnv, other, conversationId);
    expect(taken.claimVersion).toBe(claim.claimVersion + 1);
    await expect(renewSupportClaim(testEnv, actor, conversationId, claim.claimVersion)).rejects.toMatchObject({ status: 409 });
  });
  it('queues an encrypted staff response once with immutable actor, claim and text digest', async () => {
    const { actor, conversationId, claim } = await fixture(), input = reply(claim.claimVersion, 'Raw\n  staff text preserved.');
    const created = await enqueueSupportReply(testEnv, actor, conversationId, input);
    expect(created).toMatchObject({ status: 'queued', duplicate: false });
    expect(await enqueueSupportReply(testEnv, actor, conversationId, input)).toMatchObject({ messageId: created.messageId, duplicate: true });
    await expect(enqueueSupportReply(testEnv, actor, conversationId, { ...input, text: 'Different' })).rejects.toMatchObject({ code: 'support_reply_conflict' });
    const row = await testEnv.DB.prepare('SELECT * FROM messages WHERE id=?').bind(created.messageId).first<Record<string, unknown>>();
    expect(row).toMatchObject({ model: 'plause-human', is_memory_control: 1, operator_user_id: actor.userId,
      operator_grant_revision: actor.grantRevision, support_claim_version: claim.claimVersion });
    expect(await decryptText(row!.body_ciphertext as string, testEnv.CONTENT_ENCRYPTION_KEY)).toBe(input.text);
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM outbound_jobs WHERE message_id=?').bind(created.messageId).first()).toEqual({ count: 1 });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('deduplicates concurrent identical requests without orphan messages', async () => {
    const { actor, conversationId, claim } = await fixture(), input = reply(claim.claimVersion);
    const results = await Promise.all([enqueueSupportReply(testEnv, actor, conversationId, input), enqueueSupportReply(testEnv, actor, conversationId, input)]);
    expect(new Set(results.map((row) => row.messageId)).size).toBe(1);
    expect(await testEnv.DB.prepare("SELECT COUNT(*) AS count FROM messages WHERE model='plause-human'").first()).toEqual({ count: 1 });
  });
  it('delivers through the normal mock outbox while conversation stays in human mode', async () => {
    const { actor, conversationId, claim } = await fixture();
    const created = await enqueueSupportReply(testEnv, actor, conversationId, reply(claim.claimVersion));
    await processConversation(testEnv, conversationId);
    expect(await testEnv.DB.prepare('SELECT status FROM messages WHERE id=?').bind(created.messageId).first()).toEqual({ status: 'delivered' });
    expect(await testEnv.DB.prepare('SELECT mode FROM conversations WHERE id=?').bind(conversationId).first()).toEqual({ mode: 'human' });
  });
  it('renew keeps the claim version and release cancels queued replies without resuming AI', async () => {
    const { actor, conversationId, claim } = await fixture();
    const renewed = await renewSupportClaim(testEnv, actor, conversationId, claim.claimVersion);
    expect(renewed.claimVersion).toBe(claim.claimVersion);
    const created = await enqueueSupportReply(testEnv, actor, conversationId, reply(claim.claimVersion));
    expect(await releaseSupportClaim(testEnv, actor, conversationId, claim.claimVersion)).toEqual({ ok: true, mode: 'human' });
    await processConversation(testEnv, conversationId);
    expect(await testEnv.DB.prepare('SELECT status FROM outbound_jobs WHERE message_id=?').bind(created.messageId).first()).toEqual({ status: 'cancelled' });
    await expect(enqueueSupportReply(testEnv, actor, conversationId, reply(claim.claimVersion))).rejects.toMatchObject({ status: 409 });
    expect((await claimSupportConversation(testEnv, actor, conversationId)).claimVersion).toBeGreaterThan(claim.claimVersion);
  });
  it('resume closes the claim and switches only this conversation back to the bot', async () => {
    const { actor, conversationId, claim } = await fixture();
    expect(await resumeSupportConversation(testEnv, actor, conversationId, claim.claimVersion)).toEqual({ ok: true, mode: 'bot' });
    await expect(getSupportConversation(testEnv, actor, conversationId)).rejects.toMatchObject({ status: 409 });
  });
  it('revoking an operator atomically invalidates claims, cancels queued replies and holds dispatched outcomes', async () => {
    const { actor, conversationId, claim } = await fixture();
    const queued = await enqueueSupportReply(testEnv, actor, conversationId, reply(claim.claimVersion));
    const sending = await enqueueSupportReply(testEnv, actor, conversationId, reply(claim.claimVersion));
    await testEnv.DB.prepare("UPDATE outbound_jobs SET status='sending' WHERE message_id=?").bind(sending.messageId).run();
    await setOperatorGrant(testEnv, actor, { userId: actor.userId, role: null });
    expect(await testEnv.DB.prepare('SELECT status FROM messages WHERE id=?').bind(queued.messageId).first()).toEqual({ status: 'cancelled' });
    expect(await testEnv.DB.prepare('SELECT status FROM outbound_jobs WHERE message_id=?').bind(sending.messageId).first()).toEqual({ status: 'delivery_unknown' });
    expect(await testEnv.DB.prepare('SELECT operator_user_id,expires_at FROM support_claims WHERE conversation_id=?').bind(conversationId).first()).toEqual({ operator_user_id: null, expires_at: 0 });
    await expect(getSupportConversation(testEnv, actor, conversationId)).rejects.toMatchObject({ status: 403 });
  });
  it('fences held encryption when the claim is released before insert', async () => {
    const { actor, conversationId, claim } = await fixture();
    const original = crypto.subtle.encrypt.bind(crypto.subtle);
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; }), ready = new Promise<void>((resolve) => { entered = resolve; });
    const spy = vi.spyOn(crypto.subtle, 'encrypt').mockImplementationOnce(async (...args) => { entered(); await held; return original(...args); });
    const pending = enqueueSupportReply(testEnv, actor, conversationId, reply(claim.claimVersion));
    await ready; await releaseSupportClaim(testEnv, actor, conversationId, claim.claimVersion); release();
    await expect(pending).rejects.toMatchObject({ status: 409 }); spy.mockRestore();
    expect(await testEnv.DB.prepare("SELECT COUNT(*) AS count FROM messages WHERE model='plause-human'").first()).toEqual({ count: 0 });
  });
  it('fences held reply encryption when provider ownership changes before insert', async () => {
    const { actor, conversationId, claim } = await fixture();
    const original = crypto.subtle.encrypt.bind(crypto.subtle);
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; }), ready = new Promise<void>((resolve) => { entered = resolve; });
    const spy = vi.spyOn(crypto.subtle, 'encrypt').mockImplementationOnce(async (...args) => { entered(); await held; return original(...args); });
    const pending = enqueueSupportReply(testEnv, actor, conversationId, reply(claim.claimVersion));
    try {
      await ready;
      await testEnv.DB.prepare("UPDATE conversations SET provider_control='human' WHERE id=?").bind(conversationId).run();
      release(); await expect(pending).rejects.toMatchObject({ code: 'support_provider_control_unavailable' });
      expect(await testEnv.DB.prepare("SELECT COUNT(*) AS count FROM messages WHERE model='plause-human'").first()).toEqual({ count: 0 });
    } finally { release(); spy.mockRestore(); }
  });
  it('fences private transcript decryption after claim release', async () => {
    const { actor, conversationId, claim } = await fixture();
    const original = crypto.subtle.decrypt.bind(crypto.subtle);
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; }), ready = new Promise<void>((resolve) => { entered = resolve; });
    const spy = vi.spyOn(crypto.subtle, 'decrypt').mockImplementationOnce(async (...args) => { entered(); await held; return original(...args); });
    const pending = getSupportConversation(testEnv, actor, conversationId);
    await ready; await releaseSupportClaim(testEnv, actor, conversationId, claim.claimVersion); release();
    await expect(pending).rejects.toMatchObject({ code: 'support_access_changed' }); spy.mockRestore();
  });
  it('paginates tied timestamps without dropping or repeating customer messages', async () => {
    const { actor, conversationId } = await fixture();
    const cipher = await encryptText('Fictional pagination text.', testEnv.CONTENT_ENCRYPTION_KEY);
    await testEnv.DB.batch(Array.from({ length: 110 }, () => testEnv.DB.prepare(`INSERT INTO messages(id,conversation_id,role,body_ciphertext,status,created_at)
      VALUES (?,?,'user',?,'received',1)`).bind(crypto.randomUUID(), conversationId, cipher)));
    const first = await getSupportConversation(testEnv, actor, conversationId);
    expect(first.messages).toHaveLength(100); expect(first.nextBefore).not.toBeNull();
    const second = await getSupportConversation(testEnv, actor, conversationId, first.nextBefore!);
    expect(second.messages).toHaveLength(11);
    expect(new Set([...first.messages, ...second.messages].map((message) => message.id)).size).toBe(111);
  });
  it('fences a held private transcript when restore maintenance locks the account', async () => {
    const { actor, conversationId } = await fixture();
    const original = crypto.subtle.decrypt.bind(crypto.subtle);
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; }), ready = new Promise<void>((resolve) => { entered = resolve; });
    const spy = vi.spyOn(crypto.subtle, 'decrypt').mockImplementationOnce(async (...args) => { entered(); await held; return original(...args); });
    const pending = getSupportConversation(testEnv, actor, conversationId);
    try {
      await ready;
      await testEnv.DB.prepare("INSERT INTO system_settings(key,value) VALUES('restore_locked','true')").run();
      release(); await expect(pending).rejects.toMatchObject({ code: 'support_access_changed' });
      await expect(requireOperatorActor(testEnv, actor.proof)).rejects.toMatchObject({ status: 401 });
    } finally { release(); spy.mockRestore(); }
  });
  it('keeps actor provenance after staff account deletion so queued human messages cannot become bot messages', async () => {
    const { actor, conversationId, claim } = await fixture();
    const created = await enqueueSupportReply(testEnv, actor, conversationId, reply(claim.claimVersion));
    await testEnv.DB.prepare("DELETE FROM users WHERE id='u_alex'").run();
    const row = await testEnv.DB.prepare('SELECT operator_user_id FROM messages WHERE id=?').bind(created.messageId).first();
    expect(row).toEqual({ operator_user_id: 'u_alex' });
    await processConversation(testEnv, conversationId);
    expect(await testEnv.DB.prepare('SELECT status FROM outbound_jobs WHERE message_id=?').bind(created.messageId).first()).toEqual({ status: 'cancelled' });
  });
});
