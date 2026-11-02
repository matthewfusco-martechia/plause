# Plause — Apple Messages for Business registration draft

**Owner review draft · 2026-11-02 · NOT SENT OR SUBMITTED.** Enrollment, contracting, approval, staffing and public service remain incomplete. Execution steps: [live setup and acceptance](live-acceptance.md).

## Registration facts

| Field | Confirmed information |
| --- | --- |
| Legal business | Martechia LLC |
| Jurisdiction | Wyoming, United States |
| Customer-facing brand | Plause |
| Brand domain | plause.si; proposed production origin `https://plause.si` |
| Existing accounts | Apple Developer and Cloudflare accounts already exist. Apple Developer membership is separate from Messages for Business enrollment. |
| MSP status | Owner confirmed no existing Zendesk/Sunshine Conversations account or contract. No MSP purchase or enrollment is authorized. |
| Current readiness | Cloudflare staging web is deployed at `https://staging.plause.si` with verified schema, bindings, secrets, custom hostname, queues and cron. Initial and returning Google sign-in are verified; signup is closed. The isolated OpenAI smoke and three approved staging AI tests passed; the staging tests recorded 1,423 microUSD estimated app debit with no held costs. Sunshine/Apple credentials, enrollment and live Messages channel remain absent; Apple/MSP registration is not submitted. |

DBA filing is excluded from this work at the owner's direction. Confirm the legal-entity/brand fields with the MSP.

## Business and use-case description — draft for Apple/MSP review

Martechia LLC is developing Plause, a personal AI assistant whose ongoing conversation is intended to live in Apple Messages for Business. Customers initiate contact, receive an AI introduction, and sign in on Plause's website to explicitly link their account. After linking, they can ask questions, save selected preferences, request public research with source links, and review proposed reminders or calendar changes. Google Calendar is separately authorized. The secondary web surface provides account, privacy and support controls. We seek confirmation that this personal-assistant use case is eligible before enrollment or activation.

No consumer-iMessage relay, device bridge, calls, purchases, automatic memory extraction or arbitrary browser/device automation is included.

Saved memory requires a direct command, such as `remember: I prefer vegetarian meals.` Limit: ten facts, 300 UTF-16 code units each, with list/edit/forget/disable/export controls. A conservative credential guard is not comprehensive sensitive-data detection. Model-proposed writes require exact, conversation-bound, single-use approval within ten minutes. An explicit reminder command directly authorizes task creation; it does not authorize proactive Apple delivery.

## Sample customer journey — proposed review demonstration

1. **First contact.** Proposed review copy: “Hi, I’m Plause, an AI assistant. To use your account and personal tools in Messages, sign in and link this conversation at https://plause.si/?onboarding=messages. Linking requires your permission and a separate confirmation. Your message has not been sent to an AI model.” Before publication, add truthful signup availability, approved policy links and actual human routing. Apple-device timing/rendering remain untested. Unlinked greetings create no private conversation or model turn.
2. **Sign in and consent.** Sign in with Google, freshly confirm the account, choose reply consent and prepare a five-minute link code. Identity sign-in does not connect Calendar. Proactive consent is separate; **proactive Apple reminders remain off pending written permission**.
3. **Prove, then confirm.** Send `link plause CODE` in Messages. “Message proof received” states the account is not linked yet. Return to the original signed-in browser, review the verified channel and separately confirm. Only then create the binding and queue the linked acknowledgment.
4. **Review an action.** With a separately connected calendar, request a 30-minute planning event at 10:00 on November 4, 2030, America/New_York. Review exact title/start/duration/calendar before sending the generated approval command. Report completion only after a confirmed provider result; label simulations and uncertainty honestly. Unknown sends/writes are not blindly repeated. Messaging API acceptance is not proof of device delivery.
5. **Help and exit.** Demonstrate same-thread human access for linked **and unlinked** senders. Staff controls exist; accountless MSP routing, actual staffing, hours and wait messaging are **not accepted**. A web support link is insufficient. Demonstrate closure/revocation stopping later sends, unlinking, memory controls, export and erasure. Erasure does not recall delivered messages or delete external events.

