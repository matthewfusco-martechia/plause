import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';

export function makeFixtures() {
  const runId = randomUUID().replaceAll('-', '').slice(0, 12);
  const accounts = Object.fromEntries(['primary', 'peer', 'archive', 'erase', 'staff', 'staffPeer'].map((name) => [name, {
    id: `u_e2e_${name}_${runId}`, displayName: `Fictional E2E ${name}`, subjectId: `e2e-${name}-${runId}`,
    inviteToken: randomBytes(32).toString('base64url'),
  }]));
  return { runId, accounts, contentKey: randomBytes(32).toString('base64'),
    webhookSecret: randomBytes(32).toString('base64url'), operatorToken: randomBytes(32).toString('base64url') };
}

const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
export function fixtureSql(fixtures) {
  const accounts = Object.values(fixtures.accounts).map((account) => `
    INSERT INTO users(id,display_name,status,created_at,daily_message_limit,reminder_timezone,quiet_start,quiet_end)
      VALUES (${quote(account.id)},${quote(account.displayName)},'active',${Date.now()},1000,'UTC','00:00','00:00');
    INSERT INTO invitations(token_hash,user_id) VALUES
      (${quote(createHash('sha256').update(account.inviteToken).digest('hex'))},${quote(account.id)});
    INSERT INTO bindings(provider,business_id,subject_id,user_id,channel) VALUES
      ('mock','plause-local',${quote(account.subjectId)},${quote(account.id)},'mock');`).join('\n');
  return accounts + ['staff', 'staffPeer'].map((name) => `INSERT INTO operator_grants(user_id,role,revision,status,mutation_token,created_at,updated_at)
    VALUES (${quote(fixtures.accounts[name].id)},${quote(name === 'staff' ? 'admin' : 'support')},1,'active',${quote(randomUUID())},${Date.now()},${Date.now()});`).join('\n');
}

export function signedEvent(fixtures, account, text, overrides = {}) {
  const event = { schemaVersion: 1, type: 'message.received', eventId: randomUUID(), messageId: randomUUID(),
    subject: { provider: 'mock', businessId: 'plause-local', subjectId: account.subjectId }, channel: 'mock',
    occurredAt: new Date().toISOString(), text, ...overrides };
  const raw = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  return { event, raw, signature: `t=${timestamp},v1=${createHmac('sha256', fixtures.webhookSecret).update(`${timestamp}.${raw}`).digest('hex')}` };
}
