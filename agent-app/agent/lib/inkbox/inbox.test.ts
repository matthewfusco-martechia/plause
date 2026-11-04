import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type * as Inbox from "@db/services/inkbox-inbox";
import type * as Environment from "@shared/environment";
import type { findVerifiedAuthUserIdByPhoneNumber } from "@db/services/auth/phone-user";
import { processInkboxInbox } from "@agent/lib/inkbox/inbox";
import { inkboxDigest } from "@shared/messaging/inkbox";
import type * as Outbox from "@db/services/inkbox-outbox";

const controls = vi.hoisted(() => ({
  expire: vi.fn<typeof Outbox.expireInkboxOutboundPayloads>(),
  claim: vi.fn<typeof Inbox.claimInkboxInbox>(),
  decrypt: vi.fn<typeof Inbox.decryptInkboxInbox>(),
  dispatch: vi.fn<typeof Inbox.markInkboxInboxDispatched>(),
  cancel: vi.fn<typeof Inbox.cancelUnsentInkboxInbox>(),
  unknown: vi.fn<typeof Inbox.holdInkboxInboxUnknown>(),
  findUser: vi.fn<typeof findVerifiedAuthUserIdByPhoneNumber>(),
  // SAFETY: The fixture records only bounded literal dispatch-stage names.
  order: [] as string[],
}));
vi.mock("@shared/environment", async (original) => {
  const loaded = await original<typeof Environment>();
  return {
    ...loaded,
    env: {
      ...loaded.env,
      MESSAGING_PROVIDER: "inkbox",
      INKBOX_API_KEY: "fixture-inkbox-key",
      INKBOX_IDENTITY_ID: "10000000-0000-4000-8000-000000000001",
      INKBOX_WEBHOOK_SIGNING_KEY: "fixture-signing-key",
      INTERNAL_SERVICE_SECRET: "fixture-internal-secret-0123456789abcdef",
    },
  };
});
vi.mock("@shared/environment/origin", () => ({
  applicationOrigin: () => "https://fixture.example",
}));
vi.mock("@db/services/inkbox-inbox", async (original) => {
  const loaded = await original<typeof Inbox>();
  return {
    ...loaded,
    claimInkboxInbox: controls.claim,
    decryptInkboxInbox: controls.decrypt,
    markInkboxInboxDispatched: controls.dispatch,
    cancelUnsentInkboxInbox: controls.cancel,
    holdInkboxInboxUnknown: controls.unknown,
  };
});
vi.mock("@db/services/inkbox-outbox", () => ({
  expireInkboxOutboundPayloads: controls.expire,
}));
vi.mock("@db/services/auth/phone-user", () => ({
  findVerifiedAuthUserIdByPhoneNumber: controls.findUser,
}));

const lease = "00000000-0000-4000-8000-000000000001";
const body = JSON.stringify({
  id: "evt_10000000-0000-4000-8000-000000000004",
  event_type: "imessage.received",
  timestamp: new Date().toISOString(),
  data: {
    message: {
      id: "10000000-0000-4000-8000-000000000002",
      conversation_id: "10000000-0000-4000-8000-000000000003",
      assignment_id: "10000000-0000-4000-8000-000000000005",
      direction: "inbound",
      remote_number: "+15550100011",
      sender_number: null,
      is_group: false,
      content: "private fixture",
      created_at: new Date().toISOString(),
      media: null,
      message_type: "message",
      service: "imessage",
      status: "received",
      reply_to_message_id: null,
    },
    reaction: null,
    contacts: [],
    agent_identities: [],
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  controls.order.length = 0;
  controls.expire.mockResolvedValue([]);
  controls.claim.mockResolvedValue([row()]);
  controls.decrypt.mockResolvedValue(body);
  controls.findUser.mockResolvedValue("user-a");
  controls.dispatch.mockImplementation(async () => {
    controls.order.push("persist-dispatch");
    return true;
  });
  controls.unknown.mockResolvedValue(undefined);
  controls.cancel.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllGlobals());

describe("Inkbox inbox relay worker", () => {
  it("persists dispatch before one fixed-origin signed callback without provider traffic", async () => {
    const send = vi.fn<typeof fetch>().mockImplementation(async () => {
      controls.order.push("http");
      return new Response(null, { status: 200 });
    });
    vi.stubGlobal("fetch", send);
    await processInkboxInbox();
    expect(controls.order).toEqual(["persist-dispatch", "http"]);
    expect(send).toHaveBeenCalledOnce();
    const [input, init] = send.mock.calls[0] ?? [];
    const request = new Request(input ?? "https://invalid.example", init);
    expect(request.url).toBe(
      "https://fixture.example/internal/inkbox/dispatch"
    );
    expect(await request.text()).toBe(body);
    expect(request.headers.get("x-plause-inkbox-event")).toBe(row().eventKey);
    expect(request.headers.get("x-plause-inkbox-lease")).toBe(lease);
    expect(request.headers.get("x-plause-internal-signature")).toMatch(
      /^v1=[a-f0-9]{64}$/u
    );
    expect(request.redirect).toBe("error");
    expect(controls.unknown).not.toHaveBeenCalled();
  });

  it("makes no request when the lease changes before dispatch", async () => {
    controls.dispatch.mockResolvedValue(false);
    const send = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", send);
    await processInkboxInbox();
    expect(send).not.toHaveBeenCalled();
  });

  it("does not relay revoked/reassigned users or tampered encrypted payloads", async () => {
    const send = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", send);
    controls.findUser.mockResolvedValue("different-user");
    await processInkboxInbox();
    expect(controls.cancel).toHaveBeenCalledExactlyOnceWith(
      row().eventKey,
      lease
    );
    expect(controls.dispatch).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    controls.findUser.mockResolvedValue("user-a");
    controls.cancel.mockClear();
    controls.decrypt.mockRejectedValue(new Error("fixture ciphertext invalid"));
    await processInkboxInbox();
    expect(controls.cancel).toHaveBeenCalledExactlyOnceWith(
      row().eventKey,
      lease
    );
    expect(send).not.toHaveBeenCalled();
  });

  it.each(["network", "rejected"] as const)(
    "holds %s dispatch uncertainty without automatic retries",
    async (outcome) => {
      const send = vi.fn<typeof fetch>();
      if (outcome === "network")
        send.mockRejectedValue(new Error("fixture network uncertainty"));
      else send.mockResolvedValue(new Response(null, { status: 503 }));
      vi.stubGlobal("fetch", send);
      await processInkboxInbox();
      expect(send).toHaveBeenCalledOnce();
      expect(controls.unknown).toHaveBeenCalledExactlyOnceWith(
        row().eventKey,
        lease
      );
      controls.claim.mockResolvedValue([]);
      await processInkboxInbox();
      expect(send).toHaveBeenCalledOnce();
    }
  );
});

function row(): Inbox.InkboxInboxRow {
  return {
    eventKey: inkboxDigest("inkbox:event:fixture-event"),
    messageKey: inkboxDigest("inkbox:message:fixture-message"),
    conversationKey: inkboxDigest("chat-1"),
    identityDigest: inkboxDigest("10000000-0000-4000-8000-000000000001"),
    bodyDigest: inkboxDigest(body),
    bodyCiphertext: "encrypted-fixture",
    userId: "user-a",
    status: "claimed",
    leaseToken: lease,
    leaseExpiresAt: new Date(Date.now() + 300_000),
    expiresAt: new Date(Date.now() + 86_400_000),
    createdAt: new Date(),
    updatedAt: new Date(),
    errorCode: null,
  };
}
