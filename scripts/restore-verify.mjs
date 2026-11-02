import { mkdir, open, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BackupError, digest, hardenedDatabase, importSql, maxSqlBytes, parseOptions, readProtectedFile,
  schemaFingerprint, validateImportedDatabase } from './backup.mjs';

const opaque = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

export function validateLedgerSnapshot(value, expectedEnvironment, backupTime, now = Date.now()) {
  if (!exactKeys(value, ['version', 'environment', 'exportedAt', 'complete', 'records']) || value.version !== 1
    || value.environment !== expectedEnvironment || value.complete !== true || !Array.isArray(value.records) || value.records.length > 100_000) {
    throw new BackupError('RESTORE_LEDGER_INVALID');
  }
  const exported = typeof value.exportedAt === 'string' ? Date.parse(value.exportedAt) : NaN;
  if (!Number.isFinite(exported) || new Date(exported).toISOString() !== value.exportedAt
    || exported < Date.parse(backupTime) || exported < now - 5 * 60_000 || exported > now + 60_000) {
    throw new BackupError('RESTORE_LEDGER_NOT_FRESH');
  }
  const users = new Set(); const operations = new Set();
  for (const record of value.records) {
    if (!exactKeys(record, ['version', 'environment', 'userId', 'operationId', 'requestedAt']) || record.version !== 1
      || record.environment !== expectedEnvironment || typeof record.userId !== 'string' || typeof record.operationId !== 'string'
      || !opaque.test(record.userId) || !opaque.test(record.operationId)
      || !Number.isSafeInteger(record.requestedAt) || record.requestedAt < 0 || record.requestedAt > exported
      || users.has(record.userId) || operations.has(record.operationId)) throw new BackupError('RESTORE_LEDGER_INVALID');
    users.add(record.userId); operations.add(record.operationId);
  }
  return value.records;
}

