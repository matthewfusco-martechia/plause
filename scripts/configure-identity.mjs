import { constants, openSync, closeSync, fstatSync, readFileSync, writeFileSync, fsyncSync, renameSync, unlinkSync, lstatSync, realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseEncryptionKeyring } from '../packages/security/src/keyring.mjs';
import { parseVariables } from './live-readiness.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const localOrigin = 'http://localhost:8787';
const localRedirect = `${localOrigin}/api/auth/google/callback`;
const messages = Object.freeze({
  IDENTITY_ARGUMENT_INVALID: 'Use --help for supported options. Credentials must be supplied through a protected client file, never arguments.',
  IDENTITY_FILE_UNSAFE: 'Inputs must be small regular files owned by you, without group/other permissions, symlinks or hard links. Use chmod 600.',
  IDENTITY_FILE_MISSING: 'An existing local configuration and downloaded web client file are required. Run npm run setup first.',
  IDENTITY_FILE_UNREADABLE: 'The selected local file could not be read safely. No credentials were printed.',
  IDENTITY_CONFIG_INVALID: 'The local configuration contains malformed or duplicate dotenv records. No changes were written.',
  IDENTITY_LOCAL_CONFIG_REQUIRED: 'Only local configuration with the fixed http://localhost:8787 origin is supported. Cloud configuration was not changed.',
  IDENTITY_SETUP_REQUIRED: 'The local setup keys are missing or invalid. Run npm run setup; preserve existing encryption material.',
  IDENTITY_WEB_CLIENT_REQUIRED: 'Supply a downloaded Google Web application OAuth JSON file, not an installed/native client or service account.',
  IDENTITY_CLIENT_INVALID: 'The downloaded web client must contain valid client credentials and fixed Google OAuth endpoints. No changes were written.',
  IDENTITY_REDIRECT_INVALID: 'Use a dedicated local web client with exactly http://localhost:8787/api/auth/google/callback; optional JavaScript origins may contain only http://localhost:8787.',
  IDENTITY_CONFIG_CHANGED: 'The selected configuration changed during setup. No update was applied; retry after other configuration work finishes.',
  IDENTITY_WRITE_FAILED: 'The private local configuration could not be updated safely. No credentials were printed.',
});
export class IdentityConfigurationError extends Error {
  constructor(code) { super(messages[code] ?? 'Identity configuration failed. No credentials were printed.'); this.code = code; }
}
const fail = (code) => { throw new IdentityConfigurationError(code); };
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const clientId = (value) => typeof value === 'string' && value.length <= 256 && /^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(value);
const clientSecret = (value) => typeof value === 'string' && value.length >= 8 && value.length <= 1024 && /^[\x21-\x7e]+$/.test(value);

function argumentsFor(args) {
  const options = { configFile: path.join(root, '.dev.vars'), mode: args.length ? null : 'help', clientFile: null, signup: false };
  const used = new Set(); let enable = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]; if (used.has(arg)) fail('IDENTITY_ARGUMENT_INVALID'); used.add(arg);
    if (['--config', '--client-file'].includes(arg)) {
      const value = args[++index];
      if (typeof value !== 'string' || !value || value.startsWith('--') || value.length > 4000 || /[\x00-\x1f\x7f]/.test(value)) fail('IDENTITY_ARGUMENT_INVALID');
      options[arg === '--config' ? 'configFile' : 'clientFile'] = path.resolve(value);
    } else if (arg === '--enable') enable = true;
    else if (arg === '--enable-signup') options.signup = true;
    else if (['--status', '--disable', '--help'].includes(arg)) {
      if (options.mode) fail('IDENTITY_ARGUMENT_INVALID'); options.mode = arg.slice(2);
    } else fail('IDENTITY_ARGUMENT_INVALID');
  }
  if (options.mode === 'help') { if (args.length > 1) fail('IDENTITY_ARGUMENT_INVALID'); return options; }
  if (options.mode) {
    if (options.clientFile || enable || options.signup) fail('IDENTITY_ARGUMENT_INVALID');
  } else {
    if (!enable || !options.clientFile) fail('IDENTITY_ARGUMENT_INVALID'); options.mode = 'enable';
  }
  return options;
}

