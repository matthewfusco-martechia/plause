# Zendesk Sunshine Conversations adapter

The adapter implements Sunshine Conversations v2 for an existing Apple Messages for Business integration. It can authenticate and normalize webhook batches; send text, URL previews and quick replies; signal typing; pass control to a configured human integration; and reconcile an uncertain send with a read. Tests use injected fetch fixtures. No provider account, webhook, Apple enrollment or live message has been created by this implementation.

Zendesk identifies Sunshine Conversations as an Apple-certified Messaging Service Provider. Apple registration and review, a Zendesk subscription and configured Apple integration, a working staffed Agent Workspace handoff, and device acceptance remain external acceptance steps. [Apple channel documentation](https://docs.smooch.io/guide/apple-messages-for-business/), [current Zendesk setup guide](https://support.zendesk.com/hc/en-us/articles/8030634178458-Adding-and-configuring-the-Apple-Messages-for-Business-channel).

## Configuration and authorization

Set the following independently for each environment using secrets for the values marked secret. These flags configure the adapter; they do not grant consent to send.

| Variable | Meaning |
| --- | --- |
| `APPLE_BUSINESS_ID` | Approved public Apple brand UUID used by the Messages entry link; distinct from the Sunshine integration ID |
| `SUNSHINE_SUBDOMAIN` | Zendesk account subdomain only, without a URL |
| `SUNSHINE_APP_ID` | Sunshine application ID |
| `SUNSHINE_APPLE_INTEGRATION_ID` | The one allowed Apple integration |
| `SUNSHINE_WEBHOOK_ID` | The one allowed v2 webhook |
| `SUNSHINE_WEBHOOK_SECRET` | Generated webhook secret; secret |
| `SUNSHINE_KEY_ID` | Integration-scoped API key ID |
| `SUNSHINE_KEY_SECRET` | API key secret; secret |
| `SUNSHINE_BOT_SWITCHBOARD_ID` | Plause's switchboard integration ID |
| `SUNSHINE_AGENT_SWITCHBOARD_ID` | Staffed Agent Workspace switchboard ID for explicit handoff |
| `TYPING_INDICATORS_ENABLED` | Opt-in server typing activities; these do not authorize messages or establish provider support |

Webhook authentication compares the provider's shared `X-API-Key` using Web Crypto. This protocol does **not** provide a body signature or signed timestamp. The adapter pins app ID, webhook ID/version and Apple source integration, bounds JSON to 256 KiB and batches to 100 events. The HTTP handler must read the request with a byte limit before calling normalization, require HTTPS in cloud, durably fingerprint and deduplicate every event, reject conflicting replays, and acknowledge only after the accepted batch is persisted. [Official v2 webhook authentication and retry policy](https://github.com/zendesk/sunshine-conversations-api-spec/blob/0f88aea8db3653a19b192407ecf0b2bf262743ad/openapi.yaml).

The client sends Basic credentials only to `https://<subdomain>.zendesk.com/sc/v2/apps/<appId>/...`. Redirects are rejected, response bodies are limited to 512 KiB, each HTTP operation has a maximum 10-second deadline, and the client performs no automatic retries. A `beforeSend` callback runs immediately before each write so the application can revalidate the durable outbox claim, lease, account/binding, context, conversation mode, Apple consent and global pause after asynchronous preparation. [Official API authentication](https://developer.zendesk.com/documentation/conversations/getting-started/api-authentication/).

## Identity and lifecycle

The account-link identity is `{provider:'sunshine', businessId:appId, subjectId:providerUserId}`. The provider conversation ID is a separate transport destination. User `externalId`, phone/profile fields and display names never select a Plause account. Messages from another integration or channel are ignored. Switching to a new provider user or moving a conversation must not transfer an existing account binding without a new explicit linking proof.

Only one active binding may own a provider conversation within an app. Concurrent confirmations have one winner; moving a destination to a different subject or account requires explicit revocation. Migration `0018` fails on pre-existing duplicates for operator investigation rather than silently merging identities. The authenticated proof event's provider timestamp supplies the replay lower bound; server `verified_at` remains an audit timestamp. Using the same provider clock permits post-proof messages despite clock skew while rejecting older events.

Only text authored by a provider `user` becomes an incoming user turn. Reply payloads remain separate untrusted selection data; the application must match them against the current user's exact server-created approval/options. Attachments, Apple passthroughs, postbacks and business-authored messages never become text commands. Switchboard control is `bot`, `human` or `unknown`; unknown must pause automation. [Receiving messages and switchboard routing](https://developer.zendesk.com/documentation/conversations/messaging-platform/programmable-conversations/receiving-messages/).

An Apple client marked `blocked` means the customer closed the conversation. `client:remove` can omit a conversation, so revocation must fence all bindings/conversations for the subject. `client.active` is informational and does not silently restore a revoked account link or permit proactive messaging. Provider user merges revoke both old identities instead of merging Plause accounts. Switchboard events do not identify a user or channel: resolve them only through an existing same-app Apple conversation mapping. [Client status and channel identity](https://developer.zendesk.com/documentation/conversations/messaging-platform/users/clients-and-devices/).

## Sending and delivery

Messages target the configured Apple integration explicitly. This prevents Sunshine's default channel selection from choosing a different delivery channel, although Sunshine warns that linked SDK histories can still display conversation messages; do not share an Apple integration/account-link with an untrusted SDK identity. API creation returns `sent` to mean provider acceptance. A `delivery:channel` callback also means channel acceptance. Apple's documented channel lacks end-user/device delivery confirmation, so unsupported `delivery:user` events are ignored and never manufacture a `delivered` state. Final delivery failures map to `failed`; intermediate failures do not authorize another send. [Sending and explicit channel targeting](https://developer.zendesk.com/documentation/conversations/messaging-platform/programmable-conversations/sending-messages/), [delivery channel support](https://developer.zendesk.com/documentation/conversations/messaging-platform/programmable-conversations/delivery-events/).

There is no documented durable send idempotency guarantee in the reviewed v2 contract, so `supportsIdempotentRetry` is false. The application must persist its sending attempt before POST. Network loss, deadline, rate limiting, server failure or malformed acceptance leaves `delivery_unknown`; do not resend automatically. The message carries a hash of the durable dispatch key and a canonical content digest. Reconciliation makes one latest-messages GET and accepts exactly one matching business message with matching content. Missing, conflicting or older-than-page records remain unknown. A successful read confirms a provider message exists, not delivery to the user's device.

Quick replies use 2–5 documented `reply` actions, bounded labels and opaque selection payloads. Rich links use a title and one public-looking HTTPS URL in text, for Apple's documented automatic preview; the adapter never fetches that URL or emits arbitrary Apple override payloads. The domain check is syntactic and is not a DNS guarantee. Custom preview imagery, Apple authentication messages, list/time pickers and attachments are not implemented. Typing uses documented activity APIs with partial Apple support. Handoff passes control only to the configured human integration; it does not prove staffing or resolve a support ticket. [Structured messages](https://developer.zendesk.com/documentation/conversations/messaging-platform/programmable-conversations/structured-messages/), [Apple message overrides and automatic rich links](https://developer.zendesk.com/documentation/conversations/messaging-platform/programmable-conversations/message-overrides/).

## Acceptance still required

Before enabling this transport for customers, verify the enrolled app/webhook/integration IDs, opaque subject and conversation mapping, single-use account linking, closed/reopened lifecycle, quick reply approval scoping, channel/failure callbacks, a lost-ack send and read-only reconciliation, and staffed human takeover on real Apple devices. Capture redacted real fixtures and verify their schema against the synthetic examples. Confirm Apple policy and the business's approved use case before enabling any proactive notification. Runtime flags and passing fixture tests do not establish those approvals.
