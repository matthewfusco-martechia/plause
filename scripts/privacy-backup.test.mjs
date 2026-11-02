import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { backupMain, createLocalBackup, hardenedDatabase, importSql, repo } from './backup.mjs';
import { restoreMain, validateLedgerSnapshot, verifyRestore } from './restore-verify.mjs';
import { spawnSync } from 'node:child_process';

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'plause-backup-fixture-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const migrationNames = (await readdir(path.join(repo, 'migrations'))).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
  const schema = (await Promise.all(migrationNames.map((name) => readFile(path.join(repo, 'migrations', name), 'utf8')))).join('\n');
  const sql = schema + `
    INSERT INTO users(id,display_name,status,created_at) VALUES('u_restore_erase','Erased fixture','active',0),('u_restore_keep','Kept fixture','active',0);
    INSERT INTO sessions(token_hash,user_id,expires_at) VALUES('stale-session','u_restore_erase',9999999999999),('stale-kept-session','u_restore_keep',9999999999999);
    INSERT INTO external_identities(id,user_id,issuer,subject,subject_digest,created_at) VALUES('old-identity','u_restore_erase','https://accounts.google.com','opaque-subject','opaque-keyed-digest',0);
    INSERT INTO conversations(id,user_id,channel,provider,business_id,subject_id,created_at,last_activity_at,lease_token,lease_until)
      VALUES('restore_conversation','u_restore_keep','web','web','plause-web','u_restore_keep',0,0,'stale-lease',9999999999999);
    INSERT INTO bindings(provider,business_id,subject_id,user_id,channel,conversation_id) VALUES('web','plause-web','u_restore_keep','u_restore_keep','web','restore_conversation');
    INSERT INTO messages(id,conversation_id,role,body_ciphertext,status,created_at) VALUES('restored_message','restore_conversation','user','opaque-message-ciphertext','received',0);
    INSERT INTO memories(id,user_id,body_ciphertext,created_at,updated_at) VALUES('old-memory','u_restore_keep','opaque-memory-ciphertext',0,0);
    INSERT INTO google_calendar_connections(user_id,revision,connected,status,scope,access_token_ciphertext,refresh_token_ciphertext,expires_at,created_at,updated_at)
      VALUES('u_restore_erase',0,1,'connected','https://www.googleapis.com/auth/calendar.events.owned','opaque-access','opaque-refresh',9999999999999,0,0),
      ('u_restore_keep',0,1,'connected','https://www.googleapis.com/auth/calendar.events.owned','opaque-kept-access','opaque-kept-refresh',9999999999999,0,0);
    INSERT INTO model_attempts(message_id,user_id,conversation_id,attempt_token,lease_token,ownership_version,input_digest,model,budget_month,reservation_micro_usd,budget_debit_micro_usd,state,created_at,updated_at)
      VALUES('charged_message','u_restore_erase','removed-conversation','charged-attempt','old-lease',0,'private-input','gpt-6-luna','2026-10',1000,1000,'dispatched',0,0),
      ('reserved_message','u_restore_keep','restore_conversation','reserved-attempt','old-lease',0,'private-input','gpt-6-luna','2026-10',500,500,'reserved',0,0);
    INSERT INTO search_attempts(message_id,user_id,conversation_id,context_revision,day,state,query_digest,attempt_token,created_at,updated_at)
      VALUES('old_search','u_restore_erase','removed-conversation',0,'2026-10-31','dispatched','private-query-digest','search-attempt',0,0);
    INSERT INTO google_calendar_requests(message_id,user_id,conversation_id,context_revision,operation,day,counted,state,query_digest,attempt_token,created_at,updated_at)
      VALUES('old_google','u_restore_erase','removed-conversation',0,'list','2026-10-31',1,'dispatched','private-query-digest','google-attempt',0,0);
    INSERT INTO messaging_onboarding_subjects(business_id,subject_hash,status,provider_event_at,user_id)
      VALUES('fixture_app','erased-subject-hash','active',0,'u_restore_erase'),('fixture_app','anonymous-subject-hash','active',0,NULL);
    INSERT INTO messaging_onboarding_contacts(contact_key,business_id,subject_hash,destination_hash,routing_ciphertext,user_id,
      control,status,provider_event_at,last_inbound_at,created_at,updated_at)
      VALUES('erased-contact','fixture_app','erased-subject-hash','erased-destination-hash','opaque-private-route','u_restore_erase','bot','active',0,0,0,0),
      ('anonymous-contact','fixture_app','anonymous-subject-hash','anonymous-destination-hash','opaque-anonymous-route',NULL,'bot','active',0,0,0,0);
    INSERT INTO messaging_onboarding_notices(id,dedupe_key,contact_key,kind,status,contact_revision,user_id,next_attempt_at,expires_at,created_at,updated_at,dispatched_at)
      VALUES('uncertain-notice','proof:old-challenge','erased-contact','proof_received','sending',0,'u_restore_erase',0,9999999999999,0,0,123),
      ('pending-notice','welcome:anonymous-contact','anonymous-contact','welcome','pending',0,NULL,0,9999999999999,0,0,NULL);
  `;
  const config = path.join(directory, 'wrangler.json'); const persistence = path.join(directory, 'state');
  await mkdir(persistence, { mode: 0o700 });
  await writeFile(path.join(persistence, 'source-marker'), 'do not overwrite', { mode: 0o600 });
  await writeFile(config, JSON.stringify({ vars: { APP_ENV: 'local' },
    d1_databases: [{ binding: 'DB', database_id: '00000000-0000-0000-0000-000000000000' }] }), { mode: 0o600 });
  const calls = [];
  const runner = async (args) => {
    calls.push(args); const output = args[args.indexOf('--output') + 1];
    await writeFile(output, sql, { mode: 0o600 });
  };
  const backup = path.join(directory, 'backup');
  const result = await createLocalBackup({ directory: backup, configPath: config, persistencePath: persistence }, { runner });
  const ledger = path.join(directory, 'independent-latest-ledger.json');
  const snapshot = { version: 1, environment: 'local', exportedAt: new Date().toISOString(), complete: true, records: [
    { version: 1, environment: 'local', userId: 'u_restore_erase', operationId: 'erase_fixture', requestedAt: 1 },
    { version: 1, environment: 'local', userId: 'unknown_in_backup', operationId: 'erase_unknown_fixture', requestedAt: 1 },
  ] };
  await writeFile(ledger, JSON.stringify(snapshot), { mode: 0o600 });
  return { directory, backup, ledger, snapshot, calls, result, persistence, config, runner };
}

