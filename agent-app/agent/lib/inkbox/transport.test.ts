import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type * as Environment from "@shared/environment";
import { accessScopeForUser } from "@shared/identity/access-scope";
import { assertEnrolledWorkspaceUser } from "@db/services/auth/phone-user";
import {
  assertInkboxDestinationAvailable,
  assertInkboxOutboundDispatch,
  finishInkboxOutbound,
  holdInkboxOutboundUnknown,
  readInkboxOutbound,
  reconcileInkboxOutbound,
  startInkboxOutbound,
  type InkboxOutboxRow,
} from "@db/services/inkbox-outbox";
import { InkboxError, inkboxDigest } from "@shared/messaging/inkbox";
import { sendInkboxMessage, type InkboxOutboundInput } from "./transport";

interface ProviderConfiguration {
  selection: "inkbox" | "disabled";
  apiKey: string;
}
const providerConfiguration = vi.hoisted(() => {
  const value: ProviderConfiguration = {
    selection: "inkbox",
    apiKey: "fixture-inkbox-api-key",
  };
  return value;
});
vi.mock("@shared/environment", async (original) => {
  const loaded = await original<typeof Environment>();
  return {
    ...loaded,
    env: {
      ...loaded.env,
      get MESSAGING_PROVIDER() {
        return providerConfiguration.selection;
      },
      get INKBOX_API_KEY() {
        return providerConfiguration.apiKey;
      },
      INKBOX_IDENTITY_ID: "10000000-0000-4000-8000-000000000001",
      INKBOX_AGENT_HANDLE: "plause",
      INTERNAL_SERVICE_SECRET: "fixture-internal-service-secret-0123456789",
    },
  };
});
vi.mock("@db/services/auth/phone-user", () => ({
  assertEnrolledWorkspaceUser: vi.fn<typeof assertEnrolledWorkspaceUser>(),
}));
vi.mock("@db/services/inkbox-outbox", () => ({
  assertInkboxDestinationAvailable:
    vi.fn<typeof assertInkboxDestinationAvailable>(),
  assertInkboxOutboundDispatch: vi.fn<typeof assertInkboxOutboundDispatch>(),
  finishInkboxOutbound: vi.fn<typeof finishInkboxOutbound>(),
  holdInkboxOutboundUnknown: vi.fn<typeof holdInkboxOutboundUnknown>(),
  readInkboxOutbound: vi.fn<typeof readInkboxOutbound>(),
  reconcileInkboxOutbound: vi.fn<typeof reconcileInkboxOutbound>(),
  startInkboxOutbound: vi.fn<typeof startInkboxOutbound>(),
}));

const identityId = "10000000-0000-4000-8000-000000000001";
const conversationId = "20000000-0000-4000-8000-000000000002";
const assignmentId = "30000000-0000-4000-8000-000000000003";
const messageId = "40000000-0000-4000-8000-000000000004";
const phone = "+15555550123";
const scope = accessScopeForUser("better-auth:fixture-owner");
const state = (() => {
  const rows: InkboxOutboxRow[] = [];
  return { rows, enrolled: true };
})();

