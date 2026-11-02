import { constants } from 'node:fs';
import { link, lstat, open, readFile, realpath, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEncryptionKeyring } from '../packages/security/src/keyring.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
export class CloudConfigurationError extends Error { constructor(code) { super(code); this.code = code; } }
const fail = (code) => { throw new CloudConfigurationError(code); };
const opaque = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const requiredSecrets = ['CONTENT_ENCRYPTION_KEY', 'OPENAI_API_KEY', 'AUTH_GOOGLE_CLIENT_ID', 'AUTH_GOOGLE_CLIENT_SECRET'];
const sunshineSecrets = ['SUNSHINE_KEY_ID', 'SUNSHINE_KEY_SECRET', 'SUNSHINE_WEBHOOK_SECRET'];
const optionalSecrets = ['OPERATOR_BOOTSTRAP_SUBJECTS', 'AUTH_SIGNUP_SUBJECTS', 'STAGING_ACCESS_PASSWORD_SHA256', 'TAVILY_API_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', ...sunshineSecrets];
const sunshinePublic = ['APPLE_BUSINESS_ID', 'SUNSHINE_SUBDOMAIN', 'SUNSHINE_APP_ID', 'SUNSHINE_APPLE_INTEGRATION_ID', 'SUNSHINE_WEBHOOK_ID',
  'SUNSHINE_BOT_SWITCHBOARD_ID', 'SUNSHINE_AGENT_SWITCHBOARD_ID', 'SUPPORT_HOURS', 'SUPPORT_TIME_ZONE', 'SUPPORT_CONTACT'];

function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function safePath(value) {
  if (typeof value !== 'string' || !value || value.length > 4000 || /[\x00-\x1f\x7f]/.test(value)) fail('CLOUD_PATH_INVALID');
  return path.resolve(value);
}
async function privateJson(filename) {
  let file;
  try {
    file = await open(safePath(filename), constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await file.stat();
    if (!info.isFile() || info.size > 64 * 1024 || (info.mode & 0o077) !== 0 || info.nlink !== 1
      || typeof process.getuid === 'function' && info.uid !== process.getuid()) fail('CLOUD_PRIVATE_FILE_REQUIRED');
    const value = JSON.parse(await file.readFile('utf8'));
    if (!object(value)) fail('CLOUD_PRIVATE_FILE_INVALID');
    return value;
  } catch (error) { if (error instanceof CloudConfigurationError) throw error; fail('CLOUD_PRIVATE_FILE_INVALID'); }
  finally { await file?.close(); }
}
function nonempty(value, min = 1, max = 1000) {
  return typeof value === 'string' && value.length >= min && value.length <= max && !/[\s\x00-\x1f\x7f]/.test(value);
}
function validOrigin(value) {
  try {
    const url = new URL(value); const hostname = url.hostname.toLowerCase();
    if (url.origin !== value || url.protocol !== 'https:' || url.username || url.password || url.port || !hostname.includes('.')
      || /[:\[\]]/.test(hostname) || /^[0-9.]+$/.test(hostname) || hostname.endsWith('.')
      || /(?:^|\.)(?:localhost|local|internal|test|invalid|example|onion|home|lan|corp)$/.test(hostname)
      || /(?:^|\.)(?:localtest\.me|lvh\.me)$/.test(hostname)) fail('CLOUD_ORIGIN_INVALID');
    return url;
  } catch { fail('CLOUD_ORIGIN_INVALID'); }
}
function environmentName(value, environment) {
  return typeof value === 'string' && value.length <= 63 && new RegExp(`^plause-${environment}(?:-[a-z0-9]+)*$`).test(value);
}
function parseArguments(argv) {
  const allowed = ['--environment', '--origin', '--account-id', '--database-id', '--database-name', '--queue', '--dead-letter-queue', '--privacy-bucket',
    '--secrets-file', '--out', '--enable-signup', '--sunshine-config-file', '--apple-approved', '--support-covered', '--isolation-config', '--enable-messages-onboarding', '--protect-staging'];
  const flags = ['--enable-signup', '--apple-approved', '--support-covered', '--enable-messages-onboarding', '--protect-staging']; const options = {};
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (!allowed.includes(key) || Object.hasOwn(options, key)) fail('CLOUD_ARGUMENT_INVALID');
    if (flags.includes(key)) { options[key] = true; continue; }
    const value = argv[++index]; if (!value || value.startsWith('--')) fail('CLOUD_ARGUMENT_INVALID'); options[key] = value;
  }
  return options;
}

