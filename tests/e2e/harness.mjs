import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixtureSql, makeFixtures } from './fixtures.mjs';

export const repo = fileURLToPath(new URL('../../', import.meta.url));
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export class E2EError extends Error {
  constructor(code, detail = '') { super(detail ? `${code}: ${detail}` : code); this.code = code; }
}
export function redact(value, secrets) {
  let text = String(value);
  for (const secret of [...secrets].filter((item) => typeof item === 'string' && item.length > 0).sort((a, b) => b.length - a.length)) text = text.split(secret).join('[redacted]');
  return text;
}
export async function readBoundedText(response, limit = 2_000_000) {
  if (!response.body) return '';
  const reader = response.body.getReader(), chunks = []; let size = 0;
  while (true) {
    const { value, done } = await reader.read(); if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); throw new E2EError('E2E_RESPONSE_TOO_LARGE'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}
export async function eventually(operation, { timeout = 15_000, interval = 100, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  do {
    const result = await operation();
    if (result) return result;
    await delay(interval);
  } while (Date.now() < deadline);
  throw new E2EError('E2E_DEADLINE', label);
}

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

export class IsolatedHarness {
  constructor() {
    this.fixtures = makeFixtures();
    this.secrets = new Set([this.fixtures.contentKey, this.fixtures.webhookSecret, this.fixtures.operatorToken,
      ...Object.values(this.fixtures.accounts).map((account) => account.inviteToken)]);
    this.steps = []; this.children = new Set(); this.logs = ''; this.child = null; this.tick = null; this.ticking = false;
  }

  async initialize() {
    this.tempRoot = await realpath(os.tmpdir());
    this.directory = await mkdtemp(path.join(this.tempRoot, 'plause-e2e-'));
    this.snapshot = path.join(this.directory, 'source');
    await mkdir(this.snapshot, { mode: 0o700 });
    for (const relative of ['apps/api/src', 'apps/api/public', 'migrations']) {
      await cp(path.join(repo, relative), path.join(this.snapshot, relative), { recursive: true });
    }
    for (const entry of await readdir(path.join(repo, 'packages'), { withFileTypes: true })) {
      if (entry.isDirectory()) await cp(path.join(repo, 'packages', entry.name, 'src'), path.join(this.snapshot, 'packages', entry.name, 'src'), { recursive: true });
    }
    for (const relative of ['package.json', 'tsconfig.json', 'scripts/backup.mjs', 'scripts/restore-verify.mjs']) {
      await mkdir(path.dirname(path.join(this.snapshot, relative)), { recursive: true });
      await cp(path.join(repo, relative), path.join(this.snapshot, relative));
    }
    await symlink(path.join(repo, 'node_modules'), path.join(this.snapshot, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    const hash = createHash('sha256');
    const hashDirectory = async (directory) => {
      for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) await hashDirectory(file);
        else if (entry.isFile()) { hash.update(path.relative(this.snapshot, file)); hash.update(await readFile(file)); }
      }
    };
    await hashDirectory(this.snapshot); this.sourceHash = hash.digest('hex');
    // A random data marker distinguishes this owned instance from any process
    // that could take the ephemeral port between reservation and startup.
    await writeFile(path.join(this.snapshot, 'apps/api/public/e2e-instance.json'), JSON.stringify({ runId: this.fixtures.runId }), { mode: 0o600, flag: 'wx' });
    this.persistence = path.join(this.directory, 'state');
    this.config = path.join(this.directory, 'wrangler.json');
    this.port = await availablePort();
    this.base = `http://127.0.0.1:${this.port}`;
    const vars = { APP_ENV: 'local', PUBLIC_ORIGIN: this.base, MODEL_PROVIDER: 'mock', MESSAGING_PROVIDER: 'mock', LIVE_MODEL_ENABLED: 'false',
      OPENAI_API_KEY: '', SEARCH_PROVIDER: 'disabled', LIVE_SEARCH_ENABLED: 'false', TAVILY_API_KEY: '',
      LIVE_GOOGLE_CALENDAR_ENABLED: 'false', GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', GOOGLE_REDIRECT_URI: '',
      AUTH_GOOGLE_ENABLED: 'false', AUTH_SIGNUP_ENABLED: 'false', AUTH_GOOGLE_CLIENT_ID: '', AUTH_GOOGLE_CLIENT_SECRET: '',
      LIVE_MESSAGING_ENABLED: 'false', APPLE_CHANNEL_APPROVED: 'false', APPLE_PROACTIVE_ENABLED: 'false',
      OPERATOR_BOOTSTRAP_SUBJECTS: '[]', SUPPORT_COVERAGE_ENABLED: 'false',
      CONTENT_ENCRYPTION_KEY: this.fixtures.contentKey, MOCK_WEBHOOK_SECRET: this.fixtures.webhookSecret, OPERATOR_TOKEN: this.fixtures.operatorToken };
    this.workerVars = vars;
    const config = { name: `plause-e2e-${this.fixtures.runId}`, main: 'source/apps/api/src/index.ts', tsconfig: 'source/tsconfig.json',
      compatibility_date: '2026-10-30', compatibility_flags: ['nodejs_compat'], workers_dev: false,
      vars, assets: { directory: 'source/apps/api/public', binding: 'ASSETS', run_worker_first: true },
      d1_databases: [{ binding: 'DB', database_name: 'plause-e2e', database_id: '00000000-0000-0000-0000-000000000000', migrations_dir: 'source/migrations' }],
      queues: { producers: [{ binding: 'JOBS', queue: `plause-e2e-${this.fixtures.runId}` }],
        consumers: [{ queue: `plause-e2e-${this.fixtures.runId}`, max_batch_size: 10, max_batch_timeout: 1, max_retries: 3 }] },
      triggers: { crons: ['* * * * *'] }, observability: { enabled: false } };
    await writeFile(this.config, JSON.stringify(config), { mode: 0o600, flag: 'wx' });
    this.seed = path.join(this.directory, 'fixtures.sql');
    await writeFile(this.seed, fixtureSql(this.fixtures), { mode: 0o600, flag: 'wx' });
    await mkdir(path.join(this.directory, 'config'), { mode: 0o700 });
    // Do not inherit Cloudflare/provider credentials or source-tree .dev.vars.
    this.environment = Object.fromEntries(['PATH', 'HOME', 'USER', 'TMPDIR', 'SystemRoot'].filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
    Object.assign(this.environment, { WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: path.join(this.directory, 'wrangler.log'),
      XDG_CONFIG_HOME: path.join(this.directory, 'config'), CLOUDFLARE_INCLUDE_PROCESS_ENV: 'false', CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false', CI: 'true' });
    this.assertOfflineConfiguration();
  }

  assertOfflineConfiguration() {
    assert.equal(this.workerVars.APP_ENV, 'local'); assert.equal(this.workerVars.MODEL_PROVIDER, 'mock');
    assert.equal(this.workerVars.MESSAGING_PROVIDER, 'mock'); assert.equal(this.workerVars.LIVE_MODEL_ENABLED, 'false');
    assert.equal(this.workerVars.LIVE_SEARCH_ENABLED, 'false'); assert.equal(this.workerVars.SEARCH_PROVIDER, 'disabled');
    assert.equal(this.workerVars.LIVE_GOOGLE_CALENDAR_ENABLED, 'false');
    for (const flag of ['AUTH_GOOGLE_ENABLED', 'AUTH_SIGNUP_ENABLED', 'LIVE_MESSAGING_ENABLED', 'APPLE_CHANNEL_APPROVED', 'APPLE_PROACTIVE_ENABLED']) assert.equal(this.workerVars[flag], 'false');
    for (const key of ['OPENAI_API_KEY', 'TAVILY_API_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'AUTH_GOOGLE_CLIENT_ID', 'AUTH_GOOGLE_CLIENT_SECRET']) assert.equal(this.workerVars[key], '');
  }

  appendLog(chunk) { this.logs = (this.logs + redact(chunk, this.secrets)).slice(-12_000); }
  launch(args) {
    if (this.interrupted) throw new E2EError('E2E_INTERRUPTED');
    const child = spawn(process.execPath, [path.join(repo, 'node_modules/wrangler/bin/wrangler.js'), ...args, '--config', this.config],
      { cwd: this.directory, env: this.environment, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    this.children.add(child);
    child.stdout.on('data', (chunk) => this.appendLog(chunk)); child.stderr.on('data', (chunk) => this.appendLog(chunk));
    child.once('close', () => this.children.delete(child));
    return child;
  }
  async command(args, timeout = 45_000) {
    const child = this.launch(args);
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString(); if (output.length > 2_000_000) this.signal(child, 'SIGKILL'); });
    const result = new Promise((resolve, reject) => {
      child.once('error', () => reject(new E2EError('E2E_PROCESS_START')));
      child.once('close', (code) => code === 0 ? resolve(output) : reject(new E2EError('E2E_CLI_FAILED', `exit ${code}`)));
    });
    let timer;
    try { return await Promise.race([result, new Promise((_, reject) => { timer = setTimeout(() => { this.signal(child, 'SIGKILL'); reject(new E2EError('E2E_CLI_TIMEOUT')); }, timeout); })]); }
    finally { clearTimeout(timer); }
  }
  async migrate() { await this.command(['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', this.persistence]); }
  async seedFixtures() { await this.command(['d1', 'execute', 'DB', '--local', '--persist-to', this.persistence, '--file', this.seed]); }
  async offlineSql(sql) {
    if (this.child) throw new E2EError('E2E_SERVICE_MUST_BE_STOPPED');
    const file = path.join(this.directory, `fixture-${crypto.randomUUID()}.sql`);
    await writeFile(file, sql, { mode: 0o600, flag: 'wx' });
    await this.command(['d1', 'execute', 'DB', '--local', '--persist-to', this.persistence, '--file', file]);
  }
  async offlineQuery(sql) {
    if (this.child) throw new E2EError('E2E_SERVICE_MUST_BE_STOPPED');
    const file = path.join(this.directory, `query-${crypto.randomUUID()}.sql`);
    await writeFile(file, sql, { mode: 0o600, flag: 'wx' });
    const output = await this.command(['d1', 'execute', 'DB', '--local', '--persist-to', this.persistence, '--file', file, '--json']);
    const result = JSON.parse(output);
    if (!Array.isArray(result) || result.length !== 1 || result[0].success !== true || !Array.isArray(result[0].results)) throw new E2EError('E2E_QUERY_INVALID');
    return result[0].results;
  }
  async runNodeScript(relative, args) {
    if (this.child || this.interrupted || !['scripts/backup.mjs', 'scripts/restore-verify.mjs'].includes(relative)) throw new E2EError('E2E_SCRIPT_GUARD');
    const child = spawn(process.execPath, [path.join(this.snapshot, relative), ...args], { cwd: this.directory, env: this.environment,
      stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    this.children.add(child); child.once('close', () => this.children.delete(child));
    child.stdout.on('data', (chunk) => this.appendLog(chunk)); child.stderr.on('data', (chunk) => this.appendLog(chunk));
    let timer;
    try { await Promise.race([new Promise((resolve, reject) => {
      child.once('error', () => reject(new E2EError('E2E_SCRIPT_START')));
      child.once('close', (code) => code === 0 ? resolve() : reject(new E2EError('E2E_SCRIPT_FAILED', `${relative}: exit ${code}`)));
    }), new Promise((_, reject) => { timer = setTimeout(() => { this.signal(child, 'SIGKILL'); reject(new E2EError('E2E_SCRIPT_TIMEOUT')); }, 70_000); })]); }
    finally { clearTimeout(timer); }
  }

  async start() {
    assert.equal(this.child, null); this.assertOfflineConfiguration();
    const child = this.launch(['dev', '--local', '--ip', '127.0.0.1', '--port', String(this.port), '--inspector-port', '0',
      '--persist-to', this.persistence, '--show-interactive-dev-session=false', '--log-level', 'error']);
    this.child = child;
    let closed = false; child.once('close', () => { closed = true; });
    child.once('error', () => { closed = true; });
    await eventually(async () => {
      if (closed) throw new E2EError('E2E_SERVICE_EXITED');
      try {
        const health = await this.request('/health');
        assert.equal((await this.request('/e2e-instance.json')).data?.runId, this.fixtures.runId);
        assert.equal(health.data.product, 'Plause'); assert.equal(health.data.environment, 'local');
        assert.equal(health.data.model, 'mock'); assert.equal(health.data.messaging, 'mock');
        assert.equal(health.data.research?.ready, false);
        assert.equal(health.data.apple?.enabled, false); assert.equal(health.data.apple?.webhookConfigured, false); assert.equal(health.data.apple?.transportConfigured, false);
        return health;
      } catch (error) { if (error.code !== 'E2E_NETWORK_FAILURE') throw error; return null; }
    }, { timeout: 30_000, interval: 200, label: 'isolated service readiness' });
  }

  signal(child, signal) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    try { if (process.platform === 'win32') child.kill(signal); else process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  async stop({ crash = false } = {}) {
    this.stopTicker();
    await eventually(() => !this.ticking, { timeout: 11_000, interval: 20, label: 'scheduled tick drain' });
    const child = this.child; this.child = null;
    if (!child) return;
    const closed = new Promise((resolve) => child.once('close', resolve));
    this.signal(child, crash ? 'SIGKILL' : 'SIGTERM');
    await Promise.race([closed, delay(5000)]);
    if (child.exitCode === null && child.signalCode === null) { this.signal(child, 'SIGKILL'); await Promise.race([closed, delay(3000)]); }
    if (child.exitCode === null && child.signalCode === null) throw new E2EError('E2E_SERVICE_DID_NOT_STOP');
  }

  async request(route, { method = 'GET', session, operator = false, body, headers = {}, expected = 200, raw = false } = {}) {
    if (!route.startsWith('/') || route.startsWith('//')) throw new E2EError('E2E_UNSAFE_URL');
    const target = new URL(route, this.base); if (target.origin !== this.base) throw new E2EError('E2E_UNSAFE_URL');
    const requestHeaders = { ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(!['GET', 'HEAD'].includes(method) ? { origin: this.base } : {}), ...(session ? { cookie: session.cookie } : {}),
      ...(operator ? { authorization: `Bearer ${this.fixtures.operatorToken}` } : {}), ...headers };
    let response;
    try { response = await fetch(target, { method, headers: requestHeaders, ...(body !== undefined ? { body: raw ? body : JSON.stringify(body) } : {}),
      redirect: 'error', signal: AbortSignal.timeout(10_000) }); }
    catch { throw new E2EError('E2E_NETWORK_FAILURE', `${method} ${target.pathname}`); }
    let text;
    try { text = await readBoundedText(response); }
    catch (error) { if (error instanceof E2EError) throw error; throw new E2EError('E2E_NETWORK_FAILURE', `${method} ${target.pathname} response body`); }
    let data; try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    const allowed = Array.isArray(expected) ? expected : [expected];
    if (!allowed.includes(response.status)) throw new E2EError('E2E_HTTP_STATUS', `${method} ${target.pathname}: ${response.status}/${typeof data?.error === 'string' ? data.error : 'non_json'}`);
    return { response, data };
  }

  async login(account) {
    const result = await this.request('/api/session', { method: 'POST', body: { inviteToken: account.inviteToken } });
    const cookie = result.response.headers.get('set-cookie')?.split(';')[0];
    if (!cookie?.startsWith('plause_session=')) throw new E2EError('E2E_SESSION_MISSING');
    this.secrets.add(cookie); this.secrets.add(cookie.slice('plause_session='.length));
    assert.equal(result.data.user.id, account.id);
    return { ...account, cookie, conversationId: result.data.conversationId };
  }
  async conversation(session, conversationId = session.conversationId) {
    return (await this.request(`/api/conversations/${encodeURIComponent(conversationId)}`, { session })).data;
  }
  async post(session, text, clientMessageId = crypto.randomUUID()) {
    const beforeIds = new Set((await this.conversation(session)).messages.map((message) => message.id));
    const result = await this.request(`/api/conversations/${encodeURIComponent(session.conversationId)}/messages`, {
      method: 'POST', session, body: { text, clientMessageId }, expected: 202 });
    return { ...result.data, text, clientMessageId, beforeIds };
  }
  async reply(session, sent, conversationId = session.conversationId) {
    return eventually(async () => {
      const view = await this.conversation(session, conversationId);
      const input = view.messages.find((message) => message.role === 'user' && (sent.inputId ? message.id === sent.inputId
        : message.text === sent.text && !sent.beforeIds?.has(message.id)));
      if (!input) return null;
      if (['failed', 'cancelled'].includes(input.status)) throw new E2EError('E2E_INPUT_TERMINAL', input.status);
      const reply = view.messages.find((message) => message.inReplyTo === input.id && message.role === 'assistant');
      if (reply?.status !== 'delivered') return null;
      sent.inputId = input.id;
      return { input, reply, view };
    }, { timeout: 20_000, label: 'exact input/reply delivery' });
  }
  async say(session, text) { const sent = await this.post(session, text); return { sent, ...await this.reply(session, sent) }; }

  async tickOnce() { await this.request('/cdn-cgi/local/scheduled', { expected: [200, 204] }); }
  startTicker(interval = 500) {
    this.stopTicker();
    this.tick = setInterval(() => {
      if (this.ticking) return; this.ticking = true;
      this.tickOnce().catch((error) => { this.tickError = error; }).finally(() => { this.ticking = false; });
    }, interval);
  }
  stopTicker() { if (this.tick) clearInterval(this.tick); this.tick = null; }
  async exportAll(session) {
    const messages = []; const cursors = new Set(); let after = null; let first;
    for (let page = 0; page < 500; page++) {
      const result = (await this.request(`/api/account/export${after === null ? '' : `?after=${after}`}`, { session })).data;
      first ??= result; assert.ok(Array.isArray(result.messages)); messages.push(...result.messages);
      if (result.nextCursor === null) {
        assert.equal(new Set(messages.map((message) => message.id)).size, messages.length);
        return { ...first, messages, pages: page + 1 };
      }
      if (!Number.isSafeInteger(result.nextCursor) || result.nextCursor <= (after ?? 0) || cursors.has(result.nextCursor)) throw new E2EError('E2E_EXPORT_CURSOR');
      cursors.add(result.nextCursor); after = result.nextCursor;
    }
    throw new E2EError('E2E_EXPORT_INCOMPLETE');
  }
  async step(name, operation) {
    const started = Date.now(); const record = { name, status: 'running' }; this.steps.push(record);
    try { await operation(); record.status = 'passed'; console.log(`PASS ${name}`); }
    catch (error) { record.status = 'failed'; record.errorCode = error.code ?? 'E2E_ASSERTION_FAILED'; throw error; }
    finally { record.durationMs = Date.now() - started; }
  }
  async cleanup() {
    this.stopTicker(); await this.stop().catch(() => {});
    for (const child of this.children) this.signal(child, 'SIGKILL');
    await eventually(() => [...this.children].every((child) => child.exitCode !== null || child.signalCode !== null),
      { timeout: 5000, interval: 20, label: 'owned process teardown' });
    if (this.directory && this.tempRoot && path.dirname(this.directory) === this.tempRoot && path.basename(this.directory).startsWith('plause-e2e-')) {
      await rm(this.directory, { recursive: true, force: true, maxRetries: 3 });
      try { await lstat(this.directory); throw new E2EError('E2E_TEMPORARY_DATA_REMAINED'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    } else if (this.directory) {
      throw new E2EError('E2E_CLEANUP_PATH_GUARD');
    }
    return { ownedProcessesStopped: true, temporaryDataRemoved: true };
  }
}
