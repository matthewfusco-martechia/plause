import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type * as Inbox from "@db/services/linq-inbox";
import type * as Environment from "@shared/environment";
import type { findVerifiedAuthUserIdByPhoneNumber } from "@db/services/auth/phone-user";
import { processLinqInbox } from "@agent/lib/linq/inbox";
import { linqDigest } from "@db/services/linq-inbox";

const controls = vi.hoisted(() => ({
  claim: vi.fn<typeof Inbox.claimLinqInbox>(),
  decrypt: vi.fn<typeof Inbox.decryptLinqInbox>(),
  dispatch: vi.fn<typeof Inbox.markLinqInboxDispatched>(),
  cancel: vi.fn<typeof Inbox.cancelUnsentLinqInbox>(),
  unknown: vi.fn<typeof Inbox.holdLinqInboxUnknown>(),
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
      LINQ_API_KEY: "fixture-linq-key",
      LINQ_PHONE_NUMBER: "+15550100000",
      LINQ_WEBHOOK_SIGNING_SECRET: "fixture-signing-key",
      INTERNAL_SERVICE_SECRET: "fixture-internal-secret-0123456789abcdef",
    },
  };
});
vi.mock("@shared/environment/origin", () => ({
  applicationOrigin: () => "https://fixture.example",
}));
vi.mock("@db/services/linq-inbox", async (original) => {
  const loaded = await original<typeof Inbox>();
  return {
    ...loaded,
    claimLinqInbox: controls.claim,
    decryptLinqInbox: controls.decrypt,
    markLinqInboxDispatched: controls.dispatch,
    cancelUnsentLinqInbox: controls.cancel,
    holdLinqInboxUnknown: controls.unknown,
  };
});
vi.mock("@db/services/auth/phone-user", () => ({
  findVerifiedAuthUserIdByPhoneNumber: controls.findUser,
}));

const lease = "00000000-0000-4000-8000-000000000001";
const body = JSON.stringify({
  webhook_version: "2026-02-03",
  event_type: "message.received",
  event_id: "event-1",
  data: {
    id: "message-1",
    direction: "inbound",
    sender_handle: { handle: "+15550100011", is_me: false },
    chat: {
      id: "chat-1",
      is_group: false,
      owner_handle: { handle: "+15550100000", is_me: true },
    },
    parts: [{ type: "text", value: "private fixture" }],
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  controls.order.length = 0;
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

describe("Linq inbox relay worker", () => {
  it("persists dispatch before one fixed-origin signed callback without provider traffic", async () => {
    const send = vi.fn<typeof fetch>().mockImplementation(async () => {
      controls.order.push("http");
      return new Response(null, { status: 200 });
    });
    vi.stubGlobal("fetch", send);
    await processLinqInbox();
    expect(controls.order).toEqual(["persist-dispatch", "http"]);
    expect(send).toHaveBeenCalledOnce();
    const [input, init] = send.mock.calls[0] ?? [];
    const request = new Request(input ?? "https://invalid.example", init);
    expect(request.url).toBe("https://fixture.example/internal/linq/dispatch");
    expect(await request.text()).toBe(body);
    expect(request.headers.get("x-plause-linq-event")).toBe(row().eventKey);
    expect(request.headers.get("x-plause-linq-lease")).toBe(lease);
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
    await processLinqInbox();
    expect(send).not.toHaveBeenCalled();
  });

  it("does not relay revoked/reassigned users or tampered encrypted payloads", async () => {
    const send = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", send);
    controls.findUser.mockResolvedValue("different-user");
    await processLinqInbox();
    expect(controls.cancel).toHaveBeenCalledExactlyOnceWith(
      row().eventKey,
      lease
    );
    expect(controls.dispatch).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    controls.findUser.mockResolvedValue("user-a");
    controls.cancel.mockClear();
    controls.decrypt.mockRejectedValue(new Error("fixture ciphertext invalid"));
    await processLinqInbox();
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
      await processLinqInbox();
      expect(send).toHaveBeenCalledOnce();
      expect(controls.unknown).toHaveBeenCalledExactlyOnceWith(
        row().eventKey,
        lease
      );
      controls.claim.mockResolvedValue([]);
      await processLinqInbox();
      expect(send).toHaveBeenCalledOnce();
    }
  );
});

function row(): Inbox.LinqInboxRow {
  return {
    eventKey: linqDigest("linq:event:event-1"),
    messageKey: linqDigest("linq:message:chat-1:message-1"),
    conversationKey: linqDigest("chat-1"),
    lineDigest: linqDigest("+15550100000"),
    bodyDigest: linqDigest(body),
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
