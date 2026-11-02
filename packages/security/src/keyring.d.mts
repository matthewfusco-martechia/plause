export interface EncryptionKeyring {
  readonly version: 1;
  readonly activeKeyId: string;
  readonly v1KeyId: string;
  readonly keys: readonly { readonly id: string; readonly key: string }[];
}
export function validateContentKey(value: string): string;
export function parseEncryptionKeyring(configuration: string): EncryptionKeyring;
export function serializeEncryptionKeyring(keyring: EncryptionKeyring): string;
export function rotateEncryptionKeyring(configuration: string, newKey: string, newKeyId: string): string;
export function encryptionKeyringInfo(configuration: string): {
  format: 'legacy' | 'keyring'; activeKeyId: string; v1KeyId: string; keyIds: string[];
};
export function stableIdentityKeyMaterial(configuration: string): string;
