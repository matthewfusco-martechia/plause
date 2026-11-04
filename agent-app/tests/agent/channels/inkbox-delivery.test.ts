import type { Channel, ChannelDefinition } from "eve/channels";
import type * as Channels from "eve/channels";
import {
  APPROVE_OPTION_ID,
  DENY_OPTION_ID,
  type InteractionOpened,
  type JsonValue,
} from "eve/events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Environment from "@shared/environment";
import { accessScopeForUser } from "@shared/identity/access-scope";
import type { assertEnrolledWorkspaceUser } from "@db/services/auth/phone-user";
import type * as Outbox from "@db/services/inkbox-outbox";
import type {
  finalizeScheduledReport,
  holdScheduledReport,
  releaseScheduledReport,
} from "@db/services/scheduled-agent-jobs";
import type { prepareLinqImageArtifactDelivery } from "@agent/lib/linq-image-artifact/delivery";
import type { sendInkboxMessage } from "@agent/lib/inkbox/transport";
import type * as Transport from "@agent/lib/inkbox/transport";
import { inkboxInteractionToken } from "@agent/lib/inkbox/interactions";
import { viewOf } from "@tests/helpers/session-view";
import type inkbox from "@agent/channels/inkbox";
// oxlint-disable-next-line import/no-unassigned-import -- Capture the authored public channel definition during module loading.
import "@agent/channels/inkbox";

type InkboxState =
  typeof inkbox extends Channel<infer State, { conversationId: string }>
    ? State
    : never;
type Definition = ChannelDefinition<
  InkboxState,
  { state: InkboxState },
  { conversationId: string }
>;
type EventContext = Parameters<
  NonNullable<NonNullable<Definition["events"]>["call.settled"]>
>[1];
type DeliverContext = Parameters<NonNullable<Definition["deliver"]>>[1];

const controls = vi.hoisted(() => ({
  // SAFETY: The mocked public channel factory captures this concrete Inkbox definition during module loading.
  definition: undefined as Definition | undefined,
  provider: "inkbox",
  assertUser: vi.fn<typeof assertEnrolledWorkspaceUser>(),
  send: vi.fn<typeof sendInkboxMessage>(),
  prepareImages: vi.fn<typeof prepareLinqImageArtifactDelivery>(),
  outbox: vi.fn<typeof Outbox.readInkboxOutbound>(),
  promptCreatedAt: new Date(),
  finalizeReport: vi.fn<typeof finalizeScheduledReport>(),
  holdReport: vi.fn<typeof holdScheduledReport>(),
  releaseReport: vi.fn<typeof releaseScheduledReport>(),
}));
vi.mock("eve/channels", async (importOriginal) => {
  const original = await importOriginal<typeof Channels>();
  return {
    ...original,
    defineChannel(authored: Definition) {
      controls.definition = authored;
      return original.defineChannel(authored);
    },
  };
});
vi.mock("@shared/environment", async (importOriginal) => {
  const original = await importOriginal<typeof Environment>();
  return {
    ...original,
    env: {
      ...original.env,
      get MESSAGING_PROVIDER() {
        return controls.provider;
      },
      INKBOX_API_KEY: "fictional-inkbox-api-key",
      INKBOX_IDENTITY_ID: "00000000-0000-4000-8000-000000000001",
      INKBOX_AGENT_HANDLE: "plause-fixture",
      INTERNAL_SERVICE_SECRET: "fictional-internal-secret-0123456789abcdef",
    },
  };
});
vi.mock("@db/services/auth/phone-user", () => ({
  assertEnrolledWorkspaceUser: controls.assertUser,
  findVerifiedAuthUserIdByPhoneNumber: async () => undefined,
}));
vi.mock("@agent/lib/inkbox/transport", async (importOriginal) => {
  const original = await importOriginal<typeof Transport>();
  return { ...original, sendInkboxMessage: controls.send };
});
vi.mock("@agent/lib/linq-image-artifact/delivery", () => ({
  prepareLinqImageArtifactDelivery: controls.prepareImages,
}));
vi.mock("@db/services/inkbox-outbox", async (importOriginal) => {
  const original = await importOriginal<typeof Outbox>();
  return { ...original, readInkboxOutbound: controls.outbox };
});
vi.mock("@db/services/scheduled-agent-jobs", () => ({
  finalizeScheduledReport: controls.finalizeReport,
  holdScheduledReport: controls.holdReport,
  releaseScheduledReport: controls.releaseReport,
}));

