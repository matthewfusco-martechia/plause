import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync, constants as sqlite } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

export const repo = fileURLToPath(new URL('../', import.meta.url));
export class BackupError extends Error { constructor(code) { super(code); this.code = code; } }
export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const maxSqlBytes = 64 * 1024 * 1024;

export function hardenedDatabase(filename) {
  const database = new DatabaseSync(filename, { allowExtension: false });
  if (typeof database.setAuthorizer !== 'function') { database.close(); throw new BackupError('BACKUP_REQUIRES_NODE_24_10'); }
  database.setAuthorizer((action, first, second) => {
    if ([sqlite.SQLITE_ATTACH, sqlite.SQLITE_DETACH, sqlite.SQLITE_CREATE_VTABLE].includes(action)) return sqlite.SQLITE_DENY;
    if (action === sqlite.SQLITE_PRAGMA && !['foreign_keys', 'defer_foreign_keys', 'user_version', 'encoding',
      'application_id', 'recursive_triggers', 'foreign_key_check', 'integrity_check', 'quick_check', 'table_info'].includes(String(first).toLowerCase())) return sqlite.SQLITE_DENY;
    if (action === sqlite.SQLITE_FUNCTION && ['load_extension', 'readfile', 'writefile'].includes(String(second).toLowerCase())) return sqlite.SQLITE_DENY;
    return sqlite.SQLITE_OK;
  });
  return database;
}

export function schemaFingerprint(database) {
  return digest(JSON.stringify(database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type,name").all()));
}

export function validateImportedDatabase(database) {
  database.exec('PRAGMA foreign_keys=ON;');
  if (database.prepare('PRAGMA foreign_key_check').all().length) throw new BackupError('BACKUP_FOREIGN_KEYS_INVALID');
  const integrity = database.prepare('PRAGMA integrity_check').all();
  if (integrity.length !== 1 || Object.values(integrity[0])[0] !== 'ok') throw new BackupError('BACKUP_INTEGRITY_INVALID');
}

/** D1 exports may insert a child before defining its referenced parent table. */
export function importSql(database, sql) {
  database.exec('PRAGMA foreign_keys=OFF;');
  try {
    database.exec(sql);
    if (database.isTransaction) throw new BackupError('BACKUP_IMPORT_TRANSACTION_INCOMPLETE');
  } catch (error) {
    if (database.isTransaction) database.exec('ROLLBACK;');
    throw error;
  } finally { database.exec('PRAGMA foreign_keys=ON;'); }
  // Disabling ordering checks is restricted to import into this new database;
  // every reference is verified before any artifact is considered valid.
  validateImportedDatabase(database);
}

export async function readProtectedFile(filename, limit) {
  const file = await open(filename, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > limit) throw new BackupError('BACKUP_FILE_UNSAFE');
    return await file.readFile();
  } finally { await file.close(); }
}

export function parseOptions(argv, allowed, flags = []) {
  const options = {};
  for (let n = 0; n < argv.length; n++) {
    const argument = argv[n];
    if (!allowed.includes(argument) || Object.hasOwn(options, argument)) throw new BackupError('BACKUP_ARGUMENT_INVALID');
    if (flags.includes(argument)) { options[argument] = true; continue; }
    const value = argv[++n];
    if (!value || value.startsWith('--')) throw new BackupError('BACKUP_ARGUMENT_INVALID');
    options[argument] = value;
  }
  return options;
}

async function runWrangler(args, workingDirectory, timeout = 60_000) {
  const environment = Object.fromEntries(['PATH', 'HOME', 'USER', 'TMPDIR', 'SystemRoot'].filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
  Object.assign(environment, { CI: 'true', WRANGLER_SEND_METRICS: 'false',
    WRANGLER_LOG_PATH: path.join(workingDirectory, 'wrangler.log'), XDG_CONFIG_HOME: path.join(workingDirectory, 'config'),
    CLOUDFLARE_INCLUDE_PROCESS_ENV: 'false', CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false' });
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(repo, 'node_modules/wrangler/bin/wrangler.js'), ...args], {
      cwd: workingDirectory, env: environment, stdio: ['ignore', 'ignore', 'ignore'],
    });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new BackupError('BACKUP_EXPORT_TIMEOUT')); }, timeout);
    child.once('error', () => { clearTimeout(timer); reject(new BackupError('BACKUP_EXPORT_FAILED')); });
    child.once('exit', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new BackupError('BACKUP_EXPORT_FAILED')); });
  });
}

