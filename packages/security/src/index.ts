import { parseEncryptionKeyring, encryptionKeyringInfo } from './keyring.mjs';
export { validateContentKey, parseEncryptionKeyring, serializeEncryptionKeyring, rotateEncryptionKeyring,
  encryptionKeyringInfo, stableIdentityKeyMaterial, type EncryptionKeyring } from './keyring.mjs';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const encryptionLabel = encoder.encode('plause.content.v1');
const replayWindowSeconds = 300;

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, '0')).join('');
}

function toBase64(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, (value) => String.fromCharCode(value)).join(''));
}

function fromBase64(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('Invalid base64 encoding');
  }
  const decoded = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  if (toBase64(decoded) !== value) throw new Error('Noncanonical base64 encoding');
  return decoded;
}

async function encryptionKey(base64Key: string): Promise<CryptoKey> {
  const bytes = fromBase64(base64Key);
  if (bytes.byteLength !== 32) throw new Error('CONTENT_ENCRYPTION_KEY must encode exactly 32 bytes');
  return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  if (!secret) throw new Error('Webhook secret must not be empty');
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

/** Digest identifiers/tokens without retaining their plaintext. Not a password KDF. */
export async function sha256(text: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
}

/** 256 random bits, encoded without URL-unsafe characters or padding. */
export function randomToken(): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(32))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Versioned authenticated ciphertext. Every call generates a new 96-bit IV. */
export async function encryptText(plaintext: string, base64Key: string): Promise<string> {
  const configuration = parseEncryptionKeyring(base64Key);
  const version = base64Key.startsWith('kr1:') ? 'v2' : 'v1';
  const keyId = configuration.activeKeyId;
  const key = await encryptionKey(configuration.keys.find((entry) => entry.id === keyId)!.key);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: version === 'v1' ? encryptionLabel : encoder.encode(`plause.content.v2:${keyId}`), tagLength: 128 },
    key,
    encoder.encode(plaintext),
  );
  return `${version}:${version === 'v2' ? `${keyId}:` : ''}${toBase64(iv)}:${toBase64(new Uint8Array(ciphertext))}`;
}

function envelope(ciphertext: string) {
  const parts = ciphertext.split(':');
  const v1 = parts.length === 3 && parts[0] === 'v1';
  const v2 = parts.length === 4 && parts[0] === 'v2' && !!parts[1] && parts[1].length <= 48
    && /^[a-z]/.test(parts[1]) && !/[^a-z0-9_-]/.test(parts[1]);
  if ((!v1 && !v2) || !parts[v1 ? 1 : 2] || !parts[v1 ? 2 : 3]) {
    throw new Error('Invalid encrypted content envelope');
  }
  const iv = fromBase64(parts[v1 ? 1 : 2]!);
  const bytes = fromBase64(parts[v1 ? 2 : 3]!);
  if (iv.byteLength !== 12 || bytes.byteLength < 16) throw new Error('Invalid encrypted content envelope');
  return { version: v1 ? 'v1' as const : 'v2' as const, keyId: v1 ? null : parts[1]!, iv, bytes };
}

/** Envelope inventory is unauthenticated until decryptText succeeds. */
export function inspectCiphertext(ciphertext: string): { version: 'v1' | 'v2'; keyId: string | null } {
  const value = envelope(ciphertext);
  return { version: value.version, keyId: value.keyId };
}

export async function decryptText(ciphertext: string, base64Key: string): Promise<string> {
  const value = envelope(ciphertext);
  const configuration = parseEncryptionKeyring(base64Key);
  const keyId = value.version === 'v1' ? configuration.v1KeyId : value.keyId;
  const material = configuration.keys.find((entry) => entry.id === keyId);
  if (!material || value.version === 'v2' && !base64Key.startsWith('kr1:')) throw new Error('Encrypted content key unavailable');
  const key = await encryptionKey(material.key);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: value.iv, additionalData: value.version === 'v1' ? encryptionLabel : encoder.encode(`plause.content.v2:${keyId}`), tagLength: 128 },
    key,
    value.bytes,
  );
  return decoder.decode(plaintext);
}

/** Re-encrypt one record in memory. The caller must persist with its own ciphertext CAS. */
export async function reencryptText(ciphertext: string, currentConfiguration: string, targetConfiguration = currentConfiguration): Promise<string> {
  return encryptText(await decryptText(ciphertext, currentConfiguration), targetConfiguration);
}

export function needsReencryption(ciphertext: string, configuration: string): boolean {
  const value = inspectCiphertext(ciphertext); const keys = encryptionKeyringInfo(configuration);
  return keys.format === 'keyring' ? value.version !== 'v2' || value.keyId !== keys.activeKeyId : value.version !== 'v1';
}

/** The following signature format is Plause's mock protocol, not an MSP contract. */
export async function signWebhook(rawBody: string, secret: string, timestamp = Math.floor(Date.now() / 1000)): Promise<string> {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error('Invalid webhook timestamp');
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(`${timestamp}.${rawBody}`));
  return `t=${timestamp},v1=${toHex(signature)}`;
}

export async function verifyWebhook(rawBody: string, header: string | null, secret: string, nowSeconds = Math.floor(Date.now() / 1000)): Promise<boolean> {
  if (!header || !secret || !Number.isSafeInteger(nowSeconds) || nowSeconds < 0) return false;
  // Exactly one timestamp and one digest; reject duplicate fields, unknown fields,
  // reordered fields, whitespace, noncanonical timestamps and trailing bytes.
  const match = /^t=(0|[1-9][0-9]{0,15}),v1=([a-f0-9]{64})$/.exec(header);
  if (!match?.[1] || !match[2] || match[0] !== header) return false;
  const timestamp = Number(match[1]);
  if (!Number.isSafeInteger(timestamp) || Math.abs(nowSeconds - timestamp) > replayWindowSeconds) return false;
  const signature = Uint8Array.from(match[2].match(/../g)!, (pair) => Number.parseInt(pair, 16));
  return crypto.subtle.verify('HMAC', await hmacKey(secret), signature, encoder.encode(`${match[1]}.${rawBody}`));
}

let comparisonKey: Promise<CryptoKey> | undefined;

/** Use Web Crypto's signature verification rather than a JS secret-string comparison. */
export async function equalSecret(a: string, b: string): Promise<boolean> {
  comparisonKey ??= crypto.subtle.importKey(
    'raw',
    crypto.getRandomValues(new Uint8Array(32)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
  const key = await comparisonKey;
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(a));
  return crypto.subtle.verify('HMAC', key, signature, encoder.encode(b));
}
