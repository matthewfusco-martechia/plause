# Durable reminders

Plause stores explicit reminder commands in local D1 and delivers literal reminder text through the mock messaging transport. No model call is needed to create, change, list, or deliver a reminder. Apple Messages, an MSP, and real proactive notification permissions are not connected or verified.

## Commands and limits

Send one complete, unquoted command on one line. A quoted example, embedded instruction, or additional line does not authorize a reminder mutation. Dates must be explicit; the parser does not interpret “tomorrow morning.”

| Purpose | Command |
| --- | --- |
| Relative one-time reminder | `remind me in 5 minutes: call Alex` |
| Absolute one-time reminder | `remind me at 2030-11-02T09:00:00-04:00: call Alex` |
| Daily recurrence | `remind me every day at 09:00 America/New_York: plan my day` |
| Weekly recurrence | `remind me every Monday at 09:00 America/New_York: plan my week` |
| List active and paused tasks | `reminders` |
| Cancel, pause, or resume | `cancel reminder rem_UUID`, `pause reminder rem_UUID`, `resume reminder rem_UUID` |
| Change a schedule | `reschedule reminder rem_UUID at 2030-11-03T09:00:00-05:00` |
| Change recurrence | `reschedule reminder rem_UUID every day at 10:00 Europe/London` |
| Change the default/quiet-hours zone | `reminder timezone America/New_York` |
| Set quiet hours | `reminder quiet hours 22:00-08:00` |
| Disable quiet hours | `reminder quiet hours 00:00-00:00` |
| Change account-wide reminder notifications | `reminder notifications on` or `reminder notifications off` |
| Show syntax | `reminder help` |

Replace `rem_UUID` with the exact ID returned by creation or listing. Absolute timestamps must be in the future and include `Z` or a numeric UTC offset. Relative times accept positive whole minutes, hours, or days. Daily and weekly schedules require a valid IANA zone and a 24-hour `HH:mm` time.

An account can have 20 active or paused reminders. Each instruction is limited to 300 UTF-16 code units; some emoji occupy two units. Cancelled and completed records remain stored until account erasure. The authenticated `GET /api/reminders` endpoint returns settings and up to the 100 most recently created records; the chat list shows active and paused tasks.

Notifications start off. Creating a reminder explicitly turns the account-wide reminder notification setting on, including for other active tasks. Creation does not resume paused tasks. Commands are applied atomically at message ingress and deduplicated by the logical source message; retry the same client message ID after a lost acceptance response. The deterministic confirmation appears in the conversation. In human support mode it is recorded as `local_only` and is not sent by the bot.

## Time and delivery semantics

The default zone is `America/New_York`, with quiet hours from 22:00 inclusive to 08:00 exclusive. Equal endpoints disable quiet hours. The stored reminder zone controls quiet hours; each recurrence retains the zone explicitly included in its own schedule. Changing the default zone does not rewrite existing recurrence zones.

Recurrences skip wall times missing during the spring DST transition and use the earlier occurrence of a repeated time once per date during the autumn transition. After a late scheduler scan, the next recurrence is strictly after the current instant; missed periods are not replayed as a backlog.

When a reminder becomes due during quiet hours, a durable deferred occurrence retains its original scheduled time and waits for quiet hours to end. A notification already queued before quiet hours is checked again before dispatch and before mock acceptance. Ordinary requested chat can continue while that proactive reminder waits. Human mode and notifications-off also defer eligible tasks; revoked bindings, closed channels, inactive accounts, and unsupported channels pause them. Global outbound pause stops scheduling and dispatch until recovery resumes.

Each occurrence expires 24 hours after its original scheduled time, including time spent deferred. A stale one-time task becomes paused; a stale recurrence advances to its next future time. Resume cannot revive a one-time date already in the past: explicitly reschedule it. Turning notifications back on does not restore an older cancelled notice.

Cancel, pause, and reschedule invalidate older pending occurrences. Changing quiet hours or the default zone, or turning notifications off, also cancels older pending notices and advances active recurrences to a future time. A past one-time task then needs rescheduling. These controls do not erase earlier transcript text or recall an already accepted or delivered message.

## Durable state and uncertain sends

The reminder instruction is encrypted with the content key. Schedule metadata, state, timestamps, and IDs are stored as ordinary database metadata. Reminders and their deterministic confirmations are excluded from future model conversation history. Saved facts are not used to invent reminders or enrich reminder instructions.

Scheduling atomically creates the occurrence, encrypted assistant message, and outbound job, then advances the task. A unique `(reminder_id, scheduled_for)` key and version checks prevent duplicate occurrences under concurrent scans and restarts. Queue messages are wakeups; D1 remains the record of accepted work. The scan handles up to 100 due tasks at a time.

| State | Meaning |
| --- | --- |
| Task `active` | Eligible for a future occurrence, or a one-time task waiting for its delivery outcome. |
| Task `paused` | Requires a supported channel or an explicit resume/reschedule before delivery. |
| Task `cancelled` | Explicitly cancelled; pending older notices are suppressed. |
| Task `completed` | The current version of a one-time task has a recorded delivered occurrence. |
| Occurrence `deferred` | Original due time retained; no outbound message has been queued yet. |
| Occurrence `queued` | Durable outbound work exists; this does not establish delivery. |
| Outbound `delivery_unknown` | Provider acceptance may have happened; reconciliation is required. |

If a control races an inflight send, the message can remain `delivery_unknown` rather than falsely claiming cancellation. The dispatch checks current task version, notification setting, account and binding state, conversation ownership, content revision, lease, and pause status. A transport timeout does not prove rejection. Recovery reconciles the same idempotency key; an absent receipt permits retry only for an adapter that explicitly guarantees durable idempotency. The local mock provides that guarantee. Real provider behavior remains unverified.

## Local runbook

From the repository root:

```sh
npm run setup
npm run dev
```

Setup applies all available local migrations and preserves existing local secrets and invitation files. Do not replace the content encryption key for an existing database. Sign in to the local console using the intended account's key in `.local/invitations.json`; keep that file private.

`npm run dev` starts Wrangler on `127.0.0.1:8787`. Its wrapper checks local mock health, wakes the scheduled handler after startup, then ticks every 15 seconds without overlapping its own ticks. Timers do not own reminder state. Stopping the process stops local ticks; restarting it resumes durable recovery. The configured cloud cron is every minute, but no cloud deployment or production scheduler reliability has been verified.

For a missed notice, inspect the account's reminder status and schedule, notification setting, quiet window, conversation mode, and channel binding first. The separately authenticated operator routes provide aggregate status, a recovery sweep, and global pause control; see [account and operations](account-and-operations.md). Recovery enqueues eligible conversations and does not assert that a message was delivered. Do not create a new reminder to resolve an uncertain send; inspect/reconcile the existing occurrence.

An invalid schedule or unreadable encrypted instruction pauses its task. A failed list/export does not imply the record is absent. Metadata-only pause, cancel, settings, and account erasure remain available without decrypting that instruction. Correct key loss requires restoring the matching key; a new key cannot decrypt existing data.

Tests cover deterministic commands, encryption, replay/concurrent scans, restart recovery, DST and quiet boundaries, cancellation races, tenant isolation, and mocked receipts. These checks establish local behavior within this implementation scope. They do not establish real Apple delivery, production operations, or acceptance of the complete Plause product.

Implementation: [reminder store](../apps/api/src/reminder-store.ts), [command parser](../packages/agent-core/src/reminder-commands.ts), [scheduling utilities](../packages/scheduling/src/index.ts), [delivery pipeline](../apps/api/src/pipeline.ts), and [regression tests](../tests/reminders.test.ts).
