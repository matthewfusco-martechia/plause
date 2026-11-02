import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { chmod, link, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assessReadiness, inspectReadiness, parseConfiguration, parseVariables } from './live-readiness.mjs';

const script = fileURLToPath(new URL('./live-readiness.mjs', import.meta.url));
const sentinel = 'SYNTHETIC_PRIVATE_SENTINEL_NEVER_REQUESTED';
const key = () => randomBytes(32).toString('base64');
function fixture(environment = 'staging') {
  const config = { name: `plause-${environment}`, account_id: '1234567890abcdef1234567890abcdef', workers_dev: false, preview_urls: false,
    routes: [{ pattern: environment === 'production' ? 'plause.si' : 'staging.plause.si', custom_domain: true }],
    vars: { APP_ENV: environment, PUBLIC_ORIGIN: environment === 'production' ? 'https://plause.si' : 'https://staging.plause.si',
      MODEL_PROVIDER: 'openai', LIVE_MODEL_ENABLED: 'true', OPENAI_MODEL: 'gpt-6-luna', AUTH_GOOGLE_ENABLED: 'true',
      MESSAGING_PROVIDER: 'sunshine', LIVE_MESSAGING_ENABLED: 'true', APPLE_CHANNEL_APPROVED: 'true',
      APPLE_BUSINESS_ID: '12345678-1234-4234-8234-123456789abc', SUNSHINE_SUBDOMAIN: 'fixture-account', SUNSHINE_APP_ID: 'fixture_app',
      SUNSHINE_APPLE_INTEGRATION_ID: 'fixture_apple', SUNSHINE_WEBHOOK_ID: 'fixture_webhook',
      SUNSHINE_BOT_SWITCHBOARD_ID: 'fixture_bot', SUNSHINE_AGENT_SWITCHBOARD_ID: 'fixture_staff',
      SUPPORT_COVERAGE_ENABLED: 'true', SUPPORT_HOURS: 'Monday to Friday, 09:00 to 17:00', SUPPORT_TIME_ZONE: 'America/New_York',
      SUPPORT_CONTACT: 'https://plause.si/support', ONBOARDING_MESSAGES_ENABLED: 'true', ONBOARDING_GLOBAL_DAILY_LIMIT: '500' },
    d1_databases: [{ binding: 'DB', database_name: `plause-${environment}-database`,
      database_id: environment === 'production' ? '87654321-4321-4321-8321-cba987654321' : '12345678-1234-4234-8234-123456789abc' }],
    r2_buckets: [{ binding: 'PRIVACY_LEDGER', bucket_name: `plause-${environment}-privacy` }],
    queues: { producers: [{ binding: 'JOBS', queue: `plause-${environment}-jobs` }],
      consumers: [{ queue: `plause-${environment}-jobs`, dead_letter_queue: `plause-${environment}-dead` }, { queue: `plause-${environment}-dead` }] } };
  const secrets = { CONTENT_ENCRYPTION_KEY: key(), OPENAI_API_KEY: sentinel, AUTH_GOOGLE_CLIENT_ID: 'fixture.apps.googleusercontent.com',
    AUTH_GOOGLE_CLIENT_SECRET: sentinel, SUNSHINE_KEY_ID: 'fixture_key', SUNSHINE_KEY_SECRET: sentinel, SUNSHINE_WEBHOOK_SECRET: sentinel,
    OPERATOR_BOOTSTRAP_SUBJECTS: '["fixture-subject"]' };
  return { config, secrets, values: { ...config.vars, ...secrets } };
}
const check = (report, id) => report.checks.find((item) => item.id === id);
async function files(t, config = fixture().config, secrets = fixture().secrets) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'plause-readiness-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const configFile = path.join(directory, 'wrangler.jsonc'), secretsFile = path.join(directory, 'private.json');
  await writeFile(configFile, JSON.stringify(config), { mode: 0o644 });
  await writeFile(secretsFile, JSON.stringify(secrets), { mode: 0o600 });
  return { directory, configFile, secretsFile };
}

test('complete Messages fields remain static-only: no live readiness or provider verification', () => {
  const f = fixture(), report = assessReadiness(f.config, f.values);
  assert.equal(report.configurationReady, true); assert.equal(report.liveReady, false);
  assert.equal(report.liveAcceptance, 'unverified'); assert.equal(report.providerCredentialsVerified, false);
  assert.equal(report.networkRequests, 0); assert.equal(report.filesChanged, 0);
  assert.equal(JSON.stringify(report).includes(sentinel), false);
  assert.equal(JSON.stringify(report).includes(f.secrets.CONTENT_ENCRYPTION_KEY), false);
  assert.equal(check(report, 'onboarding').status, 'configured');
});

