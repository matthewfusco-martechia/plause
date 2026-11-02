import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { chmod, link, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configureIdentity, parseGoogleWebClient } from './configure-identity.mjs';
import { readVariables } from './configure-model.mjs';
import { rotateEncryptionKeyring } from '../packages/security/src/keyring.mjs';

const script = fileURLToPath(new URL('./configure-identity.mjs', import.meta.url));
const redirect = 'http://localhost:8787/api/auth/google/callback';
const privateSentinel = 'SYNTHETIC_PRIVATE_GOOGLE_SECRET_NEVER_REQUESTED';
function downloadedClient() {
  return { web: { client_id: '123456789012-fixture.apps.googleusercontent.com', project_id: 'plause-local-fixture',
    client_secret: privateSentinel, auth_uri: 'https://accounts.google.com/o/oauth2/auth', token_uri: 'https://oauth2.googleapis.com/token',
    auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs', redirect_uris: [redirect], javascript_origins: ['http://localhost:8787'] } };
}
async function fixture(t, eol = '\n') {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'plause-identity-config-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const configFile = path.join(directory, 'private.vars'), clientFile = path.join(directory, 'web-client.json');
  const encryption = rotateEncryptionKeyring(randomBytes(32).toString('base64'), randomBytes(32).toString('base64'), 'retained-existing-key');
  const untouched = ['# Existing private configuration; do not replace keys.', `CONTENT_ENCRYPTION_KEY=${JSON.stringify(encryption)}`,
    'MOCK_WEBHOOK_SECRET="synthetic-local-webhook-secret"', 'OPERATOR_TOKEN="synthetic-operator-secret"',
    'MODEL_PROVIDER="mock" # preserve provider selection', 'LIVE_MODEL_ENABLED=false',
    'MESSAGING_PROVIDER=mock', 'ONBOARDING_MESSAGES_ENABLED=false', 'APPLE_CHANNEL_APPROVED=false',
    'AUTH_SIGNUP_ENABLED=true', '# Leave the calendar and search credentials alone.',
    'GOOGLE_CLIENT_SECRET="synthetic-calendar-client-secret"', 'TAVILY_API_KEY="synthetic-search-key"'];
  const source = untouched.join(eol) + eol;
  const client = downloadedClient();
  await writeFile(configFile, source, { mode: 0o600 }); await writeFile(clientFile, JSON.stringify(client), { mode: 0o600 });
  return { directory, configFile, clientFile, encryption, source, client, args: ['--config', configFile],
    enable: ['--config', configFile, '--client-file', clientFile, '--enable'],
    writeConfig: (value) => writeFile(configFile, value, { mode: 0o600 }),
    writeClient: (value) => writeFile(clientFile, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 }) };
}
const run = (args, entry = script) => spawnSync(process.execPath, [entry, ...args], { encoding: 'utf8', timeout: 5000 });

test('explicit setup writes only local identity records and preserves the full encryption keyring, comments and providers', async (t) => {
  const f = await fixture(t); const report = configureIdentity(f.enable);
  assert.equal(report.action, 'enabled'); assert.equal(report.enabled, true); assert.equal(report.signupEnabled, false);
  assert.equal(report.configured, true); assert.equal(report.providerRequests, 0); assert.equal(report.providerCredentialsVerified, false);
  assert.equal(JSON.stringify(report).includes(privateSentinel), false); assert.equal(JSON.stringify(report).includes(f.encryption), false);
  const updated = await readFile(f.configFile, 'utf8'), values = readVariables(updated);
  assert.equal(values.CONTENT_ENCRYPTION_KEY, f.encryption); assert.equal(values.AUTH_GOOGLE_CLIENT_ID, f.client.web.client_id);
  assert.equal(values.AUTH_GOOGLE_CLIENT_SECRET, privateSentinel); assert.equal(values.PUBLIC_ORIGIN, 'http://localhost:8787');
  for (const line of f.source.split('\n').filter((line) => line && !line.startsWith('AUTH_SIGNUP_ENABLED='))) assert.equal(updated.includes(line + '\n'), true);
  assert.equal((await stat(f.configFile)).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(f.directory)).sort(), ['private.vars', 'web-client.json']);
  assert.deepEqual(JSON.parse(await readFile(f.clientFile, 'utf8')), f.client);
});

