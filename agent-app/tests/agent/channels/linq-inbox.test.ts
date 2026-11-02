import { createHmac } from "node:crypto";
import type { ChannelSource, RouteHandlerArgs } from "eve/channels";
import type { Delivery } from "eve/sessions";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Environment from "@shared/environment";
import type * as Inbox from "@db/services/linq-inbox";
import type { findVerifiedAuthUserIdByPhoneNumber } from "@db/services/auth/phone-user";
import type { claimInternalRequest } from "@db/services/internal-requests";
import type { processLinqInbox } from "@agent/lib/linq/inbox";
import { signScheduledRequest } from "@agent/lib/schedules/internal-auth";
import linq from "@agent/channels/linq";
import webhook from "@agent/channels/linq-webhook";
import { linqDigest } from "@db/services/linq-inbox";

const controls = vi.hoisted(() => ({
  record: vi.fn<typeof Inbox.recordLinqInbound>(),
  scope: vi.fn<typeof Inbox.readLinqRelayScope>(),
  finish: vi.fn<typeof Inbox.finishLinqInbox>(),
  unknown: vi.fn<typeof Inbox.holdLinqInboxUnknown>(),
  findUser: vi.fn<typeof findVerifiedAuthUserIdByPhoneNumber>(),
  receipt: vi.fn<typeof claimInternalRequest>(),
  process: vi.fn<typeof processLinqInbox>(),
  send: vi.fn<ChannelSource["send"]>(),
  seen: new Set<string>(),
}));
vi.mock("@shared/environment", async (original) => {
  const loaded = await original<typeof Environment>();
  return {
    ...loaded,
    env: {
      ...loaded.env,
      LINQ_API_KEY: "fixture-linq-key",
      LINQ_PHONE_NUMBER: "+15550100000",
      LINQ_WEBHOOK_SIGNING_SECRET: `whsec_${Buffer.alloc(32, 7).toString("base64")}`,
      INTERNAL_SERVICE_SECRET: "fixture-internal-secret-0123456789abcdef",
    },
  };
});
vi.mock("@db/services/linq-inbox", async (original) => {
  const loaded = await original<typeof Inbox>();
  return {
    ...loaded,
    recordLinqInbound: controls.record,
    readLinqRelayScope: controls.scope,
    finishLinqInbox: controls.finish,
    holdLinqInboxUnknown: controls.unknown,
  };
});
vi.mock("@db/services/auth/phone-user", () => ({
  findVerifiedAuthUserIdByPhoneNumber: controls.findUser,
  assertEnrolledWorkspaceUser: async () => undefined,
}));
vi.mock("@db/services/internal-requests", () => ({
  claimInternalRequest: controls.receipt,
}));
vi.mock("@agent/lib/linq/inbox", () => ({
  LINQ_INTERNAL_ROUTE: "/internal/linq/dispatch",
  processLinqInbox: controls.process,
}));

