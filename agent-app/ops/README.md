# Private self-hosting

This is a source runbook, not an instruction to deploy the current build. No new service, database, line or bucket has been provisioned for this application.

Use a Node 24 host with persistent disk. Keep the Next server on 127.0.0.1:3000 and its Eve child on 127.0.0.1:4274; expose only the TLS reverse proxy. Keep exactly one Eve schedule runner when using the default local workflow world. Persist `.eve/.workflow-data`, the PostgreSQL database, encryption keys and the private R2 bucket across restarts. R2 does not replace the database or workflow world. Local and Postgres workflow worlds require a planned session migration when Eve changes version.

Prepare credentials in a server secret manager using `.env.example`, then run `pnpm check:config`. It reports presence, not provider health. Keep `LIVE_MODEL_ENABLED=false` and `GOOGLE_WORKSPACE_WRITES_ENABLED=false` until a bounded live test is reviewed. Configure Google consent and APIs for the actual requested scopes; register the exact `/api/connections/google/callback` URI on the chosen application origin. Do not reuse the old Worker's sign-in client without checking its different callback contract.

For a reviewed installation, back up and migrate the intended PostgreSQL database explicitly with `pnpm db:migrate`. Build the Eve agent and Next application, then run `next start --hostname 127.0.0.1 --port 3000` under a process supervisor. Next's `withEve` starts the built Eve service. Build with Docker available or explicitly configure a compatible sandbox before testing attachments; `--skip-sandbox-prewarm` is a compilation convenience and does not accept attachment execution.

`Caddyfile` is a private reverse-proxy template. Set `PLAUSE_HOST` and a locally generated `PLAUSE_ACCESS_HASH`, validate it with Caddy, and review it before activation. It password-protects all app/browser routes and preserves their separate account authorization. Exact signed Linq, internal HMAC and workflow callback paths go to Eve. These callbacks enforce their own authorization; do not replace the exact matcher with `/internal/*`. Do not expose either Node listener directly. The existing staging password is not automatically applied to a new host.

Run one schedule owner. Set `BETTER_AUTH_URL` to the canonical HTTPS origin. Public callback routing must reach that same build. Configure Linq's signed webhook at `/webhooks/linq`; its assigned sending line must match `LINQ_PHONE_NUMBER`. Confirm signatures, duplicate delivery, offline recovery, attachments and an actual iPhone conversation before claiming iMessage acceptance.

The spending ledger reserves conservative maximum cost before each paid generation. An ambiguous provider outcome holds that reservation; it is never automatically refunded or replayed. A database or credential failure stops generation. Configure provider-side budgets independently: this application ledger does not cap the provider invoice.

Do not log request bodies, OAuth codes, authorization headers or query strings. Database/workflow backups contain conversation data; restrict access and define retention. Private bucket settings, encryption keys and object deletion need separate acceptance. No hosted deployment should proceed until the approval, enrollment and erasure acceptance gates in the adoption plan are satisfied.

References: installed Eve self-hosting and Next.js hosting documentation; [Caddy password protection](https://caddyserver.com/docs/caddyfile/directives/basic_auth) and [reverse proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy).