test('backup uses local export only, protects artifacts and never overwrites a destination', async (t) => {
  const f = await fixture(t);
  assert.equal(f.result.manifest.environment, 'local'); assert.equal(f.result.manifest.keyringIncluded, false);
  assert.equal(f.result.manifest.privacyLedgerIncluded, false); assert.match(f.result.manifest.schemaSha256, /^[0-9a-f]{64}$/);
  assert.equal(f.calls.length, 1); assert.deepEqual(f.calls[0].slice(0, 4), ['d1', 'export', 'DB', '--local']);
  assert.equal(f.calls[0].includes('--remote'), false);
  assert.equal((await stat(f.backup)).mode & 0o777, 0o700);
  for (const filename of ['database.sql', 'backup.json']) assert.equal((await stat(path.join(f.backup, filename))).mode & 0o777, 0o600);
  assert.equal(await readFile(path.join(f.persistence, 'source-marker'), 'utf8'), 'do not overwrite');
  await assert.rejects(createLocalBackup({ directory: f.backup, configPath: f.config, persistencePath: f.persistence }, { runner: f.runner }), { code: 'EEXIST' });
});

test('restore replays independent erasures, fences all stale credentials and retains charged quota', async (t) => {
  const f = await fixture(t); const output = path.join(f.directory, 'restored-new-database');
  const result = await verifyRestore({ directory: f.backup, ledgerFile: f.ledger, outputDirectory: output });
  assert.equal(result.report.appliedErasures, 2); assert.equal(result.report.servingAuthorized, false);
  const db = new DatabaseSync(result.database, { readOnly: true });
  try {
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users WHERE id='u_restore_erase'").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM external_identities WHERE user_id='u_restore_erase'").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM google_calendar_connections WHERE user_id='u_restore_erase'").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM identity_erasures WHERE subject_digest='opaque-keyed-digest'").get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memories').get().n, 0);
    assert.equal(db.prepare("SELECT memory_enabled FROM users WHERE id='u_restore_keep'").get().memory_enabled, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM google_calendar_connections WHERE access_token_ciphertext IS NOT NULL OR refresh_token_ciphertext IS NOT NULL").get().n, 0);
    assert.equal(db.prepare("SELECT value FROM system_settings WHERE key='outbound_paused'").get().value, 'true');
    assert.equal(db.prepare("SELECT value FROM system_settings WHERE key='restore_locked'").get().value, 'true');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM conversations WHERE lease_token IS NOT NULL OR lease_until!=0').get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM bindings WHERE status='active'").get().n, 0);
    assert.equal(db.prepare("SELECT budget_debit_micro_usd FROM model_attempts WHERE message_id='charged_message'").get().budget_debit_micro_usd, 1000);
    assert.equal(db.prepare("SELECT budget_debit_micro_usd FROM model_attempts WHERE message_id='reserved_message'").get().budget_debit_micro_usd, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM search_attempts').get().n, 1);
    assert.equal(db.prepare('SELECT SUM(counted) AS n FROM google_calendar_requests').get().n, 1);
    assert.equal(db.prepare("SELECT state FROM privacy_operations WHERE user_id='unknown_in_backup'").get().state, 'completed');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messaging_onboarding_contacts WHERE routing_ciphertext IS NOT NULL OR user_id IS NOT NULL OR binding_id IS NOT NULL OR status!=\'revoked\'').get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM messaging_onboarding_subjects WHERE user_id IS NOT NULL OR status!='revoked'").get().n, 0);
    assert.equal(db.prepare("SELECT status FROM messaging_onboarding_notices WHERE id='uncertain-notice'").get().status, 'delivery_unknown');
    assert.equal(db.prepare("SELECT dispatched_at FROM messaging_onboarding_notices WHERE id='uncertain-notice'").get().dispatched_at, 123);
    assert.equal(db.prepare("SELECT status FROM messaging_onboarding_notices WHERE id='pending-notice'").get().status, 'cancelled');
  } finally { db.close(); }
  assert.equal((await stat(result.database)).mode & 0o777, 0o600);
  const before = await readFile(result.database);
  await assert.rejects(verifyRestore({ directory: f.backup, ledgerFile: f.ledger, outputDirectory: output }), { code: 'EEXIST' });
  assert.deepEqual(await readFile(result.database), before);
});