async function validateSecrets(filename, sunshine, signupEnabled, protectStaging) {
  const secrets = await privateJson(filename);
  if (Object.keys(secrets).some((key) => ![...requiredSecrets, ...optionalSecrets].includes(key))) fail('CLOUD_SECRET_FIELD_UNKNOWN');
  if (requiredSecrets.some((key) => !nonempty(secrets[key], 1, key === 'CONTENT_ENCRYPTION_KEY' ? 8192 : 1000))) fail('CLOUD_REQUIRED_SECRET_MISSING');
  try { parseEncryptionKeyring(secrets.CONTENT_ENCRYPTION_KEY); } catch { fail('CLOUD_CONTENT_KEY_INVALID'); }
  if (!nonempty(secrets.OPENAI_API_KEY, 16, 1000) || !/^[A-Za-z0-9._-]{1,256}$/.test(secrets.AUTH_GOOGLE_CLIENT_ID)
    || !nonempty(secrets.AUTH_GOOGLE_CLIENT_SECRET, 8, 1000)) fail('CLOUD_SECRET_INVALID');
  for (const key of optionalSecrets) if (Object.hasOwn(secrets, key) && !['AUTH_SIGNUP_SUBJECTS', 'STAGING_ACCESS_PASSWORD_SHA256'].includes(key)
    && (typeof secrets[key] !== 'string' || key !== 'OPERATOR_BOOTSTRAP_SUBJECTS' && !nonempty(secrets[key], 1, 1000))) fail('CLOUD_SECRET_INVALID');
  if ((protectStaging || Object.hasOwn(secrets, 'STAGING_ACCESS_PASSWORD_SHA256'))
    && (typeof secrets.STAGING_ACCESS_PASSWORD_SHA256 !== 'string' || !/^[0-9a-f]{64}$/i.test(secrets.STAGING_ACCESS_PASSWORD_SHA256))) {
    fail('CLOUD_STAGING_ACCESS_HASH_INVALID');
  }
  if (signupEnabled || Object.hasOwn(secrets, 'AUTH_SIGNUP_SUBJECTS')) {
    let subjects;
    try {
      if (typeof secrets.AUTH_SIGNUP_SUBJECTS !== 'string' || secrets.AUTH_SIGNUP_SUBJECTS.length > 4096) throw new Error();
      subjects = JSON.parse(secrets.AUTH_SIGNUP_SUBJECTS);
    } catch { fail('CLOUD_SIGNUP_SUBJECTS_INVALID'); }
    if (!Array.isArray(subjects) || subjects.length < 1 || subjects.length > 5
      || subjects.some((value) => typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,255}$/.test(value))
      || new Set(subjects).size !== subjects.length) fail('CLOUD_SIGNUP_SUBJECTS_INVALID');
  }
  if (secrets.OPERATOR_BOOTSTRAP_SUBJECTS !== undefined) {
    let subjects;
    try { subjects = JSON.parse(secrets.OPERATOR_BOOTSTRAP_SUBJECTS); } catch { fail('CLOUD_OPERATOR_SUBJECTS_INVALID'); }
    if (!Array.isArray(subjects) || subjects.length > 5 || subjects.some((value) => typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,255}$/.test(value))
      || new Set(subjects).size !== subjects.length) fail('CLOUD_OPERATOR_SUBJECTS_INVALID');
  }
  if (sunshine && (sunshineSecrets.some((key) => !nonempty(secrets[key], key === 'SUNSHINE_KEY_ID' ? 1 : 16, 1000))
    || !opaque.test(secrets.SUNSHINE_KEY_ID) || !secrets.OPERATOR_BOOTSTRAP_SUBJECTS || JSON.parse(secrets.OPERATOR_BOOTSTRAP_SUBJECTS).length === 0)) {
    fail('CLOUD_SUNSHINE_SECRET_MISSING');
  }
  return [...requiredSecrets, ...(sunshine ? sunshineSecrets : []), ...(secrets.OPERATOR_BOOTSTRAP_SUBJECTS ? ['OPERATOR_BOOTSTRAP_SUBJECTS'] : []),
    ...(secrets.AUTH_SIGNUP_SUBJECTS ? ['AUTH_SIGNUP_SUBJECTS'] : []), ...(secrets.STAGING_ACCESS_PASSWORD_SHA256 ? ['STAGING_ACCESS_PASSWORD_SHA256'] : [])];
}

