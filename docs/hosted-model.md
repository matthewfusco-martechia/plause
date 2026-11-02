# Hosted model setup

Plause can use an OpenAI cloud model behind the existing conversation processor. Apple Messages remains disconnected, messaging delivery remains simulated, and the service remains a local development preview. The intended product is still an agent people text in Apple Messages; the browser console is a way to verify the backend while the real channel is being approved and integrated.

The hosted adapter can draft a bounded reminder, simulated calendar or real Google Calendar proposal for exact server review and approval, or request a bounded read from an explicitly connected Google calendar. It cannot execute a write, approve an action, automatically search, or mutate memory. Its context is the current message, bounded recent conversation, enabled saved facts, stable planning time/timezone and a nonsecret Google connection flag. Deterministic memory, reminder and action controls remain separate server capabilities. A generated answer is not evidence that a task ran. See [natural-language drafts](model-proposals.md) and [saved memory](saved-memory.md).

## Save a key before enabling requests

To store a key while keeping the existing model settings, use the hidden prompt:

```sh
npm run configure:model -- --store-only
```

This mode changes only `OPENAI_API_KEY` in the existing private `.dev.vars`. It does not select a model, enable hosted requests or make an API call. Existing hosted settings are preserved, so it does not disable a service that was already enabled. It requires an owner-only regular single-link configuration file and rejects `--enable`, `--status` or `--mock` in the same invocation.

As of 2026-11-02, the user-created key has been saved this way and verified without printing it. The primary local model remains mock and its existing encryption key is unchanged. The temporary transfer file was cleared and removed. The user completed billing setup and API credits are available. No purchase was performed by the agent. The isolated live evaluation below verified access to the selected model; a stored key or available credits alone does not establish that access.

## Run an isolated live evaluation

With a stored key and usable API billing, explicitly run:

```sh
npm run eval:model -- --live
```

This makes at most three serial model generations and their token-count requests. Each run gets a fresh local D1 database, source snapshot, random loopback port, new fictional account and new encryption material. The runner selects only `OPENAI_API_KEY` from the protected source configuration. It never uses the preview's accounts, history, saved facts, invitations or database. Keep the primary preview in mock mode; enabling or restarting it is unnecessary for this evaluation.

The checks cover a useful reply, recall of a fictional codename in the new conversation and an honest statement that no real calendar action was performed. Search, Google identity/calendar and real messaging stay disabled. Delivery uses the mock transport. This does not establish Apple delivery, Google consent or browser acceptance.

The isolated user permits three messages. User and deployment accounting caps are US$0.03, with 4,096 input tokens, 600 output tokens and a 20-second adapter deadline per call. The current conservative maximum reservation for three calls is US$0.003972. These are application estimates, not a provider invoice limit. The runner stops on the first failure and does not retry an accepted generation or automatically rerun a timed-out evaluation.

Before cleanup, the runner writes a private mode-0600 metadata report in `.local/model-evaluations/`, including source fingerprint, check outcomes and accounting attempt IDs, response IDs, tokens, debits and possible-charge holds. It contains no key, prompt, response text or source-account context. If evidence export fails, isolated state is retained and its temporary API-key file is removed. Preserve reports and unresolved holds; do not interpret cleanup as a refund or reconciliation. Use `--config PATH` for another protected key source or `--report-dir DIRECTORY` for another owner-private report directory.

The bare `npm run eval:model` command refuses without the explicit `--live` flag.

The first successful live run on 2026-11-02 passed **3/3 checks** using `gpt-6-luna`. All three accounting attempts completed, with input/output token counts of 1,821/26, 1,878/14 and 1,935/6. The conservative application debit totals 1,433 microUSD (US$0.001433), with no uncertain-charge hold; this is not an invoice reconciliation. The private report is `.local/model-evaluations/2026-11-02T17-14-32.989Z-635de353-916f-4063-9d12-30a4bc15f2cf.json`. It records source SHA256 `d727fd98c2c86fafcbb99a23ad5cb250fa42e9ff1a73873cdff1b872e7de9635`, all owned processes stopped and temporary data removed. No saved memories, Google connections, search calls or calendar requests were present. The primary preview was unchanged.

