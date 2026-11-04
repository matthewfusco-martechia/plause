import type { ChannelSource, RouteHandlerArgs } from "eve/channels";
import type { Delivery } from "eve/sessions";
import { APPROVE_OPTION_ID } from "eve/events";
import { parseAnswers } from "eve/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Environment from "@shared/environment";
import type * as Protocol from "@shared/messaging/inkbox";
import { inkboxDigest } from "@shared/messaging/inkbox";
import { accessScopeForUser } from "@shared/identity/access-scope";
import type * as Inbox from "@db/services/inkbox-inbox";
import type {
  assertEnrolledWorkspaceUser,
  findVerifiedAuthUserIdByPhoneNumber,
} from "@db/services/auth/phone-user";
import type { claimInternalRequest } from "@db/services/internal-requests";
import { signScheduledRequest } from "@agent/lib/schedules/internal-auth";
import type * as InteractionRouting from "@agent/lib/inkbox/interaction-routing";
import inkbox from "@agent/channels/inkbox";

type RoutedSession = NonNullable<
  Awaited<ReturnType<RouteHandlerArgs["resolveSession"]>>
>;

const controls = vi.hoisted(() => ({
  provider: "inkbox",
  scope: vi.fn<typeof Inbox.readInkboxRelayScope>(),
  finish: vi.fn<typeof Inbox.finishInkboxInbox>(),
  unknown: vi.fn<typeof Inbox.holdInkboxInboxUnknown>(),
  findUser: vi.fn<typeof findVerifiedAuthUserIdByPhoneNumber>(),
  assertUser: vi.fn<typeof assertEnrolledWorkspaceUser>(),
  receipt: vi.fn<typeof claimInternalRequest>(),
  conversation: vi.fn<Protocol.InkboxClient["getConversation"]>(),
  send: vi.fn<ChannelSource["send"]>(),
  respond: vi.fn<RoutedSession["respond"]>(),
  resolveSession: vi.fn<RouteHandlerArgs["resolveSession"]>(),
  resolveAnswers: vi.fn<typeof InteractionRouting.resolveInkboxStreamAnswer>(),
  stream: vi.fn<RoutedSession["stream"]>(),
  storedBody: "",
  seen: new Set<string>(),
}));
vi.mock("@shared/environment", async (original) => {
  const loaded = await original<typeof Environment>();
  return {
    ...loaded,
    env: {
      ...loaded.env,
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
vi.mock("@shared/messaging/inkbox", async (original) => {
  const loaded = await original<typeof Protocol>();
  return {
    ...loaded,
    InkboxClient: class extends loaded.InkboxClient {
      override getConversation = controls.conversation;
    },
  };
});
vi.mock("@db/services/inkbox-inbox", () => ({
  readInkboxRelayScope: controls.scope,
  finishInkboxInbox: controls.finish,
  holdInkboxInboxUnknown: controls.unknown,
}));
vi.mock("@db/services/auth/phone-user", () => ({
  findVerifiedAuthUserIdByPhoneNumber: controls.findUser,
  assertEnrolledWorkspaceUser: controls.assertUser,
}));
vi.mock("@db/services/internal-requests", () => ({
  claimInternalRequest: controls.receipt,
}));
vi.mock("@agent/lib/inkbox/inbox", () => ({
  INKBOX_INTERNAL_ROUTE: "/internal/inkbox/dispatch",
}));
vi.mock("@agent/lib/inkbox/interaction-routing", () => ({
  resolveInkboxStreamAnswer: controls.resolveAnswers,
}));

const path = "/internal/inkbox/dispatch";
const identityId = "00000000-0000-4000-8000-000000000001";
const conversationId = "00000000-0000-4000-8000-000000000002";
const assignmentId = "00000000-0000-4000-8000-000000000003";
const messageId = "00000000-0000-4000-8000-000000000004";
const lease = "00000000-0000-4000-8000-000000000005";
const phoneNumber = "+15550100011";
const acceptedAt = new Date("2026-11-02T12:00:00Z");
const address = `inkbox:${identityId}:${conversationId}:${assignmentId}`;
const eventKey = inkboxDigest("inkbox:event:evt_fixture_1");
const body = bodyWithText("Fictional private message");
function bodyWithText(text: string, withMedia = false) {
  return JSON.stringify({
    id: "evt_fixture_1",
    event_type: "imessage.received",
    timestamp: acceptedAt.toISOString(),
    agent_identity_id: identityId,
    data: {
      message: {
        id: messageId,
        conversation_id: conversationId,
        assignment_id: assignmentId,
        agent_identity_id: identityId,
        direction: "inbound",
        remote_number: phoneNumber,
        is_group: false,
        content: text,
        message_type: "message",
        service: "imessage",
        status: "received",
        media: withMedia
          ? [
              {
                url: "https://files.example/fixture.png",
                content_type: "image/png",
                size: 8,
              },
            ]
          : null,
        created_at: acceptedAt.toISOString(),
      },
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  controls.provider = "inkbox";
  controls.seen.clear();
  controls.storedBody = body;
  controls.findUser.mockResolvedValue("user-a");
  controls.assertUser.mockResolvedValue(phoneNumber);
  controls.finish.mockResolvedValue(true);
  controls.unknown.mockResolvedValue(undefined);
  controls.scope.mockImplementation(async (_event, _lease, digest) =>
    digest === inkboxDigest(controls.storedBody) ? inboxRow() : undefined
  );
  controls.conversation.mockResolvedValue({
    conversationId,
    assignmentId,
    identityId,
    remotePhoneNumber: phoneNumber,
    assignmentStatus: "active",
  });
  controls.send.mockResolvedValue(delivery());
  controls.respond.mockResolvedValue(delivery());
  controls.resolveSession.mockResolvedValue(activeSession());
  controls.resolveAnswers.mockResolvedValue(undefined);
  controls.receipt.mockImplementation(async ({ requestId }) => {
    if (controls.seen.has(requestId)) return false;
    controls.seen.add(requestId);
    return true;
  });
});

describe("Inkbox private durable admission relay", () => {
  it("requires internal HMAC authorization, not a public provider callback", async () => {
    const request = new Request(`https://fixture.example${path}`, {
      method: "POST",
      body,
      headers: { "x-inkbox-signature": `sha256=${"a".repeat(64)}` },
    });
    expect((await route().handler(request, context())).status).toBe(401);
    expect(controls.scope).not.toHaveBeenCalled();
    expect(controls.send).not.toHaveBeenCalled();
  });

  it("waits for Eve's durable admission without awaiting a model response", async () => {
    const admitted = Promise.withResolvers<Delivery>();
    controls.send.mockReturnValue(admitted.promise);
    let acknowledged = false;
    const from = vi.fn<RouteHandlerArgs["from"]>(() => source());
    const pending = route()
      .handler(relayRequest(), { ...context(), from })
      .then((response) => {
        acknowledged = true;
        return response;
      });
    await vi.waitFor(() => {
      expect(controls.send).toHaveBeenCalledOnce();
    });
    expect(acknowledged).toBe(false);
    expect(controls.finish).not.toHaveBeenCalled();
    expect(from).toHaveBeenCalledExactlyOnceWith(address);
    expect(controls.scope).toHaveBeenCalledExactlyOnceWith(
      eventKey,
      lease,
      inkboxDigest(body),
      phoneNumber
    );
    expect(controls.send.mock.calls[0]?.[0]).toEqual([
      { type: "text", text: "Fictional private message" },
    ]);
    expect(controls.send.mock.calls[0]?.[1]).toMatchObject({
      idempotencyKey: "inkbox:evt_fixture_1",
      auth: {
        authenticator: "inkbox-verified-phone",
        principalType: "user",
        principalId: "better-auth:user-a",
        attributes: {
          conversationChannel: "inkbox",
          conversationId: address,
          phoneNumber,
          inkboxMessageId: messageId,
        },
      },
      state: {
        ownerId: "better-auth:user-a",
        identityId,
        conversationId,
        assignmentId,
        phoneNumber,
        inboundMessageId: messageId,
      },
    });
    const result = vi.fn<Delivery["result"]>();
    const stream = vi.fn<Delivery["stream"]>();
    const receipt = { ...delivery(), result, stream };
    admitted.resolve(receipt);
    const response = await pending;
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(controls.finish).toHaveBeenCalledExactlyOnceWith(
      eventKey,
      lease,
      "accepted"
    );
    expect(result).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
  });

  it("does not replay the same authenticated internal request", async () => {
    const request = relayRequest();
    const replay = request.clone();
    expect((await route().handler(request, context())).status).toBe(200);
    expect((await route().handler(replay, context())).status).toBe(409);
    expect(controls.send).toHaveBeenCalledOnce();
  });

  it("does not admit a globally completed event after its lease has been consumed", async () => {
    expect((await route().handler(relayRequest(), context())).status).toBe(200);
    controls.scope.mockResolvedValue(undefined);
    expect((await route().handler(relayRequest(), context())).status).toBe(409);
    expect(controls.send).toHaveBeenCalledOnce();
  });

  it("binds the internal signature to the exact body before consulting the lease", async () => {
    const request = relayRequest();
    const altered = new Request(request.url, {
      method: "POST",
      headers: request.headers,
      body: body.replace(
        "Fictional private message",
        "Altered private message"
      ),
    });
    expect((await route().handler(altered, context())).status).toBe(401);
    expect(controls.scope).not.toHaveBeenCalled();
    expect(controls.send).not.toHaveBeenCalled();
  });

  it("requires the retained body's digest even if a different body has a valid internal HMAC", async () => {
    const altered = body.replace(
      "Fictional private message",
      "Altered private message"
    );
    expect(
      (await route().handler(relayRequest(altered), context())).status
    ).toBe(409);
    expect(controls.scope).toHaveBeenCalledExactlyOnceWith(
      eventKey,
      lease,
      inkboxDigest(altered),
      phoneNumber
    );
    expect(controls.send).not.toHaveBeenCalled();
  });

  it.each(["missing-event", "invalid-lease"])(
    "rejects %s control metadata before querying the inbox",
    async (invalid) => {
      const request = relayRequest();
      if (invalid === "missing-event")
        request.headers.delete("x-plause-inkbox-event");
      else request.headers.set("x-plause-inkbox-lease", "not-a-uuid");
      expect((await route().handler(request, context())).status).toBe(409);
      expect(controls.scope).not.toHaveBeenCalled();
      expect(controls.send).not.toHaveBeenCalled();
    }
  );

  it.each([undefined, "different-user"])(
    "drops a revoked or reassigned account before private admission (%s)",
    async (userId) => {
      controls.findUser.mockResolvedValue(userId);
      expect((await route().handler(relayRequest(), context())).status).toBe(
        200
      );
      expect(controls.finish).toHaveBeenCalledExactlyOnceWith(
        eventKey,
        lease,
        "ignored"
      );
      expect(controls.conversation).not.toHaveBeenCalled();
      expect(controls.send).not.toHaveBeenCalled();
    }
  );

  it("does not cross an assignment release and reconnect", async () => {
    controls.conversation.mockResolvedValue({
      conversationId,
      identityId,
      assignmentId: "00000000-0000-4000-8000-000000000099",
      remotePhoneNumber: phoneNumber,
      assignmentStatus: "active",
    });
    expect((await route().handler(relayRequest(), context())).status).toBe(503);
    expect(controls.send).not.toHaveBeenCalled();
    expect(controls.finish).not.toHaveBeenCalled();
    expect(controls.unknown).toHaveBeenCalledExactlyOnceWith(eventKey, lease);
  });

  it("rechecks phone enrollment after the provider lookup and refuses changed ownership", async () => {
    controls.assertUser.mockResolvedValue("+15550100099");
    expect((await route().handler(relayRequest(), context())).status).toBe(503);
    expect(controls.send).not.toHaveBeenCalled();
    expect(controls.unknown).toHaveBeenCalledExactlyOnceWith(eventKey, lease);
  });

  it("holds uncertain Eve admission without acknowledging acceptance or exposing private errors", async () => {
    controls.send.mockRejectedValue(new Error("private session detail"));
    const response = await route().handler(relayRequest(), context());
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("");
    expect(controls.finish).not.toHaveBeenCalled();
    expect(controls.unknown).toHaveBeenCalledExactlyOnceWith(eventKey, lease);
  });

  it("holds admission when its durable acceptance receipt cannot be recorded", async () => {
    controls.finish.mockResolvedValue(false);
    expect((await route().handler(relayRequest(), context())).status).toBe(503);
    expect(controls.send).toHaveBeenCalledOnce();
    expect(controls.unknown).toHaveBeenCalledExactlyOnceWith(eventKey, lease);
  });

  it.each(["disabled", "linq"])(
    "does not consume authorization or dispatch while %s is selected",
    async (provider) => {
      controls.provider = provider;
      expect((await route().handler(relayRequest(), context())).status).toBe(
        503
      );
      expect(controls.receipt).not.toHaveBeenCalled();
      expect(controls.scope).not.toHaveBeenCalled();
      expect(controls.send).not.toHaveBeenCalled();
    }
  );
});

describe("Inkbox approval replies before conversation enqueue", () => {
  it("responds to the fixed existing session without sending a new message or waiting for the model", async () => {
    const text = `APPROVE ${"a".repeat(24)}`;
    controls.storedBody = bodyWithText(text);
    const answers = parseAnswers([
      { interactionId: "parent-child-approval", optionId: APPROVE_OPTION_ID },
    ]);
    controls.resolveAnswers.mockResolvedValue(answers);
    const admitted = Promise.withResolvers<Delivery>();
    controls.respond.mockReturnValue(admitted.promise);
    let acknowledged = false;
    const pending = route()
      .handler(relayRequest(controls.storedBody), context())
      .then((response) => {
        acknowledged = true;
        return response;
      });
    await vi.waitFor(() => {
      expect(controls.respond).toHaveBeenCalledOnce();
    });
    expect(acknowledged).toBe(false);
    expect(controls.finish).not.toHaveBeenCalled();
    expect(controls.send).not.toHaveBeenCalled();
    expect(controls.resolveSession).toHaveBeenCalledExactlyOnceWith(address);
    expect(controls.resolveAnswers.mock.calls[0]?.[0].id).toBe(
      "existing-session-1"
    );
    expect(controls.resolveAnswers.mock.calls[0]?.slice(1)).toEqual([
      text,
      accessScopeForUser("better-auth:user-a"),
      address,
    ]);
    expect(controls.respond.mock.calls[0]?.[0]).toEqual(answers);
    expect(controls.respond.mock.calls[0]?.[1]).toMatchObject({
      auth: {
        authenticator: "inkbox-verified-phone",
        principalId: "better-auth:user-a",
        attributes: { conversationId: address, phoneNumber },
      },
    });
    expect(controls.respond.mock.calls[0]?.[1].idempotencyKey).toBe(
      "inkbox-answer:evt_fixture_1"
    );
    const result = vi.fn<Delivery["result"]>();
    const stream = vi.fn<Delivery["stream"]>();
    admitted.resolve({ ...delivery(), result, stream });
    expect((await pending).status).toBe(200);
    expect(controls.finish).toHaveBeenCalledExactlyOnceWith(
      eventKey,
      lease,
      "accepted"
    );
    expect(result).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
    expect(controls.send).not.toHaveBeenCalled();
  });

  it("consumes invalid, expired or already settled token replies without model admission", async () => {
    controls.storedBody = bodyWithText(`APPROVE ${"b".repeat(24)}`);
    controls.resolveAnswers.mockResolvedValue([]);
    expect(
      (await route().handler(relayRequest(controls.storedBody), context()))
        .status
    ).toBe(200);
    expect(controls.finish).toHaveBeenCalledExactlyOnceWith(
      eventKey,
      lease,
      "ignored"
    );
    expect(controls.respond).not.toHaveBeenCalled();
    expect(controls.send).not.toHaveBeenCalled();
  });

  it("does not create a session or model turn for a control reply with no active chat", async () => {
    controls.storedBody = bodyWithText(`DENY ${"a".repeat(24)}`);
    controls.resolveSession.mockResolvedValue(undefined);
    expect(
      (await route().handler(relayRequest(controls.storedBody), context()))
        .status
    ).toBe(200);
    expect(controls.resolveSession).toHaveBeenCalledExactlyOnceWith(address);
    expect(controls.resolveAnswers).not.toHaveBeenCalled();
    expect(controls.respond).not.toHaveBeenCalled();
    expect(controls.send).not.toHaveBeenCalled();
    expect(controls.finish).toHaveBeenCalledExactlyOnceWith(
      eventKey,
      lease,
      "ignored"
    );
  });

  it("does not combine an approval command with a new media delivery", async () => {
    controls.storedBody = bodyWithText(`APPROVE ${"a".repeat(24)}`, true);
    controls.resolveAnswers.mockResolvedValue(
      parseAnswers([
        { interactionId: "parent-child-approval", optionId: APPROVE_OPTION_ID },
      ])
    );
    expect(
      (await route().handler(relayRequest(controls.storedBody), context()))
        .status
    ).toBe(200);
    expect(controls.finish).toHaveBeenCalledExactlyOnceWith(
      eventKey,
      lease,
      "ignored"
    );
    expect(controls.resolveAnswers).not.toHaveBeenCalled();
    expect(controls.respond).not.toHaveBeenCalled();
    expect(controls.send).not.toHaveBeenCalled();
  });

  it("holds uncertain structured answer admission without retrying it as a model message", async () => {
    controls.storedBody = bodyWithText(`APPROVE ${"a".repeat(24)}`);
    controls.resolveAnswers.mockResolvedValue(
      parseAnswers([
        { interactionId: "parent-child-approval", optionId: APPROVE_OPTION_ID },
      ])
    );
    controls.respond.mockRejectedValue(
      new Error("Private answer admission detail")
    );
    const response = await route().handler(
      relayRequest(controls.storedBody),
      context()
    );
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("");
    expect(controls.unknown).toHaveBeenCalledExactlyOnceWith(eventKey, lease);
    expect(controls.finish).not.toHaveBeenCalled();
    expect(controls.respond).toHaveBeenCalledOnce();
    expect(controls.send).not.toHaveBeenCalled();
  });

  it("checks the verified account before resolving any approval stream", async () => {
    controls.storedBody = bodyWithText(`APPROVE ${"a".repeat(24)}`);
    controls.findUser.mockResolvedValue("different-user");
    expect(
      (await route().handler(relayRequest(controls.storedBody), context()))
        .status
    ).toBe(200);
    expect(controls.finish).toHaveBeenCalledExactlyOnceWith(
      eventKey,
      lease,
      "ignored"
    );
    expect(controls.resolveSession).not.toHaveBeenCalled();
    expect(controls.resolveAnswers).not.toHaveBeenCalled();
    expect(controls.respond).not.toHaveBeenCalled();
    expect(controls.send).not.toHaveBeenCalled();
  });

  it("checks the current assignment before resolving any approval stream", async () => {
    controls.storedBody = bodyWithText(`APPROVE ${"a".repeat(24)}`);
    controls.conversation.mockResolvedValue({
      conversationId,
      identityId,
      assignmentId: "00000000-0000-4000-8000-000000000099",
      remotePhoneNumber: phoneNumber,
      assignmentStatus: "active",
    });
    expect(
      (await route().handler(relayRequest(controls.storedBody), context()))
        .status
    ).toBe(503);
    expect(controls.unknown).toHaveBeenCalledExactlyOnceWith(eventKey, lease);
    expect(controls.resolveSession).not.toHaveBeenCalled();
    expect(controls.resolveAnswers).not.toHaveBeenCalled();
    expect(controls.respond).not.toHaveBeenCalled();
    expect(controls.send).not.toHaveBeenCalled();
  });

  it.each(["owner", "assignment"])(
    "rechecks %s after reading the approval stream and before responding",
    async (changed) => {
      controls.storedBody = bodyWithText(`APPROVE ${"a".repeat(24)}`);
      controls.resolveAnswers.mockImplementationOnce(async () => {
        if (changed === "owner")
          controls.assertUser.mockResolvedValue("+15550100099");
        else
          controls.conversation.mockResolvedValue({
            conversationId,
            identityId,
            assignmentId: "00000000-0000-4000-8000-000000000099",
            remotePhoneNumber: phoneNumber,
            assignmentStatus: "active",
          });
        return parseAnswers([
          {
            interactionId: "parent-child-approval",
            optionId: APPROVE_OPTION_ID,
          },
        ]);
      });
      expect(
        (await route().handler(relayRequest(controls.storedBody), context()))
          .status
      ).toBe(503);
      expect(controls.unknown).toHaveBeenCalledExactlyOnceWith(eventKey, lease);
      expect(controls.respond).not.toHaveBeenCalled();
      expect(controls.send).not.toHaveBeenCalled();
    }
  );
});

function relayRequest(raw = body) {
  const headers = signScheduledRequest(path, raw);
  headers.set("x-plause-inkbox-event", eventKey);
  headers.set("x-plause-inkbox-lease", lease);
  return new Request(`https://fixture.example${path}`, {
    method: "POST",
    body: raw,
    headers,
  });
}
function inboxRow(): Inbox.InkboxInboxRow {
  return {
    eventKey,
    messageKey: inkboxDigest(`inkbox:message:${messageId}`),
    conversationKey: inkboxDigest(address),
    identityDigest: inkboxDigest(identityId),
    bodyDigest: inkboxDigest(controls.storedBody),
    bodyCiphertext: "encrypted-fixture",
    userId: "user-a",
    status: "dispatching",
    leaseToken: lease,
    leaseExpiresAt: new Date(Date.now() + 300_000),
    expiresAt: new Date(Date.now() + 86_400_000),
    createdAt: acceptedAt,
    updatedAt: acceptedAt,
    errorCode: null,
  };
}
function route() {
  const candidate = inkbox.routes.find(
    (entry) =>
      entry.transport !== "websocket" &&
      entry.path === path &&
      entry.method === "POST"
  );
  if (!candidate || candidate.transport === "websocket")
    throw new Error("Fixture route missing");
  return candidate;
}
function source(): ChannelSource {
  return {
    send: controls.send,
    cancel: unexpected,
    clear: unexpected,
    compact: unexpected,
    create: unexpected,
    end: unexpected,
    respond: unexpected,
  };
}
function context(): RouteHandlerArgs {
  return {
    attachSession: unexpected,
    describe: unexpected,
    from: source,
    invokeTool: unexpected,
    listSkillFiles: unexpected,
    params: {},
    readSkill: unexpected,
    requestIp: null,
    resolveSession: controls.resolveSession,
    to: unexpected,
    waitUntil: () => undefined,
  };
}
function activeSession(): RoutedSession {
  return {
    id: "existing-session-1",
    send: unexpected,
    respond: controls.respond,
    cancel: unexpected,
    prewarm: unexpected,
    clear: unexpected,
    compact: unexpected,
    end: unexpected,
    stream: controls.stream,
  };
}
function delivery(): Delivery {
  return {
    deliveryId: "delivery-1",
    sessionId: "session-1",
    result: vi.fn<Delivery["result"]>(),
    stream: vi.fn<Delivery["stream"]>(),
  };
}
function unexpected(): never {
  throw new Error("Unexpected fixture operation");
}
