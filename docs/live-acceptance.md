# Activate and accept Plause

**Current staging access:** the origin-wide password wall is deployed and verified by cloud metadata and 15 HTTP cases. Manual Chrome prompt acceptance remains pending. The Worker now has six secrets and the canonical protected config is `.local/staging-preparation/wrangler.staging.password.json`. [Access details](staging-access.md) distinguish the current 4-attempt/1,969-microUSD account ledger from the original coordinated 3/1,423-microUSD test. The fourth turn predates the wall and is unattributed; no post-wall model call or additional agent test occurred.

Plause has a locally tested agent, account controls and provider adapters. The user already has Cloudflare and Apple Developer accounts; the Apple Developer account is used for another app. Plause staging has independently verified remote schema, both Worker deployments, custom hostname, queues/cron and six secrets (including the later password hash). The sole Google account enrolled over HTTPS and signup is now closed; returning login and all three bounded cloud AI tests passed with browser/database evidence. Apple Messages for Business registration remains outstanding. The private OpenAI key passed an isolated live smoke evaluation on 2026-11-02: 3/3 cases with three completed `gpt-6-luna` generations. The user reports billing ready and API credits were verified privately; no purchase was made by the agent. The primary model/messaging remain mock. All four local Google identity checks passed: initial OAuth/login/session, sign-out, returning sign-in with signup closed and fresh confirmation. Google identity remains enabled and signup false. The separate staging sign-in client is prepared; Calendar-specific clients/grants and Sunshine credentials remain outstanding. This hosted-model result does not establish a working service on an Apple device.

The current full check passed TypeScript, 1,332 Worker tests across 43 files and 117 Node tests (1,449 total) at source `896ba61864886be8fb3b29987d77bec7143b83db9752ea766d629793eb55d785` (70 runtime files). The 48 focused gate fixtures and 15 native live HTTP cases passed. Earlier 14/14 isolated HTTP E2E at `26e700…`, readiness/Node111 and resume-UI/Node113 checks retain their historical scope. The isolated 1,433-microUSD model smoke and coordinated cloud 1,423-microUSD run were not rerun for password protection. No browser prompt acceptance or broader Apple/product acceptance is inferred from the HTTP checks.

Local identity acceptance on **2026-11-02** passed all four checks with user confirmation and count-only SQL: initial login, sign-out (1 identity/0 valid sessions/2 audits), returning to the same account with signup false (1 identity/1 valid and fresh session/3 audits), and fresh confirmation (1 identity/1 valid and fresh session/4 audits). Final state also has 3 invitation accounts with 0 identity associations, 1 web binding, 0 model attempts and 0 connected calendars. An extra unconsumed reauth request expired naturally; valid pending flows 0 and unconsumed flows 0, without deletion. Private 0600 report `.local/identity-acceptance.json` records passed=true and contains no IDs/emails/tokens. Preview **28661** remains at the exact localhost origin, Google configured/enabled, signup false, readiness true, model/messaging mock and Apple off. There are no remaining manual checks in this bounded local identity sequence; global product live acceptance remains false. The earlier ENOSPC/heap/disk recovery remains in [the handoff](../HANDOFF.md).

The owned brand domain is **plause.si**. The proposed production origin is `https://plause.si`; the deployed staging origin is `https://staging.plause.si`. Staging custom-host configuration and initial HTTPS enrollment are verified; production remains a setup choice. Plause remains Messages first; the web console handles sign-in, permissions, approvals and account controls.

The user supplied the following business identity for setup:

| Detail | Value |
| --- | --- |
| Existing legal business | Martechia LLC |
| Registration jurisdiction | Wyoming, United States |
| Product brand | Plause |

DBA filing is not a project setup dependency, per the user's direction. No Apple/MSP registration has been submitted.

## Check what is missing safely

```sh
npm run readiness
npm run readiness -- --json
```

This command reads the selected local files only. It makes no network request, changes no file, uses no ambient provider credentials and prints no configuration values or secrets. The default inputs are `wrangler.jsonc` and a protected `.dev.vars`. It can report **local mock configured** while live Messages configuration is **blocked**. It does not probe whether the local server is running.

For a separately prepared configuration, use owner-only private files:

```sh
npm run readiness -- --config "$PLAUSE_STAGING_CONFIG" --secrets-file "$PLAUSE_STAGING_SECRETS_FILE"
npm run readiness -- --target web --config "$PLAUSE_STAGING_CONFIG" --secrets-file "$PLAUSE_STAGING_SECRETS_FILE"
npm run readiness -- --config "$PLAUSE_PRODUCTION_CONFIG" --secrets-file "$PLAUSE_PRODUCTION_SECRETS_FILE" --isolation-config "$PLAUSE_STAGING_CONFIG"
```

