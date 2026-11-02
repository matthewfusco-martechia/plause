# Explicit saved memory

Plause can save a small set of facts that a user explicitly chooses to remember. Memory controls run deterministically in the backend; they do not ask an AI model to interpret or execute the command. They work in local mock mode without an OpenAI key. Apple Messages is still disconnected and messaging delivery is simulated.

There is no automatic memory extraction, background profile building, or model-authored memory write. Ordinary chat is not a request to save a fact. A model answer cannot authorize a memory change.

## Commands

Send one complete, unquoted command on one line:

| Command | Result |
| --- | --- |
| `remember: I prefer tea.` | Save an explicit fact |
| `remember that I prefer tea.` | The other supported save form |
| `memories` | List saved facts and their IDs, with memory on/off status |
| `what do you remember about me?` | The other supported list form |
| `update memory <mem_UUID>: I prefer coffee.` | Replace the fact with that ID |
| `forget memory <mem_UUID>` | Remove the fact with that ID |
| `forget all memories` | Remove all saved facts |
| `disable memory` | Stop using saved facts and block saves/edits; retain the facts |
| `enable memory` | Allow saved facts to be used and changed again |
| `memory help` | Display the supported commands and limits |

Use the actual `mem_` ID from the list in place of `<mem_UUID>`. It must contain a complete hyphenated UUID. Command words are case-insensitive; fact text retains its case. Listing also accepts a final period, question mark, or exclamation mark. Other controls use the exact forms above.

Each account can save at most 10 facts. A fact is limited to 300 JavaScript string units (UTF-16); some emoji use two units. Empty, oversized, multiline, malformed, and control-character content is rejected. Quoted commands, code blocks, and examples embedded in a larger message do not trigger a write. A command-like phrase inside an explicitly saved fact remains literal fact text and is not executed as another command.

## Memory on and off

Memory starts enabled for the local fictional accounts, with no saved facts. When enabled, the account's saved facts can be included in future model context. If a hosted model is explicitly configured, those facts can therefore be sent to OpenAI with the conversation prompt.

Disabling memory retains the encrypted facts but excludes them from model context. New saves and updates are blocked while it is off. Listing, exporting, and forgetting remain available. Enabling memory again makes retained facts available; it does not restore forgotten facts. Repeating an already-active setting is a no-op.

Facts belong to the authenticated internal account. The same account's channels share the memory setting and facts. Another account cannot list, export, edit, or forget them by guessing an ID.

## Changes and conversation context

A successful save cancels older pending automated work across that account's channels and changes the context revision. It retains completed recent conversation context.

Successful edits, forgetting a fact, forgetting all facts, and actual changes to the on/off setting also reset the future AI context boundary. Earlier conversation history is excluded from new model requests so a forgotten or corrected fact is not immediately reintroduced from an older chat turn. Older pending inputs/replies are cancelled across channels, leases are invalidated, and cached model content is purged or fenced against reuse. A concurrent or late model result cannot bypass the new context revision to commit an old reply.

The transcript remains visible. These operations do not erase original messages, prior assistant answers, or messages already delivered. A send already in progress can have an uncertain outcome and cannot be recalled. The system records uncertainty instead of claiming the message was cancelled at the provider.

Minimal model accounting metadata and possible-charge holds remain after cache content is purged. Memory changes do not refund an uncertain external request or reset the monthly budget. See [hosted model setup](hosted-model.md) for those limits.

## Export and privacy

An authenticated `GET /api/memories/export` returns a JSON download of that account's current memory setting and saved facts. Export also works while memory is off. Keep the downloaded file private; it contains the fact text in readable form. This endpoint exports saved memory, not a complete conversation or account archive.

Fact content is encrypted before database storage. Identifiers, ownership, timestamps, revisions, and operational metadata remain queryable. The backend decrypts facts to list, export, or use them; this is application-level storage encryption, not end-to-end encryption.

A conservative guard rejects password/passcode labels, API keys, access tokens, private keys, SSNs, card numbers, and some recognizable credential formats. It is not a complete sensitive-data classifier and can reject benign text too. Do not send secrets. Rejection prevents creation of a saved fact; it does not redact or erase the original command from the encrypted transcript.

This feature does not establish production account deletion, backup erasure, provider-side retention, or a complete privacy compliance workflow. Real hosted behavior, Apple/MSP integration, and production operational acceptance remain separate verification steps.
