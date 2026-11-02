import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEncryptionKeyring } from '../packages/security/src/keyring.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const opaque = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const secretFields = new Set(['CONTENT_ENCRYPTION_KEY', 'OPENAI_API_KEY', 'AUTH_GOOGLE_CLIENT_ID', 'AUTH_GOOGLE_CLIENT_SECRET',
  'OPERATOR_BOOTSTRAP_SUBJECTS', 'AUTH_SIGNUP_SUBJECTS', 'STAGING_ACCESS_PASSWORD_SHA256', 'TAVILY_API_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'SUNSHINE_KEY_ID',
  'SUNSHINE_KEY_SECRET', 'SUNSHINE_WEBHOOK_SECRET', 'MOCK_WEBHOOK_SECRET', 'OPERATOR_TOKEN']);
export class ReadinessError extends Error { constructor(code) { super(code); this.code = code; } }
const fail = (code) => { throw new ReadinessError(code); };
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const credential = (value, minimum = 1) => typeof value === 'string' && value.length >= minimum && value.length <= 1000 && !/[\s\x00-\x1f\x7f]/.test(value);

async function readInput(filename, { privateFile = false, optional = false } = {}) {
  let file;
  try {
    file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 131_072 || stat.nlink !== 1
      || typeof process.getuid === 'function' && stat.uid !== process.getuid()
      || privateFile && (stat.mode & 0o077) !== 0) fail('READINESS_FILE_UNSAFE');
    return await file.readFile('utf8');
  } catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    if (error instanceof ReadinessError) throw error;
    fail(error.code === 'ENOENT' ? 'READINESS_FILE_MISSING' : 'READINESS_FILE_UNREADABLE');
  } finally { await file?.close(); }
}

/** JSONC comments/trailing commas are recognized only outside quoted strings. */
export function parseConfiguration(source) {
  let clean = '', quoted = false, escaped = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index], next = source[index + 1];
    if (quoted) {
      clean += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') { quoted = true; clean += char; }
    else if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index++;
      clean += '\n';
    } else if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      if (end < 0) fail('READINESS_CONFIG_INVALID');
      clean += ' '; index = end + 1;
    } else clean += char;
  }
  let normalized = ''; quoted = false; escaped = false;
  for (let index = 0; index < clean.length; index++) {
    const char = clean[index];
    if (!quoted && char === ',') {
      let following = index + 1; while (/\s/.test(clean[following] ?? '') && following < clean.length) following++;
      if (clean[following] === '}' || clean[following] === ']') continue;
    }
    normalized += char;
    if (quoted && escaped) escaped = false;
    else if (quoted && char === '\\') escaped = true;
    else if (char === '"') quoted = !quoted;
  }
  try { const result = JSON.parse(normalized); if (!object(result)) throw new Error(); return result; }
  catch { fail('READINESS_CONFIG_INVALID'); }
}

export function parseVariables(source) {
  const values = Object.create(null);
  for (const line of source.split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || Object.hasOwn(values, match[1])) fail('READINESS_VARIABLES_INVALID');
    let value = match[2];
    if (value.startsWith('"')) {
      try { value = JSON.parse(value); if (typeof value !== 'string') throw new Error(); } catch { fail('READINESS_VARIABLES_INVALID'); }
    } else if (value.startsWith("'")) {
      if (!value.endsWith("'") || value.slice(1, -1).includes("'")) fail('READINESS_VARIABLES_INVALID');
      value = value.slice(1, -1);
    } else value = value.replace(/\s+#.*$/, '').trim();
    if (/[\x00-\x1f\x7f]/.test(value)) fail('READINESS_VARIABLES_INVALID');
    values[match[1]] = value;
  }
  return values;
}

