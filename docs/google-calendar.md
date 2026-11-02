# Google Calendar connection and exact approvals

The connector foundation is separate from the simulated demo calendar and Google account sign-in. Calendar remains disabled: no Calendar-specific OAuth client credential, account grant, live Calendar token exchange or real event read/write has been verified. All four local Google identity checks passed: initial OAuth/login/session, sign-out, returning sign-in with signup closed and fresh confirmation. This identity flow does not grant Calendar access. The isolated live OpenAI smoke passed 3/3 cases while the primary preview remains mock. Apple Messages remains unconnected. Code and synthetic fixtures do not establish a connected Google Calendar.

## Permission and local setup boundary

The sole requested scope is `https://www.googleapis.com/auth/calendar.events.owned`. It grants event read/create/change/delete permission on calendars owned by the granting user. The implementation is narrower: fixed primary-calendar endpoints, bounded event reads, separately approved create/update operations, and no attendees, invitations, arbitrary calendars, arbitrary URLs or event deletion command. Review the actual grant on Google's consent page before accepting it. [Google Calendar scope definitions](https://developers.google.com/workspace/calendar/api/auth).

The developer must independently provide a separate Calendar OAuth web-client configuration with the exact authorized callback `http://localhost:8787/api/calendar/google/callback` and an account allowed by that project's consent/testing policy. The existing Plause development project and sign-in client do not configure this Calendar client or grant. No Calendar consent has been performed on anyone's behalf. Google describes web-client credentials, redirect matching and consent in its [web-server OAuth guide](https://developers.google.com/identity/protocols/oauth2/web-server).

Private configuration names match [.dev.vars.example](../.dev.vars.example):

```dotenv
LIVE_GOOGLE_CALENDAR_ENABLED=false
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=http://localhost:8787/api/calendar/google/callback
```

Keep these values in the existing protected local `.dev.vars`, preserve its content encryption key, and never put a client secret/token in chat, command arguments, browser storage, a commit or a screenshot. The repository does not have a Google setup CLI. An authorized developer can supply the private values locally, deliberately enable the feature, then restart `npm run dev`. Configuration permits connection; it does not create consent or prove that Google accepted a request. Runtime use is restricted to local preview with mock messaging, and this application callback is pinned to the exact localhost URL above.

## Deliberate connection and disconnection

The Approvals & calendar panel reads `GET /api/calendar/google`. Its safe metadata includes configured/connected flags, revision, status, granted scope and expiry. It contains no access/refresh tokens or client secret, and a status read never refreshes a token or starts a calendar request.

A user click sends same-origin `POST /api/calendar/google/connect`. The response contains an authorization URL and expiry; an HttpOnly callback cookie carries the browser proof. The UI renders an ordinary allowlisted Google link for a second deliberate click rather than opening a popup, navigating automatically, submitting a hidden form or embedding Google in an iframe. Review the permissions, finish Google consent if authorized, then return and refresh the panel.

State and S256 PKCE are bound to the original active account/session, browser proof, connection revision and ten-minute expiry. The callback consumes its proof once. Access/refresh tokens and the pending verifier are encrypted at rest. A complete connection requires exact scope and offline refresh consent. Token refresh happens only for an explicit permitted operation, uses a durable single claim, and an uncertain/stale refresh requires fresh consent instead of a blind retry.

`DELETE /api/calendar/google` explicitly revokes local eligibility and pending OAuth state first, then attempts provider token revocation. Its `providerRevocation` is `confirmed`, `unknown` or `not_needed`; an unknown result does not restore local access. Clearing local access remains possible with disabled provider configuration or unreadable token content. A changed connection revision invalidates older action approvals/dispatch eligibility.

Disconnect also resets future AI history/context, cancels older pending automatic replies across the account, invalidates active conversation leases and purges personalized model/search caches. Saved facts, reminder/task records, transcript text and delivered replies remain. The UI discloses this consequence before its explicit disconnect button. Unknown refresh invalidation applies the context fence as well, so stale private calendar results cannot be committed or sent through another channel after access is revoked.

While a provider revocation is inflight or unknown, safe metadata exposes `revocationPending:true`, reports no active connection, and blocks new consent. A repeated disconnect does not launch another revoke. This prevents a late revoke from invalidating a newer grant. Confirmed revocation clears the fence; an unknown result requires operator/provider reconciliation. No automatic retry or fence-clear endpoint is implemented. The UI explains this held state instead of offering a reconnect that cannot succeed.

Local account erasure purges stored tokens but does not guarantee provider grant revocation or delete Google events. Disconnect first to request revocation, or independently revoke Plause access through Google account settings. A provider-created event, delivered message or downloaded export is not erased by deleting this local account.

## Chat commands and secondary forms

Use one complete plain-text command per message. Times require valid explicit ISO offsets or `Z`; `-00:00`, ambiguous dates and missing zones are rejected. The read window is forward and at most 31 days. Titles are at most 200 UTF-16 units and durations are whole minutes from 1 through 480.

```text
google calendar events from <ISOoffset> to <ISOoffset>
propose google calendar event at <ISOoffset> for <minutes> minutes: <title>
propose google calendar update <eventId> etag <strongQuotedEtag> at <ISOoffset> for <minutes> minutes: <title>
approve <gapproval_UUID>
reject <gapproval_UUID>
check calendar action <gapproval_UUID>
```

The UI has the same read/proposal forms and uses the existing conversation with stable retry message IDs. Reading requires a connected account. Read results are bounded; they are calendar data, never instructions or permission. Read-only model tools may request only a validated explicit window. Model-proposed writes are drafts and cannot grant their own approval.

For an update, use a currently read Plause-created event ID and its quoted strong ETag, such as `"123456"`. Wildcards and weak ETags are rejected. The connector refuses updates to unmanaged events, events with guests/recurrence or unsupported fields that would be lost by replacement. It sends the reviewed version in `If-Match`; a changed version requires a new review. Google documents conditional modification and version conflicts in its [resource-version guide](https://developers.google.com/workspace/calendar/api/guides/version-resources).

## Exact review and uncertain outcomes

Google proposals are distinct from `approval_UUID` demo/reminder proposals. A `gapproval_UUID` is bound to the user, originating conversation, tool, immutable encrypted arguments/digest, connection revision and ten-minute expiry. Its displayed tool is `google_calendar.create` or `google_calendar.update`. A bare yes, a quoted example, an assistant draft or another account's ID does not approve it.

The action view returns bounded approvals and request states. Before approving, review the full title/start/duration, primary-calendar target, argument digest and, for updates, exact event ID and strong ETag. The digest identifies arguments; it grants no authority. The UI disables incomplete, expired, foreign-conversation or disconnected approvals; server-side gates remain authoritative.

Execution uses a durable one-use request journal and rechecks ownership, connection and eligibility at the provider boundary. Creates use a deterministic managed event ID. The client may reconcile a possible create outcome with a read of that same ID and exact arguments; it never blindly repeats the POST. Updates use a strong version fence. Request states distinguish dispatch, completion, failure, uncertainty and purged private content.

`check calendar action <gapproval_UUID>` performs only GET-based reconciliation against the saved exact action. It does not POST or PUT and cannot turn an unknown result into permission to resend. Do not create/approve a replacement just to clear an unknown state. Inspect the existing result, connection and provider calendar first. Disconnect, handoff, closure, privacy changes and account erasure fence obsolete work, while an already accepted Google change cannot be recalled by a local status change.

## Verification and live gates

[Google transport fixtures](../tests/calendar-google.test.ts) exercise fixed endpoints, bounded responses/deadlines, OAuth payloads, deterministic create identity, no-invitee writes, conditional updates and uncertain outcomes without real network calls. [OAuth fixtures](../tests/google-oauth.test.ts), [durable-action fixtures](../tests/google-calendar-work.test.ts) and [HTTP boundaries](../tests/google-calendar-api.test.ts) cover account/session proof, refresh/revocation races, exact approval consumption, expiry at the provider boundary, quotas and disabled configuration. Final integrated test/build/migration results belong in [the handoff](../HANDOFF.md). The UI has syntax and code-level argument/link checks. Browser visual and interaction QA remains blocked by URL security policy and has not been worked around.

Live acceptance requires an operator-provided OAuth client, reviewed consent/testing access and redirect configuration, deliberate user grant, real scope/refresh/revocation tests, bounded read/create/update checks in an authorized test calendar, conflict and ambiguous-write reconciliation, provider retention/deletion review, and production monitoring/credential recovery. No private credential or account grant is available yet. The broader Apple/MSP and production identity/support gates remain independent; see [Apple approval checklist](apple-approval-checklist.md) and [operations runbook](operations-runbook.md).
