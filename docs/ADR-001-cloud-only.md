# ADR 001: A cloud backend for a messaging-first agent

Status: Accepted for the initial implementation

Date: 2026-10-30

## Context

Plause is a personal AI agent that people can text in Apple Messages, similar in interaction to the product direction described by Instinct. It needs a persistent conversation, future memory and reminders, and tools that run without requiring a customer's device or desktop application to stay open. The product has been renamed from Oscilla to Plause; the existing Oscilla apps are separate products.

Earlier plans explored a Mac Messages gateway and a hosted consumer-iMessage bridge. The current direction is Apple Messages for Business through an approved messaging service provider. A real integration depends on provider evaluation and the relevant approvals.

## Decision

Run the agent backend in the cloud. Treat Apple Messages as the primary intended customer surface and use a supported provider adapter for transport. Keep account identity, conversation state, processing, and delivery state in the backend. Build the shared conversation engine before a real provider is connected.

Use Cloudflare Workers, D1, and Queues as the initial deployment architecture. D1 owns durable accepted work and outbox state. Queue publication wakes processing; it does not replace persisted work. Recovery scans reconcile unfinished state. Use explicit provider and model contracts, and begin with deterministic local mocks.

Build a small browser development console for authenticated test conversations and handoff controls. This console is a means to test the same backend while Apple onboarding proceeds. A production account surface will support linking and controls. The initial repository does not expose a production web service.

Retain structured message and lifecycle types for a future provider. Model Apple channel identities as scoped opaque subjects. Make support takeover and conversation closure durable delivery gates.

## Consequences

- The product can eventually operate without a customer's Mac, app installation, or personal API keys.
- Apple/MSP work can proceed alongside backend implementation. Until it is approved and verified, this repository cannot send or receive real Apple Messages.
- A server model integration, privacy controls, operational support, and hosting costs belong to Plause rather than the customer's device.
- Durable processing and delivery recovery are required from the beginning. Model output alone is not a completed action, and a timed-out send is not proof of failure.
- The agent and customer experience must state their real capabilities. The local mock cannot promise reminders, research, external actions, or long-term memory.
- Production launch requires account linking, provider lifecycle compliance, rich interactions where needed, real human handoff, real-device testing, and operational readiness. The local slice and a deployment dry run do not satisfy those gates.

## Alternatives considered

A Mac gateway adds a machine and personal messaging session to the availability and security boundary. It is outside the current cloud-only direction. A consumer-iMessage bridge introduces provider-specific constraints and uncertain fit for the intended official channel. A website-first assistant changes the intended daily interaction. The current choice keeps the product centered on texting Plause while isolating channel-specific work behind an adapter.
