import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generateCloudConfiguration } from './configure-cloud.mjs';
import { rotateEncryptionKeyring } from '../packages/security/src/keyring.mjs';

const script = fileURLToPath(new URL('./configure-cloud.mjs', import.meta.url));
const dbId = '12345678-1234-4234-8234-123456789abc';
const productionDbId = '87654321-4321-4321-8321-cba987654321';
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'plause-cloud-config-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const secrets = { CONTENT_ENCRYPTION_KEY: randomBytes(32).toString('base64'), OPENAI_API_KEY: 'synthetic-openai-key-never-used-live',
    AUTH_GOOGLE_CLIENT_ID: 'synthetic-google-client.apps.googleusercontent.com', AUTH_GOOGLE_CLIENT_SECRET: 'synthetic-google-secret-never-used-live' };
  const filename = path.join(directory, 'private-secrets.json'); await writeFile(filename, JSON.stringify(secrets), { mode: 0o600 });
  const options = { '--environment': 'staging', '--account-id': '1234567890abcdef1234567890abcdef', '--origin': 'https://staging.plause.app',
    '--database-id': dbId, '--database-name': 'plause-staging-database', '--queue': 'plause-staging-jobs',
    '--dead-letter-queue': 'plause-staging-dead', '--privacy-bucket': 'plause-staging-privacy', '--secrets-file': filename,
    '--out': path.join(directory, 'wrangler.staging.json') };
  return { directory, secrets, filename, options, writeSecrets: () => writeFile(filename, JSON.stringify(secrets), { mode: 0o600 }) };
}
function production(f) {
  return { ...f.options, '--environment': 'production', '--origin': 'https://app.plause.app', '--database-id': productionDbId,
    '--database-name': 'plause-production-database', '--queue': 'plause-production-jobs', '--dead-letter-queue': 'plause-production-dead',
    '--privacy-bucket': 'plause-production-privacy', '--out': path.join(f.directory, 'wrangler.production.json'),
    '--isolation-config': f.options['--out'] };
}

test('staging configuration defaults to hosted model plus authenticated web and keeps all credentials private', async (t) => {
  const f = await fixture(t); const result = await generateCloudConfiguration(f.options);
  assert.equal(result.deployed, false); assert.equal(result.providerCredentialsVerified, false);
  const raw = await readFile(f.options['--out'], 'utf8'); const config = JSON.parse(raw);
  for (const secret of Object.values(f.secrets)) assert.equal(raw.includes(secret), false);
  assert.equal(config.account_id, f.options['--account-id']); assert.equal(config.vars.APP_ENV, 'staging');
  assert.equal(config.tsconfig, undefined); // Wrangler resolves explicit paths from a different build cwd; source-tree autodiscovery is correct.
  assert.equal(config.vars.MODEL_PROVIDER, 'openai'); assert.equal(config.vars.MESSAGING_PROVIDER, 'web');
  assert.equal(config.vars.AUTH_GOOGLE_ENABLED, 'true'); assert.equal(config.vars.AUTH_SIGNUP_ENABLED, 'false');
  assert.equal(config.vars.STAGING_ACCESS_ENABLED, 'false');
  assert.equal(config.vars.APPLE_CHANNEL_APPROVED, 'false'); assert.equal(config.vars.APPLE_PROACTIVE_ENABLED, 'false');
  assert.equal(config.vars.ONBOARDING_MESSAGES_ENABLED, 'false'); assert.equal(config.vars.ONBOARDING_GLOBAL_DAILY_LIMIT, '500');
  assert.equal(config.vars.LIVE_SEARCH_ENABLED, 'false'); assert.equal(config.vars.LIVE_GOOGLE_CALENDAR_ENABLED, 'false');
  assert.equal(config.vars.MODEL_USER_MONTHLY_BUDGET_MICRO_USD, '5000000'); assert.equal(config.vars.MODEL_GLOBAL_MONTHLY_BUDGET_MICRO_USD, '50000000');
  assert.equal(config.r2_buckets[0].binding, 'PRIVACY_LEDGER'); assert.equal(config.r2_buckets[0].bucket_name, 'plause-staging-privacy');
  assert.equal(config.queues.consumers[0].dead_letter_queue, 'plause-staging-dead');
  assert.equal(config.queues.consumers[1].queue, 'plause-staging-dead'); assert.equal(config.queues.consumers[1].max_retries, 100);
  assert.equal(config.vars.JOBS_DLQ_NAME, 'plause-staging-dead');
  assert.deepEqual(config.secrets.required, ['CONTENT_ENCRYPTION_KEY', 'OPENAI_API_KEY', 'AUTH_GOOGLE_CLIENT_ID', 'AUTH_GOOGLE_CLIENT_SECRET']);
  assert.deepEqual(config.triggers.crons, ['* * * * *']); assert.equal(config.preview_urls, false);
  assert.equal(config.observability.redact_query_string, true); assert.equal(config.observability.logs.invocation_logs, false);
  assert.equal((await stat(f.options['--out'])).mode & 0o777, 0o600);
  assert.deepEqual(config.routes, [{ pattern: 'staging.plause.app', custom_domain: true }]);
  assert.equal((await readdir(f.directory)).some((name) => name.endsWith('.tmp')), false);
});

