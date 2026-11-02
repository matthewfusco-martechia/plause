# Plause operations and acceptance

The code supports local, staging and production configuration. The current preview uses mock providers. No deployment, provider credential validation, Apple enrollment or live delivery is established by local checks. Keep each database and its complete encryption keyring together under separate access control.

## Inspect and contain

`GET /health` reports safe provider configuration. `GET /ready` returns 503 until the selected runtime, encryption, authentication, privacy-ledger and messaging configuration is ready and maintenance is clear. Readiness does not establish API access or delivery. The current local preview does not need cloud credentials.

Cloud operator status/pause/recovery requires a fresh verified admin session, role checks and same-origin mutations. The private bearer token is a local-only development shortcut. Support transcript/reply access additionally requires a leased conversation claim. See [identity and support](identity-and-support.md).

| Operation | Meaning |
| --- | --- |
| `GET /api/operator/status` | Content-free queues/attempts/reminder counts, oldest pending age, pause/restore state, DLQ and provider circuit status. |
| `POST /api/operator/pause` with `{paused:true}` | Stop new model/provider work, scheduling and sends. Accepted external work cannot be recalled. |
| `POST /api/operator/recover` | Republish bounded durable work references; dispatched counts wakeups, not deliveries. |
| `POST /api/operator/pause` with `{paused:false}` | Resume normal durable recovery after investigation. |

If a provider or security incident is suspected, pause, inspect safe classifications and preserve uncertain outcomes before changing credentials or infrastructure. Never recreate a request or reset an attempt to make counters healthy. Unknown model calls retain their conservative charge reservation. Unknown Sunshine sends use a fixed read-only reconciliation request, never another POST. The authenticated web inbox and mock transport have their own durable idempotency guarantees.

Cloud queues are wakeups; D1 owns all accepted work. One-minute cron recovers missed wakeups and due reminders. The configured DLQ has its own consumer that journals only opaque conversation references. Recovery republishes those references through normal leases, consent and unknown-outcome gates. Queue exhaustion cannot erase accepted work. Actual cloud lag, deployment restart and provider/device delivery remain staging/production drills.

Five reviewed provider failures in a rolling minute open a service circuit until sixty seconds after the newest failure. New consequential calls wait/fail safely while privacy controls, cached results and independent provider paths remain available as scoped by their guards. Circuit state has no prompt or provider response body. Model/search/calendar request budgets remain separate hard limits. A circuit is not a refund or proof that an earlier request failed before acceptance.

## Restore and privacy

Account erasure first disables access/work, then records an immutable independent R2 erasure before purging live personalized data. A missing ledger returns pending rather than a false deletion acknowledgment; scheduled recovery completes it. Retained records contain opaque account/operation identifiers and times, without content, email or OAuth subject. Charged/request quota tombstones remain to prevent erasure from resetting allowances.

Use [privacy and restore](privacy-and-restore.md) for the actual CLI contracts. Backup is a quiescent local D1 export to a new private directory. The verifier imports into a new offline database, checks hashes/schema/integrity/foreign keys, fences sessions/bindings/claims/memories/provider caches, replays a separately supplied fresh complete erasure snapshot and verifies retained charge totals. It cannot overwrite a serving or production database. Its artifact remains `restore_locked=true`, outbound paused and `servingAuthorized:false`; there is no online unlock shortcut.

The HTTP E2E includes an actual populated D1 export and offline restoration of a pre-erasure backup. A production cutover still requires the service to stay quiescent, a fresh complete independent ledger scan immediately before review, current revocation/role reconciliation, isolated restore and access tests, then an explicitly authorized deployment/cutover. Offline backups and delivered/exported copies are not erased by a live account transaction. Restored saved memory and personalized model/search/calendar caches are cleared; historic transcripts remain offline until a reviewed retention/access decision.

## Keys, retention and logs

[Encryption rotation](key-rotation.md) provides a protected-file opt-in CLI and versioned keyring. Original v1 ciphertext remains readable only with its retained pinned key. New ring-mode content uses key-ID-authenticated v2 encryption. The CLI never discards keys or rewrites the actual database; inventory and verified re-encryption are prerequisites to retirement. Keep the entire required ring with older backups. Never replace a lost key with a random one and expect recovery.

Scheduled retention clears old encrypted webhook payloads only after work is safely terminal, removes expired login/rate state and old resolved DLQ metadata in bounded batches. Minimal event-ID/hash tombstones, charged/quota ledgers and uncertain holds are preserved. This prevents old vendor retries from becoming new work. Transcript and backup expiry policy, R2 retention controls and contractual provider retention require an actual operating policy and verification.

Cloud configuration enables structured logs/traces with invocation logging disabled and sensitive query-string fields redacted. Application logs use fixed content-free classifications. Do not add cookies, authorization headers, OAuth codes, message text, search results or raw exception/provider bodies. Provision actual alerts for oldest pending work, unknown outcomes, ledger failures, circuit opening and failed cron/DLQ recovery; local counters are not a deployed monitor.

`npm run check`, `npm run test:e2e` and `npm run build` validate the code locally. Real-provider model usefulness/cost, approved Apple policies, proactive consent, staffed coverage, on-device message rendering, production restore/rotation/alerting and browser interaction remain explicit acceptance gates. See [cloud setup](cloud-deployment.md) and [HANDOFF](../HANDOFF.md).
