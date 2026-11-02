import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const base = 'http://localhost:8787';
const variables = Object.fromEntries(readFileSync(new URL('.dev.vars', root), 'utf8').split('\n')
  .filter((line) => line && !line.startsWith('#')).map((line) => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
const { accounts } = JSON.parse(readFileSync(new URL('.local/invitations.json', root), 'utf8'));
const check = (condition, message) => { if (!condition) throw new Error(message); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const health = await (await fetch(`${base}/health`)).json();
check(health.model === 'mock', 'The offline demo requires mock mode. Use npm run eval:model for an explicitly configured hosted model.');

async function login(account) {
  const response = await fetch(`${base}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ inviteToken: account.inviteToken }) });
  check(response.ok, 'Local login failed. Run npm run setup and npm run dev.');
  return response.headers.get('set-cookie').split(';')[0];
}
const cookie = await login(accounts[0]);
const runId = randomUUID();
const event = { schemaVersion: 1, type: 'message.received', eventId: randomUUID(), messageId: randomUUID(),
  subject: { provider: 'mock', businessId: 'plause-local', subjectId: 'mock-alex' }, channel: 'mock',
  occurredAt: new Date().toISOString(), text: `Hello Plause. Local pipeline smoke test ${runId}.` };
const raw = JSON.stringify(event);
const timestamp = Math.floor(Date.now() / 1000);
const signature = `t=${timestamp},v1=${createHmac('sha256', variables.MOCK_WEBHOOK_SECRET).update(`${timestamp}.${raw}`).digest('hex')}`;
async function send() {
  return fetch(`${base}/webhooks/messaging/mock`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-plause-signature': signature }, body: raw });
}
const accepted = await send();
check(accepted.status === 202, `Signed mock ingress failed (${accepted.status}).`);
const result = await accepted.json();
const replay = await send();
check(replay.status === 202 && (await replay.json()).duplicate === true, 'Replay did not deduplicate.');
let conversation;
for (let attempt = 0; attempt < 50; attempt++) {
  const response = await fetch(`${base}/api/conversations/${result.conversationId}`, { headers: { cookie } });
  check(response.ok, 'Could not load scoped conversation.');
  conversation = await response.json();
  if (conversation.messages.some((message) => message.role === 'assistant' && message.status === 'delivered' && message.text.includes(runId))) break;
  if (attempt === 15) await fetch(`${base}/api/operator/recover`, { method: 'POST', headers: { authorization: `Bearer ${variables.OPERATOR_TOKEN}` } });
  await sleep(200);
}
const matches = conversation.messages.filter((message) => message.role === 'user' && message.text === event.text);
check(matches.length === 1, 'Expected one logical input message.');
check(conversation.messages.some((message) => message.role === 'assistant' && message.status === 'delivered' && message.text.includes(runId)), 'No delivered mock reply for this run.');
const secondCookie = await login(accounts[1]);
const forbidden = await fetch(`${base}/api/conversations/${result.conversationId}`, { headers: { cookie: secondCookie } });
check(forbidden.status === 404, 'Tenant isolation failed.');
console.log('PASS signed ingress → durable conversation → mock model → delivered mock reply');
console.log('PASS duplicate event produces one logical input');
console.log('PASS second local account cannot read the conversation');
console.log('All sends stayed inside the local simulator. Apple Messages and hosted AI are not connected.');