An earlier attempt failed before generation due to native Workers request incompatibilities; its report retains a zero debit and zero hold. Those defects were reproduced with intercepted native-runtime fixtures and fixed: default fetch is bound to its global receiver, and redirect mode is manual with explicit rejection. Generation redirects retain possible-charge holds. No uncertain generation was automatically retried.

## Enable from the terminal

Run local setup first if you have not already done so:

```sh
npm run setup
npm run configure:model
```

The configuration script asks for an OpenAI API key with terminal echo disabled. It then shows the selected model, request bounds, and monthly application budget limits. Type `ENABLE HOSTED AI` only if you want this local service to send messages, recent context, and enabled saved facts to OpenAI and incur API charges. Cancelling or entering another answer leaves the configuration unchanged.

The script writes the key to the existing `.dev.vars` using an atomic replacement with mode `600`. It preserves unrelated variables, including the content encryption key, webhook secret, and operator token. It makes **no API request** and prints no credential. Never place an API key in command-line arguments, shell history, browser fields, chat, or source control.

Restart the development server after configuration:

```sh
npm run dev
```

If it was already running, stop it and start it again. Check the local configuration without revealing the stored key:

```sh
npm run configure:model -- --status
```

The console distinguishes **Mock model**, **Cloud AI configured**, and **Cloud AI not ready**. Configured means that the server's local configuration passes validation. It does not mean the credential, model access, network, or provider billing has been verified. Each new assistant message records the model used; historical mock messages retain their own label after switching providers.

Enabling the primary preview permits its accounts' ordinary messages, recent history and enabled saved facts to reach OpenAI. Review existing queued work and account consent before that separate step. The isolated evaluation above does not enable this preview.

Use `npm run demo:memory` for the separate mock-only saved-memory smoke test, with no API key or hosted charges. Memory commands and list/export remain usable when hosted configuration is missing or model spending is blocked. Saves/edits remain subject to the memory-enabled setting and fact capacity.

## Explicit noninteractive setup

For a noninteractive local workflow, store the key alone in a private regular file owned by your user. Use a trusted editor or secret-management workflow to create it, then restrict its permissions. A file under `.local/` is excluded from version control.

```sh
chmod 600 .local/openai-key.txt
npm run configure:model -- --key-file .local/openai-key.txt --enable
```

`--enable` is the explicit opt-in to hosted requests using the documented model and bounds. `--key-file` and `--enable` are required together for enabling. To save a protected key file without changing model settings, use `npm run configure:model -- --store-only --key-file .local/openai-key.txt` instead. Noninteractive input by itself cannot enable the model. Symlinked, shared, oversized, and non-regular key files are rejected; store-only also rejects hard-linked inputs. The key is never supplied as an argument or printed. Keep the source key file private; the script does not delete it.

`--config /absolute/path/to/.dev.vars` can select another local configuration for an isolated smoke test. It must already contain the setup variables. This option does not provision or deploy a service.

## Configured bounds

| Variable | Value written by setup |
| --- | --- |
| `MODEL_PROVIDER` | `openai` |
| `LIVE_MODEL_ENABLED` | `true` |
| `OPENAI_MODEL` | `gpt-6-luna` |
| `MODEL_MAX_INPUT_TOKENS` | `4096` |
| `MODEL_MAX_OUTPUT_TOKENS` | `600` |
| `MODEL_TIMEOUT_MS` | `20000` |
| `MODEL_USER_MONTHLY_BUDGET_MICRO_USD` | `5000000` — US$5 per user/month |
| `MODEL_GLOBAL_MONTHLY_BUDGET_MICRO_USD` | `50000000` — US$50 across the service/month |
| `OPENAI_API_KEY` | Private value, never returned by the browser API |

Monthly budgets use UTC accounting periods. The application reserves estimated maximum request cost before dispatch so concurrent work cannot spend the same remaining allowance. Known outcomes settle against recorded usage. A timeout, interrupted connection, or crash can leave provider acceptance and charges uncertain; that reservation stays held rather than automatically releasing funds and retrying. An unresolved hold may reduce the available app budget until reconciled.