test('restore refuses corrupted SQL and stale, incomplete, cross-scope or non-independent ledgers', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.backup, 'inside-ledger.json'), JSON.stringify(f.snapshot), { mode: 0o600 });
  await assert.rejects(verifyRestore({ directory: f.backup, ledgerFile: path.join(f.backup, 'inside-ledger.json'), outputDirectory: path.join(f.directory, 'bad-inside') }), { code: 'RESTORE_LEDGER_MUST_BE_INDEPENDENT' });
  for (const [label, snapshot] of [
    ['stale', { ...f.snapshot, exportedAt: new Date(Date.now() - 600_000).toISOString() }],
    ['incomplete', { ...f.snapshot, complete: false }], ['cross-scope', { ...f.snapshot, environment: 'production' }],
  ]) {
    await writeFile(f.ledger, JSON.stringify(snapshot), { mode: 0o600 });
    await assert.rejects(verifyRestore({ directory: f.backup, ledgerFile: f.ledger, outputDirectory: path.join(f.directory, `bad-${label}`) }),
      { code: label === 'stale' ? 'RESTORE_LEDGER_NOT_FRESH' : 'RESTORE_LEDGER_INVALID' });
  }
  await writeFile(f.ledger, JSON.stringify(f.snapshot), { mode: 0o600 });
  await writeFile(path.join(f.backup, 'database.sql'), '\n-- corrupt', { flag: 'a' });
  await assert.rejects(verifyRestore({ directory: f.backup, ledgerFile: f.ledger, outputDirectory: path.join(f.directory, 'bad-checksum') }), { code: 'RESTORE_CHECKSUM_MISMATCH' });
});

test('restore refuses unprotected artifacts and path substitutions', async (t) => {
  const f = await fixture(t);
  await chmod(f.ledger, 0o644);
  await assert.rejects(verifyRestore({ directory: f.backup, ledgerFile: f.ledger, outputDirectory: path.join(f.directory, 'bad-mode') }), { code: 'BACKUP_FILE_UNSAFE' });
  await chmod(f.ledger, 0o600);
  const filename = path.join(f.backup, 'backup.json'); const manifest = JSON.parse(await readFile(filename, 'utf8'));
  manifest.file = '../outside.sql'; await writeFile(filename, JSON.stringify(manifest), { mode: 0o600 });
  await assert.rejects(verifyRestore({ directory: f.backup, ledgerFile: f.ledger, outputDirectory: path.join(f.directory, 'bad-path') }), { code: 'RESTORE_MANIFEST_INVALID' });
});