test('local mock configuration is distinguished from blocked Messages configuration', () => {
  const config = { vars: { APP_ENV: 'local', MODEL_PROVIDER: 'mock', MESSAGING_PROVIDER: 'mock' } };
  const report = assessReadiness(config, { ...config.vars, CONTENT_ENCRYPTION_KEY: key(), MOCK_WEBHOOK_SECRET: sentinel, OPERATOR_TOKEN: sentinel });
  assert.equal(report.localMockConfigured, true); assert.equal(report.configurationReady, false); assert.equal(report.liveReady, false);
  for (const id of ['environment', 'model', 'identity', 'cloudflare_account', 'messaging', 'apple_brand', 'onboarding', 'support']) assert.equal(check(report, id).status, 'blocked');
  assert.equal(check(report, 'model').missingFields.includes('OPENAI_API_KEY'), true);
  assert.match(check(report, 'model').action, /npm run configure:model -- --store-only/);
  assert.match(check(report, 'model').action, /npm run eval:model -- --live/);
  assert.match(check(report, 'model').action, /primary preview may remain mock/);
});

test('web staging can be statically configured without Apple, staffing or first-contact opt-in', () => {
  const f = fixture(); f.values.MESSAGING_PROVIDER = 'web';
  for (const name of Object.keys(f.values)) if (/^(SUNSHINE_|SUPPORT_|APPLE_|ONBOARDING_)/.test(name)) delete f.values[name];
  delete f.values.OPERATOR_BOOTSTRAP_SUBJECTS;
  const report = assessReadiness(f.config, f.values, { target: 'web' });
  assert.equal(report.configurationReady, true); assert.equal(report.liveReady, false);
  for (const id of ['messaging', 'apple_brand', 'staff_access', 'support', 'onboarding']) assert.equal(check(report, id).status, 'not_applicable');
  f.values.MESSAGING_PROVIDER = 'mock'; assert.equal(check(assessReadiness(f.config, f.values, { target: 'web' }), 'web_delivery').status, 'blocked');
});

