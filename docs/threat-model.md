# Plause threat model

Research snapshot: 2026-10-30. Scope: local simulated messaging using a Worker, D1 and Queues, explicit encrypted memory, durable reminders, expiring approvals, a simulated calendar, account controls, and optional hosted model/search adapters. Provider requests are disabled in the active configuration and live access has not been verified. This is a development foundation for an agent that lives in Messages. Apple/MSP messaging, production authentication and staffed support are not connected.

## Assets and boundaries

Protect conversation content, account-to-channel bindings, saved facts/settings, future OAuth grants, delivery destinations, approval state, operator access and spend budgets. The model is never an authorization authority.

Trust boundaries are: external event -> verified provider adapter; adapter -> validated internal event; event -> tenant-scoped database records; queue -> current conversation lifecycle; model output -> deterministic policy; outbound content -> provider; and human support -> scoped conversation access. Authenticated delivery events are not user messages and must never invoke the model.

The only implemented webhook signature contract in this slice belongs to the **mock adapter**. Its HMAC-SHA256 covers the exact `timestamp.rawBody` bytes with one `t=<unix>,v1=<hex>` header. The parser rejects duplicate/unknown fields, malformed encoding and timestamps more than 300 seconds in either direction from the server clock. This bounds replay age; durable event/message deduplication must independently suppress replays inside that window. A real MSP needs its own documented verifier and captured fixture tests; do not reuse the mock format by assumption.

## Identity and disclosure

