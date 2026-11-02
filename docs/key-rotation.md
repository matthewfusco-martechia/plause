# Content encryption keys

Plause accepts the existing canonical base64-encoded 32-byte `CONTENT_ENCRYPTION_KEY` and an optional versioned keyring. No workspace key or stored record was rotated by implementing this feature. This is application-managed symmetric encryption with [Workers Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/), not managed KMS or hardware-backed key custody.

## Formats and compatibility

An existing base64 configuration still writes `v1:iv:ciphertext`. Its AES-256-GCM parameters, 96-bit random IV and `plause.content.v1` additional authenticated data are unchanged.

A keyring is `kr1:` followed by canonical unpadded base64url JSON with these exact fields: `version:1`, `activeKeyId`, `v1KeyId`, and `keys:[{id,key}]`. Key material remains secret even though the JSON is encoded. Each key is exactly 32 bytes of canonical base64. IDs contain lowercase ASCII letters, digits, `_` or `-`, begin with a letter, and have at most 48 characters. There are at most 8 keys; duplicate IDs, duplicate key material, unknown fields and noncanonical encoding are rejected.

Keyring mode writes `v2:keyId:iv:ciphertext`. AES-GCM authenticates `plause.content.v2:keyId`, so relabeling the ciphertext does not change which key can authenticate it. Every encryption generates a fresh IV. A v2 read selects exactly its named retained key. A v1 read selects only the key named by `v1KeyId`. Missing keys, invalid envelopes and authentication failures stop the read; there is no trial decryption with other keys.

The original `v1KeyId` is also the stable key used for identity-erasure HMAC continuity. Retain that key and that label. Changing it manually can break older records and the fence that prevents a sign-in started before erasure from recreating an erased account.

## Explicit preparation

Pause writers and coordinate one configuration owner. Make a database backup and separately escrow the complete current encryption configuration using approved private storage. D1 backup artifacts deliberately exclude key material; a successful SQL restore does not establish that ciphertext can be decrypted.

Create a new random 32-byte base64 key in a private regular file owned by you. Never put the key in command arguments or a shared file. The configuration and new key file must have no group/other permissions, normally mode 600.

Inspect an explicitly selected configuration:

```sh
node scripts/configure-encryption.mjs --config /private/path/.dev.vars --status
```

Prepare its next active key:

```sh
node scripts/configure-encryption.mjs --config /private/path/.dev.vars --key-file /private/path/new-content-key --key-id content_2026_11 --rotate
```

The command validates the old configuration and new key, retains every previous key, and replaces only `CONTENT_ENCRYPTION_KEY` in a private atomic file write. Other secrets and comments are preserved. A local lock prevents two instances of this rotation command; stop other configuration writers as well. If a crash leaves its lock, verify no rotation is active before removing it. No key is printed. No provider is contacted, no deployment occurs, and no database row is changed.

Securely escrow the full resulting keyring separately from database backups. Explicitly restart the local service, or update the appropriate environment secret through its approved deployment process, to activate it. Test representative old v1, older v2 and new v2 reads before resuming writers. Keep the full ring in all readers and rollback deployments: reverting to an old single-key configuration cannot read newer ciphertext.

## Bounded record migration primitives

`inspectCiphertext` reports envelope version/key ID without authenticating it. `encryptionKeyringInfo` reports configuration labels/count without returning key material. `needsReencryption` compares a record's envelope with the active configuration; it does not prove successful decryption.

`reencryptText(ciphertext,currentConfiguration,targetConfiguration?)` decrypts one record and returns newly encrypted ciphertext using the target active key. It neither persists nor logs plaintext. Any administrative migration must enumerate a bounded batch, use a compare-and-swap on the original ciphertext, preserve authorization and erasure fences, and retry conflicts by rereading current state. These primitives do not implement a production data-migration job or verify backups.

The CLI never deletes keys. Eight retained keys is a deliberate stop requiring an operator review, not permission to discard old keys. Before retiring any key, inventory every encrypted column and relevant snapshot/backup, complete and verify any necessary migration, and account for the stable identity-erasure key. Losing a retained key can make data permanently unreadable. Rotation of webhook secrets, OAuth credentials or provider-managed keys is a separate operation.