async function sunshineSettings(filename) {
  const settings = await privateJson(filename);
  if (Object.keys(settings).length !== sunshinePublic.length || sunshinePublic.some((key) => !Object.hasOwn(settings, key))) fail('CLOUD_SUNSHINE_SETTINGS_INVALID');
  if (typeof settings.APPLE_BUSINESS_ID !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(settings.APPLE_BUSINESS_ID)) fail('CLOUD_SUNSHINE_SETTINGS_INVALID');
  if (typeof settings.SUNSHINE_SUBDOMAIN !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(settings.SUNSHINE_SUBDOMAIN)) fail('CLOUD_SUNSHINE_SETTINGS_INVALID');
  for (const key of sunshinePublic.filter((key) => key.startsWith('SUNSHINE_') && key !== 'SUNSHINE_SUBDOMAIN')) {
    if (typeof settings[key] !== 'string' || !opaque.test(settings[key])) fail('CLOUD_SUNSHINE_SETTINGS_INVALID');
  }
  if (typeof settings.SUPPORT_HOURS !== 'string' || !settings.SUPPORT_HOURS.trim() || settings.SUPPORT_HOURS.length > 300 || /[\x00-\x1f\x7f]/.test(settings.SUPPORT_HOURS)) fail('CLOUD_SUPPORT_SETTINGS_INVALID');
  try { if (typeof settings.SUPPORT_TIME_ZONE !== 'string') throw new Error(); new Intl.DateTimeFormat('en', { timeZone: settings.SUPPORT_TIME_ZONE }); }
  catch { fail('CLOUD_SUPPORT_SETTINGS_INVALID'); }
  try {
    if (typeof settings.SUPPORT_CONTACT !== 'string' || settings.SUPPORT_CONTACT.length > 300) throw new Error();
    const contact = new URL(settings.SUPPORT_CONTACT); validOrigin(contact.origin);
    if (contact.username || contact.password || contact.search || contact.hash) throw new Error();
  } catch { fail('CLOUD_SUPPORT_SETTINGS_INVALID'); }
  return settings;
}

async function atomicNewJson(filename, value) {
  const parent = path.dirname(filename);
  if (!(await lstat(parent)).isDirectory()) fail('CLOUD_OUTPUT_DIRECTORY_INVALID');
  const temporary = path.join(parent, `.plause-config-${randomUUID()}.tmp`); let created = false;
  try {
    const file = await open(temporary, 'wx', 0o600); created = true;
    try { await file.writeFile(JSON.stringify(value, null, 2) + '\n'); await file.sync(); } finally { await file.close(); }
    // hard-link creation is exclusive; rename alone could overwrite a path
    // inserted between a prior existence check and publication.
    await link(temporary, filename);
  } catch (error) { if (error instanceof CloudConfigurationError) throw error; fail(error.code === 'EEXIST' ? 'CLOUD_OUTPUT_EXISTS' : 'CLOUD_OUTPUT_FAILED'); }
  finally { if (created) await unlink(temporary).catch(() => {}); }
}