function httpsOrigin(value) {
  try {
    const url = new URL(value), host = url.hostname;
    return url.origin === value && url.protocol === 'https:' && !url.username && !url.password && !url.port
      && host.includes('.') && !host.endsWith('.') && !/[:\[\]]/.test(host) && !/^[0-9.]+$/.test(host)
      && !/(?:^|\.)(?:localhost|local|internal|test|invalid|example|onion|home|lan|corp|localtest\.me|lvh\.me)$/.test(host);
  } catch { return false; }
}
function loopbackOrigin(value) {
  try { const url = new URL(value); return url.origin === value && ['http:', 'https:'].includes(url.protocol)
    && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && !url.username && !url.password; } catch { return false; }
}
function validKey(value) { try { parseEncryptionKeyring(value); return true; } catch { return false; } }
function boundedSetting(value, fallback, maximum) {
  if (value === undefined) return fallback;
  return typeof value === 'string' && /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) <= maximum ? Number(value) : null;
}
function bootstrap(value) {
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) && parsed.length > 0 && parsed.length <= 5
    && new Set(parsed).size === parsed.length && parsed.every((entry) => typeof entry === 'string' && /^[A-Za-z0-9_-]{1,255}$/.test(entry)); } catch { return false; }
}
function admissionSubjects(value) {
  return typeof value === 'string' && value.length <= 4096 && bootstrap(value);
}
function support(values) {
  const missing = [];
  if (values.SUPPORT_COVERAGE_ENABLED !== 'true') missing.push('SUPPORT_COVERAGE_ENABLED');
  if (typeof values.SUPPORT_HOURS !== 'string' || !values.SUPPORT_HOURS.trim() || values.SUPPORT_HOURS.length > 300 || /[\x00-\x1f\x7f]/.test(values.SUPPORT_HOURS)) missing.push('SUPPORT_HOURS');
  try { if (typeof values.SUPPORT_TIME_ZONE !== 'string') throw new Error(); new Intl.DateTimeFormat('en', { timeZone: values.SUPPORT_TIME_ZONE }); } catch { missing.push('SUPPORT_TIME_ZONE'); }
  try { const contact = new URL(values.SUPPORT_CONTACT); if (!httpsOrigin(contact.origin) || contact.username || contact.password || contact.search || contact.hash || contact.href.length > 300) throw new Error(); } catch { missing.push('SUPPORT_CONTACT'); }
  return missing;
}
function resourceNames(config) {
  return [...(config.d1_databases ?? []).map((item) => item.database_name), ...(config.r2_buckets ?? []).map((item) => item.bucket_name),
    ...(config.queues?.producers ?? []).map((item) => item.queue), ...(config.queues?.consumers ?? []).flatMap((item) => [item.queue, item.dead_letter_queue]).filter(Boolean)];
}
function reviewedEnvironmentShape(config) {
  if (!object(config) || !object(config.vars) || !['staging', 'production'].includes(config.vars.APP_ENV) || !httpsOrigin(config.vars.PUBLIC_ORIGIN)) return false;
  const prefix = new RegExp(`^plause-${config.vars.APP_ENV}(?:-[a-z0-9]+)*$`);
  const validName = (value) => typeof value === 'string' && prefix.test(value);
  const db = Array.isArray(config.d1_databases) && config.d1_databases.length === 1 ? config.d1_databases[0] : null;
  const bucket = Array.isArray(config.r2_buckets) && config.r2_buckets.length === 1 ? config.r2_buckets[0] : null;
  const producer = Array.isArray(config.queues?.producers) && config.queues.producers.length === 1 ? config.queues.producers[0] : null;
  const consumers = Array.isArray(config.queues?.consumers) ? config.queues.consumers : [];
  const primary = consumers.find((item) => item.queue === producer?.queue), dead = primary?.dead_letter_queue;
  return db?.binding === 'DB' && uuid.test(db.database_id ?? '') && validName(db.database_name)
    && bucket?.binding === 'PRIVACY_LEDGER' && validName(bucket.bucket_name) && producer?.binding === 'JOBS'
    && validName(producer.queue) && validName(dead) && dead !== producer.queue && consumers.length === 2 && consumers.some((item) => item.queue === dead);
}