function safeStat(info, maximum) {
  return info.isFile() && info.size <= maximum && info.nlink === 1 && (info.mode & 0o077) === 0
    && (typeof process.getuid !== 'function' || info.uid === process.getuid());
}
function readPrivate(filename, { optional = false, maximum = 65_536 } = {}) {
  let fd;
  try {
    fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = fstatSync(fd); if (!safeStat(info, maximum)) fail('IDENTITY_FILE_UNSAFE');
    const source = readFileSync(fd, 'utf8');
    // Check the read descriptor again in case the file grew or its links changed.
    const after = fstatSync(fd);
    if (!safeStat(after, maximum) || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) fail('IDENTITY_CONFIG_CHANGED');
    return { source, info: after };
  } catch (error) {
    if (error instanceof IdentityConfigurationError) throw error;
    if (error.code === 'ENOENT' && optional) return null;
    fail(error.code === 'ENOENT' ? 'IDENTITY_FILE_MISSING' : 'IDENTITY_FILE_UNREADABLE');
  } finally { if (fd !== undefined) closeSync(fd); }
}
function variables(source) {
  // Permit ordinary dotenv comments after a closed quoted value, while keeping
  // hashes inside strings literal and rejecting duplicate records in the parser.
  const normalized = source.split(/\r?\n/).map((line) => {
    let quote = null, escaped = false;
    for (let index = 0; index < line.length; index++) {
      const char = line[index];
      if (quote) {
        if (quote === '"' && escaped) escaped = false;
        else if (quote === '"' && char === '\\') escaped = true;
        else if (char === quote) quote = null;
      } else if (char === '"' || char === "'") quote = char;
      else if (char === '#' && (index === 0 || /\s/.test(line[index - 1]))) return line.slice(0, index);
    }
    return line;
  }).join('\n');
  try { return parseVariables(normalized); } catch { fail('IDENTITY_CONFIG_INVALID'); }
}

/** The official downloaded format distinguishes web from installed clients:
 * https://googleapis.github.io/google-api-python-client/docs/client-secrets.html
 * Endpoints below are validation pins only; this script makes no request.
 */
export function parseGoogleWebClient(source) {
  let parsed; try { parsed = JSON.parse(source); } catch { fail('IDENTITY_WEB_CLIENT_REQUIRED'); }
  if (!object(parsed) || Object.keys(parsed).length !== 1 || !object(parsed.web)) fail('IDENTITY_WEB_CLIENT_REQUIRED');
  const web = parsed.web;
  const allowed = new Set(['client_id', 'client_secret', 'project_id', 'auth_uri', 'token_uri', 'auth_provider_x509_cert_url', 'redirect_uris', 'javascript_origins']);
  if (Object.keys(web).some((key) => !allowed.has(key)) || !clientId(web.client_id) || !clientSecret(web.client_secret)
    || !['https://accounts.google.com/o/oauth2/auth', 'https://accounts.google.com/o/oauth2/v2/auth'].includes(web.auth_uri)
    || !['https://oauth2.googleapis.com/token', 'https://accounts.google.com/o/oauth2/token'].includes(web.token_uri)
    || web.auth_provider_x509_cert_url !== undefined && web.auth_provider_x509_cert_url !== 'https://www.googleapis.com/oauth2/v1/certs'
    || web.project_id !== undefined && (typeof web.project_id !== 'string' || !/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(web.project_id))) fail('IDENTITY_CLIENT_INVALID');
  if (!Array.isArray(web.redirect_uris) || web.redirect_uris.length !== 1 || web.redirect_uris[0] !== localRedirect
    || web.javascript_origins !== undefined && (!Array.isArray(web.javascript_origins) || web.javascript_origins.length > 1
      || web.javascript_origins.some((origin) => origin !== localOrigin))) fail('IDENTITY_REDIRECT_INVALID');
  return { clientId: web.client_id, clientSecret: web.client_secret };
}