The reviewed `gpt-6-luna` rate policy uses conservative upper estimates of US$0.25 per million input tokens and US$0.50 per million output tokens. The input bound covers the short-context input/cache-write rates reviewed on 2026-10-30. This is a local cost policy, not an exact provider quote or invoice. Source: [OpenAI API pricing](https://developers.openai.com/api/docs/pricing). Unsupported/unpriced models fail closed rather than inheriting these rates.

The adapter performs exact input-token preflight with the same model, instructions, input, tools, reasoning effort and truncation settings as generation, and makes no generation retry. [OpenAI token-count guidance](https://developers.openai.com/api/docs/guides/token-counting). Completed output is encrypted and saved before the reply/outbox transaction so recovery can reuse it after a crash. Input digests and durable attempt tombstones prevent a changed or repeated dispatch from generating again. Ownership and lease gates are checked again before billable generation and reply persistence.

Saved facts are bounded JSON data in the prompt, not authority to change instructions or execute actions. Deterministic memory controls bypass model execution and are excluded from future chat history. Effective memory changes advance the account context revision, cancel older pending work across channels, and purge/fence old caches. Edits, forgetting, and on/off changes reset future history; adding a fact preserves completed recent context. A late hosted response cannot bypass the new revision to restore old context. Possible-charge holds remain even when personalized cache data is purged.

The default 20-second adapter deadline sits inside a 25-second processor envelope, including five seconds for persistence, and a 60-second conversation lease. An overall timeout terminally fails that input and requests cancellation. Output that arrives after the terminal cutoff is not automatically resurrected or delivered, even if a late cache record exists. An operator must inspect it; this milestone has no reconciliation or replay endpoint. Do not treat repeated submission as a safe recovery procedure for an uncertain charge.

Deleting a source message purges its encrypted cached output and input digest. Minimal accounting metadata and debits survive so transcript deletion cannot refund a possibly charged request against the monthly allowance. The independent account-erasure and restore workflow is described in [privacy and restore](privacy-and-restore.md); production acceptance remains separate.

These are application ledger limits, not a provider account spending limit. Provider billing is authoritative and can differ from the local ledger. Keep provider-side project limits and usage monitoring appropriate to the intended test. Enabling configuration does not prove billing accuracy or live end-to-end reliability.

## Return to the simulator

```sh
npm run configure:model -- --mock
```

Restart `npm run dev`. This sets `MODEL_PROVIDER=mock` and `LIVE_MODEL_ENABLED=false`; it retains the private key for a later explicit setup. It does not remove prior messages or reset held reservations. Returning to hosted mode requires the setup opt-in again.

## Verification boundary

Configuration can be checked with fake credentials and temporary files without contacting OpenAI. Automated adapter tests use controlled responses, including enabled/disabled saved facts and concurrent privacy changes. Seven offline runner fixtures verify isolation, three-turn limits and failure-evidence preservation. Current suite, versioned migrations, build and mock smoke results are recorded in [the handoff](../HANDOFF.md). Only `npm run eval:model -- --live` opts into the separate bounded provider evaluation. No deployment occurred.

Native Workers fixtures exercise default fetch behavior through a local all-egress interceptor, using fake credentials. They cover successful requests, unsupported-redirect prevention and retained uncertainty for redirected writes across OpenAI, search, messaging and Google clients. The final full check passes TypeScript, 1,259 Worker tests and 104 Node tests; the fresh HTTP suite passes 14/14 scenarios on the same source fingerprint as the live model evaluation. The deployment dry run also passes. These results do not connect the remaining providers.

A real key and the isolated hosted conversation are verified. Provider invoice reconciliation and deployed-service acceptance remain unverified. Browser visual/interaction QA is also unverified because the browser URL security policy blocked the local page; no workaround was attempted. Apple/MSP integration, device acceptance, staffed support, production authentication, and external action tools remain separate milestones.
