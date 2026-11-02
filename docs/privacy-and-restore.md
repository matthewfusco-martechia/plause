# Account erasure and restore verification

Cloud account erasure has two durable records: a D1 operation and an independent private R2 tombstone. Validating the fresh, single-use destructive intent atomically creates the operation, disables account access, revokes sessions/invitations/bindings and fences conversation leases. The customer receives `pending:true` if independent storage cannot be confirmed. Scheduled recovery retries the same operation even after the original intent expires. Completion is acknowledged only after the independent record is confirmed and the account graph is erased.

`PRIVACY_LEDGER` must bind a separate private R2 bucket for each cloud environment. Each immutable key is `erasures/v1/<environment>/<opaqueUserId>.json`; its strict record contains version, environment, opaque user ID, operation ID and request time. It contains no messages, email, OAuth subject or token. Writes use `If-None-Match: *`; a lost acknowledgement is resolved by reading the same key. R2 confirms strong consistency after successful writes. The application never deletes these records as part of ordinary account erasure or D1 retention. Configure restrictive bucket access and retention/lock policy separately; a compromised operator with bucket deletion rights could defeat this protection. [R2 conditional operations](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/), [R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/).

D1 `privacy_operations` intentionally has no account foreign key. Its completed records survive erasure; triggers prevent the same opaque account ID from being recreated or reactivated. Model/request quota tombstones and possible-charge holds remain. Personalized provider caches and the account's credentials/content are purged. Local erasure remains usable without R2, but that mode makes no independent backup-erasure guarantee. Erasing local token storage does not revoke an external provider grant, remove already-created calendar events, or recall delivered/exported copies.

## Local backup

Use Node 24.10 or later for these tools. The SQLite authorizer is required and blocks attaching other databases, extension loading and arbitrary PRAGMA operations while importing a dump.

```sh
node scripts/backup.mjs --local --out /private/tmp/plause-backup-new
```

For an isolated local test database:

```sh
node scripts/backup.mjs --local --config /path/to/local-wrangler.json --persist-to /path/to/local-state --out /private/tmp/plause-backup-test-new
```

The output directory must not exist. It is created with mode 0700; `database.sql` and `backup.json` use 0600. Export is the actual `wrangler d1 export DB --local` command. Wrangler's export lacks `--persist-to`, so the tool temporarily binds an isolated export configuration to the explicitly selected local state directory, then removes that configuration. It never provisions, deploys or uses `--remote`. The source configuration must identify a local environment. The manifest records the SQL checksum, byte length and actual schema fingerprint. [Official D1 export commands](https://developers.cloudflare.com/d1/wrangler-commands/).

The SQL contains encrypted content and other private database metadata; it is a sensitive artifact, not a publicly shareable file. It excludes environment secrets and the encryption keyring. Securely escrow the **complete keyring** separately, including every key still needed by older ciphertext and the pinned identity-digest key. Checksums detect corruption, not malicious replacement. The restore verifier does not prove ciphertext decryptability without that separately retained keyring.

## Isolated restore check

Obtain a fresh complete privacy-ledger snapshot independently of the old backup. A protected operator export must traverse every R2 page and produce the following exact envelope; each record uses the strict format above:

```json
{"version":1,"environment":"local","exportedAt":"2030-01-01T12:00:00.000Z","complete":true,"records":[]}
```

The example timestamp is illustrative; the tool requires a real export within five minutes and no earlier than the backup. The snapshot file must be 0600 and outside the backup directory. `complete:true` is an operator assertion: the local file alone cannot prove that every current R2 object was included.

```sh
node scripts/restore-verify.mjs --backup /private/tmp/plause-backup-new --privacy-ledger /private/tmp/latest-independent-privacy-ledger.json --out /private/tmp/plause-restore-new
```

This imports only into a **new offline SQLite database**, verifies checksum/schema/integrity, clears sessions and pending login/link flows, removes stale Google token credentials, revokes channel bindings, clears leases and support claims, closes conversations, cancels pending reminders/approvals/outbound work, and sets `restore_locked=true` plus the global outbound pause. In-flight external work stays uncertain. Private provider request caches are cleared when that schema column exists. It clears saved memory and personalized caches and resets the model-history barrier so an old snapshot cannot silently reintroduce forgotten facts into future model requests. Transcripts for retained accounts remain offline historical data; whole-account erasure removes them when replayed.

Every independent erasure is reapplied, including a user ID absent from the older snapshot. The verifier asserts erased accounts, identities, sessions, grants and conversations are absent. Existing charged holds and operation counts survive; never-dispatched model reservations can be released. The JSON report has `servingAuthorized:false`. The tool does not start a Worker or modify an existing local/remote database.

## Cloud cutover requirements

These CLIs verify the local restore mechanics. They do not restore production. A cloud recovery must first quiesce the old service, keep the restored service inaccessible and paused, and replay the **live independent** R2 ledger through `replayPrivacyLedger` until its cursor is null. Listing is strongly consistent per request, not a transactional snapshot of an ongoing multi-page scan; do not permit new erasures behind a cutover cursor. Reapply any pending operations and reconcile provider/quota metadata created after the backup before serving or spending again. A backup alone cannot reconstruct post-backup charges or prove external delivery outcomes.

Fresh identity sign-in, explicit channel linking/consent and Google reconnect are required after restoring a usable environment. Retention of older backup files, key escrow and eventual backup/key destruction must follow the published privacy policy. Do not describe a fixture-tested restore as accepted recovery until the actual isolated cloud database, independent ledger, keyring and maintenance procedure have been exercised.
