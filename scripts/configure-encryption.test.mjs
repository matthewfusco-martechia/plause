import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, statSync, chmodSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parseEncryptionKeyring, stableIdentityKeyMaterial } from '../packages/security/src/keyring.mjs';
import { readVariables } from './configure-model.mjs';

const script = fileURLToPath(new URL('./configure-encryption.mjs', import.meta.url));
const actualConfiguration = fileURLToPath(new URL('../.dev.vars', import.meta.url));
const original = Buffer.alloc(32, 21).toString('base64');
const fresh = Buffer.alloc(32, 22).toString('base64');
const initial = `# Preserve all unrelated configuration\nCONTENT_ENCRYPTION_KEY=${original}\nMOCK_WEBHOOK_SECRET=fixture-webhook\nOTHER_PRIVATE_TOKEN=fixture-unrelated-secret\n`;
const hash = (value) => createHash('sha256').update(value).digest('hex');

function fixture(run) {
  // Only compare digests in memory; never print or rewrite the workspace configuration.
  let actualBefore; try { actualBefore = hash(readFileSync(actualConfiguration)); } catch { actualBefore = null; }
  const directory = mkdtempSync(path.join(tmpdir(), 'plause-encryption-test-'));
  const config = path.join(directory, '.dev.vars'); const key = path.join(directory, 'new-key');
  writeFileSync(config, initial, { mode: 0o600 }); writeFileSync(key, `${fresh}\n`, { mode: 0o600 });
  const invoke = (...args) => {
    const result = spawnSync(process.execPath, [script, '--config', config, ...args], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.error, undefined);
    for (const secret of [original, fresh, 'fixture-unrelated-secret']) assert.ok(!`${result.stdout}${result.stderr}`.includes(secret), 'No key or unrelated secret may be printed.');
    return result;
  };
  try { run({ directory, config, key, invoke }); }
  finally {
    rmSync(directory, { recursive: true, force: true });
    let actualAfter; try { actualAfter = hash(readFileSync(actualConfiguration)); } catch { actualAfter = null; }
    assert.equal(actualAfter, actualBefore, 'Fixture commands must never change the actual workspace configuration.');
  }
}

test('rotation requires a protected key file and explicit opt-in; status is read-only', () => fixture(({ config, key, invoke }) => {
  assert.equal(invoke('--key-file', key).status, 1); assert.equal(readFileSync(config, 'utf8'), initial);
  assert.equal(invoke('--rotate').status, 1); assert.equal(readFileSync(config, 'utf8'), initial);
  assert.equal(invoke('--status').status, 0); assert.equal(readFileSync(config, 'utf8'), initial);
  assert.equal(invoke('--status', '--key-file', key).status, 1); assert.equal(readFileSync(config, 'utf8'), initial);
}));

test('private atomic rotation preserves original keys, comments and unrelated secrets', () => fixture(({ config, key, invoke }) => {
  assert.equal(invoke('--key-file', key, '--key-id', 'rotated', '--rotate').status, 0);
  const source = readFileSync(config, 'utf8'); const value = readVariables(source).CONTENT_ENCRYPTION_KEY;
  const ring = parseEncryptionKeyring(value);
  assert.equal(ring.activeKeyId, 'rotated'); assert.equal(ring.v1KeyId, 'legacy-v1');
  assert.deepEqual(ring.keys, [{ id: 'legacy-v1', key: original }, { id: 'rotated', key: fresh }]);
  assert.equal(stableIdentityKeyMaterial(value), original);
  assert.ok(source.includes('# Preserve all unrelated configuration'));
  assert.ok(source.includes('OTHER_PRIVATE_TOKEN=fixture-unrelated-secret'));
  assert.equal(statSync(config).mode & 0o777, 0o600);
  assert.equal(invoke('--status').status, 0); assert.equal(readFileSync(config, 'utf8'), source);
  assert.equal(invoke('--key-file', key, '--key-id', 'other', '--rotate').status, 1);
  assert.equal(readFileSync(config, 'utf8'), source);
}));

test('shared, symlinked and malformed key files fail without changing configuration', () => fixture(({ directory, config, key, invoke }) => {
  chmodSync(key, 0o644); assert.equal(invoke('--key-file', key, '--rotate').status, 1); chmodSync(key, 0o600);
  const linked = path.join(directory, 'linked-key'); symlinkSync(key, linked);
  assert.equal(invoke('--key-file', linked, '--rotate').status, 1);
  writeFileSync(key, `${fresh}\nextra`); assert.equal(invoke('--key-file', key, '--rotate').status, 1);
  assert.equal(readFileSync(config, 'utf8'), initial);
}));

test('shared/symlinked/ambiguous configuration and an existing lock cannot be replaced', () => fixture(({ directory, config, key, invoke }) => {
  chmodSync(config, 0o644); assert.equal(invoke('--key-file', key, '--rotate').status, 1); chmodSync(config, 0o600);
  writeFileSync(config, `${initial}CONTENT_ENCRYPTION_KEY=${fresh}\n`);
  assert.equal(invoke('--key-file', key, '--rotate').status, 1);
  writeFileSync(config, initial);
  writeFileSync(`${config}.plause-key-rotation.lock`, 'fixture-lock', { mode: 0o600 });
  assert.equal(invoke('--key-file', key, '--rotate').status, 1);
  assert.equal(readFileSync(`${config}.plause-key-rotation.lock`, 'utf8'), 'fixture-lock');
  assert.equal(readFileSync(config, 'utf8'), initial);
  rmSync(`${config}.plause-key-rotation.lock`);
  const target = path.join(directory, 'target'); writeFileSync(target, initial, { mode: 0o600 }); rmSync(config); symlinkSync(target, config);
  assert.equal(invoke('--key-file', key, '--rotate').status, 1); assert.equal(readFileSync(target, 'utf8'), initial);
}));

test('unknown options and invalid key labels do not leak secrets or write changes', () => fixture(({ config, key, invoke }) => {
  assert.equal(invoke('--key', fresh).status, 1);
  assert.equal(invoke('--key-file', key, '--key-id', 'invalid\nlabel', '--rotate').status, 1);
  assert.equal(invoke('--config', config, '--status').status, 1);
  assert.equal(readFileSync(config, 'utf8'), initial);
}));
