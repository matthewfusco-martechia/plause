# Plause agent

Plause is a personal AI agent built from [OpenInstinct](https://github.com/Merit-Systems/OpenInstinct/tree/d78cb0acf9724f5fa755e38e379c66138bdb8047). Users will message its Linq line in iMessage. The web app manages connections, conversations, memory, schedules and the encrypted vault.

The selected stack uses **direct Linq, OpenAI, Cloudflare R2, PostgreSQL and Kernel**. A Node host runs Next.js and Eve. Vercel is not required. R2 stores private memory and images; PostgreSQL stores identities, application state and spending records. Eve also needs persistent workflow storage.

This application is under development and has not replaced the separately protected Worker at staging.plause.si. Provider configuration does not prove a working connection. [PLAUSE.md](PLAUSE.md) records validation and remaining acceptance work. [LICENSE](LICENSE) retains Merit Systems' MIT license.

## Local checks

Use Node 24 and pnpm 11.24.0:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm check
pnpm test:runtime
pnpm test:runtime --openai
```

The unit suite and runtime fixtures use synthetic credentials and mock providers. Runtime fixtures need permission to bind a temporary loopback port. They do not test a real iMessage line or paid model. For a compile check, use synthetic environment values; `pnpm build -- --webpack` is the local fallback when Turbopack encounters sandbox restrictions.

## Configure a private installation

Copy `.env.example` to `.env.local` yourself and populate secrets locally. `pnpm check:config` reports missing names without printing values or contacting providers. Model inference and Google writes default off. Connection credentials must be separate from the older Worker installation.

`pnpm dev` starts an isolated Docker PostgreSQL container, applies migrations to that container and starts Next.js. Stop it to stop the container; its named volume preserves data. `pnpm dev:app` uses an already prepared database. Neither command provisions provider accounts. Do not use these commands merely to run the mock suite.

See [self-hosting](ops/README.md) for process, routing, persistent storage and the reviewed activation boundary. Database migrations are an explicit operator step outside the isolated development container. Google sign-in for Workspace access is separate from Plause phone-number authentication.

## Capabilities and limits

The coordinator delegates resumable browser tasks, uses Gmail/Calendar/Contacts and read-only Drive tools, recalls private memory and workstreams, and runs scheduled workflows. Direct provider adapters and durable guards are being validated locally. Live acceptance remains required for every connection.

Gmail and Calendar mutations default off; enabled mutation tools require approval. Browser actions need a separate authority review before live use. Link purchases are unavailable. This does not yet establish feature parity with Instinct or readiness for a pilot.
