import { createHmac } from "node:crypto";
import type { ChannelSource, RouteHandlerArgs } from "eve/channels";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Environment from "@shared/environment";
import { INKBOX_MAX_WEBHOOK_BYTES } from "@shared/messaging/inkbox";
import type * as Inbox from "@db/services/inkbox-inbox";
import type { findVerifiedAuthUserIdByPhoneNumber } from "@db/services/auth/phone-user";
import type { processInkboxInbox } from "@agent/lib/inkbox/inbox";
import webhook from "@agent/channels/inkbox-webhook";

const controls = vi.hoisted(() => ({
  provider: "inkbox",
  signingKey: "whsec_fictional-identity-signing-key-0123456789",
  record: vi.fn<typeof Inbox.recordInkboxInbound>(),
  findUser: vi.fn<typeof findVerifiedAuthUserIdByPhoneNumber>(),
  process: vi.fn<typeof processInkboxInbox>(),
  send: vi.fn<ChannelSource["send"]>(),
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
      get INKBOX_WEBHOOK_SIGNING_KEY() {
        return controls.signingKey;
      },
      INTERNAL_SERVICE_SECRET: "fictional-internal-secret-0123456789abcdef",
    },
  };
});
vi.mock("@db/services/inkbox-inbox", () => ({
  recordInkboxInbound: controls.record,
}));
vi.mock("@db/services/auth/phone-user", () => ({
  findVerifiedAuthUserIdByPhoneNumber: controls.findUser,
}));
vi.mock("@agent/lib/inkbox/inbox", () => ({
  processInkboxInbox: controls.process,
}));

const path = "/webhooks/inkbox";
const identityId = "00000000-0000-4000-8000-000000000001";
const phoneNumber = "+15550100011";

beforeEach(() => {
  vi.clearAllMocks();
  controls.provider = "inkbox";
  controls.signingKey = "whsec_fictional-identity-signing-key-0123456789";
  controls.findUser.mockResolvedValue("user-a");
  controls.record.mockResolvedValue("recorded");
  controls.process.mockResolvedValue(undefined);
});