test('SQLite import cannot attach, write an external file, load extensions or create a virtual module', () => {
  const database = hardenedDatabase(':memory:');
  try {
    assert.throws(() => database.exec("ATTACH DATABASE '/tmp/plause-never-created.sqlite' AS external;"), /not authorized/);
    assert.throws(() => database.exec("SELECT load_extension('untrusted');"), /not authorized/);
    assert.throws(() => database.exec("PRAGMA temp_store_directory='/tmp';"), /not authorized/);
    assert.throws(() => database.exec('CREATE VIRTUAL TABLE x USING fts5(body);'), /not authorized/);
    database.exec("CREATE TABLE allowed(body TEXT); INSERT INTO allowed VALUES('ATTACH DATABASE is ordinary text');");
    assert.equal(database.prepare('SELECT body FROM allowed').get().body, 'ATTACH DATABASE is ordinary text');
  } finally { database.close(); }
});

test('real D1 export forward-reference ordering imports safely but orphaned references still fail', () => {
  const sql = `CREATE TABLE accounts(id TEXT PRIMARY KEY);
    CREATE TABLE auth_sessions(id TEXT PRIMARY KEY,user_id TEXT REFERENCES accounts(id),identity_id TEXT REFERENCES identities(id));
    INSERT INTO accounts VALUES('fixture-user'); INSERT INTO auth_sessions VALUES('fixture-session','fixture-user','fixture-identity');
    CREATE TABLE identities(id TEXT PRIMARY KEY,user_id TEXT REFERENCES accounts(id));
    INSERT INTO identities VALUES('fixture-identity','fixture-user');`;
  const database = hardenedDatabase(':memory:');
  try {
    importSql(database, sql);
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM auth_sessions').get().n, 1);
    assert.equal(Object.values(database.prepare('PRAGMA foreign_keys').get())[0], 1);
  } finally { database.close(); }
  const orphaned = hardenedDatabase(':memory:');
  try { assert.throws(() => importSql(orphaned, sql.replace("INSERT INTO identities VALUES('fixture-identity','fixture-user');", '')), { code: 'BACKUP_FOREIGN_KEYS_INVALID' }); }
  finally { orphaned.close(); }
});

test('ledger validation rejects unexpected personal fields and conflicting opaque erasures', () => {
  const now = Date.now(); const exportedAt = new Date(now).toISOString(); const record = { version: 1, environment: 'local', userId: 'opaque', operationId: 'erase_opaque', requestedAt: now };
  const snapshot = { version: 1, environment: 'local', exportedAt, complete: true, records: [record] };
  for (const records of [[{ ...record, email: 'private@example.com' }], [record, record], [{ ...record, userId: '../escape' }]]) {
    assert.throws(() => validateLedgerSnapshot({ ...snapshot, records }, 'local', exportedAt, now), { code: 'RESTORE_LEDGER_INVALID' });
  }
});

test('CLI entry points reject remote operations or missing independent ledger before any write', async () => {
  await assert.rejects(backupMain(['--remote', '--out', '/tmp/no-write']), { code: 'BACKUP_ARGUMENT_INVALID' });
  await assert.rejects(backupMain(['--out', '/tmp/no-write']), { code: 'BACKUP_USE_LOCAL_AND_NEW_OUTPUT_DIRECTORY' });
  await assert.rejects(restoreMain(['--backup', '/tmp/no-read', '--out', '/tmp/no-write']), { code: 'RESTORE_REQUIRES_BACKUP_FRESH_LEDGER_NEW_OUTPUT' });
});

test('backup and restore CLI entry points execute when invoked through a filesystem alias', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'plause-cli-alias-')); t.after(() => rm(directory, { recursive: true, force: true }));
  for (const name of ['backup.mjs', 'restore-verify.mjs']) {
    const alias = path.join(directory, name); await symlink(path.join(repo, 'scripts', name), alias);
    const result = spawnSync(process.execPath, [alias], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 1); assert.match(result.stderr, /BACKUP_USE_LOCAL|RESTORE_REQUIRES_BACKUP/);
  }
});