const identityId = "00000000-0000-4000-8000-000000000001";
const conversationId = "00000000-0000-4000-8000-000000000002";
const assignmentId = "00000000-0000-4000-8000-000000000003";
const phoneNumber = "+15550100011";
const scope = accessScopeForUser("better-auth:fixture-owner");
const address = `inkbox:${identityId}:${conversationId}:${assignmentId}`;
const secret = "fictional-internal-secret-0123456789abcdef";

beforeEach(() => {
  vi.clearAllMocks();
  controls.provider = "inkbox";
  controls.promptCreatedAt = new Date();
  controls.assertUser.mockResolvedValue(phoneNumber);
  controls.send.mockResolvedValue({
    messageId: "00000000-0000-4000-8000-000000000004",
    status: "accepted",
  });
  controls.prepareImages.mockImplementation(async (text) => ({
    text,
    files: [],
    failedArtifactIds: [],
  }));
  controls.outbox.mockImplementation(async () => promptOutbox());
  controls.finalizeReport.mockResolvedValue(true);
  controls.holdReport.mockResolvedValue(true);
  controls.releaseReport.mockResolvedValue(true);
});

describe("Inkbox conversation delivery authority", () => {
  it("keeps the conversation private and binds initial state to the authenticated owner", async () => {
    const state = structuredClone(definition().state);
    if (!state) throw new Error("Expected initial channel state");
    const context = deliverContext(state);
    await definition().deliver?.({ state: ownerState() }, context);
    expect(state).toEqual(ownerState());
    expect(
      definition().audience?.({
        channel: { kind: "channel:inkbox" },
        environment: "production",
        caller: { type: "anonymous" },
        state,
      })
    ).toBe("private");
    expect(controls.assertUser).toHaveBeenCalledWith(scope);
  });

  it("rejects delivery without a principal before merging any state", async () => {
    const state = ownerState();
    const context = deliverContext(state);
    await expect(
      definition().deliver?.(
        { state: ownerState() },
        {
          ...context,
          session: {
            ...context.session,
            auth: { current: null, initiator: null },
          },
        }
      )
    ).rejects.toThrow("enrolled owner");
    expect(controls.send).not.toHaveBeenCalled();
  });

  it.each([
    { ownerId: "better-auth:someone-else" },
    { phoneNumber: "+15550100099" },
    { identityId: "00000000-0000-4000-8000-000000000099" },
    { conversationId: "00000000-0000-4000-8000-000000000099" },
    { assignmentId: "00000000-0000-4000-8000-000000000099" },
  ])(
    "refuses an existing owner/identity/conversation/assignment change %j",
    async (changed) => {
      const state = ownerState();
      await expect(
        definition().deliver?.(
          { state: { ...ownerState(), ...changed } },
          deliverContext(state)
        )
      ).rejects.toThrow(/ownership changed|conversation changed/u);
      expect(state).toEqual(ownerState());
      expect(controls.send).not.toHaveBeenCalled();
    }
  );

  it("refuses delivery after phone enrollment is revoked", async () => {
    controls.assertUser.mockRejectedValue(
      new Error("Phone enrollment revoked")
    );
    await expect(
      definition().deliver?.({}, deliverContext(ownerState()))
    ).rejects.toThrow("enrollment revoked");
    expect(controls.send).not.toHaveBeenCalled();
  });
});

