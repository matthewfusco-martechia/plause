# Plause product and implementation plan

Updated 2026-11-02. Plause is a personal agent whose primary interface is ordinary iMessage. The user selected [Merit Systems’ OpenInstinct](https://github.com/Merit-Systems/OpenInstinct) as the base. The current plan is [OpenInstinct adoption](openinstinct-adoption.md).

The full Next.js/Eve source lives in `agent-app/`, separately from the preserved Cloudflare Worker. The original repository uses Linq through Vercel Connect; Plause now has a direct Linq adapter. Apple Messages for Business and Sunshine are no longer the selected route. Inkbox remains an optional alternative that would need a separate adapter; it is not the current Merit integration.

The user confirmed **Cloudflare storage and direct OpenAI models**. Target private files/artifacts/profile memory to R2 and remove Vercel Blob/Gateway/Connect requirements. PostgreSQL remains the adopted application's structured database until a deliberate database port; R2 is object storage. [Current provider research and migration sequence](messaging-provider-decision.md) recommends direct Linq pending a line quote and private acceptance. No paid service is selected or activated by that recommendation.

## Intended experience

1. Sign in to a restricted private workspace, verify ownership and explicitly link any existing Plause identity; never merge accounts from a phone/email match.
2. Start a conversation in iMessage, with sender, service line and conversation scope authenticated by the provider adapter.
3. Ask the agent to complete multi-step work using connected services, memory, browser workers and files. It should retain useful task state, ask for missing information, resume safely and report verified results.
4. Review and approve exact consequential actions before execution. Durable idempotency and unknown-outcome handling remain required even after approval.
5. Configure recurring AI work with notification consent, quiet hours, spend limits and reliable cancellation/revocation.
6. Inspect connections and activity, revoke access, export or erase data. Revocation/forgetting must fence stale tasks and context.

## Work required before pilot

The application supplies the coordinator, browser workers, Gmail/Calendar/Contacts tools, memory/workstreams and scheduled jobs. Plause has added direct providers, read-only Drive search/text export, exact expiring Google and browser approvals, durable action recovery and aggregate spending reservations. These have local tests, without establishing any live provider connection. Cross-store privacy/recovery, proactive notification consent/cadence and real-device acceptance remain explicit work.

The adopted app initially blocks Gmail/Calendar writes by default and runs automated unit tests with unmocked outbound network denied. Browser actions now default off and require per-call approval, current browser observations and durable dispatch receipts. All provider capabilities still need real-service acceptance before live configuration. Link purchases are unavailable in the selected upstream branch; browser-based purchases require a separate enforcement policy and approval review. Do not advertise unsupported phone control, generic filesystem access or unimplemented connectors.

Follow the [implementation sequence and acceptance matrix](openinstinct-adoption.md#implementation-order). Complete broader agent work and its failure/recovery tests before scheduling a pilot. Restrict and password-protect all new staging hosts/routes before exposing the application.

## Existing evidence

The [preserved Worker foundation](worker-foundation.md) has verified Google sign-in and narrow hosted-model smoke tests. Its existing staging password wall has HTTP acceptance evidence. Those results do not apply automatically to the adopted app, and the legacy Apple/MSP onboarding instructions are superseded. [HANDOFF](../HANDOFF.md) retains historical results without treating them as new service acceptance.
