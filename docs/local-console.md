# Local conversation and account controls

The browser console supports development and personal controls for Plause's messaging agent. Conversation remains the default view. The sidebar adds Memory, Reminders, Approvals & calendar, and Account panels, with a return to the conversation on every panel. Authorized staff also get a secondary workspace. The current local configuration uses mock model and messaging providers; Apple Messages is not connected. Real hosted services, identity and Google Calendar require their own private configuration and live acceptance.

Panels read the authenticated account's server state when opened or refreshed. They do not maintain a separate client-side store of facts, reminders, or approvals. Mutations send the same complete typed commands through the user's existing conversation as the chat composer. A lost send response retains its client message ID for a safe retry of the same command. Acceptance alone is not a claim that the requested mutation succeeded; the conversation records the deterministic confirmation, and the panel reloads its current server state.

## Memory

The panel can save a fact, correct or forget an existing fact, forget all facts, turn memory on/off, and download the account's saved-memory JSON. Saving and editing are unavailable while memory is off; list/export/forget remain available. A failed fact read still exposes disable/forget-all controls so corrupt content cannot trap the user in an enabled memory state.

Memory changes can reset future AI context and cancel older pending work, while earlier transcript messages remain visible. Do not enter credentials as facts. Server-side conservative rejection is not transcript redaction. See [saved memory](saved-memory.md).

## Reminders

The panel creates one-time reminders using an explicit ISO timestamp with an offset or `Z`, and daily/weekly reminders with a wall time and IANA zone. It exposes notification on/off, default time zone, quiet hours, and exact-ID pause/resume/cancel controls for active or paused tasks. More advanced changes remain available through the documented chat commands.

Reminder creation produces a local durable task. The console does not claim that a real iMessage was sent. Quiet hours, channel availability, human support, and unknown delivery outcomes can affect notification timing. Each record displays its server status, schedule, and next-run time.

## Exact approvals and simulated calendar

Pending approvals distinguish `reminder.create` from `calendar.create`. Reminder review displays the full instruction, human-readable schedule and exact schedule fields; it states that approval creates a durable local task and enables account-wide reminder notifications, with quiet hours still applied. Notification delivery remains simulated. Calendar review displays its exact title, start and duration and states that the resulting event is simulated. Unknown proposal types or incomplete arguments cannot be approved from the panel.

The demo calendar connection and its events are labeled simulated. The panel can connect/disconnect the demo calendar, propose a future event with explicit time/duration/title, review the full pending arguments and expiry, approve or reject an exact ID, and cancel an exact simulated event. A model draft does not execute an action or grant approval.

An approval created in another conversation cannot be decided from this console's conversation; its buttons are disabled and the panel explains the originating-conversation requirement. Expired approvals are disabled in the client, and the server independently rechecks expiry, connection revision, immutable arguments, ownership, and capacity at commit. A stale client view cannot authorize a different write. See [actions](actions.md).

The separate Google section shows safe connection metadata and stays disabled without private server configuration. Starting OAuth requires a deliberate button click; the response adds an allowlisted Google authorization link for a second click, without auto-navigation or an iframe. It explains the requested owned-event permission before connection. Status reads do not refresh tokens or start provider reads. A saved connection can be disconnected, including when provider configuration is disabled; the UI distinguishes local revocation from confirmed/unknown provider grant revocation. An inflight/unknown revoke disables reconnect and explains the operator/provider reconciliation requirement; it never automatically retries revocation or claims a clearance endpoint exists.

Google read/create/update forms send explicit commands through the conversation. A real create/update proposal displays the full title, time, duration, argument digest, primary-calendar target and, for updates, the exact managed event ID and strong ETag. Missing review data disables approval. Unknown provider-write outcomes offer only an explicit check of the existing action; that check never resends a write. A stale or cross-conversation view cannot authorize a different action. See [Google Calendar](google-calendar.md) for configuration and live acceptance limits.

Before disconnecting Google, the panel explains that future AI context resets and older pending automatic replies are cancelled across the account. Saved facts, reminder tasks, transcript and delivered replies remain. Provider grant revocation is a separate best-effort result, not a promise that old content or events were recalled.

Terminal request failures produce a fixed, content-free `Request status` reply through the usual delivery path. Unknown provider outcomes explain that there is no automatic retry; configured budget or search limits explain that no new generation/search started for that input. These status replies do not become future AI conversation history.

## Account, usage, and export

The account panel shows scoped record counts and available usage estimates. Model ledger debits, uncertain-charge holds, and remaining allowance are application estimates; the provider invoice remains authoritative. Failure to load usage does not hide account controls.

## Sign-in and channel linking

The login view reads `/api/auth/status`. Invitation entry appears only when local invitation login is allowed. Configured Google sign-in starts with an explicit review button and then an allowlisted Google authorization link; no permission form is submitted automatically. Google account identity and Google Calendar access are separate flows. Returning from sign-in reloads the cookie-backed session; no session or provider tokens are saved in browser storage.

Account confirmation controls support a recent Google confirmation, or a fresh local invitation sign-in only in the local environment. Confirmation does not promise password or MFA reentry. A changed account never continues a pending mutation automatically. Staff access, channel changes and cloud deletion independently enforce fresh identity on the server.

