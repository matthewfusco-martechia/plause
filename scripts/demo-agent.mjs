import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
const base = 'http://localhost:8787';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const assert = (condition, message) => { if (!condition) throw new Error(message); };
async function run() {
  const health = await (await fetch(`${base}/health`)).json();
  assert(health.model === 'mock' && health.messaging === 'mock' && !health.research?.ready,
    'This demo requires mock model/messaging and disabled research. It cannot make a live provider call.');
  const { accounts } = JSON.parse(readFileSync(new URL('../.local/invitations.json', import.meta.url), 'utf8'));
  const account = accounts.find((entry) => entry.id === 'u_acceptance');
  assert(account, 'Run npm run setup first.');
  const login = await fetch(base + '/api/session', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ inviteToken: account.inviteToken }) });
  assert(login.ok, 'Could not sign in to the dedicated fictional acceptance account.');
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  assert(cookie, 'No local session was issued.');
  const { conversationId } = await login.json();
  const path = `/api/conversations/${encodeURIComponent(conversationId)}`;
  async function get(route) {
    const response = await fetch(base + route, { headers: { cookie } });
    assert(response.ok, `Local read failed (${response.status}). Apply npm run setup and restart npm run dev.`);
    return response.json();
  }
  async function post(text, clientMessageId) {
    const response = await fetch(base + path + '/messages', { method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ text, clientMessageId }) });
    assert(response.status === 202, `Command was not accepted (${response.status}).`);
  }
  async function say(text) {
    const before = new Set((await get(path)).messages.map((message) => message.id));
    const clientMessageId = randomUUID();
    await post(text, clientMessageId);
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const current = await get(path);
      const input = current.messages.find((message) => message.role === 'user' && !before.has(message.id) && message.text === text);
      assert(!input || input.status !== 'failed', 'The local agent failed to process the command.');
      const reply = current.messages.find((message) => message.inReplyTo === input?.id && message.role === 'assistant');
      if (reply?.status === 'delivered') return { reply, text, clientMessageId };
      await wait(150);
    }
    throw new Error('A simulated command reply did not arrive. Inspect the local runtime.');
  }
  assert((await get(path)).mode === 'bot', 'Resume the fictional test agent before this demo.');
  const preferences = await get('/api/reminders');
  assert(!preferences.reminders.some((reminder) => reminder.status === 'active' || reminder.status === 'paused'), 'This demo requires no active/paused acceptance-account reminders so it cannot alter existing notification preferences.');
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: preferences.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
  const minute = Number(parts.find((part) => part.type === 'hour').value) * 60 + Number(parts.find((part) => part.type === 'minute').value);
  const minutes = (value) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
  const start = minutes(preferences.quietStart); const end = minutes(preferences.quietEnd);
  assert(start === end || !(start < end ? minute >= start && minute < end : minute >= start || minute < end), 'Run this demo outside the fictional account quiet hours; it does not change quiet-hour preferences.');
  const initialActions = await get('/api/actions');
  const googleConnection = await get('/api/calendar/google');
  assert(!googleConnection.configured && !googleConnection.connected,
    'This acceptance demo requires disabled Google configuration and no real calendar grant.');
  const marker = `cedar-${randomUUID().slice(0, 8)}`;
  let reminderId; let approvalId; let eventId; let connectedByDemo = false;
  try {
    const instruction = `A fictional automatic reminder ${marker}.`;
    const at = new Date(Date.now() + 6000).toISOString();
    const created = await say(`remind me at ${at}: ${instruction}`);
    assert(created.reply.model === 'plause-reminder-control', 'Reminder creation did not use the deterministic control.');
    reminderId = (await get('/api/reminders')).reminders.find((reminder) => reminder.instruction === instruction)?.id;
    assert(reminderId, 'The durable reminder row is missing.');
    const deadline = Date.now() + 45_000;
    let notifications = [];
    while (Date.now() < deadline) {
      notifications = (await get(path)).messages.filter((message) => message.model === 'plause-reminder' && message.text.includes(marker) && message.status === 'delivered');
      if (notifications.length) break;
      await wait(300);
    }
    assert(notifications.length === 1, 'Expected one automatic reminder. Restart npm run dev to enable its15-second durable scheduler wakeup.');
    assert((await get('/api/reminders')).reminders.find((reminder) => reminder.id === reminderId)?.status === 'completed', 'Delivered one-time reminder did not complete.');
    console.log('PASS durable reminder fired automatically and completed once through mock delivery');

    if (!initialActions.calendar.connected) { await say('connect demo calendar'); connectedByDemo = true; }
    const title = `A fictional approval event ${marker}`;
    await say(`propose calendar event at ${new Date(Date.now() + 3_600_000).toISOString()} for 20 minutes: ${title}`);
    let actions = await get('/api/actions');
    approvalId = actions.approvals.find((approval) => approval.arguments.title === title && approval.state === 'pending')?.id;
    assert(approvalId && !actions.events.some((event) => event.title === title), 'The proposal either disappeared or executed before approval.');
    const approved = await say(`approve ${approvalId}`);
    await post(approved.text, approved.clientMessageId);
    actions = await get('/api/actions');
    const events = actions.events.filter((event) => event.approvalId === approvalId);
    assert(events.length === 1 && events[0].simulated === true, 'Approval replay did not preserve one simulated event.');
    eventId = events[0].id;
    await say(`cancel demo event ${eventId}`); eventId = undefined;
    console.log('PASS exact approval created one simulated calendar event, replay stayed idempotent');
    const research = await say('research: NASA public mission information');
    assert(research.reply.model === 'plause-research' && /not connected|not enabled/i.test(research.reply.text), 'Disabled research must explain its actual connection status.');
    const google = await say(`google calendar events from ${new Date(Date.now()).toISOString()} to ${new Date(Date.now() + 86_400_000).toISOString()}`);
    assert(google.reply.model === 'plause-google-calendar' && /not connected and enabled/i.test(google.reply.text),
      'Disabled Google Calendar must explain its actual connection state without a provider request.');
    const exportResponse = await fetch(base + '/api/account/export', { headers: { cookie } });
    assert(exportResponse.ok, 'Authenticated account export failed.');
    const archive = await exportResponse.text();
    assert(!archive.includes(account.inviteToken) && archive.includes('development_invitation'), 'Account export exposed a credential or omitted account context.');
    const usage = await get('/api/usage');
    assert(usage.estimateOnly && usage.providerBillingAuthoritative, 'Usage estimates did not disclose their billing boundary.');
    console.log('PASS disabled research/Google Calendar, account export and estimated usage expose truthful bounded state');
    console.log('No Apple message, real calendar change, search request, hosted AI call, or account deletion occurred.');
  } finally {
    if (eventId) await say(`cancel demo event ${eventId}`).catch(() => {});
    if (approvalId) await say(`reject ${approvalId}`).catch(() => {});
    if (reminderId) await say(`cancel reminder ${reminderId}`).catch(() => {});
    if (connectedByDemo) await say('disconnect demo calendar').catch(() => {});
    if (!preferences.enabled) await say('reminder notifications off').catch(() => {});
    await fetch(base + '/api/session', { method: 'DELETE', headers: { cookie, origin: base } }).catch(() => {});
  }
}
run().catch((error) => { console.error(error instanceof Error ? error.message : 'Local agent demo failed.'); process.exitCode = 1; });
