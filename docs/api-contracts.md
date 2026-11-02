# Plause API contracts

Application traffic supports validated local, staging and production runtimes. Local uses loopback origins and fictional invitation fixtures; cloud uses an explicit HTTPS PUBLIC_ORIGIN and verified Google identity. Production rejects mock inference/messaging. The Sunshine adapter requires explicit approved-channel configuration; authenticated web is the fallback before Apple activation. No cloud deployment or live provider acceptance has occurred.

Ordinary hosted messages require a configured model/key/bounds. Deterministic controls, privacy/export/sign-out and independent provider paths remain available as scoped by their own guards. Unsafe browser requests require the same Origin. See the cloud identity/transport/staff additions below and [identity/support](identity-and-support.md).

## Account and development conversation

| Method | Route | Contract |
| --- | --- | --- |
| GET | `/health` | Product, environment, model/readiness fields below, messaging mode, safe `apple` configuration flags (not live acceptance); no credentials |
| POST | `/api/session` | JSON `{inviteToken}`. Local-only. Creates HttpOnly/SameSite Strict cookie; returns `{user,conversationId,authentication}` |
| GET | `/api/me` | Cookie required. Returns `{user,conversationId,authentication}` |
| DELETE | `/api/session` | Cookie and same Origin required. Revokes session and clears cookie |
| GET | `/api/memories` | Cookie-scoped `{enabled,revision,memories:[{id,text,createdAt,updatedAt}]}`; also available while memory is off |
| GET | `/api/memories/export` | Cookie-scoped JSON attachment `{version:1,enabled,memories}`; facts have the same fields as the list response |
| GET | `/api/reminders` | Cookie-scoped schedules, status, notification setting, timezone and quiet hours; see reminder guide |
| GET | `/api/actions` | Cookie-scoped calendar connection, exact approvals and bounded event records |
| GET | `/api/calendar/google` | Cookie-scoped metadata, readiness, grant revision and unresolved revocation fence; no refresh or token disclosure |
| POST | `/api/calendar/google/connect` | Exact configured public origin and active account session; returns a Google consent URL and private short-lived callback proof cookie; does not grant access itself |
| GET | `/api/calendar/google/callback` | One-use state/browser/original-session/PKCE proof; fixed callback, encrypted grant persistence, safe redirect that strips the code |
| DELETE | `/api/calendar/google` | Revoke local grant first, reset future AI context and cancel older automatic replies, then best-effort provider revocation; unknown revocation blocks reconnect |
| GET | `/api/calendar/google/actions` | Cookie-scoped exact Google approvals and request states, with post-decryption privacy checks |
| GET | `/api/usage` | Cookie-scoped conservative estimated model spend, held debits, chat/search limits; no other user's data |
| GET | `/api/account` | Cookie-scoped account summary and counts |
| GET | `/api/account/export?after=<rowid>` | Readable paginated archive, 100 messages/page; follow `nextCursor` until null; live export rather than transactional snapshot |
| POST | `/api/account/deletion-intent` | Fresh verified confirmation (local invitation allowed only locally) plus exact phrase; returns a five-minute one-use token and effect text |
| DELETE | `/api/account` | Same-origin cookie plus exact confirmation token; pending-safe independent-ledger recording and private-content purge; cookie cleared, accounting tombstones retained |
| GET | `/api/conversations/:id` | Cookie and account ownership required. Latest 100 decrypted messages and current mode/status; per-message `model` and `inReplyTo` retain provenance and turn relationships |
| POST | `/api/conversations/:id/messages` | Own web conversation only. JSON `{text,clientMessageId}`; client ID must be UUID and stable across retries. Returns durable acceptance, not a synchronous AI response |
| POST | `/api/conversations/:id/handoff` | Own conversation. JSON `{mode:"human"}` or `{mode:"bot"}`. Resume is local operator simulation only |

State-changing cookie routes require the exact same-origin `Origin` header. Bodies are JSON, bounded to 20KB; text is bounded to 4,000 characters. Unknown conversation IDs and other users' conversation IDs return the same 404. Browser text is rendered as text, not HTML.