describe("Inkbox exact interaction replies", () => {
  it("renders a complete owner-scoped approval and turns the exact reply into framework answers", async () => {
    const context = approvalContext();
    const event = approvalEvent();
    const handler = definition().events?.["interaction.opened"];
    await handler?.(event, context);
    const token = tokenFor(event.data.interactionId);
    const outbound = controls.send.mock.calls[0]?.[0];
    expect(outbound?.text).toContain("Reply APPROVE");
    expect(outbound?.text).toContain(token);
    expect(outbound?.text).toContain('"to":["fictional@example.com"]');
    expect(outbound?.text).toContain('"body":"Every reviewed character."');
    expect(outbound?.idempotencyKey).toBe(
      "inkbox-interaction:session-1:approval-1"
    );
    expect(context.channel.state.pending[token]).toMatchObject({
      interactionId: "approval-1",
      ownerId: scope.userId,
      address,
    });
    context.channel.state.inboundText = `APPROVE ${token}`;
    const result = await definition().deliver?.(
      { message: `APPROVE ${token}` },
      deliverContext(context.channel.state)
    );
    expect(result).toEqual({
      answers: [{ interactionId: "approval-1", optionId: APPROVE_OPTION_ID }],
    });
    expect(result).not.toHaveProperty("message");
    expect(context.channel.state).not.toHaveProperty("inboundText");
  });

  it("does not send another person's approval prompt or store its token", async () => {
    const context = approvalContext();
    const event = approvalEvent();
    await definition().events?.["interaction.opened"]?.(
      {
        ...event,
        data: {
          ...event.data,
          audience: { principalIds: ["better-auth:other-owner"] },
        },
      },
      context
    );
    expect(controls.send).not.toHaveBeenCalled();
    expect(context.channel.state.pending).toEqual({});
  });

  it.each(["approve", "1"])(
    "suppresses bare %s in string and text-array deliveries while an approval is open",
    async (text) => {
      const context = approvalContext();
      await definition().events?.["interaction.opened"]?.(
        approvalEvent(),
        context
      );
      context.channel.state.inboundText = text;
      expect(
        await definition().deliver?.(
          { message: text },
          deliverContext(context.channel.state)
        )
      ).toEqual({});
      context.channel.state.inboundText = text;
      expect(
        await definition().deliver?.(
          { message: [{ type: "text", text }] },
          deliverContext(context.channel.state)
        )
      ).toEqual({});
    }
  );

  it("preserves exact child action details rather than displaying the parent delegation", async () => {
    const context = approvalContext();
    const event = approvalEvent();
    await definition().events?.["interaction.opened"]?.(
      {
        ...event,
        data: {
          ...event.data,
          origin: {
            sessionId: "child-session",
            interactionId: "child-approval",
            call: {
              callId: "child-call",
              name: "calendar_create_event",
              input: {
                title: "Exact reviewed event",
                attendees: ["fictional@example.com"],
              },
            },
          },
        },
      },
      context
    );
    const outbound = controls.send.mock.calls[0]?.[0];
    expect(outbound?.text).toContain("Action: calendar_create_event");
    expect(outbound?.text).toContain('"attendees":["fictional@example.com"]');
    expect(outbound?.text).not.toContain("gmail_send_email");
  });

  it("does not extend an approval's original deadline when its event is replayed", async () => {
    const context = approvalContext();
    const event = approvalEvent();
    await definition().events?.["interaction.opened"]?.(event, context);
    const token = tokenFor(event.data.interactionId);
    const pending = context.channel.state.pending[token];
    if (!pending) throw new Error("Expected pending interaction");
    const originalDeadline = Date.now() + 1000;
    pending.expiresAt = originalDeadline;
    await definition().events?.["interaction.opened"]?.(event, context);
    expect(context.channel.state.pending[token]?.expiresAt).toBe(
      originalDeadline
    );
    expect(
      controls.send.mock.calls.map(([input]) => input.idempotencyKey)
    ).toEqual([
      "inkbox-interaction:session-1:approval-1",
      "inkbox-interaction:session-1:approval-1",
    ]);
  });

  it("recovers the original expiry after an event replay loses its pending-token state", async () => {
    const openedAt = new Date(Date.now() - 100_000).toISOString();
    const context = approvalContext(openedAt);
    const event = approvalEvent();
    const token = tokenFor(event.data.interactionId);
    await definition().events?.["interaction.opened"]?.(event, context);
    const deadline = Date.parse(openedAt) + 300_000;
    expect(context.channel.state.pending[token]?.expiresAt).toBe(deadline);
    context.channel.state.pending = {};
    await definition().events?.["interaction.opened"]?.(event, context);
    expect(context.channel.state.pending[token]?.expiresAt).toBe(deadline);
  });

  it("suppresses stale and settled tokens without starting a model message", async () => {
    const context = approvalContext();
    const event = approvalEvent();
    await definition().events?.["interaction.opened"]?.(event, context);
    const token = tokenFor(event.data.interactionId);
    const pending = context.channel.state.pending[token];
    if (!pending) throw new Error("Expected pending interaction");
    pending.expiresAt = Date.now() - 1;
    context.channel.state.inboundText = `APPROVE ${token}`;
    expect(
      await definition().deliver?.(
        { message: `APPROVE ${token}` },
        deliverContext(context.channel.state)
      )
    ).toEqual({});
    context.channel.state.inboundText = `APPROVE ${token}`;
    expect(
      await definition().deliver?.(
        { message: [{ type: "text", text: `APPROVE ${token}` }] },
        deliverContext(context.channel.state)
      )
    ).toEqual({});
    await definition().events?.["interaction.settled"]?.(
      {
        type: "interaction.settled",
        data: { interactionId: event.data.interactionId, outcome: "expired" },
        scope: { turnId: "turn-1" },
      },
      context
    );
    expect(context.channel.state.pending[token]).toBeUndefined();
    context.channel.state.inboundText = `APPROVE ${token}`;
    expect(
      await definition().deliver?.(
        { message: `APPROVE ${token}` },
        deliverContext(context.channel.state)
      )
    ).toEqual({});
  });

  it("fails closed when a prompt has no durable outbox time anchor", async () => {
    const context = approvalContext();
    controls.outbox.mockResolvedValue(undefined);
    const event = approvalEvent();
    await definition().events?.["interaction.opened"]?.(event, context);
    const token = tokenFor(event.data.interactionId);
    expect(context.channel.state.pending[token]?.expiresAt).toBe(0);
    context.channel.state.inboundText = `APPROVE ${token}`;
    expect(
      await definition().deliver?.(
        { message: `APPROVE ${token}` },
        deliverContext(context.channel.state)
      )
    ).toEqual({});
  });

  it("refuses approval bodies too large for full review instead of truncating them", async () => {
    const context = approvalContext();
    const event = approvalEvent();
    await expect(
      definition().events?.["interaction.opened"]?.(
        {
          ...event,
          data: {
            ...event.data,
            request: { ...event.data.request, prompt: "x".repeat(19_000) },
          },
        },
        context
      )
    ).rejects.toThrow("too large to review");
    expect(controls.send).not.toHaveBeenCalled();
    expect(context.channel.state.pending).toEqual({});
  });
});

