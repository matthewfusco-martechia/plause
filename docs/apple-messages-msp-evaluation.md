# Plause Apple Messages for Business MSP evaluation

Research snapshot: 2026-10-30. This is a documentation-based shortlist, not a vendor quotation, purchase recommendation, account activation or confirmation that a vendor will contract with Plause. No vendor has been contacted or enrolled by this implementation.

Plause needs a cloud-operated conversational agent inside Messages, with opaque customer identity, authenticated account linking, bot/human ownership, rich content, delivery/lifecycle events and safe asynchronous replies. Official Apple Messages for Business is the primary target. No unofficial consumer-iMessage service or Apple-device relay is part of this shortlist.

| Candidate | Published capability evidence | Fit and constraints for Plause | Commercial/technical evidence still required |
| --- | --- | --- | --- |
| AWS Connect Customer | [Onboarding](https://docs.aws.amazon.com/connect/latest/adminguide/apple-messages-for-business.html) documents Apple registration, MSP linking, review and contact-center routing. [Channel features](https://docs.aws.amazon.com/connect/latest/adminguide/add-apple-messages-for-business-features.html) document rich UI, authentication and opaque customer identifiers. | Clear documented path for support staff and authentication. Plause must integrate the contact-center conversation/agent lifecycle, rather than assuming a generic text-send API. | Acceptance of Plause's AI use cases; deployment regions; account configuration; authenticated event ingress; closure semantics; AI/human concurrency; effective price at expected usage; limits and support commitments. All **UNVERIFIED** for Plause. |
| Infobip | [Getting started](https://www.infobip.com/docs/apple-messages-for-business/get-started) describes selecting Infobip as MSP, account availability, test/review steps and inbound HTTP forwarding. [Conversations documentation](https://www.infobip.com/docs/conversations/messaging-channels/chat-apps) describes switching from bot to live agent. | Potential fit for an HTTP adapter plus staffed support. Channel availability must be checked for the actual account; generic API access is not proof of Apple activation. | Written AI-assistant eligibility; channel enablement; specific webhook authentication/schema; closure and delivery events; permitted reminders/Business Updates; handoff API ownership; capacity, data processing terms and quotation. All **UNVERIFIED** for Plause. |
| Zendesk / Sunshine Conversations | [Zendesk channel setup](https://support.zendesk.com/hc/en-us/articles/8030634178458-Adding-and-configuring-the-Apple-Messages-for-Business-channel) documents Apple certification, live/AI agent routing and rich messages. It lists qualifying plans, an active AI or third-party bot and a Professional Services package. | Strong support-workspace fit; evaluate the integration surface and onboarding cost before treating it as a lightweight messaging adapter. [Sunshine's channel guide](https://docs.smooch.io/guide/apple-messages-for-business/) documents channel capabilities and closed-conversation behavior. | Confirm currently available product/onboarding route, standalone Plause bot integration, actual service package and quote, webhook security, closure delivery, bot/human switchboard contract and retention. All **UNVERIFIED** for Plause. |

## Shared decision gates

For each candidate, request an explicit response covering the following before contract selection:

1. Will the MSP support Plause's described personal assistant, including memory, research and user-authorized calendar actions? Does Apple accept the submitted use cases? Record separate MSP and Apple decisions.
2. How do we run an internal-test channel and prove business identity, branding and entry points before public activation?
3. Which exact APIs and events cover text, rich links, quick replies, typing, delivery, handoff and customer closure? Capture real fixture samples; do not invent payloads or reuse the mock signature protocol.
4. What customer/business opaque identifier scopes are guaranteed, and how are authentication and account unlinking handled? Do not assume an Apple conversation reveals a phone number.
5. How is live support during business hours staffed and routed? What prevents the bot from replying or acting after a human takes over?
6. Which delayed replies, recurring reminders and Business Updates are permitted? What consent, session or conversation state must be checked before each send? Product consent and channel eligibility are separate requirements.
7. How is deletion/closure signaled, and how quickly can queued sends be suppressed? What is the documented recovery path for uncertain send outcomes?
8. Obtain a written quotation with platform/seat minimums, messaging charges, onboarding/services costs, limits, support, regions, subprocessors, storage/retention and migration/export provisions. No uniform per-user cost is assumed.

## Current recommendation

**GO:** continue the independent local Worker/D1/Queues implementation against the mock provider and fake model. Use a small internal content/event contract for messages, delivery, closure and handoff.

**NO-GO:** selecting a production MSP, promising Apple availability, enabling proactive Apple reminders, or publishing the channel without written eligibility, contractual answers and actual approved-channel tests. All three candidates have relevant published documentation; none has a confirmed Plause quotation or approval. Compare an operator-approved technical spike against the same acceptance checklist before choosing a vendor.

Revalidate the [Apple policies](https://register.apple.com/resources/messages/messaging-documentation/policies), [experience review](https://register.apple.com/resources/messages/messaging-documentation/xp-review) and [privacy notice](https://www.apple.com/legal/privacy/data/en/messages-for-business/) alongside any MSP contract. The chosen provider cannot waive Apple's requirements.
