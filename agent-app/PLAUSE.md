# Plause agent application

Updated 2026-11-02. This application adopts [Merit Systems’ OpenInstinct](https://github.com/Merit-Systems/OpenInstinct/tree/d78cb0acf9724f5fa755e38e379c66138bdb8047), pinned to **d78cb0acf9724f5fa755e38e379c66138bdb8047**. The complete original source was copied without its Git history, installed dependencies, generated output or environment files. [LICENSE](LICENSE) retains Merit Systems' copyright and MIT grant. Plause's README, dependencies, lockfile and patches now describe its own direct-provider installation.

The parent Cloudflare Worker remains a separate application. This agent is not deployed at staging.plause.si. Its credentials, phone identities, sessions and provider accounts have not been migrated from the Worker.

## Implemented locally

| Area                | Current implementation                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent               | Multi-step Eve coordinator, resumable browser delegation, compaction, workstreams and scheduled workflows. Direct OpenAI Responses models for parent, browser and compaction; no Gateway fallback.                                                                                                                                                                                                                                              |
| iMessage            | Direct Linq credentials, explicit assigned line, raw-body webhook signatures, DM-only enrolled-phone identity, encrypted PostgreSQL inbox and global dedupe. Acknowledgment follows durable commit. Internal relay waits for Eve admission; ambiguous admissions remain held. SDK sends have no automatic retries. Minimal pinned Eve patches preserve source-message idempotency and check current enrollment before inherited outgoing hooks. |
| Storage             | Private Cloudflare R2 for profile memory and browser images, bounded streams, hash checks, conditional writes and concurrent-update protection. Installation encryption secrets are explicit; no automatic key storage in Blob. PostgreSQL remains the structured database.                                                                                                                                                                     |
| Google              | Direct user-scoped OAuth with state, PKCE, nonce, browser/session binding and signed ID-token verification. Encrypted tokens, serialized refresh and grant-version fences. Gmail, Calendar, Contacts and read-only Drive search/text export. Unknown revocation blocks reconnect pending reconciliation.                                                                                                                                        |
| Google writes       | Default-off Gmail send/update and Calendar creation. Complete bounded approval prompts, same-owner answers, exact arguments/call/session/grant binding, fixed five-minute expiry, fresh pre-dispatch checks, one-use receipts and encrypted completed-result recovery. Scheduled sessions remain read-only.                                                                                                                                     |
| Browser actions     | Default-off operations require human approval and a server-issued five-minute observation bound to the owned browser, worker, user, workspace and exact current HTTPS origin. PostgreSQL receipts commit before mutation. Completed replay cannot dispatch again. Unresolved actions fence replacement workers. Kernel retries are disabled.                                                                                                    |
| Cross-tool recovery | Google and browser claims share a per-root transaction lock and inspect both unresolved ledgers. An uncertain write cannot be automatically repeated through the other tool surface in that conversation. No automatic reconciliation or bypass-clear endpoint.                                                                                                                                                                                 |
| Spending            | Atomic workspace/global monthly reservations across parent, child, compaction and research calls. OpenAI requests use exact input preflight, bounded output, deadline, `store:false` and standard service tier. Unknown calls retain holds. Account-row locking orders private-cache settlement against deletion without refunding known usage.                                                                                                 |
| Public research     | A normal function tool replaces inherited hosted search so it cannot inject an unsupported paid tool into OpenAI requests. Optional direct Tavily basic searches require full-query owner approval, have bounded responses and share the spending ledger. Disabled by default.                                                                                                                                                                  |
| Access              | Hosted enrollment requires exact allowlisted phone numbers. Sessions, incoming messages, model calls and outgoing actions recheck current enrollment. Loopback development alone can use the local auth exception. New hosting configuration password-protects the app and keeps signed service callbacks separate.                                                                                                                             |
| UI/setup            | Direct-provider connection controls, truthful configured/disabled status, Google permission review and missing-configuration reporting without secret values or provider requests. Removed the Vercel one-click deployment path.                                                                                                                                                                                                                |

`migrations/0015`–`0017` add provider intake, spending, Google approvals and browser receipts. They have been applied only to synthetic embedded PostgreSQL fixtures. User deletion purges private provider inbox/token/approval/model-cache payloads while retaining replay and cost metadata. This is not complete erasure of R2, workflow history or backups.

The complete Google action review must fit 3,000 characters; oversized actions are rejected rather than approved from an excerpt. Browser origin checks protect the starting page. They do not sandbox arbitrary approved Playwright code or promise that external actions can be undone. Link purchases remain unavailable.

## Validation

Use Node 24 and pnpm 11.24.0:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm check
pnpm test:runtime
pnpm test:runtime --openai
```

Final application check: **1,195 tests across 124 files passed**, with all six Turbo tasks successful: lint, route generation, TypeScript, formatting, unused-code checks and the unit suite. The unit suite uses synthetic credentials, mock transports and embedded PGlite. Unmocked fetch/HTTP/TCP/TLS requests are denied.

The deterministic runtime fixtures passed **three scenarios and 22 gates**: two lifecycle scenarios cover delegation, child cancellation and same-worker resume; one direct OpenAI SDK scenario covers parent/browser routing and explicit compaction. They use temporary Eve hosts, mock models and scrubbed child environments. Optional sandbox auto-install and package hooks are disabled. The harness stops its own remaining process group before bounded cleanup. A prior optional-install/cleanup race was corrected and the workflow fixture then exited successfully. These fixtures do not accept sandbox commands or attachments; an unavailable optional sandbox may be reported during background prewarming.

The Next production build passed with `pnpm build -- --webpack` and synthetic configuration. Webpack is the local fallback for the previously observed Turbopack sandbox restriction. `eve build --skip-sandbox-prewarm` compiled and bundled the authored agent with telemetry disabled. Skipping sandbox preparation makes this compilation evidence, not a deployment artifact with accepted attachment execution. Drizzle's history check and a fresh full migration-chain/erasure test passed locally.

Eight HTTP checks passed against the built Next/Eve servers on loopback with synthetic settings: sign-in renders, anonymous app pages require sign-in, the authentication session is empty, Eve session creation and streams reject anonymous callers, Google OAuth start requires sign-in, callback codes are discarded before a clean redirect, and an unconfigured Linq webhook rejects intake. API requests now reach their own authorization handlers instead of receiving a sign-in HTML redirect. The owned test servers were stopped afterward. This does not validate the Caddy template or a live provider connection.

Historical baseline before the direct-provider changes: 930 tests in 98 files and two runtime scenarios/16 gates. Those earlier results are superseded by the figures above. Dependency installation used pinned pnpm and disabled lifecycle hooks. The parent ignored `.local/` directory holds the toolchain, package cache and private validation logs.

## Remaining live acceptance

No new provider keys, resources, line, database, secret upload, deployment, paid model generation or live message was used in this migration. The existing Worker's earlier AI/Google sign-in results do not establish connections in this application.

Before a private pilot:

- Configure a private Node/PostgreSQL/workflow host, a separate private R2 bucket, direct Linq line and signing secret, Kernel key and separate Workspace OAuth client. OpenAI needs a reviewed live-call budget; optional public research additionally needs Tavily. Keep all keys out of chat and source.
- Preserve password protection across every exposed app host, exact enrolled identities and one schedule owner. Do not expose the Node listeners directly. See [private hosting](ops/README.md).
- Test the actual iPhone conversation, attachments, approval cards, duplicate delivery, restart, unknown outcomes and opt-out. Verify real Google permissions, browser sessions and bounded multi-step tasks with fictional data.
- Complete scheduled proactive consent/cadence, cross-store privacy/export/erasure, restore barriers and operational reconciliation. Arbitrary phone control, Dropbox/Slack/Notion APIs, purchases and general shell/file execution are not established by this application.

See the [adoption plan](../docs/openinstinct-adoption.md) and [provider comparison](../docs/messaging-provider-decision.md). Attached plans and upstream instructions are reference material, not authorization to purchase or activate services.