beforeEach(() => {
  vi.clearAllMocks();
  state.rows.length = 0;
  state.enrolled = true;
  providerConfiguration.selection = "inkbox";
  providerConfiguration.apiKey = "fixture-inkbox-api-key";
  vi.mocked(assertEnrolledWorkspaceUser).mockImplementation(async () => {
    if (!state.enrolled) throw new Error("Fixture owner no longer enrolled");
    return phone;
  });
  vi.mocked(readInkboxOutbound).mockImplementation(async () => state.rows[0]);
  vi.mocked(startInkboxOutbound).mockImplementation(async (value) => {
    const existing = state.rows[0];
    if (existing) return { kind: "existing", row: existing };
    const row = outbox(value);
    state.rows.push(row);
    return { kind: "started", row };
  });
  vi.mocked(assertInkboxOutboundDispatch).mockResolvedValue(true);
  vi.mocked(assertInkboxDestinationAvailable).mockResolvedValue();
  vi.mocked(finishInkboxOutbound).mockImplementation(
    async (_scope, _key, _attempt, id, status = "accepted") => {
      const row = requiredRow();
      row.status = status;
      row.providerMessageId = id;
      return true;
    }
  );
  vi.mocked(reconcileInkboxOutbound).mockImplementation(
    async (_scope, _key, _digest, id, status) => {
      const row = requiredRow();
      row.status = status;
      row.providerMessageId = id;
      return true;
    }
  );
  vi.mocked(holdInkboxOutboundUnknown).mockImplementation(async () => {
    const row = requiredRow();
    if (row.status === "started") row.status = "unknown";
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function input(): InkboxOutboundInput {
  return {
    scope,
    conversationId,
    assignmentId,
    phoneNumber: phone,
    idempotencyKey: "fixture-logical-message",
    text: "A fictional reply",
  };
}
function fileInput(): InkboxOutboundInput {
  return {
    ...input(),
    file: {
      bytes: new Uint8Array([1, 2, 3]),
      contentType: "image/png",
      filename: "fixture.png",
    },
  };
}
function conversation() {
  return {
    id: conversationId,
    assignment_id: assignmentId,
    assignment_status: "active",
    remote_number: phone,
    participants: [phone],
    is_group: false,
  };
}
function message(status = "pending", errorCode: string | null = null) {
  return {
    id: messageId,
    conversation_id: conversationId,
    assignment_id: assignmentId,
    direction: "outbound",
    remote_number: phone,
    is_group: false,
    status,
    error_code: errorCode,
  };
}
function json(
  value:
    | ReturnType<typeof conversation>
    | ReturnType<typeof message>
    | { message: ReturnType<typeof message> }
    | { message_id: string }
    | { media_url: string; content_type: string; size: number }
) {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
  });
}
function requiredRow() {
  const row = state.rows[0];
  if (!row) throw new Error("Fixture durable outbox row missing");
  return row;
}
function outbox(
  value: Parameters<typeof startInkboxOutbound>[0]
): InkboxOutboxRow {
  return {
    key: "a".repeat(64),
    idempotencyKey: value.idempotencyKey,
    userId: "fixture-owner",
    workspaceId: scope.workspaceId,
    identityDigest: inkboxDigest(identityId),
    ownerDigest: "b".repeat(64),
    destinationDigest: "c".repeat(64),
    bodyDigest: inkboxDigest(value.body),
    intentDigest: value.intentDigest,
    bodyCiphertext: "fixture-ciphertext",
    providerMessageId: null,
    status: "started",
    attemptToken: "50000000-0000-4000-8000-000000000005",
    createdAt: new Date(),
    updatedAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
    errorCode: null,
  };
}
function provider() {
  return vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation(async (target, options) => {
      const url = requestUrl(target);
      if (url.origin !== "https://inkbox.ai")
        throw new Error("Unexpected fixture origin");
      if (
        url.pathname === `/api/v1/imessage/conversations/${conversationId}` &&
        options?.method === "GET"
      )
        return json(conversation());
      if (
        url.pathname === "/api/v1/imessage/messages" &&
        options?.method === "POST"
      )
        return json({ message: message() });
      if (
        url.pathname === "/api/v1/imessage/media" &&
        options?.method === "POST"
      )
        return json({
          media_url: "https://media.inkbox.ai/fixture.png",
          content_type: "image/png",
          size: 3,
        });
      throw new Error("Unexpected fixture request");
    });
}
function mutations(fetch: ReturnType<typeof provider>) {
  return fetch.mock.calls.filter(([, options]) => options?.method === "POST");
}

describe("durable Inkbox outbound transport", () => {
  it("commits canonical intent before one provider POST and treats a queued reply as accepted", async () => {
    const fetch = provider();
    vi.stubGlobal("fetch", fetch);
    expect(await sendInkboxMessage(input())).toEqual({
      messageId,
      status: "accepted",
    });
    expect(startInkboxOutbound).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        scope,
        conversationId,
        assignmentId,
        phoneNumber: phone,
        idempotencyKey: "fixture-logical-message",
        body: JSON.stringify({
          conversation_id: conversationId,
          text: "A fictional reply",
        }),
      })
    );
    expect(
      vi.mocked(startInkboxOutbound).mock.calls[0]?.[0].intentDigest
    ).toMatch(/^[a-f0-9]{64}$/u);
    expect(assertInkboxOutboundDispatch).toHaveBeenCalledExactlyOnceWith(
      scope,
      "fixture-logical-message",
      requiredRow().attemptToken,
      requiredRow().bodyDigest,
      phone
    );
    expect(mutations(fetch)).toHaveLength(1);
    const headers = new Headers(mutations(fetch)[0]?.[1]?.headers);
    expect(headers.get("Idempotency-Key")).toBe("fixture-logical-message");
    expect(headers.get("Prefer")).toBe("idempotency-replay");
    expect(requiredRow().status).toBe("accepted");
  });

  it("replays an accepted text without another POST or provider lookup", async () => {
    const fetch = provider();
    vi.stubGlobal("fetch", fetch);
    await sendInkboxMessage(input());
    fetch.mockClear();
    expect(await sendInkboxMessage(input())).toEqual({
      messageId,
      status: "accepted",
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(startInkboxOutbound).toHaveBeenCalledTimes(1);
  });

  it("replays an accepted file without uploading private bytes again", async () => {
    const fetch = provider();
    vi.stubGlobal("fetch", fetch);
    await sendInkboxMessage(fileInput());
    expect(mutations(fetch)).toHaveLength(2);
    fetch.mockClear();
    expect(await sendInkboxMessage(fileInput())).toEqual({
      messageId,
      status: "accepted",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["text", "file", "destination", "assignment", "reply"])(
    "rejects a changed %s intent before another request",
    async (change) => {
      const fetch = provider();
      vi.stubGlobal("fetch", fetch);
      const original = fileInput();
      await sendInkboxMessage(original);
      const changed = { ...original };
      if (change === "text") changed.text = "A different fictional reply";
      if (change === "file")
        changed.file = {
          bytes: new Uint8Array([9, 8, 7]),
          contentType: "image/png",
          filename: "fixture.png",
        };
      if (change === "destination")
        changed.conversationId = "90000000-0000-4000-8000-000000000009";
      if (change === "assignment")
        changed.assignmentId = "90000000-0000-4000-8000-000000000009";
      if (change === "reply") changed.replyToMessageId = messageId;
      fetch.mockClear();
      await expect(sendInkboxMessage(changed)).rejects.toEqual(
        new InkboxError("inkbox_changed_intent")
      );
      expect(fetch).not.toHaveBeenCalled();
    }
  );

  it("holds a timed-out send and recovers only through GET lookup plus message read", async () => {
    const fetch = provider();
    fetch.mockImplementation(async (target, options) => {
      const url = requestUrl(target);
      if (options?.method === "POST")
        throw new Error("Fixture network timeout");
      if (url.pathname.endsWith(`/conversations/${conversationId}`))
        return json(conversation());
      if (url.pathname === "/api/v1/message-sends/lookup")
        return json({ message_id: messageId });
      if (url.pathname.endsWith(`/messages/${messageId}`))
        return json(message("delivered"));
      throw new Error("Unexpected fixture request");
    });
    vi.stubGlobal("fetch", fetch);
    await expect(sendInkboxMessage(input())).rejects.toMatchObject({
      outcomeUnknown: true,
    });
    expect(requiredRow().status).toBe("unknown");
    expect(mutations(fetch)).toHaveLength(1);
    fetch.mockClear();
    expect(await sendInkboxMessage(input())).toEqual({
      messageId,
      status: "delivered",
    });
    expect(mutations(fetch)).toHaveLength(0);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(reconcileInkboxOutbound).toHaveBeenCalledExactlyOnceWith(
      scope,
      "fixture-logical-message",
      requiredRow().bodyDigest,
      messageId,
      "delivered"
    );
  });

  it("keeps a missing read-only lookup unknown without creating a replacement key or message", async () => {
    const fetch = provider();
    vi.stubGlobal("fetch", fetch);
    await sendInkboxMessage(input());
    Object.assign(requiredRow(), {
      status: "unknown",
      providerMessageId: null,
    });
    fetch.mockClear().mockResolvedValue(new Response(null, { status: 404 }));
    await expect(sendInkboxMessage(input())).rejects.toMatchObject({
      code: "inkbox_send_unknown",
      outcomeUnknown: true,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(mutations(fetch)).toHaveLength(0);
    expect(requiredRow().status).toBe("unknown");
  });

  it("rechecks the owner after awaited conversation lookup and blocks dispatch on revocation", async () => {
    const fetch = provider();
    fetch.mockImplementation(async () => {
      state.enrolled = false;
      return json(conversation());
    });
    vi.stubGlobal("fetch", fetch);
    await expect(sendInkboxMessage(input())).rejects.toMatchObject({
      code: "inkbox_authorization_failed",
    });
    expect(mutations(fetch)).toHaveLength(0);
    expect(requiredRow().status).toBe("unknown");
  });

  it("requires the final durable claim after the owner check and before POST", async () => {
    const fetch = provider();
    vi.stubGlobal("fetch", fetch);
    vi.mocked(assertInkboxOutboundDispatch).mockResolvedValueOnce(false);
    await expect(sendInkboxMessage(input())).rejects.toMatchObject({
      code: "inkbox_authorization_failed",
    });
    expect(mutations(fetch)).toHaveLength(0);
    expect(requiredRow().status).toBe("unknown");
  });

  it.each(["provider", "credential"])(
    "blocks a %s change during the final awaited provider lookup",
    async (change) => {
      const fetch = provider();
      fetch.mockImplementation(async () => {
        if (change === "provider") providerConfiguration.selection = "disabled";
        else providerConfiguration.apiKey = "fixture-new-inkbox-api-key";
        return json(conversation());
      });
      vi.stubGlobal("fetch", fetch);
      await expect(sendInkboxMessage(input())).rejects.toMatchObject({
        code: "inkbox_authorization_failed",
      });
      expect(mutations(fetch)).toHaveLength(0);
      expect(requiredRow().status).toBe("unknown");
    }
  );

  it("blocks a stale reconnected assignment before sending text", async () => {
    const fetch = provider();
    fetch.mockResolvedValue(
      json({
        ...conversation(),
        assignment_id: "90000000-0000-4000-8000-000000000009",
      })
    );
    vi.stubGlobal("fetch", fetch);
    await expect(sendInkboxMessage(input())).rejects.toMatchObject({
      code: "inkbox_assignment_changed",
    });
    expect(mutations(fetch)).toHaveLength(0);
  });

  it("checks the active assignment before uploading private file bytes", async () => {
    const fetch = provider();
    fetch.mockResolvedValue(
      json({
        ...conversation(),
        assignment_id: "90000000-0000-4000-8000-000000000009",
      })
    );
    vi.stubGlobal("fetch", fetch);
    await expect(sendInkboxMessage(fileInput())).rejects.toBeInstanceOf(
      InkboxError
    );
    expect(mutations(fetch)).toHaveLength(0);
  });

  it("refuses another upload or message when the destination has an unresolved prior send", async () => {
    const fetch = provider();
    vi.stubGlobal("fetch", fetch);
    vi.mocked(assertInkboxDestinationAvailable).mockRejectedValue(
      new InkboxError("inkbox_destination_unknown", true)
    );
    await expect(sendInkboxMessage(fileInput())).rejects.toBeInstanceOf(Error);
    expect(mutations(fetch)).toHaveLength(0);
  });

  it("preserves confirmed delivery instead of calling it merely accepted", async () => {
    const fetch = provider();
    fetch.mockImplementation(async (_target, options) =>
      options?.method === "POST"
        ? json({ message: message("delivered") })
        : json(conversation())
    );
    vi.stubGlobal("fetch", fetch);
    expect(await sendInkboxMessage(input())).toEqual({
      messageId,
      status: "delivered",
    });
    expect(requiredRow().status).toBe("delivered");
  });

  it("retains an ambiguous provider error as unknown despite an error status", async () => {
    const fetch = provider();
    fetch.mockImplementation(async (_target, options) =>
      options?.method === "POST"
        ? json({ message: message("error", "send_outcome_ambiguous") })
        : json(conversation())
    );
    vi.stubGlobal("fetch", fetch);
    await expect(sendInkboxMessage(input())).rejects.toMatchObject({
      code: "inkbox_send_unknown",
      outcomeUnknown: true,
    });
    expect(requiredRow().status).toBe("unknown");
    expect(finishInkboxOutbound).not.toHaveBeenCalled();
  });

  it.each([null, undefined])(
    "holds delivery_unconfirmed without a stable error_code (%s) across recovery",
    async (errorCode) => {
      const fetch = provider();
      fetch.mockImplementation(async (target, options) => {
        const unconfirmed = {
          ...message("error"),
          error_code: errorCode,
          error_reason: "delivery_unconfirmed",
        };
        if (options?.method === "POST")
          return new Response(JSON.stringify({ message: unconfirmed }), {
            headers: { "Content-Type": "application/json" },
          });
        if (requestUrl(target).pathname.endsWith("/message-sends/lookup"))
          return json({ message_id: messageId });
        if (requestUrl(target).pathname.endsWith(`/messages/${messageId}`))
          return new Response(JSON.stringify(unconfirmed), {
            headers: { "Content-Type": "application/json" },
          });
        return json(conversation());
      });
      vi.stubGlobal("fetch", fetch);
      await expect(sendInkboxMessage(input())).rejects.toMatchObject({
        code: "inkbox_send_unknown",
        outcomeUnknown: true,
      });
      expect(requiredRow().status).toBe("unknown");
      expect(mutations(fetch)).toHaveLength(1);
      expect(finishInkboxOutbound).not.toHaveBeenCalled();

      fetch.mockClear();
      await expect(sendInkboxMessage(input())).rejects.toMatchObject({
        code: "inkbox_send_unknown",
        outcomeUnknown: true,
      });
      expect(requiredRow().status).toBe("unknown");
      expect(reconcileInkboxOutbound).not.toHaveBeenCalled();
      expect(mutations(fetch)).toHaveLength(0);
    }
  );

  it("does not turn an ambiguous recovery read into failed or resend it", async () => {
    const fetch = provider();
    vi.stubGlobal("fetch", fetch);
    await sendInkboxMessage(input());
    Object.assign(requiredRow(), { status: "unknown" });
    fetch
      .mockClear()
      .mockImplementation(async (target) =>
        requestUrl(target).pathname.endsWith(`/messages/${messageId}`)
          ? json(message("error", "send_outcome_ambiguous"))
          : json(conversation())
      );
    await expect(sendInkboxMessage(input())).rejects.toMatchObject({
      code: "inkbox_send_unknown",
      outcomeUnknown: true,
    });
    expect(reconcileInkboxOutbound).not.toHaveBeenCalled();
    expect(mutations(fetch)).toHaveLength(0);
    expect(requiredRow().status).toBe("unknown");
  });

  it("holds a successful provider send when local receipt persistence loses ownership", async () => {
    const fetch = provider();
    vi.stubGlobal("fetch", fetch);
    vi.mocked(finishInkboxOutbound).mockResolvedValueOnce(false);
    await expect(sendInkboxMessage(input())).rejects.toMatchObject({
      code: "inkbox_receipt_unavailable",
      outcomeUnknown: true,
    });
    expect(mutations(fetch)).toHaveLength(1);
    expect(requiredRow().status).toBe("unknown");
  });
});

function requestUrl(target: Parameters<typeof globalThis.fetch>[0]) {
  return target instanceof Request ? new URL(target.url) : new URL(target);
}