Apple's customer identifier is opaque and scoped to a business. A customer phone number is not automatically available. See [Apple's channel security explanation](https://support.apple.com/en-euro/guide/security/sec1c603aab4/web) and [AWS's documented Apple customer attribute](https://docs.aws.amazon.com/connect/latest/adminguide/add-apple-messages-for-business-features.html). Identify an unlinked contact using provider + business ID + subject ID. Never merge subjects or link an existing Plause account by a claimed name, phone number, message text, or provider thread ID alone.

Before historical private context or connected accounts become available, require an authenticated, expiring, single-use account-link flow with explicit consent. Define unlinking, recovery, binding revocation and future outbound cancellation. Local simulated enrollment/operator controls are not production customer authentication. No external OAuth authorization or personal test data is necessary for this slice.

## Abuse cases and required controls

| Threat | Control and acceptance evidence |
| --- | --- |
| Forged or altered mock events | Verify the preserved raw body before parsing; reject missing, malformed, old/future or invalid signatures. Test changed bodies and duplicate header fields. |
| Replay, duplicate jobs or concurrent turns | Persist accepted events before acknowledgment; use stable deduplication and logical-response identities. Test competing workers and repeated delivery. |
| Cross-tenant reads or writes | Derive tenant scope from trusted bindings. Every query and state mutation must enforce ownership, including caller-supplied IDs. Test two subjects and malicious cross-user references. |
| Closed conversation receives queued reply | On lifecycle close, revoke send eligibility and suppress pending jobs. Recheck at dispatch, including after an in-flight model call. Define safe handling of later customer reinitiation. |
| Bot continues during human support | Persist handoff state and pause bot processing/outbound work. Test HELP during queued processing and manual resumption. A local pause is not a staffed live-support service. |
| Lost provider response causes duplicate send | Distinguish known transient failure from uncertain acceptance; do not blindly resend an unknown outcome. Production adapters require reconciliation or an operator decision. |
| Message or webpage changes permissions | Treat all inbound content, model output and retrieved text as untrusted. Deterministic authorization must remain outside the model. |
| Search leaks private facts | Only an exact explicit search command sends its current query. Saved facts, history and internal IDs are excluded. No automatic follow-up, arbitrary page fetch, or model-generated search executor exists. Provider snippets remain untrusted data. |
| Approval applies to a different action | Exact opaque IDs bind user, conversation, tool, immutable argument digest and relevant connection/context/settings revisions. Expire and atomically consume once; recheck grants and current state at execution. A bare affirmative cannot authorize a pending action. Demo events are simulated; real Google operations require a separately authorized current grant and their own exact approval journal. |
| Reminder races cancellation, quiet hours or human takeover | Atomic unique occurrences prevent duplicate enqueue; version and notification settings are rechecked at send/receipt, including after awaits. Deferred reminders do not block ordinary chat. Unknown sends remain uncertain and cannot be retried after cancellation. |
| Failure leaves a messaging user waiting indefinitely | Terminal failures create one deterministic, content-free classified status reply under the same lifecycle/context/lease fences. Unknown model acceptance never implies no charge and never auto-retries generation. |
| Erasure raced by in-flight generation/search or pending tasks | Reauthenticate and require a separate short-lived one-use intent. Atomically delete scoped content and credentials, purge caches, and retain only minimal request/cost tombstones; late completions cannot restore erased content. Delivered messages and user downloads cannot be recalled. |
| Forgotten fact returns through old history or cache | Effective edit/forget/off/on changes reset the account future-history boundary, cancel older work across channels, increment context revisions, and purge/fence prior model caches. Exclude all memory-control turns from model history. Transcripts and delivered replies remain; production deletion, backups, and any future extraction/summaries need separate treatment. |
| Model, quote, or embedded example writes memory | Parse only whole explicit user commands at trusted ingress; no model-generated mutations or automatic extraction. Reject multiline/quoted/embedded command forms. Apply event, mutation, revision fencing, and acknowledgment atomically so replay cannot repeat the change. |
| Privacy controls blocked by chat quota or missing model key | Deterministic commands and account-scoped export bypass model readiness/spend gates and normal daily chat quota. Memory-off still permits list/export/forget. Future abuse limits must preserve usable privacy controls. |
| Memory changes race generation or delivery | Recheck per-user context revision at model preflight, cache/result persistence, reply/outbox commit, and send eligibility. Privacy changes invalidate leases and pending work across channels; an accepted external request/send can still charge or arrive. |
| Cost or outbound amplification | Bound content, exact preflight input tokens, output tokens, deadlines and turn counts. Atomically reserve worst-case estimated cost against UTC user/global budgets before dispatch. Do not retry a dispatched or uncertain generation. Keep hosted AI disabled until explicit local configuration. |
| Lifecycle changes during model preflight | Recheck tenant, account, channel, bot mode, pause state and lease after token counting, immediately before paid generation. Recheck commit and outbound eligibility afterward. An already dispatched provider request may still incur cost. |
| Reply persistence failure causes another model charge | Retain one durable attempt per input and reuse its encrypted completed result. Uncertain outcomes keep their full reservation and terminally fail instead of triggering a new generation. |
| Operator token compromise | Keep operator routes separate from customer routes, use secret verification, rotate credentials and audit privileged actions. The local bearer control needs production MFA/RBAC before deployment. |

## Encryption and operational limits

The security package encrypts content using AES-256-GCM with a fresh 96-bit IV, authenticated version label and 128-bit tag. Keys must be canonical base64 encoding of exactly 32 random bytes. The versioned ciphertext includes the IV; neither key nor plaintext belongs in logs. Tampering, wrong keys and invalid envelopes must fail closed. SHA-256 is suitable for opaque high-entropy token/identifier digests, not password storage.

This primitive does not provide tenant-specific keys, key rotation, secrets management, backup erasure or encryption of all metadata. Local secrets and D1 state are development data. Before real users: use managed secret storage, define rotation/re-encryption and purge procedures, review log/backup retention, and exercise restore plus deletion. Document who can read content at the MSP, model provider and Plause support; never describe cloud processing as wholly on-device or invisible to those services.

## Hosted model data and budget boundary

Explicit hosted opt-in sends the current message, bounded recent context, and enabled saved facts to OpenAI. Facts are serialized as data with capability/authority constraints, not interpreted as commands. The adapter uses a fixed HTTPS API origin, disables redirects and retries, requests no stored response, and accepts only bounded text or one strict typed function result. Functions request drafts or authorized read-only calendar data; server policy alone can execute an exact approved write. Provider errors are reduced to safe codes; credentials and content do not belong in diagnostic output. API-side retention and billing remain separate provider policies; requesting no stored response is not a promise of zero retention.

The application ledger uses conservative estimated cost, not an authoritative invoice. Unknown acceptance retains the maximum reservation. A completed response is encrypted before durable caching; deleting its source purges cached content and input digest. Opaque billing/request metadata survives account erasure so deletion cannot reset shared allowances. Local account export and reauthenticated erasure are implemented; production identity, retention, backup erasure and reconciliation need explicit policy and validation.

## Saved memory privacy boundary

Only explicit save/update commands can add or change an account's facts. The same authenticated account's channels share the facts and on/off setting; no message can select another internal user. List/export query the cookie's account, and the JSON export is plaintext content that the user must keep private. Memory text is encrypted before storage, while IDs, ownership, revision, and timestamps remain metadata.

Turning memory off retains facts but excludes them from model requests and blocks save/edit. Listing, export, and forgetting continue to work. Effective privacy changes reset future history and cancel older pending work; adding a fact preserves completed recent history. Neither operation erases transcripts or recalls delivered replies. Account revisions fence late responses and cached output so an in-flight model cannot silently restore prior personalized context.

The credential-like-content guard is conservative, not a complete sensitive-data classifier. It can reject benign facts and miss obfuscated secrets. Rejection stops saved-fact creation but does not remove the original encrypted command message or raw event record. Do not describe this guard as transcript redaction or promise that sending a secret leaves no retained copy. The product has no automatic extraction or summary-memory layer. Local erasure does not establish production backup or provider deletion. See [saved memory](saved-memory.md) for the implemented limits.

## Google revocation and result disclosure

Google consent uses a single-use state, S256 PKCE, a private short-lived callback browser proof and the still-valid original account session. Tokens are encrypted and scope-limited; metadata reads never refresh. Unknown refresh outcomes fail closed. Only an explicit disconnect attempts provider revocation; stale callback/refresh results cannot revoke a newer grant automatically. Inflight or unknown revocation prevents reconnect until reviewed reconciliation.

Disconnect and unknown refresh invalidation reset future AI context, cancel older pending automatic replies across the account, invalidate leases and purge model/search/Google caches. Existing context/ownership fences suppress captured Google results at reply commit and queued dispatch. Saved facts, reminder tasks, transcript and delivered messages remain. Google approval-list reads recheck active account, context/grant revisions and each captured row digest after decryption, so deletion or revocation cannot return captured stale arguments. See [Google Calendar](google-calendar.md).

## Apple lifecycle and support gates

Apple's [policies](https://register.apple.com/resources/messages/messaging-documentation/policies) require live agents during stated business hours and cessation of outbound messages when the customer deletes the conversation. Model these as runtime states, not prompt instructions. The production adapter must document how closure and handoff arrive and how pending sends are fenced. There remains a race between a dispatch check and an external send; do not claim recall of an already accepted provider message.

Review [Apple's privacy notice](https://www.apple.com/legal/privacy/data/en/messages-for-business/) for Business Updates consent. A reminder request is not proof that every proactive message is permitted by the chosen channel. Until written eligibility and MSP behavior are confirmed, keep proactive Apple delivery off and present status through an independently authenticated web experience.
