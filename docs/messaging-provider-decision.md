# Plause messaging provider comparison

Researched 2026-11-02 using official pricing, documentation, SDK source and terms. The user confirmed Cloudflare storage and direct OpenAI models as the target. This review creates no account, contract, messaging line or deployment.

## Recommendation

Use **direct Linq as the preferred production candidate** for Plause, with a provider boundary that can later support Inkbox. This is a recommendation based on documented product fit and existing source integration, not measured superiority in delivery speed or uptime. No live head-to-head test has been performed.

OpenInstinct already supplies a Linq channel, message interactions and attachment handling. Plause has replaced its Vercel credential/forwarding path locally; an Inkbox switch would additionally require a new channel adapter. The [official Linq TypeScript SDK](https://github.com/linq-team/linq-node) supports Cloudflare Workers and direct API keys; Vercel is optional.

## Product and cost

| Area                   | Inkbox                                                                                                                    | Linq                                                                                 | Implication for Plause                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| Dedicated iMessage     | Startup: $200/month, or $2,000 billed annually; one included dedicated iMessage line and 100,000 dedicated messages/month | Pro starts at $260/month; exact included line allocation and all limits need a quote | Compare a dedicated product number, not a shared developer router       |
| Free development       | Shared iMessage, three concurrent recipients per identity                                                                 | Hobby: 20 contacts, described as CLI use                                             | Neither allowance establishes unrestricted public deployment rights     |
| Lower paid development | Developer: $30/month, shared iMessage; its dedicated VoIP number has no iMessage                                          | Public production starting price above                                               | Inkbox Developer does not supply the desired dedicated iMessage contact |
| Existing selected code | New adapter required                                                                                                      | Included in the selected OpenInstinct source                                         | Direct Linq preserves more existing channel behavior                    |

Prices are USD, before applicable taxes and other service charges. Inkbox's default page display can show annual equivalents ($25/$167); those are not monthly billing prices. Sources: [Inkbox pricing](https://inkbox.ai/pricing), [Linq pricing](https://linqapp.com/s/pricing).

Inkbox's shared router uses a connect command and dynamically assigned numbers. Connections can expire after inactivity; dedicated lines avoid that policy. Its dedicated lines can receive email-based Apple-ID senders but cannot reply to them: outbound recipients must be E.164 phone numbers. This is a meaningful limitation for an agent intended to work in ordinary Messages. [Inkbox iMessage guide](https://inkbox.ai/docs/capabilities/imessage).

Linq's addressing model includes phone numbers and email addresses. Provider support does not automatically authorize an address in Plause: the current app uses verified phone identity, so any email-handle linking must remain explicit and cannot silently merge accounts. [Linq key concepts](https://docs.linqapp.com/channel/imessage/getting-started/key-concepts/).

## Recovery, privacy and reliability

Inkbox documents seven-day idempotent response replay and a read-only send lookup, useful when a send response is lost. Preserve a stable send key and distinguish queued, sent, delivered, failed and unknown states. [Inkbox send recovery](https://inkbox.ai/docs/api/message-sends).

Linq documents a nested message idempotency key that returns the original result on repetition. Public material reviewed did not establish its key lifetime, changed-payload conflict semantics or a GET-by-key lookup. The SDK retries requests by default; configure this deliberately. Plause must durably accept signed webhook events and correlate outcomes without creating a fresh send after uncertainty. [Linq sending contract](https://docs.linqapp.com/channel/imessage/guides/messaging/sending-messages/), [webhooks](https://docs.linqapp.com/channel/imessage/guides/webhooks/).

Linq Pro advertises zero retention. Its technical contract retains message metadata but avoids persisting message content; attachment URLs can be single-use. Verify the event's zero_retention flag and persist required inbound content before acknowledging it. [Zero-retention contract](https://docs.linqapp.com/channel/imessage/guides/platform/zero-day-retention/).

No equivalent published Inkbox iMessage zero-retention option was located. Its service exposes stored message history, and terms allow some deleted data to remain in backups/logs. Using Cloudflare for Plause storage does not mean a messaging provider never processes or stores content. [Inkbox terms](https://inkbox.ai/terms-of-service), [DPA](https://inkbox.ai/dpa).

Neither public marketing nor a status snapshot establishes better real-world latency or delivery for our workload. Linq lists contractual SLAs on Enterprise; its default terms disclaim delivery/timing guarantees. User-requested scheduled updates still need consent, opt-out handling, reputation-aware cadence and device tests. [Linq pricing](https://linqapp.com/s/pricing), [terms](https://linqapp.com/policies/terms-of-service-and-sale), [best practices](https://docs.linqapp.com/channel/imessage/getting-started/best-practices/).

## Before selecting a paid line

- Confirm the exact dedicated-line allocation, message/contact limits, support and total recurring charges.
- Establish number continuity and port-in/port-out rights; the reviewed public sources do not establish an adequate commitment for either provider.
- Confirm the customer-facing Plause use case and scheduled-message pattern fit the actual service order.
- Test phone and Apple-ID addressing, media, approvals, opt-out, duplicate/replayed webhooks, lost send responses, outages and same-contact recovery on a real device.

This recommendation authorizes no purchase or outreach. The private service activation review should include the exact line, service terms, spend and allowed tests.

## Implemented architecture and remaining activation

Plause now uses **Cloudflare R2 for private artifacts/profile memory; direct OpenAI for parent/browser/compaction models; direct Linq for Messages; and direct per-user Google OAuth with Drive**. PostgreSQL remains the structured database. Next/Eve needs a Node host and persistent workflow storage. R2 is not a substitute for those processes or the database. [Implementation and validation](../agent-app/PLAUSE.md).

Local controls include durable signed intake, explicit installed keys, closed phone enrollment, atomic spending reservations, exact expiring Google approvals, durable browser receipts and cross-tool uncertainty fences. Optional approved Tavily research replaces the inherited hosted search path. The application has no live provider configuration or purchased line.

Complete private service setup, real-device and multi-step acceptance, proactive consent, cross-store privacy and recovery before the pilot. Existing Worker credentials, budgets, Google sign-in results and password-protected staging remain independent; they do not migrate automatically.
