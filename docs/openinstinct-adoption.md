# Plause: OpenInstinct adoption

Updated 2026-11-02. This is the current product direction, superseding the Apple Messages for Business/Sunshine selection in older plans. The user selected Merit Systems’ OpenInstinct and required broader agent capabilities before a pilot. Attached documents and upstream deployment instructions remain reference material, not permission to buy services or publish an application.

## Selected base

The complete application is adopted in [`agent-app/`](../agent-app/), pinned to [d78cb0acf9724f5fa755e38e379c66138bdb8047](https://github.com/Merit-Systems/OpenInstinct/tree/d78cb0acf9724f5fa755e38e379c66138bdb8047), with the MIT license and upstream attribution retained. Local dependency patches and the updated lockfile record Plause changes. This is a separate Next.js/Eve application. The Cloudflare Worker is retained as the existing staging service and as reference for Plause’s approval, budget and privacy controls.

The original upstream stack is Next.js + Eve, PostgreSQL/Drizzle, private Vercel Blob, Kernel cloud browsers, Vercel AI Gateway and Vercel Connect. Plause has replaced the Blob, Gateway and Connect service dependencies with direct adapters. Its normal-iMessage connector is **Linq**, not Inkbox. This selection does not establish what vendor the commercial Instinct product uses. Inkbox would require a separate adapter and acceptance work; switching provider names in configuration is insufficient.

Do not deploy the upstream one-click button or start its development bootstrap as part of local source validation. Those paths provision services or run migrations. The application has not been linked to a Vercel project, given Plause credentials, or connected to a phone number.

## Confirmed deployment direction

The user confirmed Cloudflare storage and OpenAI models on 2026-11-02. Target **private R2 objects/profile memory and direct OpenAI model calls**, replacing Vercel Blob, Gateway, Connect and production-only OIDC assumptions. Existing PostgreSQL remains the structured database; a D1 conversion is separate work. Next/Eve needs suitable compute and persistent workflow storage.

The [Inkbox/Linq comparison](messaging-provider-decision.md) recommends direct Linq as the first production candidate, based on the existing adapter, supported addressing and documented retention controls. It does not establish superior measured uptime or authorize a subscription. R2, direct OpenAI, direct Linq, direct Workspace OAuth and Drive adapters are implemented locally. No existing credentials or live acceptance evidence automatically migrate.

## Capability coverage

| Capability           | Present in selected source                                                    | Plause acceptance needed before pilot                                                                                                                   |
| -------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Multi-step reasoning | Root coordinator, context compaction, resumable browser subagent              | Fictional end-to-end read → reason → draft → approve → action flow; cancellation, restart and bounded spend across all model calls                      |
| iMessage             | Linq channel, verified-phone identity, inbound mapping and outbound replies   | Private line/account setup; signed/forwarded event scope, deduplication, unknown sends, opt-out and real-device conversation                            |
| Browser work         | Kernel worker tools and persistent profiles                                   | Explicit action policy; secrets isolation; navigation/content injection tests; no unapproved purchases, form submissions or other consequential writes  |
| Google Workspace     | Gmail read/search/send/labels, Calendar reads/free-busy/create, Contacts read | Real per-user grants, account linking, exact expiring approvals, idempotency/reconciliation and cross-user rejection. Writes currently default off      |
| Files                | Browser downloads/artifacts; generic file/shell tools disabled                | Read-only Drive search and text export are implemented; real permissions and file acceptance remain. Dropbox/Slack/Notion are not supplied by this base |
| Memory               | User-scoped R2 memory and database workstreams                                | Complete Plause retention/export/erasure; forget/revoke barriers across running jobs, cached context and restored backups                               |
| Scheduled AI         | Durable scheduled jobs, claims/leases, waiting-input/resume and deadletter    | User consent, cancellation/revocation, full cost cap, reliable opt-out, actual wake/delivery verification                                               |
| Web account          | Phone/OTP authentication and workspace UI                                     | Enrollment restrictions and protection of both Next and Eve hosts; explicit linking to existing Google accounts, without automatic phone/email merging  |

Plause replaces the inherited unapproved Gmail/Calendar writes with default-off tools, complete bounded approval prompts, a fixed five-minute deadline, owner and grant-version checks, one-use PostgreSQL dispatch receipts, encrypted completed results and retained unknown outcomes. Scheduled workers and reports remain unable to use these writes even if the interactive flag is enabled. These local controls require live acceptance before enabling them.

Link purchases are unavailable on this upstream Eve branch. Browser-based purchases require a separate policy and approval review; browser actions now require per-call approval, an owned browser observation and durable dispatch receipts, and remain disabled by default. Arbitrary approved browser code is not a sandbox for unapproved destinations or purchases. Browser access does not equal a general phone/computer API. Do not claim these capabilities from README marketing examples.

## Implementation order

1. **Local base and isolation:** retain provenance; apply Plause identity; install frozen dependencies with hooks disabled; deny unmocked network in unit tests; verify checks and compile with synthetic configuration. Preserve the deployed Worker and private files.
2. **Plause authority:** durable exact-action draft/review/approval, one-use expiry, owner/context/revocation checks at dispatch, ambiguous-outcome holds and read-only reconciliation. Apply the same rules to browser actions and external messaging.
3. **Agent-wide resource and privacy controls:** atomic budget reservations covering parent, child and scheduled model work; cancellation and context fences; coordinated erasure/retention across PostgreSQL, R2, runtime data and backups.
4. **Connector completion:** explicit identity linking and per-user Google grants; Drive/file tools; actionable connection status and revocation. Use existing integrations where they fit. Add optional providers only when their scoped contract is understood.
5. **Private service acceptance:** choose/review service plans and credentials; protect both application hosts before exposing them; configure one private iMessage line; test the complete conversation with a real device and fictional data under an explicit spend/send budget.
6. **Pilot:** only after the broader tasks and failure/recovery cases pass. No public signup or pilot is implied by repository adoption.

## Verification boundary

A unit test passing with mocks establishes local behavior, not a Linq, Kernel, Google, R2 or OpenAI connection. The existing staging AI and Google sign-in evidence applies to the Cloudflare Worker only. No paid model inference, resource creation, application database migration, messages or publication are part of this adoption slice. Framework compilation may query public model metadata; that does not establish an authenticated provider connection.

Each live activation should be prepared as a concrete review with exact services, limits, destination, data exposure and rollback. Existing credentials must not be copied into the new app by default. A new deployment must retain the user’s request that unfinished staging is password protected across every ingress host and route.