describe("Inkbox settled tool outputs", () => {
  it("sends one explicit message with a replay-stable key and no content-event duplicate", async () => {
    const context = {
      ...eventContext(),
      view: callView("send_message", {
        kind: "message",
        text: "The complete reply.",
      }),
    };
    const event = settledCall("send_message", {
      kind: "message",
      text: "The complete reply.",
    });
    await definition().events?.["call.settled"]?.(event, context);
    expect(controls.send).toHaveBeenCalledOnce();
    expect(controls.send.mock.calls[0]?.[0]).toMatchObject({
      scope,
      conversationId,
      assignmentId,
      phoneNumber,
      idempotencyKey: "inkbox-call:session-1:call-1:text",
      text: "The complete reply.",
      replyToMessageId: undefined,
    });
    expect(controls.send.mock.calls[0]?.[0].beforeSend).toBeTypeOf("function");
    expect(definition().events?.["content.completed"]).toBeUndefined();
    await definition().events?.["call.settled"]?.(event, context);
    expect(
      controls.send.mock.calls.map(([input]) => input.idempotencyKey)
    ).toEqual([
      "inkbox-call:session-1:call-1:text",
      "inkbox-call:session-1:call-1:text",
    ]);
  });

  it("does not send a returned string from an unrelated tool", async () => {
    const context = {
      ...eventContext(),
      view: callView("gmail_search", "Private search results"),
    };
    await definition().events?.["call.settled"]?.(
      settledCall("gmail_search", "Private search results"),
      context
    );
    expect(controls.send).not.toHaveBeenCalled();
  });

  it("refuses late output after workspace enrollment is revoked", async () => {
    const context = {
      ...eventContext(),
      view: callView("send_message", { kind: "message", text: "Late reply" }),
    };
    controls.assertUser.mockRejectedValue(
      new Error("Phone enrollment revoked")
    );
    await expect(
      definition().events?.["call.settled"]?.(
        settledCall("send_message", { kind: "message", text: "Late reply" }),
        context
      )
    ).rejects.toThrow("enrollment revoked");
    expect(controls.send).not.toHaveBeenCalled();
  });
});