Health includes `model: "mock"|"openai"`, `modelName`, `modelReady`, `modelStatus: "mock"|"configured"|"not_configured"`, and an optional safe `readinessError`. An unsupported configured provider can be reported as not configured; application traffic then fails closed. `modelReady:true` establishes valid local configuration only; it does not verify API access, billing, model usefulness, or any Apple connection. Missing hosted opt-in/key or invalid bounds returns 503 for ordinary conversation acceptance; authenticated transcript, memory/support controls, export, and sign-out remain available.

A conversation response contains `{id,mode,channel,status,ownershipVersion,messages}`. Each message contains `{id,role,text,status,createdAt,model,inReplyTo}`. Provenance identifies `mock`, the hosted model, or deterministic `plause-*` memory/reminder/action/research/Google/status replies. `inReplyTo` links each reply to its input. A terminal failure produces one fixed classified status reply under the same ownership/privacy fences and marks the source `failed`; unknown provider acceptance never implies no charge or authorizes automatic retry.

## Saved memory controls

Use the existing message-ingress routes with complete commands such as `remember: <fact>`, `memories`, `update memory <mem_UUID>: <fact>`, `forget memory <mem_UUID>`, `forget all memories`, `disable memory`, `enable memory`, and `memory help`. See [saved memory](saved-memory.md) for exact grammar and limits. There is no model tool or public arbitrary-JSON mutation endpoint for facts.

The event, memory change, account revision, pending-work cancellation, and deterministic acknowledgment commit in the same database transaction. Stable event/logical message IDs suppress repeat mutations. Optimistic revision checks reject conflicting snapshots rather than overwriting a concurrent privacy change. Controls bypass the ordinary daily chat quota and require no model budget/key. The 10-fact storage limit still applies to new saves; privacy controls remain available at capacity.

The off state retains facts but blocks save/edit and excludes them from model context. List/export/forget remain available. Effective changes cancel older pending work across all user channels and fence in-flight model/send paths. Edit/forget/off/on also reset future history; save preserves completed recent context. Control turns are excluded from model history. While human mode is active, control acknowledgments are recorded as `local_only` without sending an automated reply or returning to bot mode.

Help, forget, update, forget-all, and settings controls can use owned fact metadata without decrypting every saved value, so a corrupted fact cannot lock the user out of correcting/removing it or disabling memory. List/export/model-context reads still fail closed on bad ciphertext until the affected value is corrected or erased. An older send with an unknown outcome stays recorded as uncertain; it is not resent under a new memory revision and does not block a fresh control acknowledgment.

Export uses `Content-Disposition: attachment; filename="plause-memory.json"` and contains readable fact text; no caller-supplied user ID can select another account. Export is a saved-fact snapshot, not complete account deletion or a transcript archive. The original command and previously delivered messages remain in the transcript after memory changes.

## Mock messaging provider

`POST /webhooks/messaging/mock` accepts the versioned event union in `packages/contracts/src/index.ts`. It permits enrolled mock subjects only. The fake external customer identifier is scoped by provider, business and subject; request data cannot select an internal user ID.

`X-Plause-Signature` has the mock-only format `t=<unix seconds>,v1=<HMAC-SHA256 hex>`, signing `${timestamp}.${raw_body}` using `MOCK_WEBHOOK_SECRET`. The signature is checked before JSON parsing. The allowed clock difference is 300 seconds. This is not an invented Apple/MSP signature format: the implemented Sunshine adapter uses its separate documented shared X-API-Key contract.

Supported event types: `message.received`, `delivery.updated`, `conversation.closed`, `handoff.requested`. The same provider event ID with different semantic content returns 409. Repeated logical message IDs do not create additional agent turns. Customer reinitiation can reopen a closed conversation; it does not automatically end human ownership.

Successful ingress returns 202 and `{eventId,conversationId,duplicate}` after the event and pending work commit. A queue wakeup failure does not erase accepted work. Polling the scoped conversation reveals processing and delivery results.

## Operator

Local operator endpoints accept `Authorization: Bearer <OPERATOR_TOKEN>`, independent of account cookies. In staging/production, an active fresh Google-authenticated admin session is required instead, with same-origin mutations; bearer tokens cannot grant cloud operator access. Keep the token in `.dev.vars`; do not put it in a URL or browser storage.

