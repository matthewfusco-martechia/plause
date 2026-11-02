# Plause staging deployment proposal

**Current staging is password protected.** Cloud metadata and 15 HTTP cases passed; manual Chrome password-prompt acceptance is pending. Future changes use `.local/staging-preparation/wrangler.staging.password.json`, retaining six required secrets. The older closed-signup config is historical and must not replace it. See [staging access](staging-access.md).

Updated 2026-11-02 after plause.si became Active and the user completed Wrangler authorization. Public recursive and `.si` parent DNS confirm Cloudflare's assigned nameservers. Prefer hosted AI, Google sign-in and authenticated web chat at `https://staging.plause.si`. The approved Worker/custom hostname is now deployed and initial Google sign-in over HTTPS is verified; returning login and all three bounded cloud AI tests are verified, with 1,423 microUSD estimated app debit and no held costs. [Custom-domain requirements](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/). Workers.dev remains an optional fallback that does not depend on custom DNS. [Workers.dev routing](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/).

## Selected resources

The four backing resources below were created after explicit user approval and independently verified on 2026-11-02. Actual IDs remain in private `.local/staging-bootstrap/provisioning-plan.json` (0600), state `provisioned_verified`; account selection remains private. This approval excluded upgrades/checkout, billing changes, migrations, secrets, Worker/domain deployment and live Messages. Creation proves access for these four operations, not future deployment rights or zero future usage cost. The later separately approved activation deployed the Worker and hostname; an account Workers.dev subdomain is needed only if that optional origin is selected.

| Resource | Selected name/origin | State |
| --- | --- | --- |
| Worker | `plause-staging` | Initial and closed-signup deployments independently verified |
| Application origin | `https://staging.plause.si` | Custom hostname verified; initial Google enrollment over HTTPS passed |
| D1 database / binding | `plause-staging-db` / `DB` | All 19 migrations applied and independently matched; no local fixtures imported |
| Work queue / binding | `plause-staging-jobs` / `JOBS` | Deployed producer/consumer verified |
| Dead-letter queue | `plause-staging-dlq` | Deployed consumer verified |
| Private R2 ledger / binding | `plause-staging-privacy-ledger` / `PRIVACY_LEDGER` | Created; Standard/ENAM, r2.dev off, no custom domains |
| Optional temporary origin | `https://plause-staging.<actual-account-subdomain>.workers.dev` | Account subdomain not verified |

At allocation, separate GET metrics for both queues returned backlog_count=0/backlog_bytes=0 as a best-effort snapshot. R2 bucket info reported 0 and an unfiltered per_page=1 object-list response returned 0 objects. Because that response omitted an explicit truncation flag, record only the observed zero returned objects for this new bucket. No application data, producers or consumers were installed during allocation. They were added only through the later approved activation; no local fixtures were uploaded.

Use `APP_ENV=staging`, hosted OpenAI and `MESSAGING_PROVIDER=web`. Keep Sunshine, Apple onboarding/proactive notifications, research and Google Calendar disabled initially. Google **account sign-in** is enabled; Calendar permission is separate. The sole allowlisted account has enrolled over staging HTTPS; the follow-up deployment has independently verified signup=false and no operator roles. Controlled cloud enrollment is implemented: enabled signup requires private `AUTH_SIGNUP_SUBJECTS` with 1–5 unique exact verified Google subjects. Malformed/missing policy fails closed; admission grants no operator privileges. Focused validation was followed by the full passing 1,391-test check, 14/14 isolated HTTP E2E and build dry run; initial cloud identity enrollment and both deployments are verified; returning login and all three bounded cloud AI tests are verified, with 1,423 microUSD estimated app debit and no held costs. Create real tester accounts through Google, not fictional SQL fixtures.

## Exact origin and callbacks

Set `PUBLIC_ORIGIN=https://staging.plause.si`, without a trailing slash. Register its exact sign-in callback in the separate staging Google web OAuth client. Use the fallback column only if that alternate origin is explicitly selected and the account subdomain has been verified:

| Purpose | Optional Workers.dev staging | Preferred custom staging |
| --- | --- | --- |
| Account sign-in | `https://plause-staging.<actual-account-subdomain>.workers.dev/api/auth/google/callback` | `https://staging.plause.si/api/auth/google/callback` |
| Calendar, only if enabled later | `https://plause-staging.<actual-account-subdomain>.workers.dev/api/calendar/google/callback` | `https://staging.plause.si/api/calendar/google/callback` |

The angle-bracket label must be replaced with the verified account value; it is not a hostname to register. Google requires exact callback matching and HTTPS. Use a separate testing project, but do not treat Google's test-user list as an access restriction for Plause: its current `openid profile` scopes fall under Google's basic-identity exception. The initial approved config used `--enable-signup` for the sole selected subject; the account enrolled and the verified follow-up deployment closed signup. Cloud signup requires private `AUTH_SIGNUP_SUBJECTS` and admits only its 1–5 unique exact verified Google subjects; the flag alone is insufficient. Returning sign-in and reauth are independent. Initial staging HTTPS consent/enrollment and user/browser returning sign-in passed; independent database counts now reconcile the returning session. [Redirect requirements](https://developers.google.com/identity/protocols/oauth2/web-server#uri-validation), [Google staging guidance](https://developers.google.com/identity/protocols/oauth2/production-readiness/brand-verification#projects-used-in-development-testing-or-staging-tiers), [Google audience and basic-identity exception](https://support.google.com/cloud/answer/15549945?hl=en).

For the preferred custom origin the generator emits the staging hostname route with `custom_domain:true`, `workers_dev:false` and `preview_urls:false`. Confirm there is no conflicting CNAME on that hostname before activation. The optional Workers.dev pattern emits `workers_dev:true` and no custom route. If switching origins later, review configuration and callback registration together, disable the old route and require fresh sign-in; sessions do not transfer between origins.

## Prepared provisioning plan

Private files in `.local/staging-bootstrap/` retain the confirmed account selection, executed four-resource command plan and independent verification:

- `wrangler.json`: provisioning scope only, with `APP_ENV=staging`, no entrypoint, assets, routes, bindings, secrets or environment blocks. Both public endpoint flags are false. It is not an application deployment configuration.
- `provisioning-plan.json`: created resource names/IDs, independent verification, exact executed command arrays and baseline checksums. Its state is `provisioned_verified`. Actual IDs are private and are not repeated in this document.

The directory is 0700 and both files are regular owner-only 0600, without links. Creation used the reviewed isolated bootstrap and preserved the baseline hashes of `wrangler.jsonc`, `.dev.vars` and the bootstrap. The plan contains no provider credentials. No billing settings were changed. Do not deploy this bootstrap or repeat its completed creation commands.

The executed command forms for installed Wrangler 4.156.0 are retained below as a record, not instructions to repeat:

```sh
PLAUSE_STAGING_BOOTSTRAP_DIRECTORY="$PWD/.local/staging-bootstrap"
PLAUSE_STAGING_BOOTSTRAP_CONFIG="$PLAUSE_STAGING_BOOTSTRAP_DIRECTORY/wrangler.json"

node scripts/wrangler.mjs d1 create plause-staging-db --update-config=false --config "$PLAUSE_STAGING_BOOTSTRAP_CONFIG" --cwd "$PLAUSE_STAGING_BOOTSTRAP_DIRECTORY"
node scripts/wrangler.mjs queues create plause-staging-jobs --config "$PLAUSE_STAGING_BOOTSTRAP_CONFIG" --cwd "$PLAUSE_STAGING_BOOTSTRAP_DIRECTORY"
node scripts/wrangler.mjs queues create plause-staging-dlq --config "$PLAUSE_STAGING_BOOTSTRAP_CONFIG" --cwd "$PLAUSE_STAGING_BOOTSTRAP_DIRECTORY"
node scripts/wrangler.mjs r2 bucket create plause-staging-privacy-ledger --update-config=false --config "$PLAUSE_STAGING_BOOTSTRAP_CONFIG" --cwd "$PLAUSE_STAGING_BOOTSTRAP_DIRECTORY"
```

These four creation commands completed under the explicit resource-only approval. They used the absolute `--config` and isolated `--cwd`. Omit `--binding`, `--use-remote` and `--env`: in this installed Wrangler version, a supplied binding can override `--update-config=false` and cause a configuration edit. Queue creation prints configuration snippets without updating the file. The actual allocated D1 UUID is saved in the protected plan for full configuration generation.

## Supply provider credentials and allocated resource IDs

Historical initial preparation: the separate **Plause Staging Sign-in** client was created/downloaded and validated for project, exact single callback/no JS origins and a distinct client from localhost. Source/copy `.local/google/staging-client.json` are 0600. The private five-secret input includes the new independent staging keyring, stored OpenAI key, dedicated Google client and one verified subject. Initial private `wrangler.staging.json` was generated, matches allocated resources and initially admitted only that subject; enrollment is complete, signup is now closed and no operator roles are assigned. Generic generator defaults did not change; the reviewed private config sets both monthly model budgets to 30,000 microUSD (US$0.03 app accounting, not an invoice cap). Only protected local keyring storage is verified; external escrow is not. No local database, fictional identities or local encryption key will be uploaded.

To generate the actual private configuration, use the saved account and allocated D1 ID from the protected plan, retain the exact created queue/bucket names and use the completed protected staging secret file containing `CONTENT_ENCRYPTION_KEY`, `OPENAI_API_KEY`, `AUTH_GOOGLE_CLIENT_ID` and `AUTH_GOOGLE_CLIENT_SECRET`, plus private `AUTH_SIGNUP_SUBJECTS` for reviewed signup enablement. The generator validates shapes, not provider access. [Generation and deployment commands](cloud-deployment.md).

The four resource-creation operations succeeded without a billing change or checkout. This does not establish future Worker/domain permissions, subscription terms or that deployment/usage has no cost; any later required checkout remains a user action. OpenAI also needs an authorized key and usable project billing. No prices or account entitlements are assumed. [R2 prerequisites](https://developers.cloudflare.com/r2/get-started/), [Workers plans](https://developers.cloudflare.com/workers/platform/pricing/), [Queues plans](https://developers.cloudflare.com/queues/platform/pricing/).

## Approved activation status

[Staging activation](staging-activation-review.md) was approved. All 19 remote migrations, both deployments, reviewed bindings/queues/cron, custom hostname and five secrets are independently verified. The user enrolled the sole Google account; signup is now false, returning sign-in and all three bounded cloud AI tests passed, with 1,423 microUSD estimated app debit and no held costs. The actual five-secret config passed target-web static readiness (configurationReady=true/liveReady=false/networkRequests=0) and dry run at 1,336.21KiB / 241.21KiB gzip with isolated cwd/outdir, no secrets file and no serialized upload artifact; no secret values were found in 6 bundle files. The readiness CLI patch passed 19 focused tests/Node111; the later resume UI correction passed syntax, 7 focused checks and Node113 and is now independently verified deployed. The earlier 69-file match predates that HTML/JS correction and used the 1,284 Worker/14 E2E snapshot 26e700886370ffc89032ad2c8152ca47780521b78fbb91e2dadb1e0f877df74a. A later full password-wall check passed TypeScript, 1,332 Worker/117 Node tests (1,449 total) at the 70-file snapshot `896ba61864886be8fb3b29987d77bec7143b83db9752ea766d629793eb55d785`; it does not rerun the older HTTP E2E or paid model tests. Current totals are 4 completed attempts/1,969 microUSD, including one unattributed pre-wall turn; no model call occurred after wall deployment at readback. No further coordinated model attempt is authorized. The approval covers only the exact reviewed schema/Worker/secret/domain/queue/cron/sole-account/three-attempt test steps; Apple and other integrations remain off.