/** Only local export is supported. No deploy, remote DB access or overwrite. */
export async function createLocalBackup({ directory, configPath = path.join(repo, 'wrangler.jsonc'), persistencePath }, { runner = runWrangler } = {}) {
  process.umask(0o077);
  const destination = path.resolve(directory); const configFile = path.resolve(configPath);
  let source;
  try { source = JSON.parse(await readFile(configFile, 'utf8')); } catch { throw new BackupError('BACKUP_LOCAL_CONFIG_INVALID'); }
  const binding = source.d1_databases?.find((item) => item.binding === 'DB');
  if (source.vars?.APP_ENV !== 'local' || !binding || binding.remote || !/^[0-9a-f-]{36}$/i.test(binding.database_id ?? '')) {
    throw new BackupError('BACKUP_LOCAL_CONFIG_INVALID');
  }
  const persistence = await realpath(persistencePath ? path.resolve(persistencePath) : path.join(path.dirname(configFile), '.wrangler/state'));
  if (!(await lstat(persistence)).isDirectory()) throw new BackupError('BACKUP_PERSISTENCE_INVALID');
  await mkdir(destination, { mode: 0o700 }); // exclusive; existing paths are never reused
  const workspace = path.join(destination, '.export');
  try {
    await mkdir(path.join(workspace, '.wrangler'), { recursive: true, mode: 0o700 });
    await symlink(persistence, path.join(workspace, '.wrangler/state'), 'dir');
    const isolatedConfig = path.join(workspace, 'wrangler.json');
    await writeFile(isolatedConfig, JSON.stringify({ name: 'plause-local-export', compatibility_date: '2026-10-30',
      d1_databases: [{ binding: 'DB', database_name: 'plause-local-export', database_id: binding.database_id }] }), { mode: 0o600, flag: 'wx' });
    const sqlFile = path.join(destination, 'database.sql');
    await runner(['d1', 'export', 'DB', '--local', '--config', isolatedConfig, '--output', sqlFile], workspace);
    await chmod(sqlFile, 0o600);
    const sql = await readProtectedFile(sqlFile, maxSqlBytes);
    const database = hardenedDatabase(':memory:');
    let fingerprint;
    try { importSql(database, sql.toString('utf8')); fingerprint = schemaFingerprint(database); }
    finally { database.close(); }
    const manifest = { version: 1, format: 'cloudflare-d1-sql', environment: 'local', createdAt: new Date().toISOString(),
      file: 'database.sql', bytes: sql.byteLength, sha256: digest(sql), schemaSha256: fingerprint,
      keyringIncluded: false, privacyLedgerIncluded: false, restoreRequiresFreshPrivacyLedger: true };
    await writeFile(path.join(destination, 'backup.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    return { directory: destination, manifest };
  } finally { await rm(workspace, { recursive: true, force: true }); }
}

export async function backupMain(argv = process.argv.slice(2)) {
  const options = parseOptions(argv, ['--local', '--out', '--config', '--persist-to'], ['--local']);
  if (!options['--local'] || !options['--out']) throw new BackupError('BACKUP_USE_LOCAL_AND_NEW_OUTPUT_DIRECTORY');
  const result = await createLocalBackup({ directory: options['--out'],
    ...(options['--config'] ? { configPath: options['--config'] } : {}),
    ...(options['--persist-to'] ? { persistencePath: options['--persist-to'] } : {}) });
  console.log(JSON.stringify({ ok: true, directory: result.directory, sha256: result.manifest.sha256,
    note: 'Local encrypted-content database export. Escrow the complete encryption keyring separately. Restoration requires a fresh independent privacy ledger.' }));
}

if (process.argv[1] && await realpath(path.resolve(process.argv[1])).catch(() => null) === await realpath(fileURLToPath(import.meta.url))) {
  backupMain().catch((error) => { console.error(JSON.stringify({ ok: false, code: error instanceof BackupError ? error.code : 'BACKUP_FAILED' })); process.exitCode = 1; });
}
