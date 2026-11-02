import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, statSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const script = fileURLToPath(new URL('./configure-search.mjs', import.meta.url));
const fakeKey = 'tvly-fictional-key-never-a-real-credential';
const baseline = '# Preserve\nCONTENT_ENCRYPTION_KEY=fictional-content\nMOCK_WEBHOOK_SECRET=fictional-webhook\nOPERATOR_TOKEN=fictional-operator\nMODEL_PROVIDER=mock\n';
function fixture(run) {
  const directory = mkdtempSync(path.join(tmpdir(), 'plause-search-config-'));
  const config = path.join(directory, '.dev.vars'); const key = path.join(directory, 'key');
  writeFileSync(config, baseline, { mode: 0o600 }); writeFileSync(key, fakeKey, { mode: 0o600 });
  const invoke = (...args) => { const result = spawnSync(process.execPath, [script, '--config', config, ...args], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.error, undefined); assert.ok(!`${result.stdout}${result.stderr}`.includes(fakeKey)); return result; };
  try { run({ directory, config, key, invoke }); } finally { rmSync(directory, { recursive: true, force: true }); }
}
test('research setup requires explicit opt-in and privately preserves unrelated configuration', () => fixture(({ config, key, invoke }) => {
  assert.equal(invoke('--key-file', key).status, 1); assert.equal(readFileSync(config, 'utf8'), baseline);
  assert.equal(invoke('--key-file', key, '--enable').status, 0);
  const enabled = readFileSync(config, 'utf8');
  assert.ok(enabled.includes('MODEL_PROVIDER=mock')); assert.ok(enabled.includes(`TAVILY_API_KEY=${fakeKey}`)); assert.ok(enabled.includes('LIVE_SEARCH_ENABLED=true'));
  assert.equal(statSync(config).mode & 0o777, 0o600);
  assert.equal(invoke('--status').status, 0); assert.equal(readFileSync(config, 'utf8'), enabled);
  assert.equal(invoke('--disabled').status, 0); const disabled = readFileSync(config, 'utf8');
  assert.ok(disabled.includes('LIVE_SEARCH_ENABLED=false')); assert.ok(disabled.includes(`TAVILY_API_KEY=${fakeKey}`));
}));
test('research setup rejects shared/symlinked keys and extra credential lines without writing', () => fixture(({ directory, config, key, invoke }) => {
  chmodSync(key, 0o644); assert.equal(invoke('--key-file', key, '--enable').status, 1);
  chmodSync(key, 0o600); const linked = path.join(directory, 'linked'); symlinkSync(key, linked);
  assert.equal(invoke('--key-file', linked, '--enable').status, 1);
  writeFileSync(key, fakeKey + '\nextra-line'); assert.equal(invoke('--key-file', key, '--enable').status, 1);
  assert.equal(readFileSync(config, 'utf8'), baseline);
}));
test('research setup cannot replace a symlinked configuration or print unknown credential arguments', () => fixture(({ directory, config, key, invoke }) => {
  const target = path.join(directory, 'target'); writeFileSync(target, baseline); rmSync(config); symlinkSync(target, config);
  assert.equal(invoke('--key-file', key, '--enable').status, 1); assert.equal(readFileSync(target, 'utf8'), baseline);
  assert.equal(invoke('--api-key', fakeKey).status, 1);
}));