`--vars-file` accepts protected dotenv instead of JSON secrets. Custom configs never silently inherit this checkout's `.dev.vars`. Secret files must be regular files owned by the current user, mode 0600, without symlinks or hard links. Credentials in public `vars`, duplicate dotenv records, unknown secret JSON fields and unsafe files block the result. Exit 2 means missing/unsafe static configuration. Exit 0 means only that the selected static fields pass validation: `liveReady` remains false and live acceptance remains unverified. Resource ID shape does not prove an account or resource exists; an approval flag does not prove approval.

## Accounts and information to obtain

| Area | Required next input | Where it is used |
| --- | --- | --- |
| OpenAI | The isolated live smoke passed 3/3 at US$0.001433 app estimate. The separate approved cloud run also passed 3/3 visible delivered replies at US$0.001423 app estimate, with no held cost. Neither amount is an invoice. No agent purchase. | Primary local preview remains mock. Staging is configured/tested with separate secrets. No additional coordinated model attempt is authorized; broader model/agent acceptance remains separate. |
| Cloudflare | All 19 remote migrations, initial and closed-signup Worker deployments, custom hostname, reviewed bindings, queues/cron and six secrets are independently verified, including the later password wall. Broader operational acceptance remains pending. | Actual IDs stay private in `.local/staging-bootstrap/provisioning-plan.json` (0600), state `provisioned_verified`; use [staging preparation](staging-proposal.md). |
| Google sign-in | All four local checks passed: initial OAuth/login/session, sign-out, returning sign-in with signup false and fresh confirmation. The count-only private report is passed=true; the sole staging account has enrolled over HTTPS and signup is now false, while returning staging sign-in is confirmed by the user and Chrome; independent database counts reconcile the return; production setup remains pending. | Current local callback `http://localhost:8787/api/auth/google/callback`. Separate cloud callbacks `https://staging.plause.si/api/auth/google/callback` or `https://plause.si/api/auth/google/callback`. |
| Apple business | Existing Apple Developer account confirmed; Messages for Business registration remains separate. Legal/business contact and address, approved display name/logo, website, privacy/terms/support URLs, AI-assistant use-case description and actual human support plan are still needed. | Apple Business Register and selected MSP's review. Obtain the real Apple business UUID after enrollment. |
| Sunshine/Zendesk | Written confirmation that the chosen account/product supports Plause's third-party bot and staffed Apple channel; actual app, Apple integration, webhook, bot/human controller IDs and protected API/webhook credentials. | The existing adapter, signed-in channel linking and provider handoff. Confirm current subscription and Professional Services requirements/costs before purchasing. |
| Staff | Real support hours, IANA zone and contact URL; selected staff's verified Google subject IDs. | Truthful support disclosure and explicit operator grants; emails are not bootstrap identities. |

OpenAI's [developer quickstart](https://developers.openai.com/api/docs/quickstart) explains API-key setup. The current key has already been imported; do not recreate or expose it. For future imports, `npm run configure:model -- --store-only` uses a hidden prompt; `--store-only --key-file PATH` accepts a protected regular file. Store-only changes the key entry without enabling hosted requests, preserves the encryption keyring and unrelated settings, and makes no provider call. Keep credentials out of chat, shell arguments and the repository. See [Cloudflare setup](cloud-deployment.md) for resource permissions and separate environment configs. Google Calendar is a separate optional connection with its own credentials, callback and user consent; sign-in alone does not connect a calendar.

