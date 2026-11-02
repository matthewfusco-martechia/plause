# Private staging access

Updated 2026-11-02. The password wall on **https://staging.plause.si** is deployed and independently verified by cloud metadata and 15 HTTP checks. Manual Chrome password-prompt acceptance is still pending; an automated in-app-browser Basic-auth attempt failed and is not browser acceptance evidence.

Use username **plause**. The generated password is stored only in owner-private `.local/staging-access/credentials.txt` (`0600`, directory `0700`); open it locally and enter it in the browser prompt. Do not put its value in chat, URLs, command arguments or logs. The Worker receives only the password's SHA-256 digest as secret `STAGING_ACCESS_PASSWORD_SHA256`. The generated password has 32 random bytes; no plaintext password is stored in Worker configuration.

The gate runs before every HTTP handler and asset, including health, readiness, APIs and OAuth callbacks. Missing/wrong credentials return 401 with the Basic challenge and `Cache-Control: no-store`. Malformed enabled configuration, a non-staging environment or plain HTTP fails closed. Authorized responses also remain no-store and vary on Authorization. There are no public route exemptions. The local preview remains unchanged unless the gate is explicitly enabled.

The whole-host wall also deliberately gates future MSP webhooks and callbacks. Before enabling Apple, review provider-compatible authenticated ingress/credentials or a separately reviewed production hostname; never silently exempt paths. Apple is currently off, so no incoming provider connection is affected.

Passing this wall does not sign into Google or grant account/staff permissions. Google signup stays closed. A correct staging password without a Google session still receives the ordinary private-API 401 without another Basic challenge. Google sign-out and the browser's cached Basic credentials are independent.

The verified checks covered anonymous root/assets/health/ready/auth/private APIs/OAuth callback and HEAD requests, wrong-password rejection, correct-password root/assets/readiness/auth status, and the separate Google session boundary. Cloud metadata matched the deployed version, six secret names/types, unchanged bindings/hostname/queues/cron, signup=false and both 30,000 microUSD monthly app-accounting limits. Apple, Calendar, search and operator bootstrap remain off. Guarded deployment exited 0 with zero terminal input, no prompts and no retry.

Current deployed/tested source snapshot: `896ba61864886be8fb3b29987d77bec7143b83db9752ea766d629793eb55d785` (70 runtime files). The full check passed TypeScript, 1,332 Worker tests across 43 files and 117 Node tests: **1,449 tests**. The 48 focused gate fixtures passed. The prior 14-scenario HTTP E2E and three coordinated cloud AI tests retain their earlier snapshots; they were not rerun for this wall.

The original coordinated AI test passed 3/3 at **1,423 microUSD** estimated app debit. A later, separately observed account turn occurred **before** password deployment. Current account totals are 4 completed model attempts and **1,969 microUSD (US$0.001969)** estimated app debit, with no holds; no model request occurred after the wall deployment. That fourth turn's contents were not read and its actor was not attributed. It is not an additional coordinated test or agent-sent model call. One Google account, two valid sessions and zero operator roles remain.

Future staging changes must use the canonical protected configuration **`.local/staging-preparation/wrangler.staging.password.json`**, preserving `STAGING_ACCESS_ENABLED=true` and all six required secrets. Do not deploy the older closed-signup configuration: it predates this wall. `.local/staging-preparation/staging-access-secret.json` contains only the new hash key; the verified update retained the existing five server-side bindings. That file is not a complete secret set for a new Worker. Use the reviewed guarded deployment path and retain its receipts.

Apple/MSP enrollment, contract and live Messages acceptance remain separate. See [deployment instructions](cloud-deployment.md) and [handoff](../HANDOFF.md).