/** Only finite labels/known field names leave this function, never input values. */
export function assessReadiness(config, values, { target = 'messages', inputIssues = [], otherConfig = null } = {}) {
  const environment = ['local', 'staging', 'production'].includes(values.APP_ENV) ? values.APP_ENV : 'unknown';
  const cloud = ['staging', 'production'].includes(environment), checks = [];
  const add = (id, title, missingFields, action, applicable = true) => {
    checks.push({ id, title, status: !applicable ? 'not_applicable' : missingFields.length ? 'blocked' : 'configured',
      missingFields: applicable ? missingFields : [], action });
  };
  add('inputs', 'Readable selected inputs', inputIssues, 'Use regular owner-only secret/vars files; check the selected configuration. No input contents are printed.');
  add('environment', 'Cloud environment and HTTPS origin', [...(!cloud ? ['APP_ENV'] : []), ...(!httpsOrigin(values.PUBLIC_ORIGIN) ? ['PUBLIC_ORIGIN'] : [])],
    'Prepare a staging configuration with npm run configure:cloud after obtaining real resource IDs; proposed origins are documented in docs/live-acceptance.md.');
  const stagingGateMissing = [];
  const stagingGateMalformed = values.STAGING_ACCESS_ENABLED !== undefined && !['true', 'false'].includes(values.STAGING_ACCESS_ENABLED);
  if (stagingGateMalformed) stagingGateMissing.push('STAGING_ACCESS_ENABLED');
  if (environment !== 'staging') stagingGateMissing.push('APP_ENV');
  if (typeof values.STAGING_ACCESS_PASSWORD_SHA256 !== 'string' || !/^[0-9a-f]{64}$/i.test(values.STAGING_ACCESS_PASSWORD_SHA256)) stagingGateMissing.push('STAGING_ACCESS_PASSWORD_SHA256');
  add('staging_access', 'Staging password gate', stagingGateMissing,
    'Enable this gate only for staging with STAGING_ACCESS_ENABLED=true and a protected STAGING_ACCESS_PASSWORD_SHA256 secret. The shared username is plause; never put the password or its hash in public variables or command arguments.', values.STAGING_ACCESS_ENABLED === 'true' || stagingGateMalformed);
  add('encryption', 'Matching encryption keyring', validKey(values.CONTENT_ENCRYPTION_KEY) ? [] : ['CONTENT_ENCRYPTION_KEY'],
    'Supply the protected matching keyring. Preserve existing database and backup keys; do not regenerate them to clear this check.');
  const modelMissing = [];
  if (values.MODEL_PROVIDER !== 'openai') modelMissing.push('MODEL_PROVIDER');
  if (values.LIVE_MODEL_ENABLED !== 'true') modelMissing.push('LIVE_MODEL_ENABLED');
  if (!credential(values.OPENAI_API_KEY, 16)) modelMissing.push('OPENAI_API_KEY');
  if ((values.OPENAI_MODEL ?? 'gpt-6-luna') !== 'gpt-6-luna') modelMissing.push('OPENAI_MODEL');
  const policy = [['MODEL_MAX_INPUT_TOKENS', 4096, 20000], ['MODEL_MAX_OUTPUT_TOKENS', 600, 2000], ['MODEL_TIMEOUT_MS', 20000, 45000],
    ['MODEL_USER_MONTHLY_BUDGET_MICRO_USD', 5000000, 100000000], ['MODEL_GLOBAL_MONTHLY_BUDGET_MICRO_USD', 50000000, 1000000000]];
  for (const [key, fallback, maximum] of policy) if (boundedSetting(values[key], fallback, maximum) === null) modelMissing.push(key);
  if (Number(values.MODEL_USER_MONTHLY_BUDGET_MICRO_USD ?? 5000000) > Number(values.MODEL_GLOBAL_MONTHLY_BUDGET_MICRO_USD ?? 50000000)) modelMissing.push('MODEL_USER_MONTHLY_BUDGET_MICRO_USD');
  add('model', 'Bounded hosted model', [...new Set(modelMissing)], 'For local evaluation, store a missing API key with npm run configure:model -- --store-only, then explicitly run npm run eval:model -- --live. The primary preview may remain mock; no primary enablement or restart is needed. Evaluation can incur charges; this check makes no request.');
  add('identity', 'Google account sign-in', [...(values.AUTH_GOOGLE_ENABLED !== 'true' ? ['AUTH_GOOGLE_ENABLED'] : []),
    ...(!/^[A-Za-z0-9._-]{1,256}$/.test(values.AUTH_GOOGLE_CLIENT_ID ?? '') ? ['AUTH_GOOGLE_CLIENT_ID'] : []),
    ...(!credential(values.AUTH_GOOGLE_CLIENT_SECRET, 8) ? ['AUTH_GOOGLE_CLIENT_SECRET'] : [])],
    'Create a separate Google identity OAuth client per environment; register its exact PUBLIC_ORIGIN/api/auth/google/callback URI. Calendar OAuth is separate.');
  add('enrollment', 'Controlled cloud signup', values.AUTH_SIGNUP_ENABLED === 'true' && !admissionSubjects(values.AUTH_SIGNUP_SUBJECTS) ? ['AUTH_SIGNUP_SUBJECTS'] : [],
    'Keep AUTH_SIGNUP_ENABLED=false for returning sign-in only. New cloud accounts require explicit signup enablement and a protected AUTH_SIGNUP_SUBJECTS JSON list of 1–5 unique verified Google subject IDs. Operator bootstrap grants roles separately.', cloud);
  add('cloudflare_account', 'Cloudflare account', typeof config.account_id === 'string' && /^[0-9a-f]{32}$/i.test(config.account_id) && !/^0{32}$/.test(config.account_id) ? [] : ['account_id'],
    'Obtain the selected Cloudflare account ID. This shape check cannot verify account access or provision resources.');
  let routing = false;
  if (cloud && httpsOrigin(values.PUBLIC_ORIGIN)) {
    const host = new URL(values.PUBLIC_ORIGIN).hostname;
    routing = config.name === `plause-${environment}` && config.preview_urls === false && (host.endsWith('.workers.dev')
      ? config.workers_dev === true && new RegExp(`^plause-${environment}\\.[a-z0-9-]+\\.workers\\.dev$`).test(host)
      : config.workers_dev === false && Array.isArray(config.routes) && config.routes.length === 1 && config.routes[0].pattern === host && config.routes[0].custom_domain === true);
  }
  add('routing', 'Worker name and reviewed origin route', routing ? [] : ['name', 'routes_or_workers_dev', 'preview_urls'],
    'Generate and review the exact environment Worker/domain route with preview URLs disabled. Configuration does not establish domain ownership or change DNS.');
  const db = Array.isArray(config.d1_databases) && config.d1_databases.length === 1 ? config.d1_databases[0] : null;
  add('database', 'Dedicated D1 database', db?.binding === 'DB' && uuid.test(db.database_id ?? '') && typeof db.database_name === 'string'
    && cloud && new RegExp(`^plause-${environment}(?:-[a-z0-9]+)*$`).test(db.database_name) ? [] : ['d1_databases.DB'],
    'Allocate the environment-specific D1 database, record its real ID/name, and review/apply migrations only as a separately authorized operation.');
  const producer = Array.isArray(config.queues?.producers) && config.queues.producers.length === 1 ? config.queues.producers[0] : null;
  const consumers = Array.isArray(config.queues?.consumers) ? config.queues.consumers : [];
  const primary = consumers.find((item) => item.queue === producer?.queue), dead = primary?.dead_letter_queue;
  const name = (value) => typeof value === 'string' && cloud && new RegExp(`^plause-${environment}(?:-[a-z0-9]+)*$`).test(value);
  add('queues', 'Work queue and consumed dead-letter queue', producer?.binding === 'JOBS' && name(producer.queue) && name(dead)
    && dead !== producer.queue && consumers.length === 2 && consumers.some((item) => item.queue === dead) ? [] : ['queues.JOBS', 'queues.dead_letter_queue'],
    'Allocate separate work/DLQ queues in the same jurisdiction, configure both consumers, and verify deployed recovery later.');
  const bucket = Array.isArray(config.r2_buckets) && config.r2_buckets.length === 1 ? config.r2_buckets[0] : null;
  add('privacy_ledger', 'Independent private erasure ledger', bucket?.binding === 'PRIVACY_LEDGER' && name(bucket.bucket_name) ? [] : ['r2_buckets.PRIVACY_LEDGER'],
    'Allocate a private R2 erasure-ledger bucket independent of D1 backups; verify write/read outage and restore replay before serving users.');
  const isolate = !otherConfig ? ['reviewed_staging_or_production_config'] : !reviewedEnvironmentShape(otherConfig)
    || otherConfig.vars.APP_ENV === environment
    || otherConfig.vars.PUBLIC_ORIGIN === values.PUBLIC_ORIGIN
    || (otherConfig.d1_databases ?? []).some((item) => item.database_id === db?.database_id)
    || resourceNames(otherConfig).some((item) => resourceNames(config).includes(item)) ? ['separate_environment_resources'] : [];
  add('environment_isolation', 'Staging/production isolation', isolate,
    'Supply --isolation-config for the other reviewed environment; use distinct origins, D1, queue/DLQ, bucket, provider projects and encryption keys. Static checks cannot verify copied remote credentials.', environment === 'production' || otherConfig !== null);
  const messages = target === 'messages';
  const messagingMissing = [];
  if (values.MESSAGING_PROVIDER !== 'sunshine') messagingMissing.push('MESSAGING_PROVIDER');
  if (values.LIVE_MESSAGING_ENABLED !== 'true') messagingMissing.push('LIVE_MESSAGING_ENABLED');
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(values.SUNSHINE_SUBDOMAIN ?? '')) messagingMissing.push('SUNSHINE_SUBDOMAIN');
  for (const key of ['SUNSHINE_APP_ID', 'SUNSHINE_APPLE_INTEGRATION_ID', 'SUNSHINE_WEBHOOK_ID', 'SUNSHINE_KEY_ID', 'SUNSHINE_BOT_SWITCHBOARD_ID', 'SUNSHINE_AGENT_SWITCHBOARD_ID']) if (!opaque.test(values[key] ?? '')) messagingMissing.push(key);
  for (const key of ['SUNSHINE_KEY_SECRET', 'SUNSHINE_WEBHOOK_SECRET']) if (!credential(values[key], 16)) messagingMissing.push(key);
  add('messaging', 'Apple MSP transport and webhook', messagingMissing,
    'Confirm Zendesk/Sunshine subscription eligibility and costs before purchase; obtain the app/integration/webhook/controllers and protected API/webhook credentials. See docs/live-acceptance.md.', messages);
  add('apple_brand', 'Declared Apple business brand', [...(!uuid.test(values.APPLE_BUSINESS_ID ?? '') ? ['APPLE_BUSINESS_ID'] : []),
    ...(values.APPLE_CHANNEL_APPROVED !== 'true' ? ['APPLE_CHANNEL_APPROVED'] : [])],
    'Obtain actual Apple/MSP use-case approval and the Apple brand UUID before setting the approval flag. A flag is a declaration, never proof of approval.', messages);
  const onboardingMissing = [];
  if (values.ONBOARDING_MESSAGES_ENABLED !== 'true') onboardingMissing.push('ONBOARDING_MESSAGES_ENABLED');
  if (boundedSetting(values.ONBOARDING_GLOBAL_DAILY_LIMIT, 500, 5000) === null) onboardingMissing.push('ONBOARDING_GLOBAL_DAILY_LIMIT');
  add('onboarding', 'Messages first-contact and linking notices', onboardingMissing,
    'Explicitly opt in with configure:cloud --enable-messages-onboarding after Apple/MSP approval and truthful sign-in/support setup. The default daily cap is 500; verify welcome, proof and linked notices on a real device.', messages);
  add('staff_access', 'Explicit initial staff identity', bootstrap(values.OPERATOR_BOOTSTRAP_SUBJECTS) ? [] : ['OPERATOR_BOOTSTRAP_SUBJECTS'],
    'Choose verified Google subject IDs, never email addresses. Bootstrap does not revive revoked grants; verify staff/ordinary-user separation later.', messages);
  add('support', 'Declared truthful support coverage', support(values),
    'Supply real hours, IANA zone, contact URL and a staffed provider handoff. Configuration does not verify a person is currently available.', messages);
  if (!messages) add('web_delivery', 'Authenticated web fallback', ['web', 'sunshine'].includes(values.MESSAGING_PROVIDER) ? [] : ['MESSAGING_PROVIDER'],
    'Select web for the pre-Apple fallback; verify sign-in, publication and client display receipts in the deployed environment.');
  const localMockConfigured = environment === 'local' && values.MODEL_PROVIDER === 'mock' && values.MESSAGING_PROVIDER === 'mock'
    && validKey(values.CONTENT_ENCRYPTION_KEY) && credential(values.MOCK_WEBHOOK_SECRET, 16) && credential(values.OPERATOR_TOKEN, 16)
    && (!values.PUBLIC_ORIGIN || loopbackOrigin(values.PUBLIC_ORIGIN)) && inputIssues.length === 0;
  const configurationReady = checks.every((check) => check.status !== 'blocked');
  return { version: 1, scope: 'selected_local_files', target, environment, localMockConfigured, configurationReady,
    liveReady: false, liveAcceptance: 'unverified', providerCredentialsVerified: false, networkRequests: 0, filesChanged: 0,
    checks, externalAcceptance: ['Provider credential access, billing and useful model behavior', 'Google sign-in/callback and account recovery',
      'Allocated/deployed Cloudflare resources, scheduler, alerts and independent erasure/restore',
      ...(messages ? ['Apple/MSP eligibility and approval, live staffing and authentic provider captures',
        'Real-device first greeting, linking, exact approvals, receipts, closure and human takeover'] : ['Deployed authenticated web chat and displayed delivery receipts']),
      'Proactive Messages eligibility remains separately unverified; keep disabled until approved'],
    nextAction: checks.find((check) => check.status === 'blocked')?.action ?? 'Static configuration is complete. Perform separately authorized bounded live acceptance; this command has not verified or enabled it.' };
}