test('private cloud admission lists are accepted without publishing subjects or changing files', async (t) => {
  const f = fixture(); f.config.vars.AUTH_SIGNUP_ENABLED = 'true';
  f.secrets.AUTH_SIGNUP_SUBJECTS = '["PrivateCaseSensitive_Subject","second-approved-subject"]';
  const input = await files(t, f.config, f.secrets), before = await readFile(input.secretsFile);
  const report = await inspectReadiness(input);
  assert.equal(check(report, 'inputs').status, 'configured'); assert.equal(check(report, 'enrollment').status, 'configured');
  assert.equal(report.configurationReady, true); assert.equal(report.liveReady, false);
  assert.equal(report.networkRequests, 0); assert.equal(report.filesChanged, 0);
  assert.deepEqual(await readFile(input.secretsFile), before);
  for (const subject of ['PrivateCaseSensitive_Subject', 'second-approved-subject', f.secrets.AUTH_SIGNUP_SUBJECTS]) assert.equal(JSON.stringify(report).includes(subject), false);
  const result = spawnSync(process.execPath, [script, '--config', input.configFile, '--secrets-file', input.secretsFile, '--json'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0); assert.equal(JSON.parse(result.stdout).configurationReady, true);
  for (const subject of ['PrivateCaseSensitive_Subject', 'second-approved-subject', sentinel]) assert.equal(`${result.stdout}${result.stderr}`.includes(subject), false);
});

test('enabled cloud signup rejects missing, malformed, empty, duplicate or oversized admission lists', () => {
  const invalid = [undefined, null, 123, '', 'not-json', 'null', '{}', 'true', '[]', '[1]', '[""]', '["contains space"]',
    '["private-member@example.invalid"]', '["duplicate","duplicate"]', JSON.stringify(['x'.repeat(256)]),
    JSON.stringify(Array.from({ length: 6 }, (_, index) => `subject-${index}`)), ' '.repeat(4097)];
  for (const environment of ['staging', 'production']) {
    const f = fixture(environment); f.values.AUTH_SIGNUP_ENABLED = 'true';
    // Role bootstrap is already configured and must not substitute for admission.
    for (const value of invalid) {
      if (value === undefined) delete f.values.AUTH_SIGNUP_SUBJECTS; else f.values.AUTH_SIGNUP_SUBJECTS = value;
      const report = assessReadiness(f.config, f.values);
      assert.equal(report.configurationReady, false);
      assert.deepEqual(check(report, 'enrollment').missingFields, ['AUTH_SIGNUP_SUBJECTS']);
      for (const privateValue of ['private-member@example.invalid', sentinel]) assert.equal(JSON.stringify(report).includes(privateValue), false);
    }
    f.values.AUTH_SIGNUP_SUBJECTS = JSON.stringify(Array.from({ length: 5 }, (_, index) => `${index}${'x'.repeat(254)}`));
    assert.equal(check(assessReadiness(f.config, f.values), 'enrollment').status, 'configured');
  }
});

test('closed cloud signup needs no list and explicit local development signup remains unchanged', () => {
  const f = fixture();
  for (const flag of [undefined, 'false']) {
    if (flag === undefined) delete f.values.AUTH_SIGNUP_ENABLED; else f.values.AUTH_SIGNUP_ENABLED = flag;
    delete f.values.AUTH_SIGNUP_SUBJECTS;
    assert.equal(assessReadiness(f.config, f.values).configurationReady, true);
    assert.equal(check(assessReadiness(f.config, f.values), 'enrollment').status, 'configured');
    f.values.AUTH_SIGNUP_SUBJECTS = 'not-an-admission-list';
    assert.equal(check(assessReadiness(f.config, f.values), 'enrollment').status, 'configured');
  }
  const local = { ...f.values, APP_ENV: 'local', PUBLIC_ORIGIN: 'http://localhost:8787', MODEL_PROVIDER: 'mock', MESSAGING_PROVIDER: 'mock',
    MOCK_WEBHOOK_SECRET: sentinel, OPERATOR_TOKEN: sentinel, AUTH_SIGNUP_ENABLED: 'true' };
  const report = assessReadiness({ vars: {} }, local);
  assert.equal(report.localMockConfigured, true); assert.equal(check(report, 'enrollment').status, 'not_applicable');
});

test('admission subjects in public or isolation vars block readiness even with valid private inputs', async (t) => {
  const f = fixture(); f.config.vars.AUTH_SIGNUP_ENABLED = 'true'; f.config.vars.AUTH_SIGNUP_SUBJECTS = '["PUBLIC_LEAK_SENTINEL"]';
  const input = await files(t, f.config, f.secrets), report = await inspectReadiness(input);
  assert.equal(report.configurationReady, false);
  assert.equal(check(report, 'inputs').missingFields.includes('READINESS_SECRET_IN_PUBLIC_CONFIG'), true);
  assert.deepEqual(check(report, 'enrollment').missingFields, ['AUTH_SIGNUP_SUBJECTS']);
  assert.equal(JSON.stringify(report).includes('PUBLIC_LEAK_SENTINEL'), false);
  const production = fixture('production'), prodInput = await files(t, production.config, production.secrets);
  const isolated = await inspectReadiness({ ...prodInput, isolationFile: input.configFile });
  assert.equal(check(isolated, 'inputs').missingFields.includes('READINESS_SECRET_IN_PUBLIC_CONFIG'), true);
  assert.equal(JSON.stringify(isolated).includes('PUBLIC_LEAK_SENTINEL'), false);
});

test('staging password hashes are private inputs and never appear in readiness output', async (t) => {
  const f = fixture(); f.config.vars.STAGING_ACCESS_ENABLED = 'true';
  const hash = randomBytes(32).toString('hex'); f.secrets.STAGING_ACCESS_PASSWORD_SHA256 = hash;
  const input = await files(t, f.config, f.secrets), report = await inspectReadiness(input);
  assert.equal(report.configurationReady, true); assert.equal(check(report, 'staging_access').status, 'configured');
  assert.equal(JSON.stringify(report).includes(hash), false);
  f.config.vars.STAGING_ACCESS_PASSWORD_SHA256 = hash;
  for (const enabled of ['true', 'false']) {
    f.config.vars.STAGING_ACCESS_ENABLED = enabled;
    const leaked = await files(t, f.config, f.secrets), blocked = await inspectReadiness(leaked);
    assert.equal(blocked.configurationReady, false);
    assert.equal(check(blocked, 'inputs').missingFields.includes('READINESS_SECRET_IN_PUBLIC_CONFIG'), true);
    assert.equal(JSON.stringify(blocked).includes(hash), false);
  }
});

test('enabled staging gate needs a valid hash and the staging environment without altering normal defaults', () => {
  const f = fixture();
  assert.equal(check(assessReadiness(f.config, f.values), 'staging_access').status, 'not_applicable');
  for (const hash of [undefined, null, 123, '', 'x'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 'PRIVATE_INVALID_HASH']) {
    const report = assessReadiness(f.config, { ...f.values, STAGING_ACCESS_ENABLED: 'true', STAGING_ACCESS_PASSWORD_SHA256: hash });
    assert.deepEqual(check(report, 'staging_access').missingFields, ['STAGING_ACCESS_PASSWORD_SHA256']);
    assert.equal(report.configurationReady, false); assert.equal(JSON.stringify(report).includes('PRIVATE_INVALID_HASH'), false);
  }
  for (const environment of ['local', 'production']) {
    const report = assessReadiness(f.config, { ...f.values, APP_ENV: environment, STAGING_ACCESS_ENABLED: 'true', STAGING_ACCESS_PASSWORD_SHA256: 'A'.repeat(64) });
    assert.deepEqual(check(report, 'staging_access').missingFields, ['APP_ENV']);
    assert.equal(report.configurationReady, false);
  }
  for (const flag of ['TRUE', 'yes', '', true, 1]) {
    const report = assessReadiness(f.config, { ...f.values, STAGING_ACCESS_ENABLED: flag, STAGING_ACCESS_PASSWORD_SHA256: 'a'.repeat(64) });
    assert.deepEqual(check(report, 'staging_access').missingFields, ['STAGING_ACCESS_ENABLED']);
    assert.equal(report.configurationReady, false);
  }
  assert.equal(assessReadiness(f.config, { ...f.values, STAGING_ACCESS_ENABLED: 'false' }).configurationReady, true);
});

test('onboarding requires explicit enablement and a bounded positive daily cap', () => {
  const f = fixture(); delete f.values.ONBOARDING_GLOBAL_DAILY_LIMIT;
  assert.equal(check(assessReadiness(f.config, f.values), 'onboarding').status, 'configured');
  f.values.ONBOARDING_MESSAGES_ENABLED = 'false';
  assert.deepEqual(check(assessReadiness(f.config, f.values), 'onboarding').missingFields, ['ONBOARDING_MESSAGES_ENABLED']);
  f.values.ONBOARDING_MESSAGES_ENABLED = 'true';
  for (const value of ['0', '-1', '1.5', '5001', '0500', 'secret-malformed-cap']) {
    f.values.ONBOARDING_GLOBAL_DAILY_LIMIT = value;
    const report = assessReadiness(f.config, f.values);
    assert.deepEqual(check(report, 'onboarding').missingFields, ['ONBOARDING_GLOBAL_DAILY_LIMIT']);
    assert.equal(JSON.stringify(report).includes(value === 'secret-malformed-cap' ? value : sentinel), false);
  }
});

test('model policy, identity, support and staff validation report only fixed field names', () => {
  const f = fixture(); Object.assign(f.values, { OPENAI_MODEL: sentinel, MODEL_MAX_INPUT_TOKENS: '20001', MODEL_MAX_OUTPUT_TOKENS: '0',
    MODEL_TIMEOUT_MS: '45001', MODEL_USER_MONTHLY_BUDGET_MICRO_USD: '100000001', MODEL_GLOBAL_MONTHLY_BUDGET_MICRO_USD: '1',
    AUTH_GOOGLE_CLIENT_SECRET: 'short', SUPPORT_TIME_ZONE: sentinel, SUPPORT_CONTACT: 'https://plause.si/support?private=secret',
    OPERATOR_BOOTSTRAP_SUBJECTS: '["duplicate","duplicate"]' });
  const report = assessReadiness(f.config, f.values);
  assert.equal(report.configurationReady, false);
  assert.deepEqual(check(report, 'model').missingFields, ['OPENAI_MODEL', 'MODEL_MAX_INPUT_TOKENS', 'MODEL_MAX_OUTPUT_TOKENS', 'MODEL_TIMEOUT_MS', 'MODEL_USER_MONTHLY_BUDGET_MICRO_USD']);
  for (const id of ['identity', 'support', 'staff_access']) assert.equal(check(report, id).status, 'blocked');
  assert.equal(JSON.stringify(report).includes(sentinel), false);
});

test('production requires a separate reviewed environment and detects resource collisions', () => {
  const prod = fixture('production'), staging = fixture();
  assert.equal(check(assessReadiness(prod.config, prod.values), 'environment_isolation').status, 'blocked');
  assert.equal(assessReadiness(prod.config, prod.values, { otherConfig: staging.config }).configurationReady, true);
  assert.equal(check(assessReadiness(prod.config, prod.values, { otherConfig: { vars: { APP_ENV: 'staging' } } }), 'environment_isolation').status, 'blocked');
  for (const mutate of [
    (other) => { other.vars.PUBLIC_ORIGIN = prod.values.PUBLIC_ORIGIN; },
    (other) => { other.d1_databases[0].database_id = prod.config.d1_databases[0].database_id; },
    (other) => { other.queues.consumers[1].queue = prod.config.queues.producers[0].queue; },
    (other) => { other.r2_buckets[0].bucket_name = prod.config.r2_buckets[0].bucket_name; },
  ]) {
    const other = structuredClone(staging.config); mutate(other);
    assert.equal(check(assessReadiness(prod.config, prod.values, { otherConfig: other }), 'environment_isolation').status, 'blocked');
  }
});

test('strict origin, Worker routing, queue and ledger checks reject incomplete cloud setup', () => {
  const f = fixture();
  for (const value of ['http://staging.plause.si', 'https://localhost', 'https://127.0.0.1', 'https://x.internal', 'https://x.test', 'https://staging.plause.si/path']) {
    assert.equal(check(assessReadiness(f.config, { ...f.values, PUBLIC_ORIGIN: value }), 'environment').status, 'blocked');
  }
  f.config.preview_urls = true; assert.equal(check(assessReadiness(f.config, f.values), 'routing').status, 'blocked');
  f.config.preview_urls = false; f.config.queues.consumers.pop();
  assert.equal(check(assessReadiness(f.config, f.values), 'queues').status, 'blocked');
  f.config.r2_buckets = []; assert.equal(check(assessReadiness(f.config, f.values), 'privacy_ledger').status, 'blocked');
});

test('JSONC parsing preserves quoted URLs, comment markers and commas', () => {
  assert.deepEqual(parseConfiguration('{/* note */"vars":{"PUBLIC_ORIGIN":"https://staging.plause.si","text":"// /* ,} ,] \\\"",},// end\n}'),
    { vars: { PUBLIC_ORIGIN: 'https://staging.plause.si', text: '// /* ,} ,] "' } });
  for (const input of ['[]', '{', '{/*unterminated', '{"private":"' + sentinel]) assert.throws(() => parseConfiguration(input), { code: 'READINESS_CONFIG_INVALID' });
});

test('dotenv parsing rejects duplicate and malformed records without executing substitutions', () => {
  const values = parseVariables('export A="value"\nB=literal$(echo private)\nC=\'single value\'\n# ignored\nD=trailing # comment\n');
  assert.equal(values.B, 'literal$(echo private)'); assert.equal(values.C, 'single value'); assert.equal(values.D, 'trailing');
  for (const source of ['A=one\nA=two', 'no assignment', 'A="broken', 'A="escaped\\nline"', "A='bad'quote'"]) assert.throws(() => parseVariables(source), { code: 'READINESS_VARIABLES_INVALID' });
});

test('protected files are read without changing data, modes or directory entries', async (t) => {
  const f = fixture(), input = await files(t, f.config, f.secrets);
  const before = { config: await readFile(input.configFile), secret: await readFile(input.secretsFile), entries: await readdir(input.directory) };
  const savedFetch = globalThis.fetch; globalThis.fetch = () => { throw new Error('network forbidden'); }; t.after(() => { globalThis.fetch = savedFetch; });
  const report = await inspectReadiness(input);
  assert.equal(report.configurationReady, true); assert.equal(report.liveReady, false);
  assert.deepEqual(await readFile(input.configFile), before.config); assert.deepEqual(await readFile(input.secretsFile), before.secret);
  assert.deepEqual(await readdir(input.directory), before.entries); assert.equal((await stat(input.secretsFile)).mode & 0o777, 0o600);
  assert.equal(JSON.stringify(report).includes(sentinel), false);
});

test('public vars cannot supply secrets and custom configs do not inherit ambient or root secrets', async (t) => {
  const f = fixture(); Object.assign(f.config.vars, f.secrets); const input = await files(t, f.config, {});
  process.env.OPENAI_API_KEY = sentinel; t.after(() => { delete process.env.OPENAI_API_KEY; });
  const report = await inspectReadiness({ configFile: input.configFile });
  assert.equal(report.configurationReady, false); assert.equal(check(report, 'inputs').missingFields.includes('READINESS_SECRET_IN_PUBLIC_CONFIG'), true);
  assert.equal(check(report, 'model').missingFields.includes('OPENAI_API_KEY'), true);
  assert.equal(check(report, 'encryption').status, 'blocked'); assert.equal(JSON.stringify(report).includes(sentinel), false);
});

test('permissive secret permissions, symlinks and hardlinks fail closed', async (t) => {
  const input = await files(t);
  await chmod(input.secretsFile, 0o644);
  assert.deepEqual(check(await inspectReadiness(input), 'inputs').missingFields, ['READINESS_FILE_UNSAFE']);
  await chmod(input.secretsFile, 0o600);
  const alias = path.join(input.directory, 'alias.json'); await symlink(input.secretsFile, alias);
  assert.deepEqual(check(await inspectReadiness({ ...input, secretsFile: alias }), 'inputs').missingFields, ['READINESS_FILE_UNREADABLE']);
  await rm(alias); await link(input.secretsFile, alias);
  assert.deepEqual(check(await inspectReadiness(input), 'inputs').missingFields, ['READINESS_FILE_UNSAFE']);
});

test('missing, oversized, unknown and malformed secret files expose only safe codes', async (t) => {
  const input = await files(t);
  const cases = [
    [null, 'READINESS_FILE_MISSING'], ['x'.repeat(131_073), 'READINESS_FILE_UNSAFE'],
    [JSON.stringify({ UNEXPECTED_SECRET: sentinel }), 'READINESS_SECRETS_INVALID'], ['{"OPENAI_API_KEY":"' + sentinel, 'READINESS_SECRETS_INVALID'],
  ];
  for (const [source, code] of cases) {
    if (source === null) await rm(input.secretsFile); else await writeFile(input.secretsFile, source, { mode: 0o600 });
    const report = await inspectReadiness(input); assert.deepEqual(check(report, 'inputs').missingFields, [code]);
    assert.equal(JSON.stringify(report).includes(sentinel), false);
  }
});

test('explicit private dotenv configuration is supported and malformed duplicate values block readiness', async (t) => {
  const f = fixture(), input = await files(t, f.config, f.secrets), varsFile = path.join(input.directory, 'private.vars');
  await writeFile(varsFile, Object.entries(f.secrets).map(([name, value]) => `${name}=${JSON.stringify(value)}`).join('\n'), { mode: 0o600 });
  assert.equal((await inspectReadiness({ configFile: input.configFile, varsFile })).configurationReady, true);
  await writeFile(varsFile, `OPENAI_API_KEY=${sentinel}\nOPENAI_API_KEY=duplicate`, { mode: 0o600 });
  assert.deepEqual(check(await inspectReadiness({ configFile: input.configFile, varsFile }), 'inputs').missingFields, ['READINESS_VARIABLES_INVALID']);
});

test('CLI JSON output, safe exit codes, argument rejection and aliased main path', async (t) => {
  const input = await files(t), args = ['--config', input.configFile, '--secrets-file', input.secretsFile, '--json'];
  const run = (argv, entry = script) => spawnSync(process.execPath, [entry, ...argv], { encoding: 'utf8', timeout: 5000 });
  const ready = run(args); assert.equal(ready.status, 0); assert.equal(JSON.parse(ready.stdout).liveReady, false);
  assert.equal(`${ready.stdout}${ready.stderr}`.includes(sentinel), false);
  const blocked = run(['--config', input.configFile, '--json']); assert.equal(blocked.status, 2); assert.equal(JSON.parse(blocked.stdout).configurationReady, false);
  for (const argv of [['--api-key', sentinel], ['--config', input.configFile, '--config', input.configFile], ['--target', 'bad-' + sentinel], ['--config']]) {
    const result = run(argv); assert.equal(result.status, 2); assert.equal(`${result.stdout}${result.stderr}`.includes(sentinel), false);
    assert.match(result.stderr, /READINESS_ARGUMENT_INVALID/);
  }
  const alias = path.join(input.directory, 'readiness.mjs'); await symlink(script, alias);
  assert.match(run(['--help'], alias).stdout, /offline|without requests/);
});