The current [Zendesk Apple setup guide](https://support.zendesk.com/hc/en-us/articles/8030634178458-Adding-and-configuring-the-Apple-Messages-for-Business-channel) requires Apple registration/review, a qualifying subscription, an active AI agent or third-party bot and a Professional Services package. It does not supply a quotation for Plause. Confirm eligibility, cost, data terms and bot/human ownership with the provider before committing. [MSP evaluation](apple-messages-msp-evaluation.md) and [adapter contract](sunshine-messaging.md) record remaining questions.

## Activate one layer at a time

DNS is now active and Wrangler login is complete. The OpenAI key was imported at the user's request through a temporary `0600` file using store-only mode; the temporary material was cleared and deleted. That import changed only `OPENAI_API_KEY` in the regular single-link `0600` `.dev.vars`. The subsequent isolated live evaluation passed all three cases and cleaned up its temporary processes/data, retaining only private metadata and cost evidence. The later Google identity import enabled local identity/signup while preserving encryption material and mock model/messaging. The complete bounded [local Google identity sequence](google-signin-setup.md) is verified with signup closed; scoped cloud work follows the [staging proposal](staging-proposal.md) for `https://staging.plause.si`. Workers.dev remains an optional temporary path. The [Apple/MSP packet](apple-messages-registration-draft.md) contains reviewable business/use-case text and an unsent eligibility inquiry; it does not establish approval.

The existing Apple Developer account does not establish Messages for Business enrollment or channel approval. Start that channel's registration in [Apple Business Register](https://register.apple.com/messages); the [provider's onboarding requirements](https://support.zendesk.com/hc/en-us/articles/8030634178458-Adding-and-configuring-the-Apple-Messages-for-Business-channel) describe the separate test account, brand review and MSP selection. Cloudflare authorization and active DNS do not establish application resources, routing, TLS or deployment.

A later read-only `whoami --json` check on 2026-11-02 confirms Wrangler in Plause's isolated local context is **authenticated to one account**, matching the earlier account inspection. The user completed the login approval; another login is not needed. The selected ID is stored only in git-ignored `.local/cloud-account.json`, verified owner-only `0600`, without email or tokens. See [Cloudflare's account commands](https://developers.cloudflare.com/workers/wrangler/commands/general/).

After explicit user approval, all 19 remote migrations, the initial Worker deployment and the follow-up deployment closing signup are independently verified. Settings/version, custom hostname, jobs/DLQ consumers, private R2, one-minute cron and five secret names match the review. The user manually enrolled the sole Google account in Chrome. Remote checks found 1 active Google account, 1 valid session, 1 web binding and 1 Google success audit; operator roles, invitation users, model attempts and calendars are all 0. Counts stayed unchanged after closing signup. Both monthly caps are 30,000 microUSD (US$0.03 app accounting, not invoice caps). Returning login and all three fictional AI tests passed with visible delivered replies; settled totals are 5,586 input/47 output tokens and 1,423 microUSD (US$0.001423) estimated app debit, with no failed, unknown or held outcomes. At the end of those coordinated tests, independent identity counts were 1 active Google account, 2 valid sessions, 1 web binding, 3 successful Google sign-ins, 3 model attempts and no operator roles/invitation users/calendars. No further coordinated attempts are authorized. Apple, Calendar and search remain off; no billing upgrade or DNS replacement is authorized. External key escrow remains unverified. Private IDs/receipts remain private; see [activation status](staging-activation-review.md).

### Verify the connected plause.si domain

The user reports the domain is now connected in Cloudflare, with registration remaining at Hostinger. Keeping an external registrar while using Cloudflare DNS is supported; a registrar transfer is not required. [Cloudflare's transfer/DNS distinction](https://developers.cloudflare.com/registrar/get-started/transfer-domain-to-cloudflare/).

The user reports **Active**. A fresh check on 2026-11-02 independently confirms recursive DNS and the `.si` parent delegate to `kim.ns.cloudflare.com` and `norm.ns.cloudflare.com`; SOA now uses `kim.ns.cloudflare.com` / `dns.cloudflare.com`. The former Hostinger parking nameservers are no longer the observed public delegation. This verifies DNS migration, not application deployment, HTTPS readiness or a complete zone inventory.

Earlier read-only inspection of the signed-in dashboard established Full DNS setup on the Free plan and the assigned pair. Its then-Pending status is superseded by the new Active report and DNS verification:

| Existing nameservers | Assigned Cloudflare nameservers |
| --- | --- |
| byte.dns-parking.com | kim.ns.cloudflare.com |
| pixel.dns-parking.com | norm.ns.cloudflare.com |

Keep the assigned Cloudflare pair in place. The agent has not changed registrar or Cloudflare settings. No application Worker deployment or live Messages connection is established by this domain change.

1. Retain the existing Active plause.si zone and assigned Cloudflare nameservers.
2. Compare imported records with the current DNS provider, including website records and any email MX/TXT records; automatic scanning may miss records.
3. Preserve the current delegation; any later DNSSEC change should follow Cloudflare's instructions and be verified separately.
4. Verify any existing website/email services still work. Application Worker deployment, custom-hostname routing and TLS remain separate checks.

Follow [Cloudflare's primary-zone setup](https://developers.cloudflare.com/dns/zone-setups/full-setup/setup/). No zone or nameserver change has been made by the agent.

### Activate the application

1. **Retain the isolated model evidence and expand acceptance deliberately.** The 2026-11-02 live run passed 3/3 cases with three completed `gpt-6-luna` generations, 1,433 microUSD app-estimated debit and zero held cost; temporary processes/data were cleaned up. Private `0600` report: `.local/model-evaluations/2026-11-02T17-14-32.989Z-635de353-916f-4063-9d12-30a4bc15f2cf.json`. Its evaluated source hash and token counts are recorded in [the handoff](../HANDOFF.md). The earlier pre-generation network failure had zero debit/hold; native Worker compatibility was fixed before the successful run. Future `npm run eval:model -- --live` invocations explicitly opt into paid requests with a fresh isolated database/account/keys/port, at most three serial generations and a US$0.03 app-ledger estimate limit rather than an invoice cap. Metadata and unknown holds are retained before cleanup. The primary preview stays mock; no primary hosted enablement, Sam-account workflow or restart is needed. This result does not accept memory/tool usefulness, other providers or Apple-device behavior. Store-only setup and readiness never invoke the evaluation; do not blindly retry uncertain calls. See [hosted model](hosted-model.md).
2. **Retain the completed staging evidence.** Schema, initial/closed-signup deployments, sole-account enrollment/return and three serial fictional AI replies are verified, with signup closed and zero held charges. The app estimated US$0.001423; this is not an invoice amount. No further coordinated model attempt is authorized. The separately approved resume UI update is independently verified deployed, with browser/DOM checks and unchanged model counts/cost. Broader production, Apple and operational acceptance remain distinct. See [activation results](staging-activation-review.md) and [UI deployment evidence](staging-ui-fix-deployment-review.md).
3. **Review before cloud changes.** Confirm the destination, source fingerprint, migrations, policy URLs, support contact, secret-name inventory, spending limits and rollback plan. Provisioning, DNS, migrations, secret upload and publication require a separately authorized action with actual account access. Never seed fictional local accounts into a cloud database.
4. **Accept authenticated web staging.** Verify real HTTPS sign-in, sign-out, reauthentication, ordinary/staff separation, linking/revocation, displayed delivery receipts, privacy controls, approvals and failure feedback. Check deployed queue/cron/DLQ recovery, erasure-ledger outage behavior and locked restore/deletion replay. Passing `/health` or static readiness is insufficient. See [operations runbook](operations-runbook.md) and [privacy/restore](privacy-and-restore.md).
5. **Enroll and accept Messages.** After Apple/MSP approval and real staff coverage, generate a new Sunshine config with `--sunshine-config-file`, `--apple-approved` and `--support-covered`. Add `--enable-messages-onboarding` only when ready to enable public first-contact notices. Its daily global cap defaults to 500 (`ONBOARDING_GLOBAL_DAILY_LIMIT`, maximum 5000); onboarding remains false without explicit opt-in. It never enables `APPLE_PROACTIVE_ENABLED`. Re-run readiness and carry out the device checks below before accepting users.

Keep the matching full encryption keyring with databases and backups. Never regenerate it to clear a readiness failure. The erasure ledger must survive independently of database backups. Search, Google Calendar and proactive Messages each require their own credentials, consent and acceptance; they are not enabled by model or identity setup.

## Real-device acceptance record

Record the actual environment/origin, source fingerprint, device/OS, enrolled provider identifiers, timestamp and redacted result for every check. Use consenting test accounts. Retain no credentials, login/link codes, private prompts or provider payloads in a public report.

| Workflow | Required evidence |
| --- | --- |
| First contact | An unlinked person's ordinary Messages greeting receives one honest Plause AI welcome and sign-in/link URL; no private account is created, no private history is exposed and no model is called. Duplicate provider events do not send another notice. Signup-closed copy remains truthful. |
| Proof and confirmation | The signed-in user creates a link code with explicit consent, manually sends `link plause CODE`, receives a proof acknowledgment, reviews the exact channel and separately confirms it. Proof acknowledgment does not claim the link is complete. The final linked notice is sent once. |
| Namespace and closure | Other subjects/accounts cannot claim the link or see the user's transcript. Expired/replayed codes fail safely. Closed, blocked, revoked, merged or provider-owned conversations cannot continue automated private replies. |
| Useful conversation | A real model handles ordinary requests and clarification; memory is explicit; notifications respect consent, timezone and quiet hours. No fabricated tool completion. |
| Exact actions | Full title/time/schedule or Google event ID/strong ETag is visible before exact, expiring, one-use approval. A repeated selection does not execute another write. Demo calendar is visibly simulated. |
| Provider behavior | Actual Apple rendering of text, links and approval quick replies; authentic webhook/closure/receipt captures; provider acceptance distinguished from end-user delivery. Lost acknowledgments are held for read-only reconciliation without automatic resend. |
| Support | Both linked users and new, unlinked senders can reach a human in the same Messages thread through the configured MSP. Verify actual staff takeover and reply, business-hours/expected-wait copy, and bot ownership before public activation. A web support link alone does not establish this path. Linked-account operator role/claim expiry and provider bot/human ownership prevent simultaneous replies. |
| Privacy and recovery | Export, forget/off, disconnect, account erase, queued/inflight revocation and independent-ledger restore replay tested; received messages and external calendar events are not claimed erased by a local account deletion. |
| Operations | Global pause and recovery, provider/model outage feedback, budget caps/unknown holds, queue and process restart, scheduler, alerts and retained-key restore verified on deployed resources. |

These are outstanding external acceptance gates until recorded. Automated local fixtures and the isolated HTTP suite establish implementation behavior; browser visual QA remains unverified under the current URL-security restriction, and no alternate browser path is authorized by this checklist.