const internalPath = "/internal/linq/dispatch";
const publicPath = "/webhooks/linq";
const leaseToken = "00000000-0000-4000-8000-000000000001";
const body = JSON.stringify({
  webhook_version: "2026-02-03",
  event_type: "message.received",
  event_id: "event-1",
  data: {
    id: "message-1",
    direction: "inbound",
    sender_handle: { id: "sender-1", handle: "+15550100011", is_me: false },
    chat: {
      id: "chat-1",
      is_group: false,
      owner_handle: { handle: "+15550100000", is_me: true },
    },
    parts: [{ type: "text", value: "private fixture text" }],
    sent_at: "2026-11-02T12:00:00Z",
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  controls.seen.clear();
  controls.findUser.mockResolvedValue("user-a");
  controls.record.mockResolvedValue("recorded");
  controls.process.mockResolvedValue(undefined);
  controls.finish.mockResolvedValue(true);
  controls.unknown.mockResolvedValue(undefined);
  controls.send.mockResolvedValue(delivery());
  controls.scope.mockResolvedValue(inboxRow());
  controls.receipt.mockImplementation(async ({ requestId }) => {
    if (controls.seen.has(requestId)) return false;
    controls.seen.add(requestId);
    return true;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>().mockResolvedValue(Response.json({ success: true }))
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("public Linq durable webhook boundary", () => {
  it("commits the encrypted inbox before acknowledgment and starts only the relay worker", async () => {
    const committed = deferred<"recorded">();
    controls.record.mockReturnValue(committed.promise);
    let finished = false;
    const waitUntil = vi.fn<RouteHandlerArgs["waitUntil"]>();
    const pending = route(publicPath)
      .handler(providerRequest(), { ...routeContext(), waitUntil })
      .then((result) => {
        finished = true;
        return result;
      });
    await vi.waitFor(() => {
      expect(controls.record).toHaveBeenCalledOnce();
    });
    expect(finished).toBe(false);
    expect(controls.send).not.toHaveBeenCalled();
    committed.resolve("recorded");
    expect((await pending).status).toBe(202);
    expect(waitUntil).toHaveBeenCalledOnce();
    expect(controls.process).toHaveBeenCalledOnce();
  });

  it("keeps failed commits retryable and does not dispatch or expose diagnostics", async () => {
    controls.record.mockRejectedValue(new Error("private database detail"));
    const response = await route(publicPath).handler(
      providerRequest(),
      routeContext()
    );
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("");
    expect(controls.process).not.toHaveBeenCalled();
    expect(controls.send).not.toHaveBeenCalled();
  });

  it("does not mint accounts, OTPs, history or model requests for an unlinked sender", async () => {
    controls.findUser.mockResolvedValue(undefined);
    expect(
      (await route(publicPath).handler(providerRequest(), routeContext()))
        .status
    ).toBe(200);
    expect(controls.record).not.toHaveBeenCalled();
    expect(controls.process).not.toHaveBeenCalled();
    expect(controls.send).not.toHaveBeenCalled();
  });

  it.each([
    ["duplicate", 202],
    ["conflict", 409],
    ["full", 429],
  ] as const)("handles %s without re-enqueueing", async (result, status) => {
    controls.record.mockResolvedValue(result);
    expect(
      (await route(publicPath).handler(providerRequest(), routeContext()))
        .status
    ).toBe(status);
    expect(controls.process).not.toHaveBeenCalled();
    expect(controls.send).not.toHaveBeenCalled();
  });

  it("rejects unsigned public ingress without reading the user database", async () => {
    expect(
      (
        await route(publicPath).handler(
          new Request(`https://fixture.example${publicPath}`, {
            method: "POST",
            body,
          }),
          routeContext()
        )
      ).status
    ).toBe(401);
    expect(controls.findUser).not.toHaveBeenCalled();
    expect(controls.record).not.toHaveBeenCalled();
  });
});

describe("private Linq admission relay", () => {
  it("does not accept even a valid provider signature as internal authorization", async () => {
    expect(
      (
        await route(internalPath).handler(
          providerRequest(internalPath),
          routeContext()
        )
      ).status
    ).toBe(401);
    expect(controls.scope).not.toHaveBeenCalled();
    expect(controls.send).not.toHaveBeenCalled();
  });

  it("waits for durable Eve admission with a stable provider key, without waiting for the model", async () => {
    const admission = deferred<Delivery>();
    controls.send.mockReturnValue(admission.promise);
    let finished = false;
    const pending = route(internalPath)
      .handler(relayRequest(), routeContext())
      .then((result) => {
        finished = true;
        return result;
      });
    await vi.waitFor(() => {
      expect(controls.send).toHaveBeenCalledOnce();
    });
    expect(finished).toBe(false);
    expect(controls.finish).not.toHaveBeenCalled();
    expect(controls.send.mock.calls[0]?.[1]).toMatchObject({
      idempotencyKey: "linq:message:message-1",
      auth: { principalId: "better-auth:user-a" },
    });
    const result = vi.fn<Delivery["result"]>();
    const receipt = { ...delivery(), result };
    admission.resolve(receipt);
    expect((await pending).status).toBe(200);
    expect(controls.finish).toHaveBeenCalledExactlyOnceWith(
      linqDigest("linq:event:event-1"),
      leaseToken,
      "accepted"
    );
    expect(result).not.toHaveBeenCalled();
  });

  it("keeps admission failure unknown and does not report accepted", async () => {
    const logging = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    controls.send.mockRejectedValue(new Error("fixture uncertain admission"));
    const response = await route(internalPath).handler(
      relayRequest(),
      routeContext()
    );
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("");
    expect(controls.unknown).toHaveBeenCalledExactlyOnceWith(
      linqDigest("linq:event:event-1"),
      leaseToken
    );
    expect(controls.finish).not.toHaveBeenCalled();
    logging.mockRestore();
  });

  it("requires the current inbox lease and cannot re-admit an accepted global event", async () => {
    expect(
      (await route(internalPath).handler(relayRequest(), routeContext())).status
    ).toBe(200);
    controls.scope.mockResolvedValue(undefined);
    expect(
      (await route(internalPath).handler(relayRequest(), routeContext())).status
    ).toBe(409);
    expect(controls.send).toHaveBeenCalledOnce();
  });

  it("rechecks the verified account and drops a reassigned or revoked phone before Eve admission", async () => {
    controls.findUser.mockResolvedValue("different-user");
    expect(
      (await route(internalPath).handler(relayRequest(), routeContext())).status
    ).toBe(200);
    expect(controls.send).not.toHaveBeenCalled();
    expect(controls.finish).toHaveBeenCalledExactlyOnceWith(
      linqDigest("linq:event:event-1"),
      leaseToken,
      "ignored"
    );
  });
});

function route(path: string) {
  const definition = path === publicPath ? webhook : linq;
  const candidate = definition.routes.find(
    (entry) =>
      entry.transport !== "websocket" &&
      entry.path === path &&
      entry.method === "POST"
  );
  if (!candidate || candidate.transport === "websocket")
    throw new Error("Fixture route missing");
  return candidate;
}

function providerRequest(path = publicPath) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", Buffer.alloc(32, 7))
    .update(`event-1.${timestamp}.${body}`)
    .digest("base64");
  return new Request(`https://fixture.example${path}`, {
    method: "POST",
    body,
    headers: {
      "webhook-id": "event-1",
      "webhook-timestamp": timestamp,
      "webhook-signature": `v1,${signature}`,
    },
  });
}

function relayRequest() {
  const headers = signScheduledRequest(internalPath, body);
  headers.set("x-plause-linq-event", linqDigest("linq:event:event-1"));
  headers.set("x-plause-linq-lease", leaseToken);
  return new Request(`https://fixture.example${internalPath}`, {
    method: "POST",
    body,
    headers,
  });
}

function inboxRow(): Inbox.LinqInboxRow {
  return {
    eventKey: linqDigest("linq:event:event-1"),
    messageKey: linqDigest("linq:message:chat-1:message-1"),
    conversationKey: linqDigest("chat-1"),
    lineDigest: linqDigest("+15550100000"),
    bodyDigest: linqDigest(body),
    bodyCiphertext: "encrypted-fixture",
    userId: "user-a",
    status: "dispatching",
    leaseToken,
    leaseExpiresAt: new Date(Date.now() + 300_000),
    expiresAt: new Date(Date.now() + 86_400_000),
    createdAt: new Date(),
    updatedAt: new Date(),
    errorCode: null,
  };
}

function routeContext(): RouteHandlerArgs {
  const source: ChannelSource = {
    send: controls.send,
    cancel: unexpected,
    clear: unexpected,
    compact: unexpected,
    create: unexpected,
    end: unexpected,
    respond: unexpected,
  };
  return {
    attachSession: unexpected,
    describe: unexpected,
    from: () => source,
    invokeTool: unexpected,
    listSkillFiles: unexpected,
    params: {},
    readSkill: unexpected,
    requestIp: null,
    resolveSession: unexpected,
    to: unexpected,
    waitUntil: () => undefined,
  };
}
function unexpected(): never {
  throw new Error("Unexpected fixture operation");
}
function delivery(): Delivery {
  return {
    deliveryId: "delivery-1",
    sessionId: "session-1",
    result: vi.fn<Delivery["result"]>(),
    stream: vi.fn<Delivery["stream"]>(),
  };
}
function deferred<T>() {
  let resolve: (value: T) => void = unexpected;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
