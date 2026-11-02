import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, statSync, chmodSync, symlinkSync, linkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readVariables } from './configure-model.mjs';

const script = fileURLToPath(new URL('./configure-model.mjs', import.meta.url));
const fakeKey = 'sk-local-fixture-never-a-real-credential';
const initial = '# Keep local setup\nCONTENT_ENCRYPTION_KEY=fictional-content-key\nMOCK_WEBHOOK_SECRET=fictional-webhook\nOPERATOR_TOKEN=fictional-operator\nMODEL_PROVIDER=mock\nLIVE_MODEL_ENABLED=false\n';

function fixture(run) {
  const directory = mkdtempSync(path.join(tmpdir(), 'plause-config-test-'));
  const config = path.join(directory, '.dev.vars');
  const key = path.join(directory, 'key');
  writeFileSync(config, initial, { mode: 0o600 });
  writeFileSync(key, fakeKey, { mode: 0o600 });
  function invoke(...args) {
    const result = spawnSync(process.execPath, [script, '--config', config, ...args], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.error, undefined);
    assert.ok(!`${result.stdout}${result.stderr}`.includes(fakeKey), 'CLI must never print a credential');
    return result;
  }
  try { run({ config, key, directory, invoke }); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}

test('a protected key file requires explicit opt-in and otherwise changes nothing', () => fixture(({ config, key, invoke }) => {
  assert.equal(invoke('--key-file', key).status, 1);
  assert.equal(readFileSync(config, 'utf8'), initial);
}));

test('enabling preserves setup values, removes duplicate owned keys and writes privately', () => fixture(({ config, key, invoke }) => {
  writeFileSync(config, initial + 'MODEL_PROVIDER=other\n');
  assert.equal(invoke('--key-file', key, '--enable').status, 0);
  const source = readFileSync(config, 'utf8');
  assert.ok(source.includes('CONTENT_ENCRYPTION_KEY=fictional-content-key'));
  assert.ok(source.includes('# Keep local setup'));
  assert.equal(source.match(/^MODEL_PROVIDER=/gm).length, 1);
  assert.ok(source.includes('MODEL_PROVIDER=openai'));
  assert.ok(source.includes('LIVE_MODEL_ENABLED=true'));
  assert.ok(source.includes('MODEL_USER_MONTHLY_BUDGET_MICRO_USD=5000000'));
  assert.ok(source.includes(`OPENAI_API_KEY=${fakeKey}`));
  assert.equal(statSync(config).mode & 0o777, 0o600);
}));

test('status is read only and mock mode disables charges while retaining the private key', () => fixture(({ config, key, invoke }) => {
  assert.equal(invoke('--key-file', key, '--enable').status, 0);
  const enabled = readFileSync(config, 'utf8');
  assert.equal(invoke('--status').status, 0);
  assert.equal(readFileSync(config, 'utf8'), enabled);
  assert.equal(invoke('--mock').status, 0);
  const disabled = readFileSync(config, 'utf8');
  assert.ok(disabled.includes('MODEL_PROVIDER=mock'));
  assert.ok(disabled.includes('LIVE_MODEL_ENABLED=false'));
  assert.ok(disabled.includes(`OPENAI_API_KEY=${fakeKey}`));
}));

test('shared and symlinked key files are rejected without writing configuration', () => fixture(({ config, key, directory, invoke }) => {
  chmodSync(key, 0o644);
  assert.equal(invoke('--key-file', key, '--enable').status, 1);
  chmodSync(key, 0o600);
  const linked = path.join(directory, 'linked-key');
  symlinkSync(key, linked);
  assert.equal(invoke('--key-file', linked, '--enable').status, 1);
  assert.equal(readFileSync(config, 'utf8'), initial);
}));

test('a symlinked configuration cannot replace its target', () => fixture(({ config, key, directory, invoke }) => {
  const target = path.join(directory, 'target');
  writeFileSync(target, initial);
  rmSync(config);
  symlinkSync(target, config);
  assert.equal(invoke('--key-file', key, '--enable').status, 1);
  assert.equal(readFileSync(target, 'utf8'), initial);
}));

test('malformed credentials and unknown options do not leak values or modify configuration', () => fixture(({ config, key, invoke }) => {
  writeFileSync(key, `${fakeKey}\nextra-line`);
  assert.equal(invoke('--key-file', key, '--enable').status, 1);
  assert.equal(invoke('--api-key', fakeKey).status, 1);
  assert.equal(readFileSync(config, 'utf8'), initial);
}));

test('store-only saves the key while preserving every unrelated value, comment and nondefault limit', () => fixture(({ config, key, invoke }) => {
  const source = initial + '# Retain chosen limits\nOPENAI_MODEL=previous-selection\nMODEL_MAX_INPUT_TOKENS=2000\nMODEL_USER_MONTHLY_BUDGET_MICRO_USD=1000000\nOTHER_PROVIDER_KEY=keep-this-local-fixture\nOPENAI_API_KEY=old-value\nOPENAI_API_KEY=duplicate-value\n';
  writeFileSync(config, source);
  const result = invoke('--store-only', '--key-file', key);
  assert.equal(result.status, 0);
  const stored = readFileSync(config, 'utf8');
  assert.deepEqual({ ...readVariables(stored) }, { ...readVariables(source), OPENAI_API_KEY: fakeKey });
  assert.equal(stored.match(/^OPENAI_API_KEY=/gm).length, 1);
  assert.ok(stored.includes('# Retain chosen limits'));
  assert.equal(statSync(config).mode & 0o777, 0o600);
  assert.match(result.stdout, /Hosted requests remain disabled/);
  assert.doesNotMatch(result.stdout, /Hosted model configured with explicit local opt-in|Type ENABLE HOSTED AI/);
  const status = invoke('--status');
  assert.equal(status.status, 0);
  assert.match(status.stdout, /Model provider: mock/);
  assert.match(status.stdout, /Hosted requests opted in: no/);
  assert.match(status.stdout, /API key stored: yes \(hidden\)/);
  assert.equal(readFileSync(config, 'utf8'), stored);
}));

test('store-only accurately reports pre-existing hosted opt-in without changing it', () => fixture(({ config, key, invoke }) => {
  const source = initial.replace('MODEL_PROVIDER=mock', 'MODEL_PROVIDER=openai').replace('LIVE_MODEL_ENABLED=false', 'LIVE_MODEL_ENABLED=true');
  writeFileSync(config, source);
  const result = invoke('--key-file', key, '--store-only');
  assert.equal(result.status, 0);
  assert.deepEqual({ ...readVariables(readFileSync(config, 'utf8')) }, { ...readVariables(source), OPENAI_API_KEY: fakeKey });
  assert.match(result.stdout, /already opts in to hosted requests/);
  assert.doesNotMatch(result.stdout, /Hosted requests remain disabled/);
}));

test('store-only rejects enabling, conflicting modes and repeated options before reading a key', () => fixture(({ config, key, invoke }) => {
  for (const args of [
    ['--store-only', '--enable', '--key-file', key], ['--enable', '--store-only'], ['--store-only', '--mock'],
    ['--status', '--store-only'], ['--store-only', '--store-only'], ['--store-only', '--api-key', fakeKey],
  ]) {
    assert.equal(invoke(...args).status, 1);
    assert.equal(readFileSync(config, 'utf8'), initial);
  }
}));

test('store-only requires private single-link regular configuration and key files', () => fixture(({ config, key, directory, invoke }) => {
  chmodSync(config, 0o644);
  assert.equal(invoke('--store-only', '--key-file', key).status, 1);
  assert.equal(readFileSync(config, 'utf8'), initial);
  chmodSync(config, 0o600);
  const configLink = path.join(directory, 'hardlinked-config'); linkSync(config, configLink);
  assert.equal(invoke('--store-only', '--key-file', key).status, 1);
  rmSync(configLink);
  const keyLink = path.join(directory, 'hardlinked-key'); linkSync(key, keyLink);
  assert.equal(invoke('--store-only', '--key-file', key).status, 1);
  rmSync(keyLink);
  chmodSync(key, 0o644);
  assert.equal(invoke('--store-only', '--key-file', key).status, 1);
  chmodSync(key, 0o600);
  const symlink = path.join(directory, 'symlink-key'); symlinkSync(key, symlink);
  assert.equal(invoke('--store-only', '--key-file', symlink).status, 1);
  writeFileSync(key, `${fakeKey}\nsecond-line`);
  assert.equal(invoke('--store-only', '--key-file', key).status, 1);
  assert.equal(readFileSync(config, 'utf8'), initial);
}));

test('store-only defaults to a hidden terminal prompt and never asks to enable or accesses the network', () => fixture(({ config, key }) => {
  const source = `
    import { main } from ${JSON.stringify(pathToFileURL(script).href)};
    import { readFileSync } from 'node:fs';
    let networkCalls = 0;
    globalThis.fetch = () => { networkCalls++; throw new Error('No network access is permitted.'); };
    process.stdin.isTTY = true;
    process.stdout.isTTY = true;
    process.stdin.setRawMode = () => {};
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk, ...args) => {
      const result = write(chunk, ...args);
      if (String(chunk).includes('OpenAI API key (hidden): ')) queueMicrotask(() => {
        process.stdin.emit('keypress', readFileSync(${JSON.stringify(key)}, 'utf8'), {});
        process.stdin.emit('keypress', '', { name: 'return' });
      });
      return result;
    };
    await main(['--config', ${JSON.stringify(config)}, '--store-only']);
    if (networkCalls !== 0) throw new Error('Configuration attempted a network request.');
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!`${result.stdout}${result.stderr}`.includes(fakeKey));
  assert.match(result.stdout, /OpenAI API key \(hidden\):/);
  assert.doesNotMatch(result.stdout, /ENABLE HOSTED AI/);
  assert.deepEqual({ ...readVariables(readFileSync(config, 'utf8')) }, { ...readVariables(initial), OPENAI_API_KEY: fakeKey });
}));

test('store-only nonterminal invocation and help disclose the safe file workflow without modifying configuration', () => fixture(({ config, invoke }) => {
  const result = invoke('--store-only');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires a terminal/);
  assert.match(result.stderr, /--store-only/);
  const help = invoke('--help');
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--store-only --key-file PATH/);
  assert.match(help.stdout, /Existing hosted opt-in flags stay unchanged/);
  assert.equal(readFileSync(config, 'utf8'), initial);
}));