Apple's [onboarding guidance](https://register.apple.com/resources/messages/messaging-documentation/) requires an approved MSP and calls for an automated introduction within five seconds, “help”/“agent” human access, device testing and MSP-submitted experience review. These remain live acceptance gates. [Apple's privacy notice](https://www.apple.com/legal/privacy/data/en/messages-for-business/) describes session identifiers and separately authorized Business Updates; neither a phone number nor permission for updates is assumed.

## Zendesk/MSP eligibility and quote inquiry — DRAFT, NOT SENT

**Recipient:** Zendesk sales / Apple Messages for Business onboarding team; recipient address not yet selected.

**Subject:** Plause / Martechia LLC — personal-assistant eligibility and itemized Apple Messages for Business onboarding quote

Hello,

Martechia LLC, registered in Wyoming, United States, is developing **Plause** at **plause.si**. We have no Zendesk or Sunshine Conversations account or contract. We seek written use-case eligibility guidance and a quote before choosing services or starting enrollment.

Plause is a cloud-hosted personal AI assistant intended to have its ongoing, customer-initiated conversation in Apple Messages for Business. It identifies itself as AI. Customers sign in with Google and explicitly prove and confirm a link between their account and the Messages conversation. Proposed functions include questions and writing help, explicitly saved preferences, source-linked public research, and separately authorized reminders/calendar actions. Model-proposed writes require exact approval. There is no consumer-iMessage relay, Mac/device bridge or local model.

Our staging web application and Google sign-in are deployed and verified. The Sunshine adapter has controlled tests, but we have no Apple channel, enrollment or live Messages acceptance. Calendar and search are disabled in the initial staging scope. Proactive Apple reminders remain disabled pending written permission. Existing Apple Developer membership is not Messages for Business approval.

Please address the following and provide an **itemized written quote for the smallest compliant internal test and subsequent commercial launch**:

1. **Use-case eligibility.** Is this third-party personal-assistant use case eligible for Apple Messages for Business through your service? Which functions must be excluded or changed initially? Please distinguish your eligibility assessment from formal Apple approval.
2. **Qualifying service and price.** Which Zendesk/Sunshine offering supports our own bot and backend integration? Your [channel setup guide](https://support.zendesk.com/hc/en-us/articles/8030634178458-Adding-and-configuring-the-Apple-Messages-for-Business-channel) lists qualifying subscriptions, an active AI agent/third-party bot and a purchased Professional Services package. Please itemize subscription/seats, required add-ons, Professional Services/onboarding, usage charges, minimum commitments and cancellation terms. State your volume and staffing assumptions; we have not supplied or agreed to them.
3. **MSP and internal test path.** Apple's [onboarding guidance](https://register.apple.com/resources/messages/messaging-documentation/) starts with an approved MSP, then an internal test account in Apple Business Register. Can you provide that path for this use case? Identify the applicant/admin access, business evidence, brand assets, public policy URLs, test accounts and agreements required at each stage, and who submits Experience Review.
4. **Human escalation.** What staffing, hours, wait notices and bot/human routing are required? How can linked and unlinked senders reach a person in the same Messages thread using “help” or “agent”? Is staffed coverage our responsibility, or available as a separately quoted service? We have not committed to staffing or support hours.
5. **Integration and review.** Confirm support for our browser proof/confirmation linking, authenticated webhooks, opaque sender identity, closure/revocation and honest delivery/unknown-outcome handling. Which layer sends the AI introduction within five seconds, and how should it coordinate with our durable welcome to avoid duplicates? Include real-device testing, review ownership and implementation dependencies in the proposed scope.
6. **Consent and data terms.** Clarify permitted delayed replies, reminders/Business Updates and their consent requirements; processing regions, retention/subprocessors, deletion/export and support terms. We will keep proactive Apple delivery disabled until separately permitted and tested.

This inquiry requests eligibility guidance and a quote only. It does not authorize account creation, a contract, purchase, enrollment submission, provisioning, activation or customer messages. Please identify remaining questions rather than assuming contact details, volume or staffing.

Thank you,

Plause / Martechia LLC
Authorized sender name and corporate contact: **owner to supply before sending**.

## Owner inputs still required before submission

| Missing item | Needed decision or evidence |
| --- | --- |
| Business identity/contact | Authorized applicant, corporate email/phone, legal address and requested registration evidence; no guessed address. |
| MSP decision | No existing account/contract. Review eligibility response, itemized quote and obligations before choosing or buying a service. |
| Brand assets | Final display name and required logo files/dimensions. |
| Public pages | Reviewed, published website/privacy/terms/support URLs and retention/subprocessor disclosures; no assumed paths. |
| Human operations | Accountable owner, staff, hours/IANA zone, contact and tested linked/unlinked escalation; no invented SLA. |
| Enrollment/environment IDs | Apple business/test and MSP account/app/integration/controller/webhook IDs remain pending. Staging Google identity is already configured; any future Calendar client/grant is separate. Secrets stay out of this packet. |
| Acceptance evidence | Written use-case/proactive decisions, commercial terms and real-device review results/recording. |

Primary Apple onboarding and Zendesk channel requirements checked 2026-11-02. Confirm the complete policy and Experience Review requirements with the MSP before enrollment. Implementation: [product plan](product-plan.md), [onboarding](messages-onboarding.md), [identity/support](identity-and-support.md), [memory](saved-memory.md), [calendar](google-calendar.md). Full gates: [Apple checklist](apple-approval-checklist.md).
