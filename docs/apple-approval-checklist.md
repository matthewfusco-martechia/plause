# Plause Apple Messages for Business approval checklist

Research snapshot: 2026-10-30. **Status: NOT REGISTERED, NOT APPROVED, NOT DEPLOYED.** Plause is a messaging-first personal agent. Apple Messages for Business is the intended official channel; local web/mock development proceeds independently. It is not a general consumer iMessage API.

## Evidence and policy baseline

Review the current [Apple onboarding resources](https://register.apple.com/resources/messages/messaging-documentation/), [policies](https://register.apple.com/resources/messages/messaging-documentation/policies) and [experience review](https://register.apple.com/resources/messages/messaging-documentation/xp-review) before submission. The policy/review pages used in this research identify a 2026-07-21 update. Published requirements and another assistant's approval do not establish Plause eligibility.

- [ ] Authorized owner supplies the legal entity, Plause brand, domain, business address, privacy policy, terms, support owner and truthful support hours. No invented company information.
- [ ] Apple and the selected MSP confirm acceptance of Plause's actual personal-assistant use cases, memory, research and calendar behavior. Keep the written decision.
- [ ] Operator approves enrollment, agreements, provisioning, deployment and first test sends separately from local implementation.
- [ ] Register an internal-test account and select an approved MSP using [Apple Business Register](https://register.apple.com/). Record account, review and activation statuses without treating registration as launch approval.

## Conversation experience and human support

Live support during stated business hours is a requirement, not an unresolved optional feature. [AWS's onboarding guidance](https://docs.aws.amazon.com/connect/latest/adminguide/apple-messages-for-business.html) also describes live-agent routing, automation disclosure and after-hours handling.

- [ ] Provide a staffed live-agent path, support coverage, queue ownership and escalation owner. An AI replying that someone will help is not a live handoff.
- [ ] Make HELP and the offered human-support action route deterministically. Introduce the human, pause bot activity while the human owns the conversation, and define resumption.
- [ ] Show accurate after-hours availability and set a response expectation.
- [ ] Capture the initial automated greeting within the review's five-second expectation; identify Plause as automated and describe its useful capabilities.
- [ ] Implement the selected MSP's typing indication, rich links and quick replies where required by Apple's review. Internal rich-content types and browser previews are not an Apple implementation.
- [ ] Use explicit yes/no quick-reply consent before soliciting personal identifying information, following current policy. Explain purpose and handling without pasting a large legal document into chat.
- [ ] Demonstrate the actual end-to-end flows and human handoff for the experience review; retain redacted evidence, Apple decision and MSP production activation.

## Identity, deletion and outbound eligibility

- [ ] Map the provider/business-scoped opaque customer subject to an unlinked Plause contact. Use an authenticated account-link flow before exposing historical context or connected accounts. Phone collection is separate and optional for channels that need it. See [AWS's opaque identity attribute](https://docs.aws.amazon.com/connect/latest/adminguide/add-apple-messages-for-business-features.html).
- [ ] Obtain documented lifecycle events from the MSP. Deleting/closing the customer's conversation must stop later outbound messages; suppress queued bot replies and future proactive jobs immediately, with execution-time checks.
- [ ] Define customer reinitiation explicitly so an old delayed event or job cannot reopen a closed conversation.
- [ ] Confirm the permitted conditions for delayed research results, reminders and recurring updates with Apple and the MSP. Keep proactive Apple sends disabled while unverified.
- [ ] If using Business Updates, implement its separate authorization and eligibility requirements; user intent alone does not prove channel eligibility. [Apple's privacy notice](https://www.apple.com/legal/privacy/data/en/messages-for-business/) describes this opt-in capability.
- [ ] Provide export/erasure and retention rules across Plause and subprocessors, including source messages, summaries and backups. Explain that conversation closure and account-wide erasure are different operations.

## Technical launch gates

- [ ] Implement the chosen MSP's documented auth, webhook verification and actual event schemas, with real provider fixtures. Plause's mock HMAC format is not an MSP claim.
- [ ] Test inbound text, delivery status, handoff, closed conversation, duplicate/reordered events, unknown send outcome and provider outage. A status event must not produce an agent reply.
- [ ] Before calendar writes, implement immutable action-bound single-use approvals, expiry, grant rechecks and changed-event detection. Real OAuth/tools and writes are deferred from the local slice.
- [ ] Confirm pricing, minimum commitments, throughput, support terms, regions, retention, subprocessors and migration path in writing. Measure costs and reliability.
- [ ] Receive explicit Apple review approval and MSP activation before enabling public Apple entry points or marketing a working Messages integration.

Missing evidence remains **UNVERIFIED**. A completed local mock exchange satisfies none of the external approval gates.
