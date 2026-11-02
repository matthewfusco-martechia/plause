import { constants, openSync, closeSync, fstatSync, readFileSync, writeFileSync, fsyncSync, renameSync, unlinkSync, lstatSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { emitKeypressEvents, createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const defaults = Object.freeze({
  MODEL_PROVIDER: 'openai',
  LIVE_MODEL_ENABLED: 'true',
  OPENAI_MODEL: 'gpt-6-luna',
  MODEL_MAX_INPUT_TOKENS: '4096',
  MODEL_MAX_OUTPUT_TOKENS: '600',
  MODEL_TIMEOUT_MS: '20000',
  MODEL_USER_MONTHLY_BUDGET_MICRO_USD: '5000000',
  MODEL_GLOBAL_MONTHLY_BUDGET_MICRO_USD: '50000000',
});

const help = `Configure Plause's local hosted model without making an API call.

  npm run configure:model                         Hidden key prompt and confirmation
  npm run configure:model -- --key-file PATH --enable
                                                   Explicit opt-in using a protected key file
  npm run configure:model -- --store-only           Hidden key prompt; save only the key
  npm run configure:model -- --store-only --key-file PATH
                                                   Save a protected key without changing model settings
  npm run configure:model -- --status               Safe configuration status; no secrets
  npm run configure:model -- --mock                 Disable hosted requests; retain stored key

Options:
  --config PATH   Use a different local .dev.vars file (also useful for smoke tests)
  --help          Show these instructions

Run npm run setup first. Never put an API key in command-line arguments.
The key file must be a regular file owned by you with no group/other permissions.
Store-only also requires a private, single-link configuration file. It cannot be
combined with --enable, --status or --mock. Existing hosted opt-in flags stay unchanged.
Hosted requests remain local to this development service; Apple Messages is not connected.
`;

function parseArguments(args) {
  const options = { config: path.join(root, '.dev.vars'), keyFile: null, enable: false, mode: 'interactive' };
  let selectedMode = false;
  const used = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (used.has(arg)) throw new Error('Options must not be repeated. Use --help for supported options.');
    used.add(arg);
    if (arg === '--help') return { ...options, mode: 'help' };
    if (arg === '--config' || arg === '--key-file') {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error('A local file path is required after --config or --key-file.');
      options[arg === '--config' ? 'config' : 'keyFile'] = path.resolve(value);
    } else if (arg === '--enable') options.enable = true;
    else if (arg === '--status' || arg === '--mock' || arg === '--store-only') {
      if (selectedMode) throw new Error('Choose only one of --status, --mock or --store-only.');
      options.mode = arg.slice(2);
      selectedMode = true;
    } else throw new Error('Unsupported option. Use --help; do not pass credentials as arguments.');
  }
  if (options.mode === 'store-only') {
    if (options.enable) throw new Error('--store-only cannot be combined with --enable. No changes were written.');
    return options;
  }
  if (selectedMode && (options.keyFile || options.enable)) throw new Error('--status and --mock cannot enable hosted requests.');
  if (Boolean(options.keyFile) !== options.enable) throw new Error('--key-file and --enable must be used together.');
  return options;
}

/** Read dotenv values without evaluating shell expressions or printing their contents. */
export function readVariables(source) {
  const values = Object.create(null);
  for (const line of source.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    let value = match[2];
    if (value.startsWith('"') && value.endsWith('"')) {
      try { value = JSON.parse(value); } catch { continue; }
    } else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '').trim();
    if (typeof value === 'string') values[match[1]] = value;
  }
  return values;
}