- `POST /api/operator/recover`: scan durable pending work and publish queue wakeups. Returns `{dispatched}`.
- `GET /api/operator/status`: aggregate inbox/outbox/reminder/model counts, oldest pending age and pause state; no message content or credentials.
- `POST /api/operator/pause` with JSON `{paused:true|false}`: persist global outbound pause and its audit record. Resume requests a recovery sweep. A pause cannot recall an already accepted external send.

## Work processing

Queue messages are `{kind:"conversation",conversationId}`. The processor claims a bounded lease, drains ordered input/output, and checks ownership/version/status before consequential commits. A scheduled handler republishes recoverable work references if publication or processing was interrupted. Hosted calls reserve user/global budget atomically and recheck durable authorization before billable generation. Completed encrypted model output can recover an interruption before the reply/outbox commit; a dispatched attempt is not automatically generated again.

`delivery_unknown` never means confirmed failure. The mock has a durable idempotency guarantee and can safely retry a missing receipt with the same logical key. Adapters without that verified capability keep uncertain outcomes pending reconciliation. The mock also atomically checks the exact lease and attempt tokens at receipt creation, enabling failure tests without making promises about a future external provider.

Model-charge uncertainty is separate from messaging-delivery uncertainty. Hosted errors use safe codes such as `model_budget_exhausted`, `model_timeout`, or `model_outcome_unknown` in durable processing state. Charge-possible outcomes retain their budget reservation. The default adapter timeout is 20 seconds; the processor allows five more seconds for persistence under its 60-second lease. An overall terminal timeout prevents automatic replay or late delivery even if output later reaches the encrypted cache. Scoped usage reporting is available; budget adjustment, late-result replay and charge reconciliation require reviewed operator procedures. See [hosted model setup](hosted-model.md).

## Personal capabilities

All mutations use the existing trusted message ingress and stable logical IDs. See [reminders](reminders.md) for exact schedule/settings commands, [actions](actions.md) for exact approval IDs and simulation boundaries, [research](research.md) for explicit-query consent and request caps, and [account controls](account-and-operations.md) for export and erasure semantics. These routes derive account ownership from the authenticated cookie; they never accept a caller-selected user ID.


## Cloud identity, real transport and staff additions

See [identity and support](identity-and-support.md) for the full sign-in/linking/staff route table. `GET /api/auth/status` reports safe configuration and optional approved Apple entry URL. `/api/auth/google/start` and `/api/auth/google/callback` implement account identity; `/api/calendar/google/*` remains separate scoped Calendar consent. Invitation login and global bearer operator credentials are local only.

`POST /webhooks/messaging/sunshine` authenticates bounded raw batches using the configured Sunshine shared X-API-Key before normalization. App/webhook/Apple integration/controller are pinned. A verified provider proof and same-session web confirmation establish the opaque account binding. Customer text never chooses an internal account/destination. Events and messages dedupe independently, including proof/lifecycle namespaces. Delivery, closure, client revocation and provider handoff do not become model turns. Old events before the same-provider proof watermark are ignored. Provider control is fail-closed when unknown.

`POST /api/conversations/:id/receipts` accepts `{messageIds:[...]}` only for the authenticated user's web conversation. Web publication is sent until that receipt; Sunshine API acceptance is sent, with subsequent actual provider delivery receipts authoritative. Queued/cancelled unpublished assistant content is hidden from the real web transport.

Cloud customer `/handoff` accepts human requests; bot resume requires the staff claim path. Staff grants and replies require fresh identity, role revision and expiring claim version. Provider-owned or unknown-control threads are unavailable for Plause staff replies/resume. See the staff API table for exact payloads and pagination.

Cloud account deletion uses fresh identity confirmation followed by an exact phrase/one-use intent. `DELETE /api/account` may return202 `{pending:true,deleted:false,operationId}` when independent erasure recording is unavailable. Access/work are disabled immediately; it does not claim content was erased before recording/purge.200 deleted follows independent durability and live purge. Minimal charge/quota/erasure metadata is retained.

`GET /ready` uses503 for incomplete runtime configuration or maintenance. Restore locks fence private reads, delayed callbacks, provider work and final reply/cache commits. Operator status adds safe runtime/DLQ/circuit counters. There is no online restore unlock or billing hold-release endpoint. Real external acceptance remains separate from these contracts and controlled fixtures.