describe("Inkbox scheduled report uncertainty", () => {
  it("keeps an uncertain send held through both turn and session completion", async () => {
    const context = reportContext();
    controls.send.mockRejectedValueOnce(
      new Error("Fictional provider outcome unknown")
    );
    await expect(
      definition().events?.["call.settled"]?.(
        settledCall("send_message", {
          kind: "message",
          text: "Scheduled report",
        }),
        context
      )
    ).rejects.toThrow("outcome unknown");
    expect(context.channel.state.reportAttempts[reportKey]).toBe("unknown");
    expect(controls.holdReport).toHaveBeenCalledWith(
      reportRunId,
      reportLease,
      "Inkbox report delivery is unconfirmed; reconcile before retrying."
    );
    await definition().events?.["turn.settled"]?.(
      {
        type: "turn.settled",
        data: { turnId: "turn-1", outcome: "completed" },
      },
      context
    );
    await definition().events?.["session.ended"]?.(
      { type: "session.ended", data: { outcome: "completed" } },
      context
    );
    expect(controls.finalizeReport).not.toHaveBeenCalled();
    expect(controls.releaseReport).not.toHaveBeenCalled();
    expect(controls.send).toHaveBeenCalledOnce();
  });

  it("holds a durable attempted report recovered before its send outcome was recorded", async () => {
    const context = reportContext();
    context.channel.state.reportAttempts[reportKey] = "attempted";
    await definition().events?.["turn.settled"]?.(
      { type: "turn.settled", data: { turnId: "turn-1", outcome: "failed" } },
      context
    );
    expect(controls.holdReport).toHaveBeenCalledOnce();
    expect(controls.finalizeReport).not.toHaveBeenCalled();
    expect(controls.releaseReport).not.toHaveBeenCalled();
    expect(controls.send).not.toHaveBeenCalled();
  });

  it("finalizes an accepted report once and never later marks it suppressed or released", async () => {
    const context = reportContext();
    await definition().events?.["call.settled"]?.(
      settledCall("send_message", {
        kind: "message",
        text: "Scheduled report",
      }),
      context
    );
    expect(context.channel.state.reportAttempts[reportKey]).toBe("accepted");
    expect(controls.send.mock.calls[0]?.[0].idempotencyKey).toBe(
      `${reportKey}:text`
    );
    expect(controls.finalizeReport).toHaveBeenCalledExactlyOnceWith(
      reportRunId,
      reportLease,
      "delivered"
    );
    await definition().events?.["turn.settled"]?.(
      {
        type: "turn.settled",
        data: { turnId: "turn-1", outcome: "completed" },
      },
      context
    );
    await definition().events?.["session.ended"]?.(
      { type: "session.ended", data: { outcome: "completed" } },
      context
    );
    expect(controls.finalizeReport).toHaveBeenCalledOnce();
    expect(controls.holdReport).not.toHaveBeenCalled();
    expect(controls.releaseReport).not.toHaveBeenCalled();
  });
});

