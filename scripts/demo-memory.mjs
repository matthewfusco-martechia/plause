import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const base = 'http://localhost:8787';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const assert = (condition, message) => { if (!condition) throw new Error(message); };

async function run() {
  const healthResponse = await fetch(`${base}/health`);
  assert(healthResponse.ok, 'Start npm run dev before the memory demo.');
  const health = await healthResponse.json();
  assert(health.model === 'mock' && health.messaging === 'mock', 'This demo requires mock model and messaging settings; no hosted calls are allowed.');
  const { accounts } = JSON.parse(readFileSync(new URL('../.local/invitations.json', import.meta.url), 'utf8'));
  const account = accounts.find((entry) => entry.id === 'u_sam');
  assert(account, 'Run npm run setup to create the fictional demo account.');
  const login = await fetch(`${base}/api/session`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' },
    body: JSON.stringify({ inviteToken: account.inviteToken }) });
  assert(login.ok, 'Could not sign in to the fictional demo account.');
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  assert(cookie, 'The server did not create a session.');
  const { conversationId } = await login.json();
  const conversationPath = `/api/conversations/${encodeURIComponent(conversationId)}`;
  async function get(path) {
    const response = await fetch(base + path, { headers: { cookie } });
    assert(response.ok, `Could not read local state (${response.status}). Run npm run setup if the migration has not been applied.`);
    return response.json();
  }
  const initial = await get('/api/memories');
  assert(initial.enabled, 'The fictional account has memory disabled. Enable it explicitly before running the demo.');
  assert(initial.memories.length < 10, 'The fictional demo account has reached its fact limit.');
  assert((await get(conversationPath)).mode === 'bot', 'Resume the fictional test agent before running this demo.');

  async function say(text) {
    const before = new Set((await get(conversationPath)).messages.map((message) => message.id));
    const clientMessageId = randomUUID();
    const accepted = await fetch(base + conversationPath + '/messages', { method: 'POST',
      headers: { cookie, origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ text, clientMessageId }) });
    assert(accepted.status === 202, `Local message acceptance failed (${accepted.status}).`);
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const current = await get(conversationPath);
      const input = current.messages.find((message) => message.role === 'user' && !before.has(message.id) && message.text === text);
      assert(!input || input.status !== 'failed', 'The simulated agent could not process this turn.');
      const reply = current.messages.find((message) => message.role === 'assistant' && message.inReplyTo === input?.id);
      if (reply?.status === 'delivered') return reply;
      await wait(150);
    }
    throw new Error('Timed out waiting for simulated delivery. Inspect the local service; do not change live provider settings.');
  }

  const fact = `My fictional demo preference is cedar-${randomUUID().slice(0, 8)} tea.`;
  let savedId;
  try {
    const confirmation = await say(`remember: ${fact}`);
    assert(confirmation.model === 'plause-memory', 'A model interpreted the explicit save instead of the memory control.');
    const saved = (await get('/api/memories')).memories.find((memory) => memory.text === fact);
    assert(saved, 'The explicit fact was not durably saved.');
    savedId = saved.id;
    const listing = await say('memories');
    assert(listing.model === 'plause-memory' && listing.text.includes(savedId), 'Memory listing did not return the saved fact.');
    const recall = await say('What is my saved preference?');
    assert(recall.model === 'mock' && recall.text.includes(fact), 'The simulated model did not receive saved account context.');
    const exported = await get('/api/memories/export');
    assert(exported.version === 1 && exported.memories.some((memory) => memory.id === savedId), 'Authenticated export omitted the saved fact.');
    await say(`forget memory ${savedId}`);
    assert(!(await get('/api/memories')).memories.some((memory) => memory.id === savedId), 'The forgotten fact remained in saved memory.');
    savedId = undefined;
    const after = await say('What is my saved preference?');
    assert(!after.text.includes(fact), 'A forgotten fact reappeared through old conversation context.');
    console.log('PASS explicit save and list through the conversation, without a model call');
    console.log('PASS persisted account context reaches the simulated model and authenticated export');
    console.log('PASS forget removes the fact and excludes old recall from future context');
    console.log('All delivery stayed local and simulated. The demo used fictional Sam data; earlier transcript messages remain visible.');
  } finally {
    // Remove only the unique fact this demo created if an intermediate assertion failed.
    if (savedId) await say(`forget memory ${savedId}`).catch(() => {
      console.error('The unique demo fact could not be removed automatically. Review the fictional account memories locally.');
    });
    await fetch(`${base}/api/session`, { method: 'DELETE', headers: { cookie, origin: base } }).catch(() => {});
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Local memory demo failed.');
  process.exitCode = 1;
});
