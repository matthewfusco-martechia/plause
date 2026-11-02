> Historical Cloudflare foundation documentation. The active agent direction is now [OpenInstinct adoption](openinstinct-adoption.md). Apple Messages for Business and Sunshine are no longer the selected messaging route. Commands below apply only to the preserved Worker app.

# Plause

Plause is a cloud personal AI agent designed to live in Apple Messages. The Messages conversation is the primary experience. The web app provides sign-in, account controls, channel linking and staff support, with authenticated web chat available while Apple approval is pending.

The code includes Google sign-in, verified channel linking, a Sunshine Conversations Apple adapter, durable conversations and delivery, saved memory, reminders, exact action approvals, optional research and Google Calendar, staff ownership and replies, privacy erasure, backup/restore verification and isolated end-to-end tests. An isolated live OpenAI smoke passed three cases. All four local Google identity checks passed: initial OAuth/login/session, sign-out, returning sign-in with signup closed, and fresh confirmation. **Staging deployment and initial Google enrollment are verified; returning staging login and all three bounded cloud AI tests are verified by browser/database evidence. Calendar, Apple, search and broader service acceptance remain outstanding.** The primary preview has one real Google account alongside three fictional invitation accounts; model/messaging remain mock and Apple is off.

Staging is behind an origin-wide password wall, verified by cloud metadata and 15 HTTP checks. Manual Chrome password-prompt acceptance is pending; Google sign-in remains a separate requirement. Use the [private staging access instructions](staging-access.md); no password or hash value belongs in this repository.

Opt-in Messages onboarding gives an unlinked sender a deterministic AI welcome and sign-in URL, then distinct proof-received and linked notices. It creates no private conversation or model turn before account confirmation. [Onboarding design](messages-onboarding.md) records the delivery and privacy boundaries.

## Run locally

Use Node.js 24.10 or newer.

```sh
npm ci
npm run setup
npm run dev
```