function definition() {
  const value = controls.definition;
  if (!value) throw new Error("Expected channel definition capture");
  return value;
}
function ownerState(): InkboxState {
  const initial = definition().state;
  if (!initial) throw new Error("Expected initial channel state");
  return {
    ...structuredClone(initial),
    ownerId: scope.userId,
    identityId,
    conversationId,
    assignmentId,
    phoneNumber,
    pending: {},
    openInteractionIds: [],
  };
}
const reportRunId = "00000000-0000-4000-8000-000000000010";
const reportLease = "00000000-0000-4000-8000-000000000011";
const reportKey = `scheduled-report:${reportRunId}:1`;
function reportContext(): EventContext {
  const context = eventContext();
  return {
    ...context,
    view: callView("send_message", {
      kind: "message",
      text: "Scheduled report",
    }),
    session: {
      ...context.session,
      auth: {
        current: {
          authenticator: "scheduled-result",
          principalType: "user",
          principalId: scope.userId,
          attributes: {
            workspaceId: scope.workspaceId,
            conversationChannel: "inkbox",
            conversationId: address,
            scheduleId: "00000000-0000-4000-8000-000000000012",
            scheduledReportLeaseToken: reportLease,
            scheduledReportSequence: "1",
            scheduledRunId: reportRunId,
            scheduledRunSessionId: "scheduled-worker-session",
          },
        },
        initiator: null,
      },
    },
  };
}
function eventContext(): EventContext {
  return {
    channel: { state: ownerState() },
    position: { index: 0, line: 0 },
    view: callView("gmail_send_email", {
      to: ["fictional@example.com"],
      body: "Every reviewed character.",
    }),
    getSandbox: async () => {
      throw new Error("Unexpected sandbox access");
    },
    session: {
      id: "session-1",
      auth: {
        current: {
          authenticator: "inkbox-verified-phone",
          principalType: "user",
          principalId: scope.userId,
          attributes: { workspaceId: scope.workspaceId, phoneNumber },
        },
        initiator: null,
      },
      turn: { id: "turn-1", sequence: 0 },
    },
  };
}
function deliverContext(state: InkboxState): DeliverContext {
  return { state, session: eventContext().session };
}
function approvalContext(openedAt = new Date().toISOString()) {
  controls.promptCreatedAt = new Date(openedAt);
  return {
    ...eventContext(),
    view: callView(
      "gmail_send_email",
      { to: ["fictional@example.com"], body: "Every reviewed character." },
      approvalEvent(),
      openedAt
    ),
  };
}
function promptOutbox(): NonNullable<
  Awaited<ReturnType<typeof Outbox.readInkboxOutbound>>
> {
  const digest = "a".repeat(64);
  return {
    key: digest,
    idempotencyKey: "inkbox-interaction:session-1:approval-1",
    userId: "fixture-owner",
    workspaceId: scope.workspaceId,
    identityDigest: digest,
    ownerDigest: digest,
    destinationDigest: digest,
    bodyDigest: digest,
    intentDigest: digest,
    bodyCiphertext: "encrypted-fixture",
    providerMessageId: "00000000-0000-4000-8000-000000000004",
    status: "accepted",
    attemptToken: "00000000-0000-4000-8000-000000000005",
    createdAt: controls.promptCreatedAt,
    updatedAt: controls.promptCreatedAt,
    expiresAt: new Date(controls.promptCreatedAt.getTime() + 86_400_000),
    errorCode: null,
  };
}
function tokenFor(interactionId: string) {
  return inkboxInteractionToken(secret, {
    sessionId: "session-1",
    interactionId,
    ownerId: scope.userId,
    address,
  });
}
function approvalEvent(): InteractionOpened {
  return {
    type: "interaction.opened",
    data: {
      interactionId: "approval-1",
      subject: { callId: "call-1" },
      audience: { principalIds: [scope.userId] },
      request: {
        kind: "approval",
        title: "Review this exact action",
        prompt: "Send the fully reviewed message?",
        options: [
          { id: APPROVE_OPTION_ID, label: "Approve" },
          { id: DENY_OPTION_ID, label: "Deny" },
        ],
      },
    },
    scope: { turnId: "turn-1", runId: "run-1" },
  };
}
function callView(
  name: string,
  input: JsonValue,
  interaction?: InteractionOpened,
  openedAt = new Date().toISOString()
) {
  return viewOf(
    [
      [
        {
          type: "turn.started",
          data: {
            cause: { deliveryId: "delivery-1" },
            follows: null,
            turnId: "turn-1",
          },
        },
      ],
      [
        {
          type: "call.requested",
          data: {
            callId: "call-1",
            capability: { kind: "tool", name },
            input,
            owner: { runId: "run-1" },
          },
          scope: { runId: "run-1", turnId: "turn-1" },
        },
      ],
      ...(interaction ? [[interaction]] : []),
    ],
    openedAt
  );
}
function settledCall(_name: string, output: JsonValue) {
  return {
    type: "call.settled" as const,
    data: { callId: "call-1", outcome: "completed" as const, output },
    scope: { runId: "run-1", turnId: "turn-1" },
  };
}
