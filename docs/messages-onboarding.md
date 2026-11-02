# Messages onboarding

Plause can send a deterministic introduction before a Messages sender has an account link. This is separate from the private agent conversation. The implementation uses authenticated Sunshine Conversations events and injected provider responses in tests. No Apple account, deployment or live message has been accepted by these checks.

## Customer flow

1. A new sender contacts the approved Apple business conversation while Plause's bot controls it. A bounded welcome identifies Plause as an AI assistant and links to the configured HTTPS Plause origin.
2. The person signs in on that page and explicitly allows replies. Proactive reminder consent is a separate choice. If signup is closed, the welcome says that sign-in is for existing approved accounts.
3. The signed-in person prepares a five-minute link and sends its exact command in Messages. A valid proof queues “Message proof received”; the notice explains that the conversation is not linked yet and that the person must return to the original browser session.
4. That session reviews the verified channel and confirms it. Binding creation, suppression of older public notices and the linked acknowledgment commit together. The person can then send an ordinary agent request in Messages.

The fixed link is `${PUBLIC_ORIGIN}/?onboarding=messages`. It contains no possession code, provider subject, account ID, credential or return URL. Opening it does not grant permission or create a binding. Unknown, invalid or expired linking commands do not become model turns or echo the code. Existing/revoked subjects on a new destination must explicitly prove a new link; an ordinary message cannot move their account or restore revoked routing.

## Configuration

`ONBOARDING_MESSAGES_ENABLED=true` explicitly opts in. Readiness also requires the approved/live Sunshine channel, configured Sunshine webhook/transport credentials, a configured Google identity provider and a valid HTTPS public origin. `ONBOARDING_GLOBAL_DAILY_LIMIT` defaults to 500 and accepts 1–5000. These are configuration checks, not proof of provider access or Apple approval. Local mock mode does not send these notices.

There is at most one welcome record per business-scoped subject per UTC day, across its destinations. Every actual notice attempt reserves the deployment's daily global allowance atomically. Rejected, uncertain and erased attempts retain their quota accounting. This cap does not cover other application messaging or guarantee a provider-wide bill.

## Storage and lifecycle

Migration `0019` adds an independent public-contact state, event tombstones and notice outbox. No fictional account, private conversation, model request or agent history is created. Incoming text and possession codes are not retained. Subject/destination indexes and event fingerprints use a purpose-scoped HMAC; the minimal provider routing tuple is encrypted. A valid proof attributes operational records to its account before confirmation so pending erasure can purge them. Once confirmation selects an account, an unsuccessful competing claimant cannot cancel the winner's notices or routing.

Notices expire after five minutes and require recent inbound activity. Unknown or human provider ownership, closure, revocation, changed binding, account disablement, maintenance and outbound pause are checked at dispatch. Ordinary messages and `client.active` cannot restore revoked routing. A new explicit, valid proof is required. Provider revocation without a conversation applies to every destination of that subject. Account erasure purges routing while retaining minimal event, attempt and uncertainty tombstones. Inactive routing is also purged after 24 hours by recovery; notices contain template identities rather than copied personal message bodies.

The outbox commits before dispatch, uses a bounded claim, and makes at most one POST for each notice. A crash after claiming is uncertain, even if the request may never have started. Recovery performs GET-only reconciliation against the same dispatch metadata; it never blindly sends again. Read reconciliation is bounded to the provider's latest page, and cannot resolve every older unknown message. After routing is purged, the unknown record remains without further provider reads. Closure or revocation cannot recall a request that already crossed the network.

Sunshine API success and channel acceptance mean **sent**, not received by the person. Zendesk currently documents Apple channel delivery confirmation and failures, with no device delivery confirmation. Tests include callback-before-response ordering so an early terminal failure survives the later POST acknowledgment. [Delivery semantics and channel support](https://developer.zendesk.com/documentation/conversations/messaging-platform/programmable-conversations/delivery-events/).

Onboarding replies use the existing provider conversation with an explicit Apple integration destination. Sunshine's phone-addressed Notification API is documented for WhatsApp, Twilio and MessageBird, so it is not used for Apple onboarding. [Replying and channel targeting](https://developer.zendesk.com/documentation/conversations/messaging-platform/programmable-conversations/sending-messages/), [Notification API channel limits](https://developer.zendesk.com/documentation/conversations/messaging-platform/programmable-conversations/outbound-messaging/).

## Acceptance

Accountless, same-thread human escalation and real business-hours staffing must be configured and verified through the MSP before public activation. The welcome's web support information does not itself establish that path; Plause does not create a second accountless ticket system.

Before activation, verify real initial greeting and disclosures, signup/sign-in, valid/invalid/expired proof handling, separate consent, browser confirmation, relinking, provider-human ownership, close/reopen, lost acknowledgment and final failure on Apple devices. Keep proactive Apple notifications disabled until separately approved. Public onboarding code does not establish eligibility, staffing, legal terms, provider contract acceptance or live delivery. See [identity and support](identity-and-support.md), [Sunshine adapter](sunshine-messaging.md) and [cloud deployment](cloud-deployment.md).
