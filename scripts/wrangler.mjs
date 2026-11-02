import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
mkdirSync(path.join(root, '.local/config'), { recursive: true });
const args = [path.join(root, 'node_modules/wrangler/bin/wrangler.js'), ...process.argv.slice(2)];
const options = { cwd: root, stdio: 'inherit',
  env: { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: path.join(root, '.local/wrangler.log'), XDG_CONFIG_HOME: path.join(root, '.local/config') } };

if (process.argv[2] !== 'dev') {
  const result = spawnSync(process.execPath, args, options);
  process.exit(result.status ?? 1);
}

// Wrangler does not fire cron automatically locally. This process only wakes
// the durable scheduled handler; due work and deduplication remain in D1.
const child = spawn(process.execPath, args, options);
let runningTick = false;
let stopping = false;
async function tick() {
  if (runningTick || stopping) return;
  runningTick = true;
  try {
    const healthResponse = await fetch('http://127.0.0.1:8787/health', { redirect: 'error', signal: AbortSignal.timeout(3000) });
    if (!healthResponse.ok) return;
    const health = await healthResponse.json();
    if (health.product !== 'Plause' || health.environment !== 'local' || health.messaging !== 'mock') return;
    await fetch('http://127.0.0.1:8787/cdn-cgi/local/scheduled', { redirect: 'error', signal: AbortSignal.timeout(5000) });
  } catch { /* Server startup/reload is transient. The next durable sweep retries. */ }
  finally { runningTick = false; }
}
const interval = setInterval(() => { void tick(); }, 15_000);
const initial = setTimeout(() => { void tick(); }, 2000);
function stop(signal) {
  stopping = true;
  clearInterval(interval);
  clearTimeout(initial);
  child.kill(signal);
}
process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));
child.once('error', () => { clearInterval(interval); clearTimeout(initial); process.exitCode = 1; });
child.once('exit', (code, signal) => {
  stopping = true;
  clearInterval(interval);
  clearTimeout(initial);
  process.exit(code ?? (signal === 'SIGINT' ? 130 : 1));
});
