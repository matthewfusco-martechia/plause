// Pure Web-standard module shared by Workers and the private Node configuration CLI.
// Never log a parsed keyring: its `key` fields contain secret key material.
const prefix = 'kr1:';
const legacyId = 'legacy-v1';
const maximumKeys = 8;
const invalid = () => new Error('Invalid encryption keyring configuration');

export function validateContentKey(value) {
  if (typeof value !== 'string' || value.length !== 44 || !/^[A-Za-z0-9+/]{43}=$/.test(value)) throw invalid();
  let bytes;
  try { bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0)); } catch { throw invalid(); }
  if (bytes.length !== 32 || btoa(String.fromCharCode(...bytes)) !== value) throw invalid();
  return value;
}

function validId(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 48 && /^[a-z]/.test(value) && !/[^a-z0-9_-]/.test(value);
}

function exactFields(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...expected].sort().join(',');
}

function validated(value) {
  if (!exactFields(value, ['version', 'activeKeyId', 'v1KeyId', 'keys']) || value.version !== 1
    || !validId(value.activeKeyId) || !validId(value.v1KeyId) || !Array.isArray(value.keys)
    || value.keys.length < 1 || value.keys.length > maximumKeys) throw invalid();
  const ids = new Set(); const material = new Set();
  const keys = value.keys.map((entry) => {
    if (!exactFields(entry, ['id', 'key']) || !validId(entry.id)) throw invalid();
    const key = validateContentKey(entry.key);
    if (ids.has(entry.id) || material.has(key)) throw invalid();
    ids.add(entry.id); material.add(key);
    return Object.freeze({ id: entry.id, key });
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (!ids.has(value.activeKeyId) || !ids.has(value.v1KeyId)) throw invalid();
  return Object.freeze({ version: 1, activeKeyId: value.activeKeyId, v1KeyId: value.v1KeyId, keys: Object.freeze(keys) });
}

function encode(value) {
  return btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Accepts the unchanged legacy 32-byte base64 key or the explicit kr1 format. */
export function parseEncryptionKeyring(configuration) {
  if (typeof configuration !== 'string' || configuration.length > 8192) throw invalid();
  if (!configuration.startsWith(prefix)) {
    const key = validateContentKey(configuration);
    return validated({ version: 1, activeKeyId: legacyId, v1KeyId: legacyId, keys: [{ id: legacyId, key }] });
  }
  const encoded = configuration.slice(prefix.length);
  if (!encoded || /[^A-Za-z0-9_-]/.test(encoded)) throw invalid();
  try {
    const decoded = atob(encoded.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - encoded.length % 4) % 4));
    const result = validated(JSON.parse(decoded));
    // Reject duplicate JSON keys, extra whitespace, reordered fields and noncanonical base64url.
    if (encode(result) !== encoded) throw invalid();
    return result;
  } catch { throw invalid(); }
}

export function serializeEncryptionKeyring(keyring) {
  return `${prefix}${encode(validated(keyring))}`;
}

/** Adds a new active key. Existing IDs/material and the original v1 key remain immutable. */
export function rotateEncryptionKeyring(configuration, newKey, newKeyId) {
  const previous = parseEncryptionKeyring(configuration);
  validateContentKey(newKey);
  if (!validId(newKeyId) || previous.keys.length >= maximumKeys
    || previous.keys.some((entry) => entry.id === newKeyId || entry.key === newKey)) throw invalid();
  return serializeEncryptionKeyring({ ...previous, activeKeyId: newKeyId, keys: [...previous.keys, { id: newKeyId, key: newKey }] });
}

/** Safe inventory metadata only. Key IDs are labels, not cryptographic proof of a record. */
export function encryptionKeyringInfo(configuration) {
  const value = parseEncryptionKeyring(configuration);
  return { format: configuration.startsWith(prefix) ? 'keyring' : 'legacy', activeKeyId: value.activeKeyId,
    v1KeyId: value.v1KeyId, keyIds: value.keys.map((entry) => entry.id) };
}

/** Preserve identity-erasure HMAC continuity when the active content key changes. */
export function stableIdentityKeyMaterial(configuration) {
  const value = parseEncryptionKeyring(configuration);
  return value.keys.find((entry) => entry.id === value.v1KeyId).key;
}