test('preserves unrelated CRLF records exactly while updating identity settings', async (t) => {
  const f = await fixture(t, '\r\n'); configureIdentity(f.enable);
  const updated = await readFile(f.configFile, 'utf8');
  for (const line of f.source.split('\r\n').filter((line) => line && !line.startsWith('AUTH_SIGNUP_ENABLED='))) assert.equal(updated.includes(line + '\r\n'), true);
  assert.equal(updated.replaceAll('\r\n', '').includes('\n'), false);
});

test('signup is an explicit local option and is reset off by ordinary enable or disable', async (t) => {
  const f = await fixture(t);
  assert.equal(configureIdentity([...f.enable, '--enable-signup']).signupEnabled, true);
  assert.equal(configureIdentity(f.enable).signupEnabled, false);
  configureIdentity([...f.enable, '--enable-signup']);
  const disabled = configureIdentity([...f.args, '--disable']); assert.equal(disabled.enabled, false); assert.equal(disabled.signupEnabled, false);
  const values = readVariables(await readFile(f.configFile, 'utf8'));
  assert.equal(values.AUTH_GOOGLE_CLIENT_ID, f.client.web.client_id); assert.equal(values.AUTH_GOOGLE_CLIENT_SECRET, privateSentinel);
  assert.equal(values.CONTENT_ENCRYPTION_KEY, f.encryption); assert.equal(values.MESSAGING_PROVIDER, 'mock');
});

test('status reads only finite booleans and leaves both input files and directory entries unchanged', async (t) => {
  const f = await fixture(t), before = await readFile(f.configFile), entries = await readdir(f.directory);
  const report = configureIdentity([...f.args, '--status']);
  assert.equal(report.action, 'status'); assert.equal(report.enabled, false); assert.equal(report.clientSecretStored, false); assert.equal(report.restartRequired, false);
  assert.equal(report.providerRequests, 0); assert.equal(report.providerCredentialsVerified, false);
  assert.deepEqual(await readFile(f.configFile), before); assert.deepEqual(await readdir(f.directory), entries);
  configureIdentity(f.enable); const enabled = configureIdentity([...f.args, '--status']);
  assert.equal(enabled.configured, true); assert.equal(enabled.clientSecretStored, true);
  const encoded = JSON.stringify(enabled); assert.equal(encoded.includes(privateSentinel), false); assert.equal(encoded.includes(f.client.web.client_id), false);
  await f.writeConfig((await readFile(f.configFile, 'utf8')) + 'APP_ENV=production\n');
  assert.equal(configureIdentity([...f.args, '--status']).configured, false);
});

test('status safely reports absent local configuration; mutating modes require existing setup keys', async (t) => {
  const f = await fixture(t); await rm(f.configFile);
  assert.equal(configureIdentity([...f.args, '--status']).configurationPresent, false);
  assert.throws(() => configureIdentity(f.enable), { code: 'IDENTITY_FILE_MISSING' });
  await f.writeConfig('AUTH_SIGNUP_ENABLED=false\n');
  assert.throws(() => configureIdentity(f.enable), { code: 'IDENTITY_SETUP_REQUIRED' });
  await f.writeConfig(f.source.replace(/CONTENT_ENCRYPTION_KEY=.*\n/, 'CONTENT_ENCRYPTION_KEY=not-a-key\n'));
  assert.throws(() => configureIdentity([...f.args, '--disable']), { code: 'IDENTITY_SETUP_REQUIRED' });
});

test('never writes a cloud or different-origin selected configuration', async (t) => {
  const f = await fixture(t);
  for (const suffix of ['APP_ENV=production\n', 'APP_ENV=staging\n', 'PUBLIC_ORIGIN=https://plause.si\n', 'PUBLIC_ORIGIN=http://127.0.0.1:8787\n']) {
    const source = f.source + suffix; await f.writeConfig(source);
    for (const args of [f.enable, [...f.args, '--disable']]) assert.throws(() => configureIdentity(args), { code: 'IDENTITY_LOCAL_CONFIG_REQUIRED' });
    assert.equal(await readFile(f.configFile, 'utf8'), source);
  }
});