describe("Inkbox signed public ingress", () => {
  it("waits for the durable inbox commit before acknowledging and only wakes its relay", async () => {
    const committed = Promise.withResolvers<"recorded">();
    controls.record.mockReturnValue(committed.promise);
    const waitUntil = vi.fn<RouteHandlerArgs["waitUntil"]>();
    const raw = body();
    let acknowledged = false;
    const pending = route()
      .handler(signedRequest(raw), { ...context(), waitUntil })
      .then((result) => {
        acknowledged = true;
        return result;
      });
    await vi.waitFor(() => {
      expect(controls.record).toHaveBeenCalledOnce();
    });
    expect(acknowledged).toBe(false);
    expect(controls.send).not.toHaveBeenCalled();
    expect(controls.process).not.toHaveBeenCalled();
    expect(controls.record.mock.calls[0]?.[0]).toBe(raw);
    expect(controls.record.mock.calls[0]?.[1]).toMatchObject({
      identityId,
      senderPhoneNumber: phoneNumber,
      assignmentId: "00000000-0000-4000-8000-000000000003",
    });
    expect(controls.record.mock.calls[0]?.[2]).toBe("user-a");
    committed.resolve("recorded");
    const response = await pending;
    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("");
    expect(waitUntil).toHaveBeenCalledOnce();
    expect(controls.process).toHaveBeenCalledOnce();
    expect(controls.send).not.toHaveBeenCalled();
  });

  it("does not admit an unlinked sender into accounts, private storage, or the agent", async () => {
    controls.findUser.mockResolvedValue(undefined);
    expect(
      (await route().handler(signedRequest(body()), context())).status
    ).toBe(200);
    expect(controls.findUser).toHaveBeenCalledExactlyOnceWith(phoneNumber);
    expect(controls.record).not.toHaveBeenCalled();
    expect(controls.process).not.toHaveBeenCalled();
    expect(controls.send).not.toHaveBeenCalled();
  });

  it.each([
    ["duplicate", 202],
    ["conflict", 409],
    ["full", 429],
  ] as const)(
    "acknowledges %s without repeating admission",
    async (result, status) => {
      controls.record.mockResolvedValue(result);
      expect(
        (await route().handler(signedRequest(body()), context())).status
      ).toBe(status);
      expect(controls.process).not.toHaveBeenCalled();
      expect(controls.send).not.toHaveBeenCalled();
    }
  );

  it.each(["disabled", "linq"])(
    "does not activate Inkbox while %s is selected",
    async (provider) => {
      controls.provider = provider;
      expect(
        (await route().handler(signedRequest(body()), context())).status
      ).toBe(503);
      expect(controls.findUser).not.toHaveBeenCalled();
      expect(controls.record).not.toHaveBeenCalled();
    }
  );

  it("rejects unsigned and modified raw bodies before any account lookup", async () => {
    const raw = body();
    const signed = signedRequest(raw);
    const unsigned = new Request(signed.url, { method: "POST", body: raw });
    const altered = new Request(signed.url, {
      method: "POST",
      headers: signed.headers,
      body: `${raw} `,
    });
    const responses = await Promise.all(
      [unsigned, altered].map((request) => route().handler(request, context()))
    );
    expect(responses.map((response) => response.status)).toEqual([401, 401]);
    expect(controls.findUser).not.toHaveBeenCalled();
    expect(controls.record).not.toHaveBeenCalled();
  });

  it("binds even a correctly signed envelope to the configured identity", async () => {
    const raw = body("00000000-0000-4000-8000-000000000099");
    expect((await route().handler(signedRequest(raw), context())).status).toBe(
      401
    );
    expect(controls.findUser).not.toHaveBeenCalled();
    expect(controls.record).not.toHaveBeenCalled();
  });

  it("rejects oversized streams before signature verification or persistence", async () => {
    const request = signedRequest("x".repeat(INKBOX_MAX_WEBHOOK_BYTES + 1));
    expect((await route().handler(request, context())).status).toBe(413);
    expect(controls.findUser).not.toHaveBeenCalled();
    expect(controls.record).not.toHaveBeenCalled();
  });

  it("keeps failed inbox commits retryable without exposing private diagnostics", async () => {
    controls.record.mockRejectedValue(new Error("private database detail"));
    const response = await route().handler(signedRequest(body()), context());
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("");
    expect(controls.process).not.toHaveBeenCalled();
    expect(controls.send).not.toHaveBeenCalled();
  });
});

function body(assertedIdentity = identityId) {
  const timestamp = new Date().toISOString();
  return JSON.stringify({
    id: "evt_fixture_1",
    event_type: "imessage.received",
    timestamp,
    agent_identity_id: assertedIdentity,
    data: {
      message: {
        id: "00000000-0000-4000-8000-000000000004",
        conversation_id: "00000000-0000-4000-8000-000000000002",
        assignment_id: "00000000-0000-4000-8000-000000000003",
        agent_identity_id: assertedIdentity,
        direction: "inbound",
        remote_number: phoneNumber,
        is_group: false,
        content: "Fictional private message",
        message_type: "message",
        service: "imessage",
        status: "received",
        media: null,
        created_at: timestamp,
      },
    },
  });
}
function signedRequest(raw: string) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const requestId = "request_fixture_1";
  const signature = createHmac("sha256", controls.signingKey.slice(6))
    .update(`${requestId}.${timestamp}.`)
    .update(raw)
    .digest("hex");
  return new Request(`https://fixture.example${path}`, {
    method: "POST",
    body: raw,
    headers: {
      "x-inkbox-request-id": requestId,
      "x-inkbox-timestamp": timestamp,
      "x-inkbox-signature": `sha256=${signature}`,
    },
  });
}
function route() {
  const candidate = webhook.routes.find(
    (entry) =>
      entry.transport !== "websocket" &&
      entry.path === path &&
      entry.method === "POST"
  );
  if (!candidate || candidate.transport === "websocket")
    throw new Error("Fixture route missing");
  return candidate;
}
function context(): RouteHandlerArgs {
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