export async function inspectReadiness({ configFile = path.join(root, 'wrangler.jsonc'), varsFile, secretsFile, isolationFile, target = 'messages' } = {}) {
  if (!['messages', 'web'].includes(target)) fail('READINESS_ARGUMENT_INVALID');
  let config = {}, otherConfig = null; const inputIssues = [];
  try { config = parseConfiguration(await readInput(configFile)); } catch (error) { inputIssues.push(error instanceof ReadinessError ? error.code : 'READINESS_CONFIG_INVALID'); }
  const values = Object.assign(Object.create(null), object(config.vars) ? config.vars : {});
  if (Object.keys(values).some((key) => secretFields.has(key))) {
    inputIssues.push('READINESS_SECRET_IN_PUBLIC_CONFIG');
    for (const key of secretFields) delete values[key];
  }
  const selectedVars = varsFile ?? (configFile === path.join(root, 'wrangler.jsonc') && !secretsFile ? path.join(root, '.dev.vars') : null);
  if (selectedVars) {
    try { const source = await readInput(selectedVars, { privateFile: true, optional: varsFile === undefined }); if (source !== null) Object.assign(values, parseVariables(source)); }
    catch (error) { inputIssues.push(error instanceof ReadinessError ? error.code : 'READINESS_VARIABLES_INVALID'); }
  }
  if (secretsFile) {
    try {
      const secrets = JSON.parse(await readInput(secretsFile, { privateFile: true }));
      if (!object(secrets) || Object.entries(secrets).some(([key, value]) => !secretFields.has(key) || typeof value !== 'string')) fail('READINESS_SECRETS_INVALID');
      Object.assign(values, secrets);
    } catch (error) { inputIssues.push(error instanceof ReadinessError ? error.code : 'READINESS_SECRETS_INVALID'); }
  }
  if (isolationFile) {
    try { otherConfig = parseConfiguration(await readInput(isolationFile)); }
    catch (error) { inputIssues.push(error instanceof ReadinessError ? error.code : 'READINESS_CONFIG_INVALID'); }
    if (object(otherConfig?.vars) && Object.keys(otherConfig.vars).some((key) => secretFields.has(key))) inputIssues.push('READINESS_SECRET_IN_PUBLIC_CONFIG');
  }
  try { return assessReadiness(config, values, { target, inputIssues, otherConfig }); }
  catch { fail('READINESS_CONFIG_INVALID'); }
}