test('rejects native/installed, service-account, mixed and malformed client JSON without modifying configuration', async (t) => {
  const f = await fixture(t);
  const cases = [{ installed: f.client.web }, { type: 'service_account', private_key: privateSentinel }, { ...f.client, installed: f.client.web }, { web: [] }, '{bad-json-' + privateSentinel];
  for (const value of cases) {
    await f.writeClient(value); assert.throws(() => configureIdentity(f.enable), { code: 'IDENTITY_WEB_CLIENT_REQUIRED' });
    assert.equal(await readFile(f.configFile, 'utf8'), f.source);
  }
});

test('pins Google endpoints and rejects invalid or extra downloaded credential fields', async (t) => {
  const f = await fixture(t);
  for (const patch of [{ client_id: 'not-google-client' }, { client_secret: 'short' }, { client_secret: 'with\nnewline' },
    { auth_uri: 'https://attacker.invalid/auth' }, { auth_uri: 'https://accounts.google.com.attacker.invalid/o/oauth2/auth' },
    { token_uri: 'http://oauth2.googleapis.com/token' }, { token_uri: 'https://oauth2.googleapis.com/token?secret=' + privateSentinel },
    { auth_provider_x509_cert_url: 'https://attacker.invalid/certs' }, { unknownCredential: privateSentinel }, { project_id: '../unsafe' },
    { auth_uri: undefined }, { token_uri: undefined }]) {
    await f.writeClient({ web: { ...f.client.web, ...patch } });
    assert.throws(() => configureIdentity(f.enable), { code: 'IDENTITY_CLIENT_INVALID' });
    assert.equal(await readFile(f.configFile, 'utf8'), f.source);
  }
});

test('requires exactly the local callback and no arbitrary or cloud JavaScript origin', async (t) => {
  const f = await fixture(t);
  for (const patch of [{ redirect_uris: [] }, { redirect_uris: [redirect, redirect] }, { redirect_uris: ['http://localhost:8787/api/auth/google/callback/'] },
    { redirect_uris: ['http://127.0.0.1:8787/api/auth/google/callback'] }, { redirect_uris: ['https://plause.si/api/auth/google/callback'] },
    { redirect_uris: [redirect, 'https://plause.si/api/auth/google/callback'] }, { redirect_uris: [redirect + '?next=https://attacker.invalid'] },
    { javascript_origins: ['https://plause.si'] }, { javascript_origins: ['http://localhost:8787', 'http://localhost:8787'] }, { javascript_origins: 'http://localhost:8787' }]) {
    await f.writeClient({ web: { ...f.client.web, ...patch } });
    assert.throws(() => configureIdentity(f.enable), { code: 'IDENTITY_REDIRECT_INVALID' }); assert.equal(await readFile(f.configFile, 'utf8'), f.source);
  }
});

test('accepts the documented fixed legacy endpoint variant and absent optional fields', () => {
  const web = downloadedClient().web; delete web.javascript_origins; delete web.project_id; delete web.auth_provider_x509_cert_url;
  web.token_uri = 'https://accounts.google.com/o/oauth2/token'; web.auth_uri = 'https://accounts.google.com/o/oauth2/v2/auth';
  assert.deepEqual(parseGoogleWebClient(JSON.stringify({ web })), { clientId: web.client_id, clientSecret: privateSentinel });
});

test('handles punctuation in protected client secrets without dotenv or shell evaluation', async (t) => {
  const f = await fixture(t), client = structuredClone(f.client); client.web.client_secret = 'GOCSPX-quote"-slash\\-dollar$(echo)-hash#-end';
  await f.writeClient(client); configureIdentity(f.enable);
  assert.equal(readVariables(await readFile(f.configFile, 'utf8')).AUTH_GOOGLE_CLIENT_SECRET, client.web.client_secret);
});

