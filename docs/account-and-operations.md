# Account privacy and operations

The account controls manage the current Plause account. Cloud authentication uses verified Google identity and a session cookie; invitations are a local development fixture only. Apple Messages, an MSP, production identity recovery, and real provider delivery remain unverified. A working local account or healthy queue does not establish acceptance of the full product.

## Account views and export

Authenticated customer routes are scoped to the current active account. Writes require a same-origin request. The browser Account panel uses these routes and keeps account controls available if usage loading fails.

| Route | Result |
| --- | --- |
| `GET /api/account` | Account identity and scoped conversation, message, memory, active-reminder, and pending-approval counts. |
| `GET /api/account/export` | First transcript page plus current memory, reminder, and action snapshots. |
| `GET /api/account/export?after=CURSOR` | Next transcript page using the previous `nextCursor`. |
| `GET /api/usage` | The account's current UTC-month model estimates and current UTC-day accepted-chat count. |

An export page contains at most 100 readable transcript messages. Continue until `nextCursor` is `null`. This is a live paginated export: concurrent changes can affect later pages, and control snapshots are included only on the first page. Reminder and action snapshots use their own bounded listing limits. The browser combines pages before downloading and refuses a partial download after an invalid cursor progression or more than 500 pages.

Exported data is readable personal content, including whatever a user entered in a message. Access credentials and retained billing/request tombstones are excluded; this exclusion is not automatic redaction of secrets someone typed into the transcript. Store and share downloaded files deliberately. Server reads recheck active-account scope after asynchronous decryption. Corrupt encrypted content can make an export fail rather than return unverified plaintext or silently omit a record.

## Two-step account erasure

Preparing deletion and executing deletion are separate authenticated actions:

1. `POST /api/account/deletion-intent` requires a freshly confirmed account and the exact `confirmation` phrase `DELETE MY PLAUSE ACCOUNT`. Local invitation accounts can provide `inviteToken`; Google sessions use a completed recent identity confirmation. It returns the deletion effect, expiry, and a new `confirmationToken`.
2. Review that effect, then explicitly send `DELETE /api/account` with `confirmationToken`. The server consumes the token once within five minutes. An invalid, expired, already consumed, or foreign-account token cannot authorize deletion.

The browser displays the returned effect and expiry before exposing a separate permanent-delete button. Preparing the review, refreshing a page, opening Account, or cancelling the review does not erase data. The UI clears the invitation field, drops review tokens when leaving/cancelling, and does not save them in browser storage. A newly prepared intent replaces that account's previous intent. Successful deletion clears the session cookie; database session and invitation records are removed with the account.

Erasure disables account access/work first, then requires an independent R2 erasure record before the gated D1 purge. A cloud ledger outage returns202 pending with access disabled; recovery completes recording/purge before reporting deleted. Local fixtures without R2 make no independent-durability promise. It purges personalized model, search and Google request caches and their input/query digests, removes the account's mock receipts, then deletes the user with cascades through transcripts, saved facts, reminders and occurrences, bindings, sessions, invitations, approvals, simulated calendar data and encrypted Google OAuth grants. Local erasure does not revoke a Google provider grant or remove real events; disconnect first to request revocation, or revoke access through Google settings. It does not need to decrypt personal content, so corruption cannot prevent erasure. A scoped token gate prevents another account or a concurrent replay from applying the transaction again. Inflight completion cannot recreate cached personal content for a deleted source account.

Some request/accounting metadata deliberately survives in model and search attempt tombstones: opaque record/user/conversation IDs, timestamps, request state, token/cost metadata where applicable, and safe error codes. They do not retain the erased cached answer/search result or its input/query digest. A model reservation never dispatched is released; an attempt that may have reached the provider retains its possible-charge hold. Deletion must not refund a possible charge against the service budget. This implementation does not provide an automatic tombstone-retention expiry policy.

Erasure does not recall delivered messages, downloaded exports, or content already submitted to an external service. The current implementation only controls its local data and mocks; it does not establish a production data-deletion agreement with a provider. Erasure tombstones prevent recreation/reactivation of the same opaque account ID, including fixture provisioning. A fresh Google signup can create a different account after a new explicit flow; old callbacks cannot resurrect the erased account.

## Usage estimates

The usage route returns only the signed-in user's model attempts, recorded input/output tokens, debits, uncertain holds, and remaining application allowance. Global spend is exposed to customers only as a service-budget-available flag. Accepted ordinary chat is counted per UTC day; deterministic personal-control commands are excluded from that chat quota.