function tableExists(database, table) { return !!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table); }
function count(database, table, column, userId) {
  return tableExists(database, table) ? database.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column}=?`).get(userId).n : 0;
}
function costSnapshot(database) {
  return {
    model: tableExists(database, 'model_attempts') ? database.prepare("SELECT COUNT(*) AS n,COALESCE(SUM(budget_debit_micro_usd),0) AS debit,COALESCE(SUM(CASE WHEN state!='reserved' THEN budget_debit_micro_usd ELSE 0 END),0) AS held FROM model_attempts").get() : { n: 0, debit: 0, held: 0 },
    search: tableExists(database, 'search_attempts') ? database.prepare('SELECT COUNT(*) AS n FROM search_attempts').get().n : 0,
    google: tableExists(database, 'google_calendar_requests') ? database.prepare('SELECT COUNT(*) AS n,COALESCE(SUM(counted),0) AS counted FROM google_calendar_requests').get() : { n: 0, counted: 0 },
  };
}

/** The artifact stays offline and paused; this does not authorize serving it. */
export function fenceRestoredDatabase(database) {
  for (const table of ['sessions', 'invitations', 'identity_login_states', 'google_oauth_pending', 'channel_link_challenges', 'account_deletion_intents', 'memories']) {
    if (tableExists(database, table)) database.exec(`DELETE FROM ${table};`);
  }
  database.exec("INSERT INTO system_settings(key,value) VALUES('outbound_paused','true') ON CONFLICT(key) DO UPDATE SET value='true';");
  database.exec("INSERT INTO system_settings(key,value) VALUES('restore_locked','true') ON CONFLICT(key) DO UPDATE SET value='true';");
  database.exec(`UPDATE users SET context_revision=context_revision+1,google_calendar_revision=google_calendar_revision+1,
    reminders_revision=reminders_revision+1,actions_revision=actions_revision+1,reminders_enabled=0,memory_enabled=0,
    memory_history_after_sequence=(SELECT COALESCE(MAX(sequence),0) FROM inbox);
    UPDATE conversations SET mode='human',status='closed',ownership_version=ownership_version+1,lease_token=NULL,lease_until=0;
    UPDATE bindings SET status='revoked',revision=revision+1,reply_consent_at=NULL,proactive_consent_at=NULL,
      revoked_at=CAST((julianday('now')-2440587.5)*86400000 AS INTEGER);
    UPDATE inbox SET status='cancelled',last_error='restore_fenced' WHERE status IN('pending','processing');
    UPDATE outbound_jobs SET status=CASE WHEN status='sending' THEN 'delivery_unknown' ELSE 'cancelled' END,
      error_code='restore_fenced' WHERE status IN('queued','retryable_failed','sending');`);
  if (database.prepare("SELECT 1 FROM pragma_table_info('outbound_jobs') WHERE name='provider_request_ciphertext'").get()) {
    database.exec('UPDATE outbound_jobs SET provider_request_ciphertext=NULL;');
  }
  if (tableExists(database, 'google_calendar_connections')) database.exec(`UPDATE google_calendar_connections SET connected=0,status='reauthorization_required',
    access_token_ciphertext=NULL,refresh_token_ciphertext=NULL,refresh_claim_token=NULL,revocation_claim_token=NULL,
    revision=(SELECT google_calendar_revision FROM users WHERE id=user_id);`);
  if (tableExists(database, 'model_attempts')) database.exec(`UPDATE model_attempts SET response_ciphertext=NULL,input_digest='',
    state=CASE WHEN state='completed' THEN 'purged' WHEN state='dispatched' THEN 'unknown' WHEN state='reserved' THEN 'failed' ELSE state END,
    budget_debit_micro_usd=CASE WHEN state='reserved' THEN 0 ELSE budget_debit_micro_usd END,error_code='restore_fenced';`);
  for (const table of ['search_attempts', 'google_calendar_requests']) if (tableExists(database, table)) {
    database.exec(`UPDATE ${table} SET result_ciphertext=NULL,query_digest='',state=CASE WHEN state='completed' THEN 'purged' WHEN state='dispatched' THEN 'unknown' ELSE state END,error_code='restore_fenced';`);
  }
  if (tableExists(database, 'action_approvals')) database.exec("UPDATE action_approvals SET args_ciphertext='',args_hash='',state=CASE WHEN state='pending' THEN 'revoked' ELSE state END;");
  if (tableExists(database, 'google_calendar_approvals')) database.exec("UPDATE google_calendar_approvals SET arguments_ciphertext=NULL,arguments_digest='',state=CASE WHEN state='pending' THEN 'revoked' WHEN state='executing' THEN 'unknown' ELSE state END;");
  if (tableExists(database, 'reminders')) database.exec("UPDATE reminders SET status='cancelled',next_run_at=NULL;");
  if (tableExists(database, 'reminder_occurrences')) database.exec("UPDATE reminder_occurrences SET status='cancelled' WHERE status IN('queued','deferred');");
  if (tableExists(database, 'support_claims')) database.exec('DELETE FROM support_claims;');
  if (tableExists(database, 'messaging_onboarding_notices')) database.exec(`UPDATE messaging_onboarding_notices
    SET status=CASE WHEN status='sending' THEN 'delivery_unknown' WHEN status='pending' THEN 'cancelled' ELSE status END,
      error_code='restore_fenced',user_id=NULL;`);
  if (tableExists(database, 'messaging_onboarding_contacts')) database.exec(`UPDATE messaging_onboarding_contacts
    SET routing_ciphertext=NULL,user_id=NULL,binding_id=NULL,status='revoked',revision=revision+1;`);
  if (tableExists(database, 'messaging_onboarding_subjects')) database.exec(`UPDATE messaging_onboarding_subjects
    SET user_id=NULL,binding_id=NULL,status='revoked';`);
}

function applyRecord(database, record) {
  const now = Date.now();
  database.prepare(`INSERT INTO privacy_operations(id,user_id,environment,ledger_key,state,created_at,updated_at)
    VALUES(?,?,?,?,'recorded',?,?) ON CONFLICT(user_id) DO UPDATE SET state='recorded',updated_at=excluded.updated_at`)
    .run(record.operationId, record.userId, record.environment, `erasures/v1/${record.environment}/${record.userId}.json`, record.requestedAt, now);
  if (tableExists(database, 'mock_receipts')) database.prepare(`DELETE FROM mock_receipts WHERE idempotency_key IN
    (SELECT o.idempotency_key FROM outbound_jobs o JOIN conversations c ON c.id=o.conversation_id WHERE c.user_id=?)`).run(record.userId);
  database.prepare('DELETE FROM users WHERE id=?').run(record.userId);
  database.prepare("UPDATE privacy_operations SET state='completed',completed_at=?,updated_at=? WHERE user_id=?").run(now, now, record.userId);
}

export async function verifyRestore({ directory, ledgerFile, outputDirectory, now = Date.now() }) {
  process.umask(0o077);
  const source = path.resolve(directory); const output = path.resolve(outputDirectory);
  if ((await realpath(ledgerFile)).startsWith((await realpath(source)) + path.sep)) throw new BackupError('RESTORE_LEDGER_MUST_BE_INDEPENDENT');
  const manifest = JSON.parse((await readProtectedFile(path.join(source, 'backup.json'), 32 * 1024)).toString('utf8'));
  if (manifest.version !== 1 || manifest.format !== 'cloudflare-d1-sql' || manifest.environment !== 'local' || manifest.file !== 'database.sql'
    || !/^[0-9a-f]{64}$/.test(manifest.sha256) || !/^[0-9a-f]{64}$/.test(manifest.schemaSha256)
    || !Number.isSafeInteger(manifest.bytes) || manifest.bytes < 1 || manifest.bytes > maxSqlBytes
    || !Number.isFinite(Date.parse(manifest.createdAt)) || manifest.restoreRequiresFreshPrivacyLedger !== true) throw new BackupError('RESTORE_MANIFEST_INVALID');
  const sql = await readProtectedFile(path.join(source, 'database.sql'), maxSqlBytes);
  if (sql.byteLength !== manifest.bytes || digest(sql) !== manifest.sha256) throw new BackupError('RESTORE_CHECKSUM_MISMATCH');
  const snapshot = JSON.parse((await readProtectedFile(path.resolve(ledgerFile), 32 * 1024 * 1024)).toString('utf8'));
  const records = validateLedgerSnapshot(snapshot, manifest.environment, manifest.createdAt, now);
  await mkdir(output, { mode: 0o700 }); // never reuse a database directory
  const filename = path.join(output, 'restored.sqlite'); const created = await open(filename, 'wx', 0o600); await created.close();
  const database = hardenedDatabase(filename);
  let report;
  try {
    importSql(database, sql.toString('utf8'));
    if (schemaFingerprint(database) !== manifest.schemaSha256) throw new BackupError('RESTORE_SCHEMA_MISMATCH');
    for (const table of ['privacy_operations', 'users', 'system_settings', 'inbox', 'outbound_jobs', 'bindings', 'conversations']) {
      if (!tableExists(database, table)) throw new BackupError('RESTORE_SCHEMA_TOO_OLD');
    }
    const cost = costSnapshot(database);
    database.exec('BEGIN IMMEDIATE;');
    try {
      fenceRestoredDatabase(database);
      for (const record of records) applyRecord(database, record);
      // Unknown billing still counts. Releasing never-dispatched reservations
      // can lower debit, but may not delete request rows or any charged holds.
      const after = costSnapshot(database);
      if (after.model.n !== cost.model.n || after.model.debit !== cost.model.held || after.search !== cost.search
        || after.google.n !== cost.google.n || after.google.counted !== cost.google.counted) throw new BackupError('RESTORE_QUOTA_TOMBSTONES_CHANGED');
      for (const record of records) {
        for (const [table, owner] of [['users', 'id'], ['sessions', 'user_id'], ['external_identities', 'user_id'], ['google_calendar_connections', 'user_id'], ['bindings', 'user_id'], ['conversations', 'user_id']]) {
          if (count(database, table, owner, record.userId)) throw new BackupError('RESTORE_ERASURE_INCOMPLETE');
        }
      }
      if (database.prepare('SELECT COUNT(*) AS n FROM sessions').get().n
        || database.prepare('SELECT COUNT(*) AS n FROM conversations WHERE lease_token IS NOT NULL OR lease_until!=0').get().n
        || database.prepare("SELECT value FROM system_settings WHERE key='outbound_paused'").get()?.value !== 'true') throw new BackupError('RESTORE_FENCE_INCOMPLETE');
      validateImportedDatabase(database); database.exec('COMMIT;');
      report = { version: 1, verifiedAt: new Date(now).toISOString(), backupSha256: manifest.sha256, ledgerSha256: digest(JSON.stringify(snapshot)),
        appliedErasures: records.length, outboundPaused: true, restoreLocked: true, sessionsCleared: true, grantsRequireReconnect: true,
        savedMemoryCleared: true, historyReset: true, quotaTombstonesRetained: true, servingAuthorized: false,
        note: 'Offline verification only. Quiesce the old service and replay the live independent ledger again at cutover. Reconcile post-backup billing before any production restore.' };
    } catch (error) { database.exec('ROLLBACK;'); throw error; }
  } finally { database.close(); }
  await writeFile(path.join(output, 'restore-report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  return { database: filename, report };
}

export async function restoreMain(argv = process.argv.slice(2)) {
  const options = parseOptions(argv, ['--backup', '--privacy-ledger', '--out']);
  if (!options['--backup'] || !options['--privacy-ledger'] || !options['--out']) throw new BackupError('RESTORE_REQUIRES_BACKUP_FRESH_LEDGER_NEW_OUTPUT');
  const result = await verifyRestore({ directory: options['--backup'], ledgerFile: options['--privacy-ledger'], outputDirectory: options['--out'] });
  console.log(JSON.stringify({ ok: true, ...result }));
}

if (process.argv[1] && await realpath(path.resolve(process.argv[1])).catch(() => null) === await realpath(fileURLToPath(import.meta.url))) {
  restoreMain().catch((error) => { console.error(JSON.stringify({ ok: false, code: error instanceof BackupError ? error.code : 'RESTORE_FAILED' })); process.exitCode = 1; });
}
