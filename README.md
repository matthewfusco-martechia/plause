# Plause

Plause is a personal AI agent whose main conversation lives in iMessage. We are adopting [Merit Systems’ OpenInstinct](https://github.com/Merit-Systems/OpenInstinct) as the agent base, following the user’s selection on 2026-11-02. Multi-step work, connected services and scheduled AI tasks must be verified before a pilot.

The confirmed target is **Cloudflare R2 storage and direct OpenAI models**, with Vercel service dependencies removed. Direct Linq is the preferred messaging candidate after the [Inkbox/Linq comparison](docs/messaging-provider-decision.md). The local application now uses direct provider adapters. Live provider acceptance remains pending.

## Agent application

[`agent-app/`](agent-app/) is the standalone Next.js/Eve application, pinned to upstream `d78cb0acf9724f5fa755e38e379c66138bdb8047`. Its MIT license and upstream attribution are retained; local patches and the lockfile record the provider migration. See [provenance and local changes](agent-app/PLAUSE.md) and the [adoption plan](docs/openinstinct-adoption.md).

This base supplies multi-step agent execution, browser workers, Gmail, Calendar, Contacts, memory and scheduled AI jobs. Its iMessage transport is **direct Linq**. Inkbox would require a different adapter. Apple Messages for Business is no longer the selected path.

The new application is local source only. It has no Plause service credentials, provider accounts, database, messaging line or deployment. Private enrollment, inference, Google writes, browser actions and public-query research are closed or disabled by default. Gmail, Calendar, Contacts and read-only Drive use direct per-user Google OAuth. Expiring approvals and durable dispatch receipts are implemented locally; live recovery and service acceptance remain required.

Use Node.js 24 and the package manager pinned in `agent-app/package.json`:

```sh
cd agent-app
pnpm install --frozen-lockfile --ignore-scripts
pnpm check
```

The unit tests use synthetic credentials, mocked providers and PGlite, with unmocked outbound requests denied. Do not use `pnpm dev`, deployment scripts, live evals or benchmark scripts as an offline check: those are separate workflows with service prerequisites. [Local validation](agent-app/PLAUSE.md#validation) records the exact commands and current results.

## Preserved staging foundation

The root `apps/`, `packages/`, `migrations/` and npm scripts belong to the existing Cloudflare Worker foundation. They remain separate from `agent-app/`. The password wall at [staging.plause.si](https://staging.plause.si) protects that Worker; it does not yet host the new agent application.

The existing database, encryption material, credentials and deployed configuration are preserved. No automatic account or conversation migration is performed. See [staging access](docs/staging-access.md), the [Worker documentation](docs/worker-foundation.md) and [HANDOFF](HANDOFF.md) for its verified behavior and historical tests.

Before any new public deployment, protect both the Next and Eve hosts, restrict enrollment, retain per-user authorization, and test the actual iMessage connection. Cloning the repository does not establish any live connection.

See the [owner setup checklist](docs/owner-setup-checklist.md) for the account, consent and device steps that require the owner's involvement.
