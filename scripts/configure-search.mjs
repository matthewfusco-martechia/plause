import { constants, openSync, closeSync, fstatSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readVariables, updateVariables, writeConfiguration } from './configure-model.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const usage = `Configure Plause's read-only research without making an API request.
  npm run configure:search -- --status
  npm run configure:search -- --key-file .local/tavily-key.txt --enable
  npm run configure:search -- --disabled
Use a private regular key file owned by you (chmod 600). Never pass a key as an argument.
--config PATH selects a different existing local configuration for isolated checks.
Enabling sends only explicit public search queries to Tavily, up to20/user/day and500/service/day.
Provider requests can incur charges. AI model configuration and Apple messaging are independent.`;

function readPrivate(filename, maximum, protectedMode) {
  let descriptor;
  try {
    descriptor = openSync(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > maximum || (process.getuid && stat.uid !== process.getuid()) || (protectedMode && (stat.mode & 0o077))) throw new Error('unsafe');
    return readFileSync(descriptor, 'utf8');
  } catch { throw new Error('Cannot read the private local file safely. It must be small, owned by you, regular, and not a symlink; key files require mode600. No credentials were printed.'); }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
}

try {
  let config = path.join(root, '.dev.vars');
  let keyFile;
  let mode;
  let enable = false;
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (seen.has(argument)) throw new Error('Do not repeat options.');
    seen.add(argument);
    if (argument === '--help') { console.log(usage); process.exit(0); }
    if (argument === '--config' || argument === '--key-file') {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error('A local file path is required.');
      if (argument === '--config') config = path.resolve(value); else keyFile = path.resolve(value);
    } else if (argument === '--enable') enable = true;
    else if (argument === '--status' || argument === '--disabled') {
      if (mode) throw new Error('Choose one mode.');
      mode = argument;
    } else throw new Error('Unsupported option. Do not put credentials in arguments. Use --help.');
  }
  if (mode && (enable || keyFile)) throw new Error('Status/disabled modes cannot enable requests.');
  if (!mode && (!keyFile || !enable)) throw new Error('Use both --key-file and --enable for explicit opt-in, or --status/--disabled.');
  const source = readPrivate(config, 65_536, false);
  const values = readVariables(source);
  if (mode === '--status') {
    console.log(`Research provider: ${values.SEARCH_PROVIDER === 'tavily' ? 'Tavily' : !values.SEARCH_PROVIDER || values.SEARCH_PROVIDER === 'disabled' ? 'disabled' : 'unsupported'}.`);
    console.log(`Live search opted in: ${values.LIVE_SEARCH_ENABLED === 'true' ? 'yes' : 'no'}.`);
    console.log(`API key stored: ${values.TAVILY_API_KEY ? 'yes (hidden)' : 'no'}.`);
    console.log('Configuration only; API access and charges have not been verified.');
  } else {
    if (!['CONTENT_ENCRYPTION_KEY', 'MOCK_WEBHOOK_SECRET', 'OPERATOR_TOKEN'].every((key) => values[key])) throw new Error('Run npm run setup first.');
    if (mode === '--disabled') {
      writeConfiguration(config, updateVariables(source, { SEARCH_PROVIDER: 'disabled', LIVE_SEARCH_ENABLED: 'false' }));
      console.log('Research requests disabled. A stored key is retained. Restart npm run dev.');
    } else {
      const key = readPrivate(keyFile, 1024, true).trim();
      if (!/^[A-Za-z0-9_-]{16,512}$/.test(key)) throw new Error('The key file must contain one API key without spaces or extra lines. No changes were written.');
      writeConfiguration(config, updateVariables(source, { SEARCH_PROVIDER: 'tavily', LIVE_SEARCH_ENABLED: 'true', TAVILY_API_KEY: key,
        SEARCH_USER_DAILY_LIMIT: '20', SEARCH_GLOBAL_DAILY_LIMIT: '500' }));
      console.log('Read-only research configured with explicit opt-in. Only user-supplied public queries are sent to Tavily.');
      console.log('Limits:20requests/user/day,500requests/service/day (UTC). Requests can incur provider charges.');
      console.log('No API request was made. The key remains private. Restart npm run dev.');
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Research setup failed. No credentials were printed.');
  process.exitCode = 1;
}