The model ledger is an application estimate, not an invoice. Current defaults are US$5 per user per UTC month and US$50 across the service per UTC month, configurable within the supported model policy. Values are reported in micro-USD: 1,000,000 units equal US$1. Default token caps are 4,096 input and 600 output, with a 20-second adapter deadline. See [hosted model](hosted-model.md) for configuration and the rate policy.

Worst-case request cost is reserved before dispatch. A known non-billable failure releases its reservation; a timeout, network interruption, or crash after possible generation keeps it held. A recovery sweep does not authorize another paid generation for that input. Do not manually zero uncertain debits or delete tombstones to clear a budget block. There is no automatic provider-invoice reconciliation or customer hold-release endpoint in this milestone.

## Operator runbook

Run local setup and the development server with `npm run setup` and `npm run dev`. The server reads secrets from the private `.dev.vars` file. Keep it and `.local/invitations.json` outside source control; do not print their contents into logs, tickets, screenshots, or status reports. Preserve the existing content key when applying migrations to an existing database.

Local operator routes accept the independent `Authorization: Bearer <OPERATOR_TOKEN>` credential. Cloud requires a fresh verified admin session and durable role. A customer session cookie does not grant operator access. Use an authenticated local HTTP client without embedding the token in a committed script.

| Request | Purpose and interpretation |
| --- | --- |
| `GET /health` | Provider/configuration readiness and safe Apple configuration state; no delivery proof. |
| `GET /api/operator/status` | Content-free aggregate inbox/outbox/model/reminder states, outbound pause flag, and oldest pending inbox age. |
| `POST /api/operator/recover` | Run the durable sweep; returned `dispatched` counts successful conversation wakeups, not deliveries. |
| `POST /api/operator/pause` with `{"paused":true}` | Stop new scheduling/dispatch while preserving durable work. |
| `POST /api/operator/pause` with `{"paused":false}` | Clear pause and request recovery. |

The development wrapper wakes the local scheduled endpoint about two seconds after startup and every 15 seconds thereafter, only after confirming a local Plause mock-messaging health response. Due tasks and deduplication remain in D1. The recovery sweep scans up to 100 due reminders and wakes up to 50 eligible conversations per pass. Queue wakeup failures leave work durable for a later pass. A stopped computer or server cannot deliver local reminders; restart and inspect expiry/status rather than claiming uninterrupted service.

For stalled work:

1. Check health, global pause, account/channel eligibility, conversation support mode, and current task settings. A deliberate human handoff or closed channel is not a queue failure.
2. Inspect aggregate status and the user's scoped conversation/reminder views. Quiet-hour deferrals and future retry times are expected waits. Expired or cancelled work must not be recreated as a fresh send automatically.
3. Request one recovery sweep, then inspect state again. A `delivery_unknown` send is reconciled by its existing idempotency key. An adapter without verified durable idempotency must not blindly resend it. Cancellation cannot promise recall of an already accepted message.
4. For unreadable content, preserve the database and matching encryption key. List/export may fail closed while metadata-only privacy controls and account erasure remain usable. Key replacement does not repair old ciphertext.
5. For an uncertain model charge or held budget, preserve the attempt metadata for investigation; a new user message is a new possible paid request. Operator counters do not prove provider billing accuracy.

Automated tests exercise local tenant isolation, exports, reauthentication, expiry/single-use tokens, atomic cascades and cache purges, usage scoping, and independent operator authorization. Live provider acceptance, production authentication/access/recovery drills, staffing and human support operations, deployment reliability, and browser visual/interaction acceptance remain separate gates.

Implementation: [account controls](../apps/api/src/account.ts), [operations](../apps/api/src/operations.ts), [HTTP routes](../apps/api/src/index.ts), [local scheduler wrapper](../scripts/wrangler.mjs), [account tests](../tests/account.test.ts), and [operations tests](../tests/operations.test.ts). See also [local console](local-console.md), [reminders](reminders.md), and [Apple approval checklist](apple-approval-checklist.md).


## Expanded identity, support and operational contracts

The current [identity/support guide](identity-and-support.md), [operations runbook](operations-runbook.md), [privacy and restore verifier](privacy-and-restore.md), and [keyring guide](key-rotation.md) supersede earlier local-only operational descriptions. Cloud operator access uses a fresh admin session and role; support transcripts/replies require a leased claim and current provider control. A global bearer token is local only. Production restoration is an offline, locked review process; no automatic cutover or online unlock endpoint exists. Actual cloud/provider/device acceptance remains unverified.