test('production requires a separate reviewed staging configuration and resources', async (t) => {
  const f = await fixture(t); const options = production(f); delete options['--isolation-config'];
  await assert.rejects(generateCloudConfiguration(options), { code: 'CLOUD_PRODUCTION_REQUIRES_STAGING_CONFIG' });
  await generateCloudConfiguration(f.options);
  const prod = production(f); prod['--enable-signup'] = true;
  f.secrets.AUTH_SIGNUP_SUBJECTS = '["synthetic-first-member"]'; await f.writeSecrets();
  await generateCloudConfiguration(prod); const config = JSON.parse(await readFile(prod['--out'], 'utf8'));
  assert.equal(config.vars.APP_ENV, 'production'); assert.equal(config.vars.MODEL_PROVIDER, 'openai');
  assert.equal(config.vars.MESSAGING_PROVIDER, 'web'); assert.equal(config.vars.AUTH_SIGNUP_ENABLED, 'true');
  assert.equal(config.d1_databases[0].database_id, productionDbId);
});

test('cloud signup requires a private exact-subject admission list and never publishes its values', async (t) => {
  const f = await fixture(t);
  f.secrets.AUTH_SIGNUP_SUBJECTS = '["CaseSensitive_First","second-member"]'; await f.writeSecrets();
  const result = await generateCloudConfiguration({ ...f.options, '--enable-signup': true });
  const raw = await readFile(f.options['--out'], 'utf8'), config = JSON.parse(raw);
  assert.equal(config.vars.AUTH_SIGNUP_ENABLED, 'true');
  assert.equal(Object.hasOwn(config.vars, 'AUTH_SIGNUP_SUBJECTS'), false);
  assert.equal(config.secrets.required.includes('AUTH_SIGNUP_SUBJECTS'), true);
  assert.equal(result.requiredSecretNames.includes('AUTH_SIGNUP_SUBJECTS'), true);
  for (const value of ['CaseSensitive_First', 'second-member', f.secrets.AUTH_SIGNUP_SUBJECTS]) {
    assert.equal(raw.includes(value), false); assert.equal(JSON.stringify(result).includes(value), false);
  }
});