/** Preserve unrelated secrets and comments; collapse duplicate keys we own. */
export function updateVariables(source, changes) {
  const remaining = new Map(Object.entries(changes));
  const owned = new Set(remaining.keys());
  const output = [];
  for (const line of source.replace(/\r\n/g, '\n').split('\n')) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (!match || !owned.has(match[1])) { output.push(line); continue; }
    if (remaining.has(match[1])) {
      output.push(`${match[1]}=${remaining.get(match[1])}`);
      remaining.delete(match[1]);
    }
  }
  while (output.at(-1) === '') output.pop();
  if (remaining.size) output.push('', '# Local model configuration. No hosted request is made by this script.', ...Array.from(remaining, ([key, value]) => `${key}=${value}`));
  return `${output.join('\n')}\n`;
}

function readLocalFile(filename, { protectedFile = false, singleLink = false, allowMissing = false, maxBytes = 65_536 } = {}) {
  let descriptor;
  try {
    descriptor = openSync(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > maxBytes || (process.getuid && stat.uid !== process.getuid()) || (singleLink && stat.nlink !== 1)) {
      throw new Error('The local configuration or key file must be a small regular file owned by the current user.');
    }
    if (protectedFile && (stat.mode & 0o077) !== 0) throw new Error('The configuration or key file must have no group or other permissions. Set its mode to 600 first.');
    return readFileSync(descriptor, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT' && allowMissing) return null;
    if (error?.code) throw new Error('Cannot safely read the local file. Check that it exists, is owned by you, and is not a symlink.');
    throw error;
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

/** Write privately in the same directory, then replace atomically. */
export function writeConfiguration(filename, source) {
  const temporary = path.join(path.dirname(filename), `.plause-model-${randomUUID()}.tmp`);
  let descriptor;
  try {
    // Reject replacing a symlink even if the caller did not read the file first.
    try { if (!lstatSync(filename).isFile()) throw new Error('Configuration must be a regular file.'); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
    writeFileSync(descriptor, source, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, filename);
  } catch {
    throw new Error('Could not write the local configuration safely. No credentials were printed.');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try { unlinkSync(temporary); } catch { /* The atomic rename normally removes it. */ }
  }
}

function validateApiKey(value) {
  const key = value.trim();
  if (!/^sk-[A-Za-z0-9_-]{16,512}$/.test(key)) throw new Error('The key must be one OpenAI API key, without spaces or additional lines. No changes were written.');
  return key;
}

function hiddenKeyPrompt() {
  if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== 'function') {
    throw new Error('Interactive setup requires a terminal. Use a protected --key-file with --store-only to save it, or --enable for explicit hosted opt-in.');
  }
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    const wasRaw = Boolean(input.isRaw);
    let key = '';
    emitKeypressEvents(input);
    process.stdout.write('OpenAI API key (hidden): ');
    function finish(error) {
      input.removeListener('keypress', onKeypress);
      input.setRawMode(wasRaw);
      input.pause();
      process.stdout.write('\n');
      if (error) reject(error); else resolve(key);
    }
    function onKeypress(character, event = {}) {
      if ((event.ctrl && (event.name === 'c' || event.name === 'd')) || event.name === 'escape') return finish(new Error('Configuration cancelled. No changes were written.'));
      if (event.name === 'return' || event.name === 'enter') return finish();
      if (event.name === 'backspace' || event.name === 'delete') { key = Array.from(key).slice(0, -1).join(''); return; }
      if (!event.ctrl && !event.meta && character && !/[\x00-\x1f\x7f]/.test(character)) {
        if (key.length + character.length > 600) return finish(new Error('The key was too long. No changes were written.'));
        key += character;
      }
    }
    input.on('keypress', onKeypress);
    input.setRawMode(true);
    input.resume();
  });
}

function printLimits() {
  console.log('Hosted model: gpt-6-luna (OpenAI).');
  console.log('Per request: at most 4,096 input tokens, 600 output tokens, 20-second timeout.');
  console.log('App ledger limits: US$5 per user/month and US$50 globally/month (UTC).');
  console.log('Enabling sends messages and recent conversation context to OpenAI and can incur API charges.');
  console.log('Uncertain request outcomes retain their budget reservation until reconciled. Provider billing remains authoritative.');
  console.log('No API request will be made by this configuration script. Apple Messages remains disconnected.');
}

async function confirmEnable() {
  printLimits();
  const terminal = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  try {
    const answer = await new Promise((resolve) => {
      terminal.once('close', () => resolve(''));
      terminal.question('Type ENABLE HOSTED AI to allow hosted requests from this local service: ', resolve);
    });
    if (answer.trim() !== 'ENABLE HOSTED AI') throw new Error('Hosted requests were not enabled. No changes were written.');
  } finally { terminal.close(); }
}

function printStatus(source) {
  if (source === null) { console.log('Local configuration is absent. Run npm run setup first. Hosted requests are not configured.'); return; }
  const values = readVariables(source);
  const mock = values.MODEL_PROVIDER === undefined || values.MODEL_PROVIDER === 'mock';
  const selected = values.OPENAI_MODEL === 'gpt-6-luna';
  const enabled = values.LIVE_MODEL_ENABLED === 'true';
  const hasKey = Boolean(values.OPENAI_API_KEY);
  const defaultsMatch = Object.entries(defaults).every(([key, value]) => values[key] === value);
  console.log(`Model provider: ${mock ? 'mock' : values.MODEL_PROVIDER === 'openai' ? 'OpenAI' : 'unsupported'}.`);
  console.log(`Hosted requests opted in: ${enabled ? 'yes' : 'no'}.`);
  console.log(`Supported model selected: ${selected ? 'gpt-6-luna' : 'no'}.`);
  console.log(`API key stored: ${hasKey ? 'yes (hidden)' : 'no'}.`);
  console.log(`Default bounded configuration: ${defaultsMatch && hasKey ? 'present' : 'not enabled with all defaults'}.`);
  console.log('Status checks configuration only; API access and billing have not been verified.');
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArguments(args);
  if (options.mode === 'help') { console.log(help); return; }
  const source = readLocalFile(options.config, { allowMissing: options.mode === 'status',
    protectedFile: options.mode === 'store-only', singleLink: options.mode === 'store-only' });
  if (options.mode === 'status') { printStatus(source); return; }
  const existing = readVariables(source);
  if (!['CONTENT_ENCRYPTION_KEY', 'MOCK_WEBHOOK_SECRET', 'OPERATOR_TOKEN'].every((key) => existing[key])) {
    throw new Error('The local configuration is missing setup keys. Run npm run setup before configuring the model.');
  }
  if (options.mode === 'mock') {
    writeConfiguration(options.config, updateVariables(source, { MODEL_PROVIDER: 'mock', LIVE_MODEL_ENABLED: 'false' }));
    console.log('Mock mode enabled. Hosted requests are disabled; any stored API key was retained. Restart npm run dev.');
    return;
  }
  const key = validateApiKey(options.keyFile
    ? readLocalFile(options.keyFile, { protectedFile: true, singleLink: options.mode === 'store-only', maxBytes: 1024 })
    : await hiddenKeyPrompt());
  if (options.mode === 'store-only') {
    writeConfiguration(options.config, updateVariables(source, { OPENAI_API_KEY: key }));
    console.log('API key saved privately. Only OPENAI_API_KEY changed; model and hosted opt-in settings were preserved.');
    console.log(existing.MODEL_PROVIDER === 'openai' && existing.LIVE_MODEL_ENABLED === 'true'
      ? 'The existing configuration already opts in to hosted requests; those settings were not changed.'
      : 'Hosted requests remain disabled by the current provider or opt-in settings.');
    console.log('No API request was made. API access and billing have not been verified.');
    return;
  }
  if (options.keyFile) printLimits();
  else await confirmEnable();
  writeConfiguration(options.config, updateVariables(source, { ...defaults, OPENAI_API_KEY: key }));
  console.log('Hosted model configured with explicit local opt-in. Restart npm run dev to load it.');
  console.log('The key was stored in the private local configuration. No hosted request has been made.');
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Configuration failed. No credentials were printed.');
    process.exitCode = 1;
  });
}
