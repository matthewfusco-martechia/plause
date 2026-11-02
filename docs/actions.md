# Typed actions and the simulated calendar

This milestone establishes explicit tool contracts and approval handling with a local demo calendar. It does not connect Google Calendar, Apple Calendar, an OAuth account, or any external calendar API. All events, connection state, and writes are simulated in Plause's local database. No API key is needed for these commands. Apple Messages remains disconnected.

Complete explicit user commands enter the deterministic action handler. The optional hosted model can also return one strictly typed draft for server validation and a separate exact approval; see [natural-language drafts](model-proposals.md). Model output, quoted examples, retrieved text, and a bare `yes` cannot execute or approve an action. Deterministic acknowledgments use `model: "plause-actions"` and are excluded from future AI history. During human support, acknowledgments remain `local_only`; a command does not restart the bot.

## Commands

Send one command on one line:

```text
connect demo calendar
calendar events
propose calendar event at <ISO time with offset> for <minutes> minutes: <title>
approvals
approve <approval_UUID>
reject <approval_UUID>
cancel demo event <event_UUID>
disconnect demo calendar
action help
```

Replace placeholders with the exact values from a proposal or event confirmation. A time must be an actual future date within 365 days and include an explicit timezone offset, such as `2030-06-01T10:00:00-04:00`, or `Z` for UTC. The example demonstrates the format; choose a date within the allowed range when running it. Natural dates such as “tomorrow afternoon” and timezone-free local times are rejected. Durations are whole minutes from 1 through 480. Titles are plain text up to 200 UTF-16 units and preserve their case.

The demo calendar starts disconnected. Connecting grants the internal simulated calendar scopes; it is not a real OAuth consent or provider permission. Calendar reads cover ongoing/upcoming events in the next 30 days and return at most 20 records, prioritizing active events. A user can have at most 20 active future events and 20 unexpired pending approvals. Long titles may be shortened in chat lists; review the full original proposal before approving it.

## Exact approvals

A proposal displays its full title, canonical UTC start, duration, exact approval ID, and ten-minute expiry. It creates no event. To change an argument, reject it and propose a new event rather than approving a similar-looking action.

An approval is bound to the internal user, originating conversation, fixed `calendar.create` tool, canonical arguments and SHA-256 digest, connection revision, and expiry. Another user or another conversation cannot consume it. Creation is permitted only while the demo connection is still active at the same revision, the start remains in the future, the approval is unexpired, and capacity remains.

Approving consumes the pending approval and creates one simulated event in the same database transaction. The event's unique approval ID prevents another execution. Repeated approval commands cannot create another event. Rejected, expired, revoked, or already-approved IDs cannot execute. Argument hash and ciphertext are rechecked; corruption or a change between review and commit fails closed.

Expiry and connection eligibility are checked using the database clock at commit, not only when preparing a response. A proposal that becomes invalid between those steps does not receive a false success confirmation. The states are `pending`, `approved`, `rejected`, `expired`, and `revoked`; `approved` means that the simulated creation transaction executed.

Cancellation requires the exact owned event ID and a connected demo calendar. It changes the local event status to `cancelled`. This explicit, reversible simulation uses the user's exact command rather than a separate approval. No real calendar event is cancelled.

## Revocation and persistence

Disconnecting advances connection/account revisions and atomically revokes pending approvals. Stale prepared writes cannot execute after disconnection, and reconnecting does not revive their approval IDs. Execution is a single local transaction, so there is no external asynchronous calendar write to recall. Existing simulated event records remain for the account; they are not proof of a provider-side event.

The accepted source message is the mutation token. The action statements join the normal ingress transaction after its account-revision check, so a replayed logical input cannot repeat a mutation. Connection state, immutable proposals, decisions, event records, and acknowledgments survive process restart in D1.

Calendar titles/arguments are encrypted before storage. Ownership, timestamps, status, connection revision, argument digests, and event routing times remain metadata. The backend decrypts arguments to display a proposal or event; this is application-level storage encryption. Normal chat transcripts retain the original command, so do not send secrets as event titles. This milestone is not complete account deletion or backup erasure.

## Integration contract

`packages/agent-core/src/action-commands.ts` exports the strict parser, command union, help text, and bounds. `apps/api/src/action-store.ts` exports typed tool definitions with fixed names, read/write classification, required internal scopes, and strict Zod schemas. No arbitrary endpoint, tool name, or provider credential can be supplied through arguments.

The store provides `prepareActionCommand`, revision-scoped `actionStatements`, and `listActionsForUser`. The bounded list returns simulated connection state, owned approval details, and decrypted upcoming events without provider secrets. Migration `0005` adds connection, approval, event, and per-user action-revision state. Root ingress/API integration and the final service smoke checks must be verified alongside these modules.

Reminder drafts share the opaque approval-ID flow. Their exact instruction/schedule is encrypted, hash-bound, and scoped to current privacy/settings revisions. Approval atomically creates one durable reminder and consumes the ID; replay cannot create another task. These are local durable reminders, while calendar events in this guide remain simulated. Real provider access, production approvals, live Apple delivery, and hosted usefulness require separate acceptance. The complete Plause product is not established by this simulation.