Open [Plause locally](http://localhost:8787). Local invitation keys are in `.local/invitations.json`; open that file locally and use an account's `inviteToken`. Do not paste keys in chat or commit them. Setup preserves existing keys/accounts and applies additive migrations. A running local server wakes scheduled recovery every 15 seconds; D1 owns the durable state.

Keep `.dev.vars`, `.local`, `.wrangler` and backups private. Preserve the matching encryption key or complete keyring with every database backup. Local invitations and the operator bearer token work only in the local environment.

## Verify the complete implementation

```sh
npm run check
npm run test:e2e
npm run build
```

`check` runs TypeScript, Worker integration tests and Node CLI/security tests. `test:e2e` owns a temporary server, database, random port and fictional identities. It tests real HTTP authentication, signed ingress, channel proof/confirmation, tenant isolation, memory, reminders, approvals, staff replies, SIGKILL/restart recovery, export pagination, account erasure and an actual quiescent D1 backup/offline restore. It never reads local invitation/provider credentials or uses the preview database. Its report is `.local/e2e-report.json`. Provider API tests use controlled fixtures and deny real network calls.

The current full check passed TypeScript, 1,332 Worker tests across 43 files and 117 Node tests (**1,449 total**) at password-wall snapshot `896ba61864886be8fb3b29987d77bec7143b83db9752ea766d629793eb55d785` (70 runtime files). All 48 focused gate fixtures passed. The earlier 14/14 HTTP E2E, three coordinated cloud AI tests and three isolated model-evaluation cases remain separate historical evidence; none was rerun for this wall. Cloud metadata and 15 native HTTP checks verified the password deployment, with manual browser prompt acceptance pending. See [the handoff](../HANDOFF.md).

`build` is a deployment dry run. It publishes nothing. CI runs the same checks and uploads the compact E2E report; no remote CI result is claimed before a repository/run exists. The four local Google identity interactions are verified by user confirmation and count-only checks. Broader browser visual, interaction and accessibility acceptance remains unverified; the earlier automated-browser URL restriction and API/static checks do not establish those gates.

With the preview running, `npm run demo`, `npm run demo:memory` and `npm run demo:agent` exercise additional fictional mock flows.

## Agent behavior

- Conversation work, provider events, logical messages, model attempts and the outbox are durable and independently deduplicated. Ownership, account context, channel binding, leases, consent and maintenance gates are rechecked before consequential work.
- Hosted AI uses a bounded OpenAI Responses adapter, exact input-token preflight, conservative per-user/service spending reservations, encrypted result recovery and one paid generation attempt per accepted input. Unknown charges remain held.
- Saved facts require explicit commands. Send `memory help`; up to 10 facts of 300 UTF-16 units are supported. Ordinary chat and model output do not save facts. Forget/edit/off/on reset future AI context and cancel stale work; existing transcripts remain until account erasure.
- Once/daily/weekly reminders respect IANA time zones, DST, quiet hours, notification preferences and versioned occurrences. Proactive Apple delivery additionally requires channel approval, an explicit deployment policy flag and separate user consent.
- Model tools can propose reminders or calendar events and request a bounded calendar read. Writes require a separate exact expiring one-use approval; a bare yes does nothing. Send `action help` or `google calendar help`. Simulated calendars remain clearly labeled and are disabled for the production transport.
- Research requires an explicit public query such as `search: public libraries in Boston`. No private facts or chat history are forwarded as search arguments. Search and Google Calendar are disabled until separately configured.
- A human support request pauses model replies. Authorized staff use fresh verified sessions, roles and expiring conversation claims. Replies are durably queued and revoked claims cannot send. Provider-owned or unknown-control conversations require provider-side resolution before Plause staff can resume them.
- Web messages become delivered only after an authenticated display receipt. Sunshine API acceptance is recorded as sent. Unknown provider sends use read-only reconciliation and are never blindly posted again.

## Cloud configuration and live acceptance

The confirmed domain is **plause.si**, with staging deployed at `https://staging.plause.si`. Public DNS delegates to Cloudflare; the Worker/custom hostname and reviewed runtime configuration are independently verified. Run `npm run readiness` for a read-only, secret-free report of missing configuration, then follow [account setup and real-device acceptance](live-acceptance.md). Exit 2 means live configuration is incomplete; the local mock can still be configured.

After explicit user approval, exactly four empty staging resources were created: `plause-staging-db`, `plause-staging-jobs`, `plause-staging-dlq` and private `plause-staging-privacy-ledger`. At allocation independent info checks matched D1 identity with 0 tables, found no queue producers/consumers and zero observed backlog, and checked the new private Standard/ENAM bucket returned 0 objects. Its list response lacked an explicit truncation flag; the observation is not an exhaustive-list guarantee. Actual IDs and verification evidence stay private in the 0600 plan, state `provisioned_verified`. Local configuration/bootstrap hashes were preserved. The later approved activation applied all 19 remote migrations, uploaded five secrets and deployed the Worker/custom hostname, queues and cron. No billing changes or live Messages occurred.

The imported OpenAI key was used successfully in a fresh isolated live evaluation on 2026-11-02: three completed `gpt-6-luna` generations, 3/3 cases passed, zero unknown charge holds and verified temporary process/data cleanup. The app ledger estimated US$0.001433; that is not an invoice amount. That evaluation preserved the primary preview's then-current encryption/settings. The primary model remains mock (`MODEL_PROVIDER=mock`, `LIVE_MODEL_ENABLED=false`). The user reports billing ready and API credits were verified privately; no purchase was made by the agent.

The Plause development Google project and local identity client are configured. User confirmation and count-only checks verified initial login, sign-out, returning to the same account with signup closed, and fresh confirmation. Final state: 1 Google identity, 1 valid/fresh session and 4 successful login audits; the 3 fictional invitation accounts have 0 identity associations. Google identity remains enabled and signup false. No local manual identity check remains pending; the private 0600 count-only report is `.local/identity-acceptance.json` (passed=true). Encryption material and mock model/messaging were preserved. Calendar-specific credentials/grants and Sunshine credentials remain absent. The separate staging Google client was created/downloaded and validated, and the initial five-secret input plus private staging config passed offline readiness/dry run. The current password-wall deployment retains those five secrets and adds only its hash as the sixth. The sole allowlisted Google account enrolled over staging HTTPS; the independently verified follow-up deployment closed signup. No operator roles are assigned. The reviewed initial per-user/service model budgets are each US$0.03 in app accounting, not an invoice cap. External key escrow is unverified. [Approved staging activation](staging-activation-review.md) is deployed; returning login and all three bounded cloud AI tests are verified. `npm run configure:identity` makes no Google request; actual acceptance used the separate browser OAuth flow.

Start with [cloud deployment](cloud-deployment.md), [identity and support](identity-and-support.md), [Sunshine messaging](sunshine-messaging.md), [operations](operations-runbook.md), [privacy and restore](privacy-and-restore.md), and [encryption rotation](key-rotation.md).

`npm run configure:cloud -- <options>` creates a reviewed staging/production configuration from explicit resource IDs and protected secret files. It does not provision, deploy or send messages. Environments use separate D1 databases, queues/DLQs, privacy buckets, origins and private credentials. Production rejects mock inference/messaging. Authenticated web is the initial fallback; Apple requires actual approved brand/MSP configuration and staffed support arrangements.

`npm run configure:model -- --store-only` stores a key through a hidden prompt without enabling hosted requests. The protected-file form is `npm run configure:model -- --store-only --key-file PATH`; never put a key value in an argument. The current key has already been stored.

To explicitly run the isolated paid evaluation:

```sh
npm run eval:model -- --live
```

It uses a fresh temporary D1 database, fictional account, encryption keys and random port, reusing only the stored API key. It permits at most three serial generations with a US$0.03 app-ledger estimate limit, which is not a provider invoice cap. A private `0600` metadata report, including unknown charge holds, is retained under `.local/model-evaluations` before cleanup. The primary preview can remain mock; enabling or restarting it is unnecessary. The completed 3/3 run establishes the narrow hosted-model smoke result, rather than general assistant quality or Apple/device acceptance. Research has a separate protected-file setup.

The historical coordinated staging sequence completed: three serial fictional AI tests passed with visible delivered replies, 5,586 input/47 output tokens and **1,423 microUSD (US$0.001423) estimated app debit**, with zero failed, unknown or held outcomes. At the end of that sequence counts showed 1 Google account, 2 valid sessions, 1 web binding, 3 Google sign-ins, 3 model attempts and no operator roles/invitation users/calendars. No further coordinated model attempts are authorized. The three AI tests used snapshot `26e700886370ffc89032ad2c8152ca47780521b78fbb91e2dadb1e0f877df74a`. The later resume-control update used snapshot `5bbde33780d3281ca5b2de36a90e28019f18d2a670463ff14d40a5092da808ac`. Current password-wall deployment and 4-attempt/1,969-microUSD account ledger are documented in [staging access](staging-access.md); the fourth turn predates the wall, is unattributed and was not an added coordinated test. The password deployment made no model call. [Activation results](staging-activation-review.md) distinguish the approved one-conversation recovery and retained history. Apple/MSP, Calendar/search, other provider provisioning, billing upgrades and admin grants remain excluded. Broad provider/device acceptance, production recovery and legal/retention work remain separate.

See [HANDOFF.md](../HANDOFF.md) for the latest tested snapshot and remaining acceptance gates.
# openfont-ai
