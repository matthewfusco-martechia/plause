import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { E2EError, eventually } from './harness.mjs';
import { signedEvent } from './fixtures.mjs';

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const iso = (milliseconds = 3_600_000) => new Date(Date.now() + milliseconds).toISOString();
const reminderMessages = (archive, marker) => archive.messages.filter((message) => message.role === 'assistant'
  && message.model === 'plause-reminder' && message.status === 'delivered' && message.text.includes(marker));
const get = async (h, session, route) => (await h.request(route, { session })).data;
async function webhook(h, fixture, expected = 202) {
  return h.request('/webhooks/messaging/mock', { method: 'POST', body: fixture.raw, raw: true,
    headers: { 'x-plause-signature': fixture.signature }, expected });
}

export async function runScenarios(h) {
  const sessions = {};
  const prefix = `e2e-${h.fixtures.runId}`;
  let channelId; let expiredApproval; let pausedInput; let outageReminder; let backupDirectory; let erasureOperationId;
  const billingFixtureId = `billing_fixture_${randomUUID()}`;

  await h.step('fresh additive migrations and fictional fixture provisioning', async () => {
    await h.initialize(); await h.migrate(); await h.seedFixtures(); await h.migrate();
  });
  await h.step('self-owned service readiness with live providers disabled', async () => {
    await h.start(); h.startTicker();
    assert.equal((await h.request('/api/me', { expected: 401 })).data.error, 'sign_in_required');
    assert.equal((await h.request('/api/operator/status', { expected: 401 })).data.error, 'identity_reauthentication_required');
    const badOrigin = await h.request('/api/session', { method: 'POST', expected: 403,
      headers: { origin: 'https://outside.invalid' }, body: { inviteToken: h.fixtures.accounts.primary.inviteToken } });
    assert.equal(badOrigin.data.error, 'origin_rejected');
    assert.equal((await h.request('/api/session', { method: 'POST', expected: 401, body: { inviteToken: 'not-a-real-invitation-'.repeat(2) } })).data.error, 'invalid_invitation');
    for (const [name, account] of Object.entries(h.fixtures.accounts)) sessions[name] = await h.login(account);
    for (const session of Object.values(sessions)) {
      const me = await get(h, session, '/api/me');
      assert.equal(me.user.id, session.id); assert.equal(me.authentication, 'development_invitation');
      assert.equal((await get(h, session, '/api/calendar/google')).configured, false);
    }
    assert.equal((await h.request(`/api/conversations/${sessions.primary.conversationId}`, { session: sessions.peer, expected: 404 })).data.error, 'conversation_not_found');
    assert.equal((await h.request('/api/operator/status', { session: sessions.primary, expected: 403 })).data.error, 'operator_role_required');
  });

  await h.step('real signed ingress, event/logical replay, conflicts and tenant boundaries', async () => {
    const account = h.fixtures.accounts.primary;
    const fixture = signedEvent(h.fixtures, account, `A fictional channel greeting ${prefix}`);
    const bad = await h.request('/webhooks/messaging/mock', { method: 'POST', body: fixture.raw, raw: true,
      headers: { 'x-plause-signature': 't=0,v1=' + '0'.repeat(64) }, expected: 401 });
    assert.equal(bad.data.error, 'invalid_webhook_signature');
    const unbound = signedEvent(h.fixtures, { ...account, subjectId: `unbound-${prefix}` }, `Unbound fictional contact ${prefix}`);
    assert.equal((await webhook(h, unbound, 403)).data.error, 'unknown_sender');
    const accepted = await webhook(h, fixture); channelId = accepted.data.conversationId;
    assert.equal((await webhook(h, fixture)).data.duplicate, true);
    const logicalReplay = signedEvent(h.fixtures, account, fixture.event.text, { messageId: fixture.event.messageId });
    assert.equal((await webhook(h, logicalReplay)).data.duplicate, true);
    const delivered = await h.reply(sessions.primary, { text: fixture.event.text }, channelId);
    assert.equal(delivered.reply.model, 'mock');
    assert.equal(delivered.view.messages.filter((message) => message.role === 'user' && message.text === fixture.event.text).length, 1);
    assert.equal(delivered.view.messages.filter((message) => message.inReplyTo === delivered.input.id).length, 1);
    const conflict = signedEvent(h.fixtures, account, 'A different fictional payload', { eventId: fixture.event.eventId, messageId: fixture.event.messageId });
    assert.equal((await webhook(h, conflict, 409)).data.error, 'event_conflict');
    const logicalConflict = signedEvent(h.fixtures, account, 'A conflicting fictional logical input', { messageId: fixture.event.messageId });
    assert.equal((await webhook(h, logicalConflict, 409)).data.error, 'message_conflict');
    assert.equal((await h.request(`/api/conversations/${channelId}`, { session: sessions.peer, expected: 404 })).data.error, 'conversation_not_found');
  });

  await h.step('declared sign-in readiness and two-sided messaging-channel proof', async () => {
    const auth = (await h.request('/api/auth/status')).data;
    assert.equal(auth.configured, false); assert.equal(auth.invitationLoginAllowed, true);
    assert.equal(auth.appleEntryUrl, null);
    assert.equal((await h.request('/api/auth/google/start', { method: 'POST', body: { intent: 'signin' }, expected: 503 })).data.error, 'identity_disabled');
    assert.equal((await h.request('/api/channel-links', { method: 'POST', body: { replyConsent: true, proactiveConsent: false }, expected: 401 })).data.error, 'sign_in_required');
    const created = await h.request('/api/channel-links', { method: 'POST', session: sessions.primary,
      body: { replyConsent: true, proactiveConsent: false }, expected: 201 });
    const challenge = created.data; h.secrets.add(challenge.code); h.secrets.add(challenge.command);
    assert.equal(challenge.command, `link plause ${challenge.code}`);
    assert.equal((await h.request(`/api/channel-links/${challenge.id}/confirm`, { method: 'POST', session: sessions.primary, body: {}, expected: 409 })).data.error, 'channel_link_conflict');
    assert.equal((await h.request(`/api/channel-links/${challenge.id}`, { session: sessions.peer, expected: 404 })).data.error, 'channel_link_unavailable');
    const freshChannel = { ...h.fixtures.accounts.primary, subjectId: `new-channel-${prefix}` };
    const proof = signedEvent(h.fixtures, freshChannel, challenge.command);
    await webhook(h, proof); assert.equal((await webhook(h, proof)).data.duplicate, true);
    const reviewed = await get(h, sessions.primary, `/api/channel-links/${challenge.id}`);
    assert.equal(reviewed.status, 'proved'); assert.equal(reviewed.proactiveConsent, false); assert.equal(reviewed.proof.provider, 'mock');
    assert.equal((await webhook(h, signedEvent(h.fixtures, freshChannel, 'Before account-side confirmation'), 403)).data.error, 'unknown_sender');
    const linked = await h.request(`/api/channel-links/${challenge.id}/confirm`, { method: 'POST', session: sessions.primary, body: {} });
    assert.equal(linked.data.linked, true);
    assert.equal((await h.request(`/api/channel-links/${challenge.id}/confirm`, { method: 'POST', session: sessions.primary, body: {} })).data.bindingId, linked.data.bindingId);
    const bindings = (await get(h, sessions.primary, '/api/channel-bindings')).bindings;
    const binding = bindings.find((item) => item.id === linked.data.bindingId);
    assert.equal(binding.status, 'active'); assert.equal(binding.proactiveConsentAt, null); assert.ok(binding.replyConsentAt);
    const greeting = signedEvent(h.fixtures, freshChannel, `Newly linked fictional channel ${prefix}`);
    const accepted = await webhook(h, greeting);
    await h.reply(sessions.primary, { text: greeting.event.text }, accepted.data.conversationId);
    assert.equal(JSON.stringify((await h.exportAll(sessions.primary)).messages).includes(challenge.code), false);
    assert.equal((await h.request(`/api/channel-bindings/${binding.id}`, { method: 'DELETE', session: sessions.peer, expected: 404 })).data.error, 'channel_binding_unavailable');
    assert.equal((await h.request(`/api/channel-bindings/${binding.id}`, { method: 'DELETE', session: sessions.primary })).data.revoked, true);
    assert.equal((await webhook(h, signedEvent(h.fixtures, freshChannel, 'Revoked channel replay attempt'), 403)).data.error, 'unknown_sender');
  });

  await h.step('explicit memory crosses owned channels, isolates peers and survives privacy controls', async () => {
    const fact = `My fictional favorite drink is cedar tea ${prefix}.`;
    await h.say(sessions.primary, `remember: ${fact}`);
    let memory = await get(h, sessions.primary, '/api/memories');
    assert.equal(memory.memories.length, 1); assert.equal(memory.memories[0].text, fact);
    const question = signedEvent(h.fixtures, h.fixtures.accounts.primary, `What is my favorite fictional drink ${prefix}?`);
    await webhook(h, question);
    assert.ok((await h.reply(sessions.primary, { text: question.event.text }, channelId)).reply.text.includes(fact));
    assert.ok(!(await h.say(sessions.peer, `What is my favorite fictional drink ${prefix}?`)).reply.text.includes(fact));
    await h.say(sessions.primary, `forget memory ${memory.memories[0].id}`);
    assert.equal((await get(h, sessions.primary, '/api/memories')).memories.length, 0);
    assert.ok(!(await h.say(sessions.primary, `What is my favorite fictional drink after forgetting ${prefix}?`)).reply.text.includes(fact));
    await h.say(sessions.primary, 'disable memory');
    await h.say(sessions.primary, `remember: A disabled fictional fact ${prefix}`);
    memory = await get(h, sessions.primary, '/api/memories');
    assert.equal(memory.enabled, false); assert.equal(memory.memories.length, 0);
    await h.say(sessions.primary, 'enable memory');
    assert.equal((await get(h, sessions.primary, '/api/memories')).enabled, true);
  });

  await h.step('once reminder fires exactly once through the real scheduled handler', async () => {
    const instruction = `Fictional due reminder ${prefix}`;
    await h.say(sessions.primary, `remind me at ${iso(2500)}: ${instruction}`);
    const task = (await get(h, sessions.primary, '/api/reminders')).reminders.find((reminder) => reminder.instruction === instruction);
    assert.ok(task);
    await eventually(async () => {
      const archive = await h.exportAll(sessions.primary);
      return reminderMessages(archive, instruction).length === 1;
    }, { timeout: 15_000, label: 'one due reminder' });
    await h.tickOnce(); await h.tickOnce();
    assert.equal(reminderMessages(await h.exportAll(sessions.primary), instruction).length, 1);
    assert.equal((await get(h, sessions.primary, '/api/reminders')).reminders.find((reminder) => reminder.id === task.id).status, 'completed');
  });

  await h.step('recurring lifecycle, notification preference and quiet-hour suppression', async () => {
    await h.say(sessions.primary, `remind me every day at 12:34 UTC: Fictional daily task ${prefix}`);
    await h.say(sessions.primary, `remind me every Monday at 09:00 America/New_York: Fictional weekly task ${prefix}`);
    let data = await get(h, sessions.primary, '/api/reminders');
    const daily = data.reminders.find((reminder) => reminder.instruction === `Fictional daily task ${prefix}`);
    const weekly = data.reminders.find((reminder) => reminder.instruction === `Fictional weekly task ${prefix}`);
    assert.equal(daily.schedule.kind, 'daily'); assert.equal(weekly.schedule.kind, 'weekly');
    await h.say(sessions.primary, `pause reminder ${daily.id}`);
    assert.equal((await get(h, sessions.primary, '/api/reminders')).reminders.find((reminder) => reminder.id === daily.id).status, 'paused');
    await h.say(sessions.primary, `resume reminder ${daily.id}`);
    await h.say(sessions.primary, `reschedule reminder ${daily.id} every day at 13:45 UTC`);
    assert.equal((await get(h, sessions.primary, '/api/reminders')).reminders.find((reminder) => reminder.id === daily.id).schedule.time, '13:45');
    await h.say(sessions.primary, 'reminder notifications off');
    assert.equal((await get(h, sessions.primary, '/api/reminders')).enabled, false);
    await h.say(sessions.primary, 'reminder notifications on');
    await h.say(sessions.primary, 'reminder timezone UTC');
    const now = new Date(); const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
    const clock = (number) => `${String(Math.floor((number % 1440) / 60)).padStart(2, '0')}:${String(number % 60).padStart(2, '0')}`;
    await h.say(sessions.primary, `reminder quiet hours ${clock(minutes)}-${clock(minutes + 5)}`);
    const quietInstruction = `Fictional quiet task ${prefix}`;
    await h.say(sessions.primary, `remind me at ${iso(1800)}: ${quietInstruction}`);
    const quiet = (await get(h, sessions.primary, '/api/reminders')).reminders.find((reminder) => reminder.instruction === quietInstruction);
    await delay(2300); await h.tickOnce();
    assert.equal(reminderMessages(await h.exportAll(sessions.primary), quietInstruction).length, 0);
    await h.say(sessions.primary, 'reminder quiet hours 00:00-00:00');
    await h.say(sessions.primary, `reschedule reminder ${quiet.id} at ${iso(2000)}`);
    await eventually(async () => reminderMessages(await h.exportAll(sessions.primary), quietInstruction).length === 1,
      { label: 'explicitly rescheduled quiet reminder' });
    await h.say(sessions.primary, `cancel reminder ${daily.id}`);
    await h.say(sessions.primary, `cancel reminder ${weekly.id}`);
    data = await get(h, sessions.primary, '/api/reminders');
    assert.equal(data.reminders.find((reminder) => reminder.id === daily.id).status, 'cancelled');
    assert.equal(data.reminders.find((reminder) => reminder.id === weekly.id).status, 'cancelled');
  });

  await h.step('exact action review, cross-account denial, one-use approval and rejection', async () => {
    await h.say(sessions.primary, 'connect demo calendar');
    const title = `Fictional approved event ${prefix}`;
    await h.say(sessions.primary, `propose calendar event at ${iso()} for 25 minutes: ${title}`);
    let actions = await get(h, sessions.primary, '/api/actions');
    const approval = actions.approvals.find((item) => item.arguments.title === title);
    assert.equal(approval.state, 'pending'); assert.equal(actions.events.filter((event) => event.title === title).length, 0);
    await h.say(sessions.primary, `A bare yes without an approval identifier ${prefix}`);
    await h.say(sessions.peer, `approve ${approval.id}`);
    assert.equal((await get(h, sessions.primary, '/api/actions')).events.filter((event) => event.title === title).length, 0);
    const approved = await h.say(sessions.primary, `approve ${approval.id}`);
    assert.equal((await h.post(sessions.primary, approved.sent.text, approved.sent.clientMessageId)).duplicate, true);
    await h.say(sessions.primary, `approve ${approval.id}`);
    actions = await get(h, sessions.primary, '/api/actions');
    const events = actions.events.filter((event) => event.approvalId === approval.id);
    assert.equal(events.length, 1); assert.equal(events[0].simulated, true);
    await h.say(sessions.primary, `cancel demo event ${events[0].id}`);
    const rejectedTitle = `Fictional rejected event ${prefix}`;
    await h.say(sessions.primary, `propose calendar event at ${iso()} for 20 minutes: ${rejectedTitle}`);
    actions = await get(h, sessions.primary, '/api/actions');
    const rejected = actions.approvals.find((item) => item.arguments.title === rejectedTitle);
    await h.say(sessions.primary, `reject ${rejected.id}`);
    assert.equal((await get(h, sessions.primary, '/api/actions')).approvals.find((item) => item.id === rejected.id).state, 'rejected');
    assert.equal((await get(h, sessions.primary, '/api/actions')).events.filter((event) => event.title === rejectedTitle).length, 0);
    const expiryTitle = `Fictional expired event ${prefix}`;
    await h.say(sessions.primary, `propose calendar event at ${iso()} for 20 minutes: ${expiryTitle}`);
    expiredApproval = (await get(h, sessions.primary, '/api/actions')).approvals.find((item) => item.arguments.title === expiryTitle);
  });

  await h.step('accepted work, pause and due task survive a forced process crash', async () => {
    await h.request('/api/operator/pause', { method: 'POST', operator: true, body: { paused: true } });
    pausedInput = await h.post(sessions.primary, `Fictional durable crash greeting ${prefix}`);
    const reminderText = `Fictional outage reminder ${prefix}`;
    await h.post(sessions.primary, `remind me at ${iso(2000)}: ${reminderText}`);
    outageReminder = (await get(h, sessions.primary, '/api/reminders')).reminders.find((reminder) => reminder.instruction === reminderText);
    assert.ok(outageReminder); await delay(2300);
    const before = await h.exportAll(sessions.primary);
    assert.equal(before.messages.filter((message) => message.role === 'assistant' && message.text.includes(pausedInput.text)).length, 0);
    await h.stop({ crash: true });
    await assert.rejects(h.request('/health'), (error) => error instanceof E2EError && error.code === 'E2E_NETWORK_FAILURE');
    assert.match(expiredApproval.id, /^approval_[0-9a-f-]{36}$/);
    await h.offlineSql(`UPDATE action_approvals SET expires_at=0 WHERE id='${expiredApproval.id}';`);
    await h.migrate(); await h.start(); h.startTicker();
    assert.equal((await h.request('/api/operator/status', { operator: true })).data.outboundPaused, true);
    assert.equal((await get(h, sessions.primary, '/api/me')).user.id, sessions.primary.id);
    await h.request('/api/operator/pause', { method: 'POST', operator: true, body: { paused: false } });
    const delivered = await h.reply(sessions.primary, pausedInput);
    assert.equal(delivered.view.messages.filter((message) => message.inReplyTo === delivered.input.id).length, 1);
    await eventually(async () => reminderMessages(await h.exportAll(sessions.primary), reminderText).length === 1,
      { label: 'one overdue reminder after crash' });
    assert.equal((await get(h, sessions.primary, '/api/reminders')).reminders.find((reminder) => reminder.id === outageReminder.id).status, 'completed');
    await h.request('/api/operator/recover', { method: 'POST', operator: true });
    assert.equal((await h.post(sessions.primary, pausedInput.text, pausedInput.clientMessageId)).duplicate, true);
    const all = await h.exportAll(sessions.primary);
    assert.equal(all.messages.filter((message) => message.role === 'assistant' && message.text.includes(pausedInput.text)).length, 1);
    const expiry = await h.say(sessions.primary, `approve ${expiredApproval.id}`);
    assert.match(expiry.reply.text, /expired/i);
    assert.equal((await get(h, sessions.primary, '/api/actions')).events.filter((event) => event.approvalId === expiredApproval.id).length, 0);
  });

  await h.step('human ownership suppresses bot replies and explicit resumption does not resurrect work', async () => {
    await h.post(sessions.primary, 'support');
    assert.equal((await h.conversation(sessions.primary)).mode, 'human');
    const text = `Fictional message during human ownership ${prefix}`;
    await h.post(sessions.primary, text); await h.tickOnce();
    const during = await h.exportAll(sessions.primary);
    assert.equal(during.messages.filter((message) => message.role === 'assistant' && message.text.includes(text)).length, 0);
    // Human ownership cancels AI inbox processing, while the received message
    // remains available to a future staff responder.
    assert.equal(during.messages.find((message) => message.role === 'user' && message.text === text).status, 'received');
    const control = await h.post(sessions.primary, 'memories');
    await eventually(async () => {
      const view = await h.conversation(sessions.primary);
      const input = view.messages.find((message) => message.role === 'user' && message.text === 'memories' && !control.beforeIds.has(message.id));
      return input && view.messages.some((message) => message.inReplyTo === input.id && message.status === 'local_only');
    }, { label: 'local-only personal control in human mode' });
    await h.request(`/api/conversations/${sessions.primary.conversationId}/handoff`, { method: 'POST', session: sessions.primary, body: { mode: 'bot' } });
    assert.equal((await h.conversation(sessions.primary)).mode, 'bot');
    await h.say(sessions.primary, `A fictional greeting after resumption ${prefix}`);
    assert.equal((await h.exportAll(sessions.primary)).messages.filter((message) => message.role === 'assistant' && message.text.includes(text)).length, 0);
  });

  await h.step('fresh staff roles, claims, durable replies, release and grant revocation', async () => {
    const admin = sessions.staff, peer = sessions.staffPeer, customer = sessions.primary;
    assert.equal((await get(h, admin, '/api/operator/capabilities')).canManageOperators, true);
    assert.equal((await get(h, peer, '/api/operator/capabilities')).role, 'support');
    assert.equal((await h.request('/api/operator/support', { session: customer, expected: 403 })).data.error, 'operator_role_required');
    assert.equal((await h.request('/api/operator/grants', { method: 'POST', session: peer,
      body: { userId: customer.id, role: 'admin' }, expected: 403 })).data.error, 'operator_role_required');
    await h.request(`/api/conversations/${customer.conversationId}/handoff`, { method: 'POST', session: customer, body: { mode: 'human' } });
    const route = `/api/operator/support/${customer.conversationId}`;
    assert.ok((await get(h, admin, '/api/operator/support')).conversations.some((item) => item.conversationId === customer.conversationId));
    assert.equal((await h.request(route, { session: admin, expected: 409 })).data.error, 'support_claim_unavailable');
    const claim = (await h.request(`${route}/claim`, { method: 'POST', session: admin, body: {} })).data;
    assert.equal((await h.request(`${route}/claim`, { method: 'POST', session: peer, body: {}, expected: 409 })).data.error, 'support_claim_unavailable');
    const text = `Fictional human support\nExact response ${prefix}`;
    const body = { text, clientMessageId: randomUUID(), claimVersion: claim.claimVersion };
    const queued = (await h.request(`${route}/reply`, { method: 'POST', session: admin, body, expected: 202 })).data;
    assert.equal((await h.request(`${route}/reply`, { method: 'POST', session: admin, body, expected: 202 })).data.messageId, queued.messageId);
    assert.equal((await h.request(`${route}/reply`, { method: 'POST', session: admin, body: { ...body, text: 'Conflicting text' }, expected: 409 })).data.error, 'support_reply_conflict');
    await eventually(async () => (await h.conversation(customer)).messages.find((message) => message.id === queued.messageId && message.status === 'delivered'), { label: 'durable human reply' });
    const view = await h.conversation(customer);
    assert.equal(view.mode, 'human'); assert.equal(view.messages.filter((message) => message.id === queued.messageId).length, 1);
    assert.equal(view.messages.find((message) => message.id === queued.messageId).model, 'plause-human');
    assert.equal((await get(h, admin, route)).messages.find((message) => message.id === queued.messageId).text, text);
    assert.equal((await h.request(`${route}/renew`, { method: 'POST', session: admin, body: { claimVersion: claim.claimVersion } })).data.claimVersion, claim.claimVersion);
    await h.request('/api/operator/pause', { method: 'POST', session: admin, body: { paused: true } });
    const waiting = (await h.request(`${route}/reply`, { method: 'POST', session: admin,
      body: { text: `A reply cancelled on release ${prefix}`, clientMessageId: randomUUID(), claimVersion: claim.claimVersion }, expected: 202 })).data;
    assert.equal((await h.request(`${route}/release`, { method: 'POST', session: admin, body: { claimVersion: claim.claimVersion } })).data.mode, 'human');
    assert.equal((await h.conversation(customer)).messages.find((message) => message.id === waiting.messageId).status, 'cancelled');
    assert.equal((await h.request(`${route}/reply`, { method: 'POST', session: admin,
      body: { text: 'Expired claim', clientMessageId: randomUUID(), claimVersion: claim.claimVersion }, expected: 409 })).data.error, 'support_claim_unavailable');
    const other = (await h.request(`${route}/claim`, { method: 'POST', session: peer, body: {} })).data;
    const revoked = (await h.request(`${route}/reply`, { method: 'POST', session: peer,
      body: { text: `A reply cancelled on role revocation ${prefix}`, clientMessageId: randomUUID(), claimVersion: other.claimVersion }, expected: 202 })).data;
    await h.request('/api/operator/grants', { method: 'POST', session: admin, body: { userId: peer.id, role: null } });
    assert.equal((await h.request(route, { session: peer, expected: 403 })).data.error, 'operator_role_required');
    assert.equal((await h.conversation(customer)).messages.find((message) => message.id === revoked.messageId).status, 'cancelled');
    await h.request('/api/operator/grants', { method: 'POST', session: admin, body: { userId: peer.id, role: 'support' } });
    const reclaimed = (await h.request(`${route}/claim`, { method: 'POST', session: peer, body: {} })).data;
    assert.ok(reclaimed.claimVersion > other.claimVersion);
    assert.equal((await h.request(`${route}/resume`, { method: 'POST', session: peer, body: { claimVersion: reclaimed.claimVersion } })).data.mode, 'bot');
    await h.request('/api/operator/pause', { method: 'POST', session: admin, body: { paused: false } });
    assert.equal((await h.say(customer, `Bot after staffed support ${prefix}`)).reply.model, 'mock');
    assert.equal((await h.request('/api/support/coverage')).data.configured, false);
  });

  await h.step('more-than-100-message export is complete, unique and excludes credentials', async () => {
    const expected = Array.from({ length: 60 }, (_, index) => `Fictional pagination line ${index.toString().padStart(2, '0')} ${prefix}`);
    for (let offset = 0; offset < expected.length; offset += 6) await Promise.all(expected.slice(offset, offset + 6).map((text) => h.post(sessions.archive, text)));
    const archive = await eventually(async () => {
      const snapshot = await h.exportAll(sessions.archive);
      return snapshot.messages.filter((message) => message.role === 'assistant' && message.status === 'delivered').length === expected.length ? snapshot : null;
    }, { timeout: 45_000, interval: 250, label: 'all paginated replies' });
    assert.ok(archive.messages.length >= 120); assert.ok(archive.pages >= 2);
    for (const text of expected) {
      assert.equal(archive.messages.filter((message) => message.role === 'user' && message.text === text).length, 1);
      assert.equal(archive.messages.filter((message) => message.role === 'assistant' && message.text.includes(text)).length, 1);
    }
    assert.equal((await h.conversation(sessions.archive)).messages.length, 100);
    const serialized = JSON.stringify(archive);
    for (const secret of h.secrets) assert.equal(serialized.includes(secret), false, 'Export contained an access credential.');
    const usage = await get(h, sessions.archive, '/api/usage');
    assert.equal(usage.chat.acceptedToday, 60); assert.equal(usage.model.attempts, 0); assert.equal(usage.estimateOnly, true);
    assert.equal((await h.request('/api/account/export?after=-1', { session: sessions.archive, expected: 400 })).data.error, 'invalid_cursor');
  });

  await h.step('reauthenticated two-step erasure is scoped, one-use and durable after restart', async () => {
    const session = sessions.erase;
    await h.say(session, `remember: A fictional erasable fact ${prefix}`);
    await h.say(session, `remind me at ${iso()}: A fictional erasable task ${prefix}`);
    await h.say(session, 'connect demo calendar');
    await h.say(session, `propose calendar event at ${iso()} for 10 minutes: A fictional erasable proposal ${prefix}`);
    // Quiescent backup predates erasure, so replay must actually remove a user
    // present in that backup. The held charge is fictional fixture data only.
    await h.stop();
    await h.offlineSql(`INSERT INTO model_attempts(message_id,user_id,conversation_id,attempt_token,lease_token,ownership_version,
      input_digest,model,budget_month,reservation_micro_usd,budget_debit_micro_usd,state,created_at,updated_at,dispatched_at)
      VALUES ('${billingFixtureId}','${session.id}','${session.conversationId}','${randomUUID()}','fixture-no-lease',0,
        '','e2e-fixture-no-provider-call','${new Date().toISOString().slice(0, 7)}',1475,1475,'unknown',${Date.now()},${Date.now()},${Date.now()});`);
    backupDirectory = path.join(h.directory, 'backup-before-erasure');
    await h.runNodeScript('scripts/backup.mjs', ['--local', '--config', h.config, '--persist-to', h.persistence, '--out', backupDirectory]);
    await h.start(); h.startTicker();
    const phrase = 'DELETE MY PLAUSE ACCOUNT';
    assert.equal((await h.request('/api/account/deletion-intent', { method: 'POST', session, expected: 401,
      body: { inviteToken: sessions.peer.inviteToken, confirmation: phrase } })).data.error, 'reauthentication_required');
    assert.equal((await h.request('/api/account/deletion-intent', { method: 'POST', session, expected: 400,
      body: { inviteToken: session.inviteToken, confirmation: 'DELETE' } })).data.error, 'invalid_request');
    const intent = await h.request('/api/account/deletion-intent', { method: 'POST', session,
      body: { inviteToken: session.inviteToken, confirmation: phrase } });
    h.secrets.add(intent.data.confirmationToken);
    assert.ok(intent.data.expiresAt > Date.now());
    assert.equal((await get(h, session, '/api/me')).user.id, session.id);
    assert.equal((await h.request('/api/account', { method: 'DELETE', session: sessions.peer, expected: 409,
      body: { confirmationToken: intent.data.confirmationToken } })).data.error, 'deletion_intent_invalid');
    const erased = (await h.request('/api/account', { method: 'DELETE', session, body: { confirmationToken: intent.data.confirmationToken } })).data;
    assert.equal(erased.deleted, true); erasureOperationId = erased.operationId;
    assert.equal((await h.request('/api/me', { session, expected: 401 })).data.error, 'sign_in_required');
    assert.equal((await h.request('/api/session', { method: 'POST', expected: 401, body: { inviteToken: session.inviteToken } })).data.error, 'invalid_invitation');
    assert.equal((await webhook(h, signedEvent(h.fixtures, session, `Erased fictional subject ${prefix}`), 403)).data.error, 'unknown_sender');
    assert.equal((await get(h, sessions.peer, '/api/me')).user.id, sessions.peer.id);
    await h.stop(); await h.start(); h.startTicker();
    assert.equal((await h.request('/api/session', { method: 'POST', expected: 401, body: { inviteToken: session.inviteToken } })).data.error, 'invalid_invitation');
    assert.equal((await get(h, sessions.primary, '/api/me')).user.id, sessions.primary.id);
    await h.request('/api/session', { method: 'DELETE', session: sessions.peer });
    assert.equal((await h.request('/api/me', { session: sessions.peer, expected: 401 })).data.error, 'sign_in_required');
  });
  await h.step('real quiescent backup and offline restore replay erasure while retaining held charges', async () => {
    await h.stop();
    const records = await h.offlineQuery(`SELECT environment,user_id AS userId,id AS operationId,created_at AS requestedAt
      FROM privacy_operations WHERE user_id='${sessions.erase.id}' AND state='completed'`);
    assert.equal(records.length, 1); assert.equal(records[0].operationId, erasureOperationId);
    const manifest = JSON.parse(await readFile(path.join(backupDirectory, 'backup.json'), 'utf8'));
    const ledger = { version: 1, environment: 'local', exportedAt: new Date().toISOString(), complete: true,
      records: records.map((record) => ({ version: 1, ...record })) };
    assert.ok(Date.parse(ledger.exportedAt) >= Date.parse(manifest.createdAt));
    const ledgerFile = path.join(h.directory, 'independent-fresh-privacy-ledger.json');
    await writeFile(ledgerFile, JSON.stringify(ledger), { mode: 0o600, flag: 'wx' });
    const before = new DatabaseSync(':memory:', { allowExtension: false });
    try {
      before.exec('PRAGMA foreign_keys=OFF;');
      before.exec(await readFile(path.join(backupDirectory, 'database.sql'), 'utf8'));
      before.exec('PRAGMA foreign_keys=ON;');
      assert.deepEqual(before.prepare('PRAGMA foreign_key_check').all(), []);
      assert.equal(before.prepare('SELECT COUNT(*) AS count FROM users WHERE id=?').get(sessions.erase.id).count, 1);
      assert.equal(before.prepare('SELECT budget_debit_micro_usd FROM model_attempts WHERE message_id=?').get(billingFixtureId).budget_debit_micro_usd, 1475);
    } finally { before.close(); }
    const output = path.join(h.directory, 'offline-verified-restore');
    await h.runNodeScript('scripts/restore-verify.mjs', ['--backup', backupDirectory, '--privacy-ledger', ledgerFile, '--out', output]);
    const report = JSON.parse(await readFile(path.join(output, 'restore-report.json'), 'utf8'));
    assert.equal(report.servingAuthorized, false); assert.equal(report.appliedErasures, 1);
    assert.equal(report.outboundPaused, true); assert.equal(report.quotaTombstonesRetained, true);
    const restored = new DatabaseSync(path.join(output, 'restored.sqlite'), { readOnly: true, allowExtension: false });
    try {
      for (const table of ['users', 'sessions', 'invitations', 'external_identities', 'bindings', 'conversations']) {
        const column = table === 'users' ? 'id' : 'user_id';
        assert.equal(restored.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column}=?`).get(sessions.erase.id).count, 0);
      }
      for (const table of ['sessions', 'invitations', 'identity_login_states', 'support_claims']) assert.equal(restored.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0);
      assert.equal(restored.prepare("SELECT value FROM system_settings WHERE key='outbound_paused'").get().value, 'true');
      assert.equal(restored.prepare("SELECT COUNT(*) AS count FROM conversations WHERE mode!='human' OR status!='closed' OR lease_token IS NOT NULL OR lease_until!=0").get().count, 0);
      assert.equal(restored.prepare('SELECT budget_debit_micro_usd FROM model_attempts WHERE message_id=?').get(billingFixtureId).budget_debit_micro_usd, 1475);
      assert.equal(restored.prepare('SELECT state FROM model_attempts WHERE message_id=?').get(billingFixtureId).state, 'unknown');
    } finally { restored.close(); }
  });
  if (h.tickError) throw h.tickError;
}