test('cloud signup fails closed for missing, malformed, empty, duplicate or oversized admission lists', async (t) => {
  const f = await fixture(t);
  for (const value of [undefined, null, 12, '', 'not-json', 'null', '{}', 'true', '[]', '[1]', '[""]', '["contains space"]',
    '["member@example.invalid"]', '["same","same"]', JSON.stringify(['x'.repeat(256)]),
    JSON.stringify(Array.from({ length: 6 }, (_, index) => `subject-${index}`)), ' '.repeat(4097)]) {
    if (value === undefined) delete f.secrets.AUTH_SIGNUP_SUBJECTS; else f.secrets.AUTH_SIGNUP_SUBJECTS = value;
    await f.writeSecrets();
    await assert.rejects(generateCloudConfiguration({ ...f.options, '--enable-signup': true }), { code: 'CLOUD_SIGNUP_SUBJECTS_INVALID' });
    assert.equal((await readdir(f.directory)).includes('wrangler.staging.json'), false);
  }
  // Operator admission is deliberately independent from account enrollment.
  delete f.secrets.AUTH_SIGNUP_SUBJECTS; f.secrets.OPERATOR_BOOTSTRAP_SUBJECTS = '["operator-only"]'; await f.writeSecrets();
  await assert.rejects(generateCloudConfiguration({ ...f.options, '--enable-signup': true }), { code: 'CLOUD_SIGNUP_SUBJECTS_INVALID' });
  f.secrets.AUTH_SIGNUP_SUBJECTS = '["PRIVATE_INVALID_SUBJECT@invalid"]'; await f.writeSecrets();
  const args = Object.entries(f.options).flatMap(([key, value]) => [key, value]);
  const result = spawnSync(process.execPath, [script, ...args, '--enable-signup'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 1); assert.match(result.stderr, /CLOUD_SIGNUP_SUBJECTS_INVALID/);
  assert.equal(`${result.stdout}${result.stderr}`.includes('PRIVATE_INVALID_SUBJECT@invalid'), false);
});

test('an admission list never enables cloud signup without the explicit flag', async (t) => {
  const f = await fixture(t); f.secrets.AUTH_SIGNUP_SUBJECTS = '["synthetic-first-member"]'; await f.writeSecrets();
  await generateCloudConfiguration(f.options);
  const config = JSON.parse(await readFile(f.options['--out'], 'utf8'));
  assert.equal(config.vars.AUTH_SIGNUP_ENABLED, 'false');
  assert.equal(config.secrets.required.includes('AUTH_SIGNUP_SUBJECTS'), true);
});

test('staging password protection requires explicit opt-in and keeps the hash private', async (t) => {
  const f = await fixture(t); const hash = randomBytes(32).toString('hex');
  f.secrets.STAGING_ACCESS_PASSWORD_SHA256 = hash; await f.writeSecrets();
  const result = await generateCloudConfiguration({ ...f.options, '--protect-staging': true });
  const raw = await readFile(f.options['--out'], 'utf8'), config = JSON.parse(raw);
  assert.equal(config.vars.STAGING_ACCESS_ENABLED, 'true'); assert.equal(config.vars.AUTH_SIGNUP_ENABLED, 'false');
  assert.equal(config.secrets.required.includes('STAGING_ACCESS_PASSWORD_SHA256'), true);
  assert.equal(Object.hasOwn(config.vars, 'STAGING_ACCESS_PASSWORD_SHA256'), false);
  assert.equal(raw.includes(hash), false); assert.equal(JSON.stringify(result).includes(hash), false);
  const out = path.join(f.directory, 'wrangler.protected-cli.json');
  const args = Object.entries({ ...f.options, '--out': out }).flatMap(([key, value]) => [key, value]);
  const cli = spawnSync(process.execPath, [script, ...args, '--protect-staging'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(cli.status, 0); assert.equal(`${cli.stdout}${cli.stderr}`.includes(hash), false);
  await generateCloudConfiguration({ ...f.options, '--out': path.join(f.directory, 'wrangler.unprotected.json') });
  assert.equal(JSON.parse(await readFile(path.join(f.directory, 'wrangler.unprotected.json'), 'utf8')).vars.STAGING_ACCESS_ENABLED, 'false');
});

test('staging protection rejects missing or malformed hashes and cannot enable in production', async (t) => {
  const f = await fixture(t);
  for (const value of [undefined, null, 123, '', 'x'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 'PRIVATE_INVALID_HASH']) {
    if (value === undefined) delete f.secrets.STAGING_ACCESS_PASSWORD_SHA256; else f.secrets.STAGING_ACCESS_PASSWORD_SHA256 = value;
    await f.writeSecrets();
    await assert.rejects(generateCloudConfiguration({ ...f.options, '--protect-staging': true }), { code: 'CLOUD_STAGING_ACCESS_HASH_INVALID' });
    assert.equal((await readdir(f.directory)).includes('wrangler.staging.json'), false);
  }
  await assert.rejects(generateCloudConfiguration({ ...production(f), '--protect-staging': true }), { code: 'CLOUD_STAGING_ACCESS_ENVIRONMENT_INVALID' });
});

test('production rejects reused D1 or origin and environment-mixed names', async (t) => {
  const f = await fixture(t); await generateCloudConfiguration(f.options);
  for (const patch of [{ '--database-id': dbId }, { '--origin': f.options['--origin'] }]) {
    await assert.rejects(generateCloudConfiguration({ ...production(f), ...patch }), { code: 'CLOUD_ENVIRONMENT_NOT_ISOLATED' });
  }
  for (const key of ['--queue', '--dead-letter-queue', '--privacy-bucket', '--database-name']) {
    await assert.rejects(generateCloudConfiguration({ ...production(f), [key]: f.options[key] }), { code: 'CLOUD_RESOURCE_ENVIRONMENT_MISMATCH' });
  }
  await assert.rejects(generateCloudConfiguration({ ...f.options, '--dead-letter-queue': f.options['--queue'] }), { code: 'CLOUD_QUEUE_ISOLATION_REQUIRED' });
});

test('rejects ambiguous/private origins and invalid account/database identifiers', async (t) => {
  const f = await fixture(t);
  for (const origin of ['http://staging.plause.app', 'https://localhost', 'https://127.0.0.1', 'https://[::1]', 'https://x.internal',
    'https://staging.plause.app/path', 'https://staging.plause.app/', 'https://u:p@staging.plause.app', 'https://staging.plause.app:8443', 'https://x.test']) {
    await assert.rejects(generateCloudConfiguration({ ...f.options, '--origin': origin }), { code: 'CLOUD_ORIGIN_INVALID' });
  }
  for (const value of ['00000000-0000-0000-0000-000000000000', 'not-a-uuid', '1234', '12345678-1234-4234-1234-123456789abc']) {
    await assert.rejects(generateCloudConfiguration({ ...f.options, '--database-id': value }), { code: 'CLOUD_DATABASE_ID_INVALID' });
  }
  await assert.rejects(generateCloudConfiguration({ ...f.options, '--account-id': '00000000000000000000000000000000' }), { code: 'CLOUD_ACCOUNT_ID_INVALID' });
});

test('supports exact workers.dev origin without adding a custom domain route', async (t) => {
  const f = await fixture(t); await generateCloudConfiguration({ ...f.options, '--origin': 'https://plause-staging.fixtureaccount.workers.dev' });
  const config = JSON.parse(await readFile(f.options['--out'], 'utf8')); assert.equal(config.workers_dev, true); assert.equal(config.routes, undefined);
  await assert.rejects(generateCloudConfiguration({ ...f.options, '--origin': 'https://other-worker.fixtureaccount.workers.dev' }), { code: 'CLOUD_WORKERS_DEV_NAME_MISMATCH' });
});

test('requires protected single-file secrets and accepts the complete canonical keyring', async (t) => {
  const f = await fixture(t);
  await chmod(f.filename, 0o644); await assert.rejects(generateCloudConfiguration(f.options), { code: 'CLOUD_PRIVATE_FILE_REQUIRED' });
  await chmod(f.filename, 0o600); const linked = path.join(f.directory, 'linked-secret.json'); await symlink(f.filename, linked);
  await assert.rejects(generateCloudConfiguration({ ...f.options, '--secrets-file': linked }), { code: 'CLOUD_PRIVATE_FILE_INVALID' });
  f.secrets.CONTENT_ENCRYPTION_KEY = rotateEncryptionKeyring(f.secrets.CONTENT_ENCRYPTION_KEY, randomBytes(32).toString('base64'), 'active-cloud-key');
  await f.writeSecrets(); await generateCloudConfiguration(f.options);
  assert.equal((await readFile(f.options['--out'], 'utf8')).includes(f.secrets.CONTENT_ENCRYPTION_KEY), false);
});

test('missing, invalid and unexpected secrets fail without creating a config or printing their values', async (t) => {
  const f = await fixture(t); const baseline = { ...f.secrets };
  for (const key of Object.keys(baseline)) {
    const values = { ...baseline }; delete values[key]; await writeFile(f.filename, JSON.stringify(values), { mode: 0o600 });
    await assert.rejects(generateCloudConfiguration(f.options), { code: 'CLOUD_REQUIRED_SECRET_MISSING' });
  }
  await writeFile(f.filename, JSON.stringify({ ...baseline, CONTENT_ENCRYPTION_KEY: 'not-a-key' }), { mode: 0o600 });
  await assert.rejects(generateCloudConfiguration(f.options), { code: 'CLOUD_CONTENT_KEY_INVALID' });
  await writeFile(f.filename, JSON.stringify({ ...baseline, UNEXPECTED_SECRET: 'PRIVATE_SENTINEL' }), { mode: 0o600 });
  await assert.rejects(generateCloudConfiguration(f.options), { code: 'CLOUD_SECRET_FIELD_UNKNOWN' });
  const args = Object.entries(f.options).flatMap(([key, value]) => [key, value]);
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 1);
  for (const value of [...Object.values(baseline), 'PRIVATE_SENTINEL']) assert.equal(`${result.stdout}${result.stderr}`.includes(value), false);
  assert.equal((await readdir(f.directory)).includes('wrangler.staging.json'), false);
});

test('output publication is exclusive, including existing and symlinked secret/config paths', async (t) => {
  const f = await fixture(t); await generateCloudConfiguration(f.options); const baseline = await readFile(f.options['--out']);
  await assert.rejects(generateCloudConfiguration(f.options), { code: 'CLOUD_OUTPUT_EXISTS' });
  assert.deepEqual(await readFile(f.options['--out']), baseline);
  await assert.rejects(generateCloudConfiguration({ ...f.options, '--out': f.filename }), { code: 'CLOUD_OUTPUT_EXISTS' });
  const linked = path.join(f.directory, 'linked-output.json'); await symlink(f.filename, linked);
  await assert.rejects(generateCloudConfiguration({ ...f.options, '--out': linked }), { code: 'CLOUD_OUTPUT_EXISTS' });
  assert.deepEqual(JSON.parse(await readFile(f.filename, 'utf8')), f.secrets);
  await assert.rejects(generateCloudConfiguration({ ...f.options, '--out': 'bad\npath.json' }), { code: 'CLOUD_PATH_INVALID' });
});

test('Sunshine requires explicit Apple/staffing assertions and exact provider/support configuration', async (t) => {
  const f = await fixture(t); const providerFile = path.join(f.directory, 'sunshine-public-settings.json');
  const settings = { APPLE_BUSINESS_ID: '12345678-1234-4234-8234-123456789abc', SUNSHINE_SUBDOMAIN: 'fixture-account', SUNSHINE_APP_ID: 'fixture_app', SUNSHINE_APPLE_INTEGRATION_ID: 'fixture_apple',
    SUNSHINE_WEBHOOK_ID: 'fixture_webhook', SUNSHINE_BOT_SWITCHBOARD_ID: 'fixture_bot', SUNSHINE_AGENT_SWITCHBOARD_ID: 'fixture_staff',
    SUPPORT_HOURS: 'Monday to Friday, 09:00 to 17:00', SUPPORT_TIME_ZONE: 'America/New_York', SUPPORT_CONTACT: 'https://plause.app/support' };
  await writeFile(providerFile, JSON.stringify(settings), { mode: 0o600 });
  const options = { ...f.options, '--sunshine-config-file': providerFile };
  await assert.rejects(generateCloudConfiguration(options), { code: 'CLOUD_APPLE_APPROVAL_REQUIRED' });
  options['--apple-approved'] = true; options['--support-covered'] = true;
  await assert.rejects(generateCloudConfiguration(options), { code: 'CLOUD_SUNSHINE_SECRET_MISSING' });
  Object.assign(f.secrets, { SUNSHINE_KEY_ID: 'fixture_key', SUNSHINE_KEY_SECRET: 'fixture-sunshine-secret-never-used',
    SUNSHINE_WEBHOOK_SECRET: 'fixture-webhook-secret-never-used', OPERATOR_BOOTSTRAP_SUBJECTS: '["fixture-operator-subject"]' });
  await f.writeSecrets(); const result = await generateCloudConfiguration(options);
  const config = JSON.parse(await readFile(f.options['--out'], 'utf8'));
  assert.equal(result.providerCredentialsVerified, false); assert.equal(config.vars.MESSAGING_PROVIDER, 'sunshine');
  assert.equal(config.vars.APPLE_CHANNEL_APPROVED, 'true'); assert.equal(config.vars.APPLE_PROACTIVE_ENABLED, 'false');
  assert.equal(config.vars.SUPPORT_COVERAGE_ENABLED, 'true'); assert.equal(config.vars.SUNSHINE_APP_ID, 'fixture_app');
  assert.equal(config.vars.TYPING_INDICATORS_ENABLED, 'true');
  assert.equal(config.vars.ONBOARDING_MESSAGES_ENABLED, 'false');
  for (const key of ['SUNSHINE_KEY_SECRET', 'SUNSHINE_KEY_ID', 'SUNSHINE_WEBHOOK_SECRET', 'OPERATOR_BOOTSTRAP_SUBJECTS']) assert.equal(Object.hasOwn(config.vars, key), false);
  const output = path.join(f.directory, 'wrangler.onboarding.json');
  await generateCloudConfiguration({ ...options, '--enable-messages-onboarding': true, '--out': output });
  const optedIn = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(optedIn.vars.ONBOARDING_MESSAGES_ENABLED, 'true'); assert.equal(optedIn.vars.ONBOARDING_GLOBAL_DAILY_LIMIT, '500');
  assert.equal(optedIn.vars.APPLE_PROACTIVE_ENABLED, 'false');
});

test('Messages onboarding opt-in is rejected without the approved Sunshine configuration', async (t) => {
  const f = await fixture(t);
  await assert.rejects(generateCloudConfiguration({ ...f.options, '--enable-messages-onboarding': true }), { code: 'CLOUD_ONBOARDING_REQUIRES_SUNSHINE' });
  assert.equal((await readdir(f.directory)).includes('wrangler.staging.json'), false);
  const args = Object.entries(f.options).flatMap(([name, value]) => [name, value]);
  const result = spawnSync(process.execPath, [script, ...args, '--enable-messages-onboarding'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 1); assert.match(result.stderr, /CLOUD_ONBOARDING_REQUIRES_SUNSHINE/);
  for (const value of Object.values(f.secrets)) assert.equal(`${result.stdout}${result.stderr}`.includes(value), false);
});

test('CLI rejects credential arguments without echoing the supplied credential', (t) => {
  const secret = 'never-print-this-private-credential';
  const result = spawnSync(process.execPath, [script, '--api-key', secret], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 1); assert.equal(`${result.stdout}${result.stderr}`.includes(secret), false);
});

test('cloud CLI main executes through a symlinked filesystem path', async (t) => {
  const f = await fixture(t); const alias = path.join(f.directory, 'configure-cloud.mjs'); await symlink(script, alias);
  const result = spawnSync(process.execPath, [alias], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 1); assert.match(result.stderr, /CLOUD_ENVIRONMENT_INVALID/);
});
