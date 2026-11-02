# Local Google sign-in setup

This configures the existing Google identity flow for local testing. The cloud staging origin now first requires its separate [password wall](staging-access.md), which is HTTP/cloud verified while manual Chrome prompt acceptance remains pending. Cloudflare DNS for plause.si is active; the separate staging client is deployed and initial HTTPS enrollment is verified, with signup now closed. Returning staging sign-in is confirmed by user/browser/database evidence. All three approved fictional cloud AI tests then passed with 1,423 microUSD estimated app debit and no held costs; no further coordinated attempt is authorized. This command does not create a Google project, register a client, grant Calendar access or deploy Plause.

Verified setup state on **2026-11-02**: **Plause Development** (`plause-development`), its consent application and the **Plause Local Sign-in** Web application client exist. The user created the client and downloaded JSON; fresh Chrome UI confirmed **OAuth client created** and the completed download. Its only callback is below, JavaScript origins are empty, and **Use this client for an AI-powered agent** is unchecked because it serves human sign-in. A protected copy is `.local/google/local-client.json` (`0600`) inside a `0700` directory; the original download was also restricted to `0600`. Keep its original filename, credentials, contact addresses, client/account/organization IDs and project number private.

All four local Google identity checks passed on 2026-11-02, with user confirmation and count-only SQL: initial OAuth/login/session, sign-out through the new header button, returning sign-in to the same account with signup closed, and Account→Review confirmation→Confirm with Google. The final private `.local/identity-acceptance.json` is 0600 and records passed=true with count-only stage metadata, no IDs/emails/tokens. Final state: 1 Google identity, 1 valid/fresh session, 4 successful login audits, 3 invitation accounts with 0 identity associations, 1 web binding, 0 model attempts and 0 connected calendars. An additional unconsumed reauth request expired naturally; final valid pending flows 0 and unconsumed flows 0, without deleting records. No manual step remains pending for this bounded local identity sequence. Current preview session **28661** is unchanged; identity configured/enabled, signup false, readiness true, mock model/messaging and Apple off. Global product live acceptance remains false.

Signup was closed without disabling identity:

```sh
npm run configure:identity -- --client-file .local/google/local-client.json --enable
```

The user could not find the old sign-out control at the bottom of the independently scrolling sidebar. Its sole button is now persistent in the masthead beside the environment label, with a 44px minimum touch target and narrow-screen wrapping. It stays hidden while logged out and is shown by `openSession`; the existing DELETE handler is unchanged. Only the three public UI files changed. Five existing focused UI tests passed via `node --test --test-name-pattern='console|account confirmation|Messages entry' scripts/e2e.test.mjs`, and `node --check apps/api/public/app.js` passed; no new tests were added. The full suite/E2E/build have since passed with the button and controlled cloud-enrollment changes. The current E2E snapshot is `26e700886370ffc89032ad2c8152ca47780521b78fbb91e2dadb1e0f877df74a`; the older live-model evaluation is historical and was not rerun. The button move did not change the model adapter; backend identity changed for controlled cloud enrollment. The user subsequently confirmed the header button works, and SQL verified sign-out; broader visual/accessibility acceptance remains separate from this bounded identity flow.

The accepted stages were:

| Stage | Google identities | Valid sessions | Successful login audits |
| --- | --- | --- | --- |
| Initial login | 1 | 1 | 1 |
| User-confirmed sign-out | 1 | 0 | 2 |
| Returning sign-in, signup closed | 1 | 1 | 3 |
| Fresh confirmation | 1 | 1 | 4 |

The earlier setup was interrupted by iCloud dataless reads and an `IDENTITY_CONFIG_CHANGED` refusal without an update. Finder **Keep Downloaded** was applied to the exact Plause folder and keyring source hydration verified; complete folder hydration is not established. Session 25186 later stopped after ENOSPC log-write and V8 heap errors, whose causal relationship remains unproven. The user freed space (59GiB verified), and recovery session 44986 passed homepage/ready checks. It was intentionally stopped with its port verified free before the current restart. No guard weakening, key regeneration, heap-limit change or data reseed was used.

