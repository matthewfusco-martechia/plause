import { describe, expect, it } from 'vitest';
import {
  decryptText,
  encryptText,
  equalSecret,
  randomToken,
  sha256,
  signWebhook,
  verifyWebhook,
} from '../packages/security/src/index';

const encryptionKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const differentKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(8)));

describe('content encryption', () => {
  it.each(['', 'Private Unicode: 😀 café\nsecond line', '\uFEFFKeep the leading BOM'])('round-trips the complete plaintext %j', async (plaintext) => {
    expect(await decryptText(await encryptText(plaintext, encryptionKey), encryptionKey)).toBe(plaintext);
  });

  it('generates a fresh IV and ciphertext for identical plaintext', async () => {
    const first = await encryptText('same secret', encryptionKey);
    const second = await encryptText('same secret', encryptionKey);
    expect(first.split(':')[1]).not.toBe(second.split(':')[1]);
    expect(first).not.toBe(second);
    expect(await decryptText(first, encryptionKey)).toBe('same secret');
    expect(await decryptText(second, encryptionKey)).toBe('same secret');
  });

  it('rejects ciphertext tampering and the wrong encryption key', async () => {
    const encrypted = await encryptText('private fact', encryptionKey);
    const [version, iv, payload] = encrypted.split(':');
    const bytes = Uint8Array.from(atob(payload!), (character) => character.charCodeAt(0));
    bytes[0] = bytes[0]! ^ 1;
    const tamperedPayload = btoa(String.fromCharCode(...bytes));
    await expect(decryptText(`${version}:${iv}:${tamperedPayload}`, encryptionKey)).rejects.toThrow();
    await expect(decryptText(encrypted, differentKey)).rejects.toThrow();
  });

  it.each([
    '',
    'AA==',
    btoa(String.fromCharCode(...new Uint8Array(16))),
    btoa(String.fromCharCode(...new Uint8Array(24))),
    `${encryptionKey}\n`,
    encryptionKey.slice(0, -1),
    '!!!',
  ])('rejects malformed or non-256-bit keys %j', async (key) => {
    await expect(encryptText('private fact', key)).rejects.toThrow();
  });

  it.each(['', 'v2:AA==:AA==', 'v1:AA==:AA==', 'v1:AAAA:AAAA', 'v1:AA==:AA==:extra'])('rejects an invalid encryption envelope %j', async (ciphertext) => {
    await expect(decryptText(ciphertext, encryptionKey)).rejects.toThrow();
  });
});

describe('mock webhook authentication', () => {
  const timestamp = 1_000_000;
  const secret = 'test-webhook-secret';
  const rawBody = '{"text":"hello", "sequence":1}';

  it('authenticates the exact raw body, not an equivalent parsed JSON value', async () => {
    const signature = await signWebhook(rawBody, secret, timestamp);
    expect(await verifyWebhook(rawBody, signature, secret, timestamp)).toBe(true);
    expect(await verifyWebhook(JSON.stringify(JSON.parse(rawBody)), signature, secret, timestamp)).toBe(false);
    expect(await verifyWebhook(`${rawBody}\n`, signature, secret, timestamp)).toBe(false);
    expect(await verifyWebhook(rawBody, signature, 'wrong secret', timestamp)).toBe(false);
  });

  it.each([-300, 0, 300])('accepts a timestamp offset of %i seconds', async (offset) => {
    const signature = await signWebhook(rawBody, secret, timestamp + offset);
    expect(await verifyWebhook(rawBody, signature, secret, timestamp)).toBe(true);
  });

  it.each([-301, 301])('rejects a timestamp offset of %i seconds', async (offset) => {
    const signature = await signWebhook(rawBody, secret, timestamp + offset);
    expect(await verifyWebhook(rawBody, signature, secret, timestamp)).toBe(false);
  });

  it('strictly rejects malformed, duplicated and noncanonical header fields', async () => {
    const signature = await signWebhook(rawBody, secret, timestamp);
    const digest = signature.split('v1=')[1]!;
    const invalidHeaders = [
      null,
      '',
      `${signature}\n`,
      `${signature}\r\n`,
      `${signature},t=${timestamp}`,
      `${signature},v1=${digest}`,
      `${signature},extra=x`,
      `v1=${digest},t=${timestamp}`,
      `t=0${timestamp},v1=${digest}`,
      `t=-${timestamp},v1=${digest}`,
      `t=${timestamp}.0,v1=${digest}`,
      `t=${timestamp}, v1=${digest}`,
      `t=${timestamp},v1=${digest.toUpperCase()}`,
      `t=${timestamp},v1=${digest.slice(0, -1)}`,
      `t=${timestamp},v1=${'g'.repeat(64)}`,
    ];
    for (const header of invalidHeaders) {
      expect(await verifyWebhook(rawBody, header, secret, timestamp), String(header)).toBe(false);
    }
  });

  it('fails closed for empty secrets and invalid server timestamps', async () => {
    const signature = await signWebhook(rawBody, secret, timestamp);
    expect(await verifyWebhook(rawBody, signature, '', timestamp)).toBe(false);
    expect(await verifyWebhook(rawBody, signature, secret, Number.NaN)).toBe(false);
    expect(await verifyWebhook(rawBody, signature, secret, Number.MAX_SAFE_INTEGER + 1)).toBe(false);
    await expect(signWebhook(rawBody, '', timestamp)).rejects.toThrow();
    await expect(signWebhook(rawBody, secret, 1.5)).rejects.toThrow();
  });
});

describe('opaque tokens and secret comparison', () => {
  it('computes the known SHA-256 digest', async () => {
    expect(await sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('returns independently generated URL-safe 256-bit tokens', () => {
    const tokens = Array.from({ length: 32 }, () => randomToken());
    expect(new Set(tokens).size).toBe(tokens.length);
    for (const token of tokens) expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('compares complete secret values including empty and Unicode strings', async () => {
    for (const value of ['', 'test-secret', '😀']) expect(await equalSecret(value, value)).toBe(true);
    expect(await equalSecret('test-secret', 'test-secreu')).toBe(false);
    expect(await equalSecret('test-secret', 'test-secret-extra')).toBe(false);
    expect(await equalSecret('', 'test-secret')).toBe(false);
  });
});