test('refuses permissive, symlinked, hardlinked, oversized and missing client inputs before any write', async (t) => {
  const f = await fixture(t); await chmod(f.clientFile, 0o644);
  assert.throws(() => configureIdentity(f.enable), { code: 'IDENTITY_FILE_UNSAFE' }); await chmod(f.clientFile, 0o600);
  const alias = path.join(f.directory, 'alias.json'); await symlink(f.clientFile, alias);
  assert.throws(() => configureIdentity([...f.args, '--client-file', alias, '--enable']), { code: 'IDENTITY_FILE_UNREADABLE' });
  await rm(alias); await link(f.clientFile, alias);
  assert.throws(() => configureIdentity(f.enable), { code: 'IDENTITY_FILE_UNSAFE' }); await rm(alias);
  await f.writeClient('x'.repeat(65_537)); assert.throws(() => configureIdentity(f.enable), { code: 'IDENTITY_FILE_UNSAFE' });
  await rm(f.clientFile); assert.throws(() => configureIdentity(f.enable), { code: 'IDENTITY_FILE_MISSING' });
  assert.equal(await readFile(f.configFile, 'utf8'), f.source);
});

test('refuses unsafe configuration files including hardlinks without replacing originals', async (t) => {
  const f = await fixture(t); await chmod(f.configFile, 0o644);
  assert.throws(() => configureIdentity(f.enable), { code: 'IDENTITY_FILE_UNSAFE' }); await chmod(f.configFile, 0o600);
  const alias = path.join(f.directory, 'alias.vars'); await symlink(f.configFile, alias);
  assert.throws(() => configureIdentity(['--config', alias, '--disable']), { code: 'IDENTITY_FILE_UNREADABLE' });
  await rm(alias); await link(f.configFile, alias);
  assert.throws(() => configureIdentity(f.enable), { code: 'IDENTITY_FILE_UNSAFE' });
  assert.equal(await readFile(f.configFile, 'utf8'), f.source); assert.equal(await readFile(alias, 'utf8'), f.source);
});

test('duplicate or malformed dotenv records fail without replacing any existing setting', async (t) => {
  const f = await fixture(t);
  for (const suffix of ['AUTH_GOOGLE_ENABLED=true\nAUTH_GOOGLE_ENABLED=false\n', 'no assignment\n', 'SECRET="bad\\nline"\n']) {
    const source = f.source + suffix; await f.writeConfig(source);
    assert.throws(() => configureIdentity(f.enable), { code: 'IDENTITY_CONFIG_INVALID' }); assert.equal(await readFile(f.configFile, 'utf8'), source);
  }
});

test('no-network setup, no implicit enable, safe CLI errors and alias execution', async (t) => {
  const f = await fixture(t); const previous = globalThis.fetch; globalThis.fetch = () => { throw new Error('Network forbidden.'); }; t.after(() => { globalThis.fetch = previous; });
  configureIdentity(f.enable); // A fetch attempt would fail this test.
  const cli = run([...f.args, '--status']); assert.equal(cli.status, 0);
  assert.equal(`${cli.stdout}${cli.stderr}`.includes(privateSentinel), false); assert.equal(`${cli.stdout}${cli.stderr}`.includes(f.client.web.client_id), false);
  for (const args of [[], ['--enable'], ['--client-file', f.clientFile], [...f.args, '--status', '--enable-signup'],
    [...f.args, '--disable', '--enable'], [...f.enable, '--enable'], ['--client-secret', privateSentinel],
    ['--config', f.configFile, '--config', f.configFile, '--status'], ['--config'], ['--help', '--client-secret', privateSentinel]]) {
    const result = run(args);
    assert.equal(result.status, args.length ? 1 : 0); assert.equal(`${result.stdout}${result.stderr}`.includes(privateSentinel), false);
    if (args.length) assert.match(result.stderr, /IDENTITY_ARGUMENT_INVALID/);
  }
  const alias = path.join(f.directory, 'identity-cli.mjs'); await symlink(script, alias);
  const aliased = run([...f.args, '--status'], alias); assert.equal(aliased.status, 0); assert.match(aliased.stdout, /"action":"status"/);
  await f.writeClient({ installed: { client_secret: privateSentinel } });
  const invalid = run(f.enable); assert.equal(invalid.status, 1); assert.equal(`${invalid.stdout}${invalid.stderr}`.includes(privateSentinel), false);
  assert.match(invalid.stderr, /IDENTITY_WEB_CLIENT_REQUIRED/);
});