1. Retain the existing **Plause Development** (`plause-development`) consent application and **Plause Local Sign-in** Web client; creating a replacement is unnecessary. This client serves human sign-in; keep Calendar agent clients separate. [Google's consent setup](https://developers.google.com/workspace/guides/configure-oauth-consent), [client prerequisites](https://support.google.com/cloud/answer/15549257?hl=en). Plause sign-in requests only `openid profile`; Google's Testing status and test-user list do not restrict authorization for these basic identity scopes. Use Plause's own signup setting and controlled enrollment, rather than the Google test-user list, to govern account creation. [Google's basic-identity exception](https://support.google.com/cloud/answer/15549945?hl=en).
2. Give this dedicated local client exactly this authorized redirect URI:

   ```text
   http://localhost:8787/api/auth/google/callback
   ```

   Leave JavaScript origins empty for this server-side sign-in client. Keep cloud clients separate. Google requires the redirect to match the registered value; local HTTP is permitted. [Google web-client setup](https://developers.google.com/identity/protocols/oauth2/web-server#creatingcred), [Google identity setup](https://developers.google.com/identity/openid-connect/openid-connect#setting-up-oauth-20).

3. The local JSON is already downloaded/protected. For any future credential download, protect its actual path:

   ```sh
   chmod 600 "/absolute/path/to/downloaded-client.json"
   ```

4. Local configuration is already enabled. For a future authorized reimport from the Plause folder:

   ```sh
   npm run configure:identity -- --client-file "/absolute/path/to/downloaded-client.json" --enable
   npm run configure:identity -- --status
   ```

   Substitute the real file path. The command validates a dedicated local web client, preserves encryption and unrelated settings, writes privately, and makes no network request. It prints configuration status without credential values. Native/installed clients, additional redirects and cloud origins are rejected.

5. Account creation defaults off (`AUTH_SIGNUP_ENABLED=false`) and is now closed again after the first real enrollment. Google identity remains enabled. This flag permits new account creation; it is not limited to Google's test-user list. Staging signup was opened only for the approved sole enrollment and is now independently verified closed. Cloud signup now additionally requires private `AUTH_SIGNUP_SUBJECTS` containing 1–5 unique exact verified Google subjects, with missing/malformed policy failing closed; the local signup flag alone is not a cloud admission mechanism. The verified Google account is distinct from the fictional invitation accounts; matching email/display names do not merge them.
6. The bounded local identity sequence is complete at exactly `http://localhost:8787`: initial login, sign-out, returning sign-in with signup false and fresh confirmation. Keep the registered localhost origin; 127.0.0.1 is not its replacement. The separate staging Google client is now downloaded/validated at `.local/google/staging-client.json` (0600), with exact staging callback/no JS origins and distinction from this local client; initial staging HTTPS Google enrollment is verified, signup is closed, and returning staging sign-in is confirmed by user/browser/database evidence. Historical staging counts after the three coordinated cloud AI tests were 1 Google account, 2 valid sessions, 1 web binding, 3 successful sign-ins, 3 model attempts and no operator roles/invitation users/calendars. Calendar still requires its own separate credentials/consent. The prior validation passed TypeScript, 1,284 Worker/107 Node tests, 14/14 isolated HTTP E2E and build dry run. The later password-wall full check passed TypeScript, 1,332 Worker/117 Node tests (1,449 total) at snapshot `896ba61864886be8fb3b29987d77bec7143b83db9752ea766d629793eb55d785`. The later readiness CLI patch passed 19 focused tests/Node111; the separately deployed resume UI correction passed syntax, 7 focused checks and Node113. The earlier 69-file match predates that HTML/JS change; the later full check above does not imply a new 14-scenario HTTP E2E or paid model run. Current account totals are 4 completed attempts/1,969 microUSD, including an unattributed pre-wall turn; no post-wall model call occurred at readback. Mock-provider E2E reports browser acceptance false; the four real local identity steps above are separate manual/count-only evidence. The live-model evaluation remains historical with no charged rerun.

To disable local Google sign-in while retaining its credentials:

```sh
npm run configure:identity -- --disable
```

The command applies only to an existing protected local `.dev.vars`; `--config` selects a different private local file for isolated setup. Never put client secrets in chat, source control, shell arguments or the browser console. Use [cloud deployment](cloud-deployment.md) for separate staging/production clients and secrets, and [identity/support](identity-and-support.md) for the implemented trust boundaries.