export async function generateCloudConfiguration(options) {
  const environment = options['--environment'];
  if (!['staging', 'production'].includes(environment)) fail('CLOUD_ENVIRONMENT_INVALID');
  if (options['--protect-staging'] && environment !== 'staging') fail('CLOUD_STAGING_ACCESS_ENVIRONMENT_INVALID');
  if (environment === 'production' && !options['--isolation-config']) fail('CLOUD_PRODUCTION_REQUIRES_STAGING_CONFIG');
  const origin = validOrigin(options['--origin']);
  const accountId = options['--account-id'];
  if (typeof accountId !== 'string' || !/^[0-9a-f]{32}$/i.test(accountId) || /^0{32}$/.test(accountId)) fail('CLOUD_ACCOUNT_ID_INVALID');
  const databaseId = options['--database-id'];
  if (typeof databaseId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(databaseId)) fail('CLOUD_DATABASE_ID_INVALID');
  for (const key of ['--database-name', '--queue', '--dead-letter-queue', '--privacy-bucket']) {
    if (!environmentName(options[key], environment)) fail('CLOUD_RESOURCE_ENVIRONMENT_MISMATCH');
  }
  if (options['--queue'] === options['--dead-letter-queue']) fail('CLOUD_QUEUE_ISOLATION_REQUIRED');
  const sunshine = !!options['--sunshine-config-file'];
  if (sunshine !== !!options['--apple-approved'] || sunshine !== !!options['--support-covered']) fail('CLOUD_APPLE_APPROVAL_REQUIRED');
  if (options['--enable-messages-onboarding'] && !sunshine) fail('CLOUD_ONBOARDING_REQUIRES_SUNSHINE');
  const settings = sunshine ? await sunshineSettings(options['--sunshine-config-file']) : {};
  const secretNames = await validateSecrets(options['--secrets-file'], sunshine, !!options['--enable-signup'], !!options['--protect-staging']);
  const filename = safePath(options['--out']);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.jsonc?$/.test(path.basename(filename))) fail('CLOUD_OUTPUT_PATH_INVALID');
  if (await realpath(safePath(options['--secrets-file'])) === filename || sunshine && await realpath(safePath(options['--sunshine-config-file'])) === filename) fail('CLOUD_OUTPUT_EXISTS');
  const workerName = `plause-${environment}`; const workersDev = origin.hostname.endsWith('.workers.dev');
  if (workersDev && !new RegExp(`^${workerName}\\.[a-z0-9-]+\\.workers\\.dev$`).test(origin.hostname)) fail('CLOUD_WORKERS_DEV_NAME_MISMATCH');
  const config = {
    $schema: path.relative(path.dirname(filename), path.join(root, 'node_modules/wrangler/config-schema.json')),
    name: workerName, account_id: accountId, main: path.relative(path.dirname(filename), path.join(root, 'apps/api/src/index.ts')),
    compatibility_date: '2026-10-30', compatibility_flags: ['nodejs_compat'], workers_dev: workersDev, preview_urls: false,
    ...(workersDev ? {} : { routes: [{ pattern: origin.hostname, custom_domain: true }] }),
    secrets: { required: secretNames },
    vars: { APP_ENV: environment, PUBLIC_ORIGIN: origin.origin, STAGING_ACCESS_ENABLED: options['--protect-staging'] ? 'true' : 'false', JOBS_DLQ_NAME: options['--dead-letter-queue'], MODEL_PROVIDER: 'openai', LIVE_MODEL_ENABLED: 'true',
      OPENAI_MODEL: 'gpt-6-luna', MODEL_MAX_INPUT_TOKENS: '4096', MODEL_MAX_OUTPUT_TOKENS: '600', MODEL_TIMEOUT_MS: '20000',
      MODEL_USER_MONTHLY_BUDGET_MICRO_USD: '5000000', MODEL_GLOBAL_MONTHLY_BUDGET_MICRO_USD: '50000000',
      MESSAGING_PROVIDER: sunshine ? 'sunshine' : 'web', LIVE_MESSAGING_ENABLED: sunshine ? 'true' : 'false',
      APPLE_CHANNEL_APPROVED: sunshine ? 'true' : 'false', APPLE_PROACTIVE_ENABLED: 'false',
      ONBOARDING_MESSAGES_ENABLED: sunshine && options['--enable-messages-onboarding'] ? 'true' : 'false', ONBOARDING_GLOBAL_DAILY_LIMIT: '500',
      AUTH_GOOGLE_ENABLED: 'true', AUTH_SIGNUP_ENABLED: options['--enable-signup'] ? 'true' : 'false',
      SEARCH_PROVIDER: 'disabled', LIVE_SEARCH_ENABLED: 'false', SEARCH_USER_DAILY_LIMIT: '20', SEARCH_GLOBAL_DAILY_LIMIT: '500',
      LIVE_GOOGLE_CALENDAR_ENABLED: 'false', GOOGLE_REDIRECT_URI: `${origin.origin}/api/calendar/google/callback`,
      SUPPORT_COVERAGE_ENABLED: sunshine ? 'true' : 'false', TYPING_INDICATORS_ENABLED: sunshine ? 'true' : 'false', ...settings },
    assets: { directory: path.relative(path.dirname(filename), path.join(root, 'apps/api/public')), binding: 'ASSETS', run_worker_first: true },
    d1_databases: [{ binding: 'DB', database_name: options['--database-name'], database_id: databaseId,
      migrations_dir: path.relative(path.dirname(filename), path.join(root, 'migrations')) }],
    r2_buckets: [{ binding: 'PRIVACY_LEDGER', bucket_name: options['--privacy-bucket'] }],
    queues: { producers: [{ binding: 'JOBS', queue: options['--queue'] }], consumers: [{ queue: options['--queue'],
      max_batch_size: 10, max_batch_timeout: 1, max_retries: 3, dead_letter_queue: options['--dead-letter-queue'] },
      { queue: options['--dead-letter-queue'], max_batch_size: 10, max_batch_timeout: 1, max_retries: 100 }] },
    triggers: { crons: ['* * * * *'] },
    observability: { enabled: true, redact_query_string: true, logs: { enabled: true, invocation_logs: false, persist: true },
      traces: { enabled: true, head_sampling_rate: 0.1 } },
  };
  if (options['--isolation-config']) {
    let other;
    try { other = JSON.parse(await readFile(safePath(options['--isolation-config']), 'utf8')); } catch { fail('CLOUD_ISOLATION_CONFIG_INVALID'); }
    if (!['staging', 'production'].includes(other.vars?.APP_ENV) || typeof other.vars.PUBLIC_ORIGIN !== 'string'
      || !Array.isArray(other.d1_databases) || other.d1_databases.length !== 1 || other.d1_databases[0].binding !== 'DB'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(other.d1_databases[0].database_id ?? '')
      || !Array.isArray(other.r2_buckets) || other.r2_buckets.length !== 1 || other.r2_buckets[0].binding !== 'PRIVACY_LEDGER'
      || !environmentName(other.r2_buckets[0].bucket_name, other.vars.APP_ENV)
      || !Array.isArray(other.queues?.producers) || other.queues.producers.length !== 1 || other.queues.producers[0].binding !== 'JOBS'
      || !environmentName(other.queues.producers[0].queue, other.vars.APP_ENV)
      || !Array.isArray(other.queues?.consumers) || other.queues.consumers.length !== 2
      || !environmentName(other.queues.consumers[0].dead_letter_queue, other.vars.APP_ENV)
      || other.queues.consumers[1].queue !== other.queues.consumers[0].dead_letter_queue) fail('CLOUD_ISOLATION_CONFIG_INVALID');
    validOrigin(other.vars.PUBLIC_ORIGIN);
    if (!['staging', 'production'].includes(other.vars?.APP_ENV) || other.vars.APP_ENV === environment
      || other.vars.PUBLIC_ORIGIN === origin.origin || other.d1_databases?.some((item) => item.database_id === databaseId || item.database_name === options['--database-name'])
      || other.r2_buckets?.some((item) => item.bucket_name === options['--privacy-bucket'])
      || other.queues?.producers?.some((item) => [options['--queue'], options['--dead-letter-queue']].includes(item.queue))
      || other.queues?.consumers?.some((item) => [item.queue, item.dead_letter_queue].some((name) => [options['--queue'], options['--dead-letter-queue']].includes(name)))) fail('CLOUD_ENVIRONMENT_NOT_ISOLATED');
  }
  await atomicNewJson(filename, config);
  return { environment, output: filename, messaging: config.vars.MESSAGING_PROVIDER, requiredSecretNames: secretNames,
    secretUploadRequired: true, providerCredentialsVerified: false, deployed: false };
}

export async function configureCloudMain(argv = process.argv.slice(2)) {
  const result = await generateCloudConfiguration(parseArguments(argv));
  console.log(JSON.stringify({ ok: true, ...result }));
}
if (process.argv[1] && await realpath(path.resolve(process.argv[1])).catch(() => null) === await realpath(fileURLToPath(import.meta.url))) {
  configureCloudMain().catch((error) => { console.error(JSON.stringify({ ok: false, code: error instanceof CloudConfigurationError ? error.code : 'CLOUD_CONFIGURATION_FAILED' })); process.exitCode = 1; });
}
