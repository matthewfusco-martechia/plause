import { constants, openSync, closeSync, fstatSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { encryptionKeyringInfo, rotateEncryptionKeyring, validateContentKey } from '../packages/security/src/keyring.mjs';
import { readVariables, updateVariables, writeConfiguration } from './configure-model.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const usage = `Prepare Plause content-key rotation in an explicitly selected private configuration.

  node scripts/configure-encryption.mjs --config PATH --status
  node scripts/configure-encryption.mjs --config PATH --key-file PATH --rotate

--key-file must contain one NEW canonical base64-encoded 32-byte key, mode600,
owned by you, regular, and not a symlink. --key-id LABEL optionally names it.
--rotate is explicit opt-in. Existing keys remain available; none are discarded.
No provider request, deployment, database rewrite, or backup is performed.
Stop writers before activation. Separately escrow the FULL keyring and retain
the original v1 key for older records, backups and identity-erasure continuity.
Never pass key material as a command-line argument. --help changes nothing.
`;

function argumentsFor(args) {
  const result = { config: path.join(root, '.dev.vars'), mode: null, keyFile: null, keyId: null };
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const option = args[index];
    if (seen.has(option)) throw new Error('Do not repeat options. Use --help.');
    seen.add(option);
    if (option === '--help') return { ...result, mode: 'help' };
    if (option === '--status' || option === '--rotate') {
      if (result.mode) throw new Error('Choose --status or --rotate.');
      result.mode = option.slice(2);
    } else if (['--config', '--key-file', '--key-id'].includes(option)) {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error('An option value is missing. Use --help.');
      if (option === '--key-id') result.keyId = value;
      else result[option === '--config' ? 'config' : 'keyFile'] = path.resolve(value);
    } else throw new Error('Unsupported option. Never supply key material in arguments. Use --help.');
  }
  if (!result.mode || (result.mode === 'rotate' && !result.keyFile)
    || (result.mode === 'status' && (result.keyFile || result.keyId))) throw new Error('Use --status, or both --key-file and --rotate. No changes were written.');
  return result;
}

function readPrivate(filename, maximum) {
  let descriptor;
  try {
    descriptor = openSync(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > maximum || (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o077)) throw new Error();
    return readFileSync(descriptor, 'utf8');
  } catch { throw new Error('Cannot safely read the private configuration or key file. Require an owned, small regular file, mode600, without symlinks. No secrets were printed.'); }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
}

function configurationValue(source) {
  const count = source.split(/\r?\n/).filter((line) => /^\s*(?:export\s+)?CONTENT_ENCRYPTION_KEY\s*=/.test(line)).length;
  const value = readVariables(source).CONTENT_ENCRYPTION_KEY;
  if (count !== 1 || !value) throw new Error('Configuration must contain exactly one CONTENT_ENCRYPTION_KEY. No changes were written.');
  encryptionKeyringInfo(value);
  return value;
}

export function main(args = process.argv.slice(2)) {
  const options = argumentsFor(args);
  if (options.mode === 'help') { console.log(usage); return; }
  const source = readPrivate(options.config, 65_536);
  const previous = configurationValue(source);
  if (options.mode === 'status') {
    const info = encryptionKeyringInfo(previous);
    console.log(`Content encryption: ${info.format === 'legacy' ? 'legacy v1 key' : 'versioned keyring'}.`);
    console.log(`Retained key count: ${info.keyIds.length}; active key label: ${info.activeKeyId}; original v1 label: ${info.v1KeyId}.`);
    console.log('Configuration inventory only. Ciphertext, database recovery, provider storage and backup decryptability were not verified.');
    return;
  }
  const contents = readPrivate(options.keyFile, 128);
  const key = contents.endsWith('\r\n') ? contents.slice(0, -2) : contents.endsWith('\n') ? contents.slice(0, -1) : contents;
  validateContentKey(key);
  const next = rotateEncryptionKeyring(previous, key, options.keyId ?? `k_${randomUUID().replace(/-/g, '')}`);
  const lock = `${options.config}.plause-key-rotation.lock`;
  let descriptor;
  try {
    try { descriptor = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600); }
    catch { throw new Error('Another rotation or a stale rotation lock exists. Verify no writer is active before removing that lock. No changes were written.'); }
    writeFileSync(descriptor, String(process.pid));
    if (readPrivate(options.config, 65_536) !== source) throw new Error('Configuration changed during rotation. Retry after stopping writers. No changes were written.');
    writeConfiguration(options.config, updateVariables(source, { CONTENT_ENCRYPTION_KEY: next }));
    console.log('Private configuration updated with a new active key and every previous key retained. No keys were printed.');
    console.log('No records were rewritten and no provider was contacted. Escrow the full keyring separately, then explicitly restart/deploy to activate it.');
  } finally {
    if (descriptor !== undefined) { closeSync(descriptor); try { unlinkSync(lock); } catch { /* Never delete a lock we did not acquire. */ } }
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { main(); }
  catch { console.error('Encryption configuration failed. Check --help, private file permissions, key format and retained-key limits. No secrets were printed.'); process.exitCode = 1; }
}
