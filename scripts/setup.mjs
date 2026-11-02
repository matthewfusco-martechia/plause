import { randomBytes, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const local = path.join(root, '.local');
mkdirSync(local, { recursive: true, mode: 0o700 });
const variables = path.join(root, '.dev.vars');
if (!existsSync(variables)) {
  writeFileSync(variables, [
    '# Generated local-only secrets. Keep this file and .local out of version control.',
    `CONTENT_ENCRYPTION_KEY=${randomBytes(32).toString('base64')}`,
    `MOCK_WEBHOOK_SECRET=${randomBytes(32).toString('base64url')}`,
    `OPERATOR_TOKEN=${randomBytes(32).toString('base64url')}`,
    '',
  ].join('\n'), { mode: 0o600, flag: 'wx' });
}
chmodSync(variables, 0o600);
const invitationFile = path.join(local, 'invitations.json');
if (!existsSync(invitationFile)) {
  writeFileSync(invitationFile, JSON.stringify({ accounts: [
    { id: 'u_alex', displayName: 'Alex', inviteToken: randomBytes(32).toString('base64url') },
    { id: 'u_sam', displayName: 'Sam', inviteToken: randomBytes(32).toString('base64url') },
  ] }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
}
chmodSync(invitationFile, 0o600);
const invitations = JSON.parse(readFileSync(invitationFile, 'utf8'));
// A separate fictional account keeps the full-agent smoke test away from Alex/Sam preferences.
if (!invitations.accounts.some((account) => account.id === 'u_acceptance')) {
  invitations.accounts.push({ id: 'u_acceptance', displayName: 'Acceptance test', inviteToken: randomBytes(32).toString('base64url') });
  writeFileSync(invitationFile, JSON.stringify(invitations, null, 2) + '\n', { mode: 0o600 });
}
const sql = readFileSync(path.join(root, 'scripts/fixtures.sql'), 'utf8') + '\n' + invitations.accounts.map((account) => {
  if (!['u_alex', 'u_sam', 'u_acceptance'].includes(account.id) || typeof account.inviteToken !== 'string') throw new Error('Invalid local fixture');
  const hash = createHash('sha256').update(account.inviteToken).digest('hex');
  return `INSERT OR IGNORE INTO invitations(token_hash, user_id) VALUES ('${hash}', '${account.id}');`;
}).join('\n');
const seed = path.join(local, 'seed.sql');
writeFileSync(seed, sql, { mode: 0o600 });

function wrangler(args) {
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/wrangler.mjs'), ...args], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
wrangler(['d1', 'migrations', 'apply', 'DB', '--local']);
wrangler(['d1', 'execute', 'DB', '--local', '--file', seed]);
console.log('Plause local setup complete. Invitation keys are in .local/invitations.json.');
console.log('Run npm run dev, then open http://localhost:8787. No external accounts or messages are used.');