const help = `Inspect Plause's selected local files without requests, writes or deployment.
  npm run readiness
  npm run readiness -- --json
  npm run readiness -- --target web --config PATH --secrets-file PRIVATE_JSON
  npm run readiness -- --config PATH --secrets-file PRIVATE_JSON --isolation-config PATH
Options: --vars-file PRIVATE_DOTENV, --target messages|web, --help.
Default target is Messages. Default inputs are wrangler.jsonc and protected .dev.vars.
Custom configs never silently inherit this checkout's .dev.vars. Credentials belong in
protected files, never arguments. Exit 2 means missing/unsafe configuration; exit 0
means static configuration only. Live acceptance always remains unverified.
No health probe, provider request, provisioning, secret upload or deploy is performed.`;
export async function readinessMain(args = process.argv.slice(2)) {
  const options = {}, seen = new Set(); let json = false;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (seen.has(argument)) fail('READINESS_ARGUMENT_INVALID'); seen.add(argument);
    if (argument === '--help') { console.log(help); return 0; }
    if (argument === '--json') { json = true; continue; }
    const names = { '--config': 'configFile', '--vars-file': 'varsFile', '--secrets-file': 'secretsFile', '--isolation-config': 'isolationFile', '--target': 'target' };
    const key = names[argument], value = args[++index];
    if (!key || !value || value.startsWith('--') || /[\x00-\x1f\x7f]/.test(value)) fail('READINESS_ARGUMENT_INVALID');
    options[key] = key === 'target' ? value : path.resolve(value);
  }
  const report = await inspectReadiness(options);
  if (json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log('Plause readiness · offline configuration only');
    console.log(`Local mock configuration: ${report.localMockConfigured ? 'configured (service not probed)' : 'not established by selected inputs'}.`);
    console.log(`Live ${report.target} configuration: ${report.configurationReady ? 'static fields configured' : 'blocked'}. Live acceptance: UNVERIFIED.`);
    for (const check of report.checks) if (check.status !== 'not_applicable') console.log(`${check.status.toUpperCase()} ${check.title}${check.missingFields.length ? ` — needs ${check.missingFields.join(', ')}` : ''}\n  ${check.action}`);
    console.log(`Next: ${report.nextAction}\nDetails: docs/live-acceptance.md. No credentials were printed or requests made.`);
  }
  return report.configurationReady ? 0 : 2;
}
if (process.argv[1] && await realpath(path.resolve(process.argv[1])).catch(() => null) === await realpath(fileURLToPath(import.meta.url))) {
  readinessMain().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(JSON.stringify({ ok: false, code: error instanceof ReadinessError ? error.code : 'READINESS_FAILED' })); process.exitCode = 2;
  });
}