/** Replace only the owned records, keeping every unrelated line/comment intact. */
function updateLocalVariables(source, changes) {
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const remaining = new Map(Object.entries(changes));
  let updated = source.replace(/[^\r\n]*(?:\r\n|\n|$)/g, (line) => {
    const match = /^\s*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=/.exec(line);
    if (!match || !remaining.has(match[1])) return line;
    const suffix = line.endsWith('\r\n') ? '\r\n' : line.endsWith('\n') ? '\n' : '';
    const value = remaining.get(match[1]); remaining.delete(match[1]);
    return `${match[1]}=${JSON.stringify(value)}${suffix}`;
  });
  if (remaining.size) {
    if (updated && !updated.endsWith('\n')) updated += eol;
    updated += `# Local Google sign-in configuration; no provider request is made by setup.${eol}`;
    updated += Array.from(remaining, ([name, value]) => `${name}=${JSON.stringify(value)}${eol}`).join('');
  }
  return updated;
}
function writePrivate(filename, original, source) {
  const temporary = path.join(path.dirname(filename), `.plause-identity-${randomUUID()}.tmp`); let fd;
  try {
    if (Buffer.byteLength(source, 'utf8') > 65_536) fail('IDENTITY_WRITE_FAILED');
    fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    writeFileSync(fd, source, 'utf8'); fsyncSync(fd); closeSync(fd); fd = undefined;
    const current = readPrivate(filename);
    if (current.info.dev !== original.info.dev || current.info.ino !== original.info.ino || current.source !== original.source
      || current.info.mtimeMs !== original.info.mtimeMs || current.info.ctimeMs !== original.info.ctimeMs) fail('IDENTITY_CONFIG_CHANGED');
    const entry = lstatSync(filename);
    if (!safeStat(entry, 65_536) || entry.dev !== current.info.dev || entry.ino !== current.info.ino) fail('IDENTITY_CONFIG_CHANGED');
    renameSync(temporary, filename);
  } catch (error) {
    if (error instanceof IdentityConfigurationError) throw error;
    fail('IDENTITY_WRITE_FAILED');
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch { /* Atomic publication normally removes it. */ }
  }
}
function status(snapshot, action = 'status') {
  const values = snapshot ? variables(snapshot.source) : {};
  return { action, configurationPresent: snapshot !== null, localOriginConfigured: values.PUBLIC_ORIGIN === localOrigin,
    enabled: values.AUTH_GOOGLE_ENABLED === 'true', signupEnabled: values.AUTH_SIGNUP_ENABLED === 'true',
    clientIdStored: Boolean(values.AUTH_GOOGLE_CLIENT_ID), clientSecretStored: Boolean(values.AUTH_GOOGLE_CLIENT_SECRET),
    configured: (values.APP_ENV === undefined || values.APP_ENV === 'local') && values.AUTH_GOOGLE_ENABLED === 'true' && values.PUBLIC_ORIGIN === localOrigin
      && clientId(values.AUTH_GOOGLE_CLIENT_ID) && clientSecret(values.AUTH_GOOGLE_CLIENT_SECRET),
    providerCredentialsVerified: false, providerRequests: 0, restartRequired: action !== 'status' };
}
const help = `Configure Plause's LOCAL Google sign-in without requests or login.
  npm run configure:identity -- --status
  npm run configure:identity -- --client-file PRIVATE_JSON --enable
  npm run configure:identity -- --client-file PRIVATE_JSON --enable --enable-signup
  npm run configure:identity -- --disable
  --config PATH selects an existing private local .dev.vars file for isolated setup.
Download a Google Web application OAuth client, protect it with chmod 600, and
register exactly http://localhost:8787/api/auth/google/callback. Installed/native
clients and extra redirect origins are rejected. Client secrets belong in the
protected file, never arguments or browser input. Run npm run setup first.
Signup defaults OFF on each enable unless --enable-signup is explicitly supplied.
Disabling retains the stored credentials. Encryption and unrelated settings are
preserved. This does not register an app, open a browser, authenticate, connect a
calendar, configure a cloud deployment, or verify Google access. Restart the local
service after an explicit change. No provider request is made by this command.`;

export function configureIdentity(args = process.argv.slice(2)) {
  const options = argumentsFor(args);
  if (options.mode === 'help') return { action: 'help' };
  const snapshot = readPrivate(options.configFile, { optional: options.mode === 'status' });
  if (options.mode === 'status') return status(snapshot);
  const values = variables(snapshot.source);
  if (values.APP_ENV !== undefined && values.APP_ENV !== 'local'
    || values.PUBLIC_ORIGIN !== undefined && values.PUBLIC_ORIGIN !== localOrigin) fail('IDENTITY_LOCAL_CONFIG_REQUIRED');
  try {
    parseEncryptionKeyring(values.CONTENT_ENCRYPTION_KEY);
    if (!values.MOCK_WEBHOOK_SECRET || !values.OPERATOR_TOKEN) throw new Error();
  } catch { fail('IDENTITY_SETUP_REQUIRED'); }
  const changes = options.mode === 'disable' ? { AUTH_GOOGLE_ENABLED: 'false', AUTH_SIGNUP_ENABLED: 'false' } : (() => {
    const client = parseGoogleWebClient(readPrivate(options.clientFile).source);
    return { PUBLIC_ORIGIN: localOrigin, AUTH_GOOGLE_ENABLED: 'true', AUTH_SIGNUP_ENABLED: options.signup ? 'true' : 'false',
      AUTH_GOOGLE_CLIENT_ID: client.clientId, AUTH_GOOGLE_CLIENT_SECRET: client.clientSecret };
  })();
  const updated = updateLocalVariables(snapshot.source, changes); writePrivate(options.configFile, snapshot, updated);
  return status({ ...snapshot, source: updated }, options.mode === 'disable' ? 'disabled' : 'enabled');
}
export function configureIdentityMain(args = process.argv.slice(2)) {
  const report = configureIdentity(args);
  if (report.action === 'help') console.log(help);
  else {
    console.log(JSON.stringify({ ok: true, ...report }));
    console.log(report.action === 'status' ? 'Local configuration only. Google access is unverified; no requests or changes were made.'
      : 'Private local configuration updated. Restart npm run dev. No Google request, login or registration was performed.');
  }
}
if (process.argv[1] && (() => { try { return realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })()) {
  try { configureIdentityMain(); }
  catch (error) {
    const safe = error instanceof IdentityConfigurationError ? error : new IdentityConfigurationError('IDENTITY_WRITE_FAILED');
    console.error(JSON.stringify({ ok: false, code: safe.code, message: safe.message })); process.exitCode = 1;
  }
}