The channel-link form separately asks for reply consent and optional proactive reminder consent. It prepares a five-minute one-time code. The user sends that exact command from the messaging channel, checks the server-authenticated proof, reviews its provider, business, channel, subject hint and consent, then confirms the exact link in the signed-in account. Proof alone does not create the binding. Codes remain only in the current view, are excluded from model history and transcript storage, and are not persisted in browser storage. Current Apple/provider enrollment is still required to exercise this through real Messages; local HTTP tests use signed mock fixtures.

When the server exposes an approved Apple business entry URL, the panel offers an optional **Open Plause in Messages** link. The client accepts only an exact HTTPS `bcrw.apple.com/urn:biz:<UUID>` URL without credentials, query or fragment. The one-time code is sent manually and never added to that URL. Rendering the link does not preview or request it.

Existing channel records show current access and separate consent timestamps. Explicit revocation closes its conversation and cancels eligible queued work; it cannot recall delivered messages. Fresh account confirmation is required. Browser-rendered web replies acknowledge delivery only after they have been added to the conversation DOM; API polling by itself does not acknowledge them.

## Staff workspace

The staff navigation appears only after the server grants support capability. Inbox metadata is bounded and includes only open human-support conversations. Staff must explicitly claim a conversation before loading its private transcript. Claims last five minutes, preserve a monotonic version, and renew only while the workspace remains open and account confirmation is recent. A stale claim or revoked role cannot read new private text or queue a new reply. Access failures clear the displayed staff transcript.

Default local invitations do not grant staff access. Staff provisioning requires a verified Google subject on the configured bootstrap allowlist or an explicit grant from an existing admin. The isolated HTTP suite creates separate fictional staff roles only in its own temporary database.

When the messaging provider owns a conversation or its control is unknown, the inbox shows metadata and disables claiming. Staff use the configured provider workspace for that conversation. Plause rejects private reads, replies, claim renewal and agent resumption until the provider confirms control has returned; changing the local mode never overrides provider ownership.

Staff replies preserve their exact text and a stable client UUID across an uncertain HTTP retry. They create one encrypted `plause-human` message and one durable outbox job; the UI distinguishes acceptance from delivery. Releasing a claim leaves the customer in human mode. A separate close-and-resume action returns that conversation to the agent without resurrecting cancelled inputs. Role revocation or claim closure cancels queued staff replies, while dispatched outcomes can remain unknown.

Admins can review exact user IDs and roles, explicitly grant/revoke staff access, read content-free delivery status, pause/resume outbound delivery, and wake eligible durable work. They cannot force retries of uncertain provider sends or writes. Coverage comes from explicit service configuration and never establishes that a live person is currently staffing the service. Google bootstrap compares verified subject IDs, not email addresses; it does not revive revoked grants.

Account export reads the authenticated paginated endpoint, combines its first-page control snapshots and message pages, and downloads one JSON file only after a complete result. It rejects repeated/nonadvancing cursors and stops at 500 pages without downloading a partial file. The endpoint is a live export rather than a transactionally fixed historical snapshot; concurrent changes can affect later pages. The file contains readable personal data. Credentials and retained model billing tombstones are excluded.

## Deliberate account deletion

Deletion has two separate user actions. First, the panel displays the affected data and current counts, requires the exact phrase `DELETE MY PLAUSE ACCOUNT`, and requires recent account confirmation. Local development can confirm with that account's invitation in a password field; cloud uses recent Google identity confirmation. Fields are cleared before requesting a short-lived deletion review. The returned effect and expiry are displayed before a separate **Permanently delete this account** button becomes available.

The final button sends the short-lived confirmation token to the authenticated deletion endpoint. Both a completed deletion and an accepted pending erasure clear session/panel data. A `202` pending result explicitly says access is disabled and independent privacy-ledger recovery is pending; it does not claim that the purge completed. Preparing a review, opening Account, refreshing, returning to the conversation, or loading the page never automatically deletes an account. Cancelling or leaving the review drops the token from UI state; it is not written to localStorage/sessionStorage. Server expiry and single-use consumption remain authoritative.

Deleting the account removes access, transcripts, saved facts, reminders, approvals, demo calendar data, and stored Google credentials. It does not guarantee provider grant revocation or delete real Google events. Disconnect Google first to request grant revocation, or revoke Plause access in Google account settings. Minimal model accounting metadata and possible-charge holds remain. Previously delivered messages and downloaded exports cannot be recalled. UI interaction remains unverified; isolated HTTP tests erase only their generated fictional accounts.

## Implementation and verification limits

All content from APIs is rendered with DOM text nodes or `textContent`; no response HTML is injected. Forms have labels, status messages are announced, controls retain keyboard access, and the sidebar adapts to narrow screens. Invitation/API keys and deletion tokens are not persisted in browser storage. The console has no model-provider API-key entry form; hosted services are configured through local terminal tooling.

JavaScript syntax and static DOM checks validate unique element IDs, referenced targets, labels, text rendering, and the absence of browser credential storage. The isolated HTTP suite exercises channel proof/confirmation/revocation and staff claims/replies/release/role revocation through the actual service. Browser visual and interaction QA remains blocked by the browser URL security policy. No alternate browser or policy workaround was attempted; code-level and HTTP checks do not establish visual, accessibility, or real user acceptance.
