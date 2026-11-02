import { describe, expect, it } from 'vitest';
import { decryptText, encryptText, encryptionKeyringInfo, inspectCiphertext, needsReencryption,
  parseEncryptionKeyring, reencryptText, rotateEncryptionKeyring, serializeEncryptionKeyring,
  stableIdentityKeyMaterial } from '../packages/security/src/index';

const key = (byte: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(byte)));
const original = key(3); const second = key(4); const third = key(5);
const encoded = (value: unknown) => `kr1:${btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;

describe('versioned content keyring', () => {
  it('preserves legacy base64/v1 reads and writes byte-for-byte envelope compatibility', async () => {
    const ciphertext = await encryptText('Private Unicode 😀\n\uFEFF', original);
    expect(ciphertext).toMatch(/^v1:[A-Za-z0-9+/]+=*:[A-Za-z0-9+/]+=*$/);
    expect(await decryptText(ciphertext, original)).toBe('Private Unicode 😀\n\uFEFF');
    expect(encryptionKeyringInfo(original)).toEqual({ format: 'legacy', activeKeyId: 'legacy-v1', v1KeyId: 'legacy-v1', keyIds: ['legacy-v1'] });
    expect(stableIdentityKeyMaterial(original)).toBe(original);
    // Independently produced with Node AES-256-GCM, fixed fixture IV and original v1 AAD.
    expect(await decryptText('v1:AQEBAQEBAQEBAQEB:291d+updfy58xNV+PFRNtqxnzrFp+8l+z8rcvXq0yh78QSlkJJkvKfZQmsk=', original))
      .toBe('Golden legacy plaintext 😀');
  });

  it('retains old v1 and prior v2 records through two rotations while using only the active key for new writes', async () => {
    const old = await encryptText('Old retained content', original);
    const ring = rotateEncryptionKeyring(original, second, 'current');
    const intermediate = await encryptText('Intermediate content', ring);
    const later = rotateEncryptionKeyring(ring, third, 'newest');
    const fresh = await encryptText('Fresh content', later);
    expect(inspectCiphertext(intermediate)).toEqual({ version: 'v2', keyId: 'current' });
    expect(inspectCiphertext(fresh)).toEqual({ version: 'v2', keyId: 'newest' });
    expect(await decryptText(old, later)).toBe('Old retained content');
    expect(await decryptText(intermediate, later)).toBe('Intermediate content');
    expect(await decryptText(fresh, later)).toBe('Fresh content');
    await expect(decryptText(fresh, ring)).rejects.toThrow('key unavailable');
    expect(stableIdentityKeyMaterial(later)).toBe(original);
    expect(parseEncryptionKeyring(later).keys).toHaveLength(3);
    expect(serializeEncryptionKeyring(parseEncryptionKeyring(later))).toBe(later);
  });

  it('authenticates the key label with AES-GCM additional data, even when renamed metadata selects the same key bytes', async () => {
    const ring = rotateEncryptionKeyring(original, second, 'current');
    const ciphertext = await encryptText('AAD-bound content', ring);
    const renamed = serializeEncryptionKeyring({ version: 1, activeKeyId: 'renamed', v1KeyId: 'legacy-v1',
      keys: [{ id: 'legacy-v1', key: original }, { id: 'renamed', key: second }] });
    await expect(decryptText(ciphertext.replace('v2:current:', 'v2:renamed:'), renamed)).rejects.toThrow();
    await expect(decryptText(ciphertext.replace('v2:current:', 'v1:'), original)).rejects.toThrow();
    await expect(decryptText(ciphertext, second)).rejects.toThrow();
  });

  it('rejects tampered ciphertext, unknown keys, malformed envelopes and never tries another retained key', async () => {
    const ring = rotateEncryptionKeyring(original, second, 'current');
    const ciphertext = await encryptText('Private content', ring);
    const parts = ciphertext.split(':');
    const bytes = Uint8Array.from(atob(parts[3]!), (char) => char.charCodeAt(0)); bytes[0] = bytes[0]! ^ 1;
    await expect(decryptText(`${parts[0]}:${parts[1]}:${parts[2]}:${btoa(String.fromCharCode(...bytes))}`, ring)).rejects.toThrow();
    await expect(decryptText(ciphertext.replace(':current:', ':missing:'), ring)).rejects.toThrow('key unavailable');
    for (const invalid of ['v2:current:AA==:AA==', `${ciphertext}:extra`, ciphertext.replace(':current:', ':current\n:')]) {
      await expect(decryptText(invalid, ring)).rejects.toThrow();
    }
    const old = await encryptText('Original v1 content', original);
    const wrongV1 = serializeEncryptionKeyring({ ...parseEncryptionKeyring(ring), v1KeyId: 'current' });
    await expect(decryptText(old, wrongV1)).rejects.toThrow();
  });

  it('generates fresh v2 IVs and supports per-record re-encryption without changing original ciphertext', async () => {
    const ciphertext = await encryptText('Retained content', original);
    const ring = rotateEncryptionKeyring(original, second, 'current');
    const first = await reencryptText(ciphertext, original, ring);
    const next = await reencryptText(first, ring);
    expect(first).not.toBe(next); expect(first.split(':')[2]).not.toBe(next.split(':')[2]);
    expect(needsReencryption(ciphertext, ring)).toBe(true); expect(needsReencryption(next, ring)).toBe(false);
    expect(await decryptText(next, ring)).toBe('Retained content');
    expect(await decryptText(ciphertext, original)).toBe('Retained content');
  });

  it.each([
    {}, { version: 2, activeKeyId: 'a', v1KeyId: 'a', keys: [{ id: 'a', key: original }] },
    { version: 1, activeKeyId: 'missing', v1KeyId: 'a', keys: [{ id: 'a', key: original }] },
    { version: 1, activeKeyId: 'a', v1KeyId: 'missing', keys: [{ id: 'a', key: original }] },
    { version: 1, activeKeyId: 'a', v1KeyId: 'a', keys: [{ id: 'a', key: original }, { id: 'a', key: second }] },
    { version: 1, activeKeyId: 'a', v1KeyId: 'a', keys: [{ id: 'a', key: original }, { id: 'b', key: original }] },
    { version: 1, activeKeyId: 'a', v1KeyId: 'a', keys: [{ id: 'a', key: 'AA==' }] },
    { version: 1, activeKeyId: 'a\n', v1KeyId: 'a\n', keys: [{ id: 'a\n', key: original }] },
    { version: 1, activeKeyId: 'a', v1KeyId: 'a', keys: [{ id: 'a', key: original }], extra: true },
    { version: 1, activeKeyId: 'a', v1KeyId: 'a', keys: [{ id: 'a', key: original, extra: true }] },
  ])('rejects invalid or ambiguous keyring configuration without exposing key material %j', (value) => {
    expect(() => parseEncryptionKeyring(encoded(value))).toThrow('Invalid encryption keyring');
  });

  it('rejects noncanonical encoding, duplicate JSON fields, key replacement and retained-key overflow', () => {
    const ring = rotateEncryptionKeyring(original, second, 'current');
    expect(() => parseEncryptionKeyring(`${ring}\n`)).toThrow();
    expect(() => parseEncryptionKeyring(`${ring}=`)).toThrow();
    const duplicate = `{"version":1,"version":1,"activeKeyId":"a","v1KeyId":"a","keys":[{"id":"a","key":"${original}"}]}`;
    expect(() => parseEncryptionKeyring(`kr1:${btoa(duplicate).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`)).toThrow();
    expect(() => rotateEncryptionKeyring(ring, third, 'current')).toThrow();
    expect(() => rotateEncryptionKeyring(ring, second, 'other')).toThrow();
    let full = ring;
    for (let index = 0; index < 6; index++) full = rotateEncryptionKeyring(full, key(10 + index), `key_${index}`);
    expect(encryptionKeyringInfo(full).keyIds).toHaveLength(8);
    expect(() => rotateEncryptionKeyring(full, third, 'overflow')).toThrow();
  });
});
