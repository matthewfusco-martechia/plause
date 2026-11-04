import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendNativeLinqMessage } from "@agent/lib/linq/transport";
import { accessScopeForUser } from "@shared/identity/access-scope";
import type { assertEnrolledWorkspaceUser } from "@db/services/auth/phone-user";

interface DirectLinqTestConfiguration {
  MESSAGING_PROVIDER: "disabled" | "inkbox" | "linq";
  LINQ_API_KEY: string | undefined;
  LINQ_PHONE_NUMBER: string | undefined;
}

const configuration = vi.hoisted(() => {
  const value: DirectLinqTestConfiguration = {
    MESSAGING_PROVIDER: "linq",
    LINQ_API_KEY: "direct-test-api-key",
    LINQ_PHONE_NUMBER: "+15550100000",
  };
  return value;
});
const authorization = vi.hoisted(() =>
  vi.fn<typeof assertEnrolledWorkspaceUser>()
);
vi.mock("@shared/environment", () => ({ env: configuration }));
vi.mock("@db/services/auth/phone-user", () => ({
  assertEnrolledWorkspaceUser: authorization,
}));
const scope = accessScopeForUser("better-auth:fixture");

describe("direct Linq transport", () => {
  beforeEach(() => {
    configuration.MESSAGING_PROVIDER = "linq";
    configuration.LINQ_API_KEY = "direct-test-api-key";
    configuration.LINQ_PHONE_NUMBER = "+15550100000";
    authorization.mockReset().mockResolvedValue("+15550100011");
  });

  it.each(["disabled", "inkbox"] as const)(
    "does not activate Linq transport when %s is selected",
    async (provider) => {
      configuration.MESSAGING_PROVIDER = provider;
      const send = vi.fn<typeof fetch>();
      vi.stubGlobal("fetch", send);
      await expect(
        sendNativeLinqMessage(
          "chat-1",
          { parts: [{ type: "text", value: "Fixture" }] },
          undefined,
          scope
        )
      ).rejects.toThrow("not configured");
      expect(send).not.toHaveBeenCalled();
    }
  );

  it("rechecks provider selection after SDK preparation before HTTP", async () => {
    const send = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", send);
    authorization.mockImplementationOnce(async () => {
      configuration.MESSAGING_PROVIDER = "inkbox";
      return "+15550100011";
    });
    await expect(
      sendNativeLinqMessage(
        "chat-1",
        { parts: [{ type: "text", value: "Fixture" }] },
        undefined,
        scope
      )
    ).rejects.toThrow("Connection error");
    expect(send).not.toHaveBeenCalled();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("uses the direct key, fixed endpoint and stable message idempotency", async () => {
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ message: { id: "message-1" } }));
    vi.stubGlobal("fetch", send);
    await sendNativeLinqMessage(
      "chat-1",
      {
        idempotency_key: "turn-1:reply-1",
        parts: [{ type: "text", value: "Fixture reply" }],
      },
      undefined,
      scope
    );
    expect(send).toHaveBeenCalledOnce();
    const [input, init] = send.mock.calls[0] ?? [];
    const request = new Request(input ?? "https://invalid.test", init);
    expect(request.url).toBe(
      "https://api.linqapp.com/api/partner/v3/chats/chat-1/messages"
    );
    expect(request.headers.get("authorization")).toBe(
      "Bearer direct-test-api-key"
    );
    expect(await request.json()).toEqual({
      message: {
        idempotency_key: "turn-1:reply-1",
        parts: [{ type: "text", value: "Fixture reply" }],
      },
    });
    expect(request.redirect).toBe("error");
  });

  it("does not retry an uncertain server failure even if the caller requests retries", async () => {
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ error: "fixture failure" }, { status: 503 })
      );
    vi.stubGlobal("fetch", send);
    await expect(
      sendNativeLinqMessage(
        "chat-1",
        { parts: [{ type: "text", value: "Fixture reply" }] },
        { maxRetries: 9 },
        scope
      )
    ).rejects.toThrow("fixture failure");
    expect(send).toHaveBeenCalledOnce();
  });

  it.each(["LINQ_API_KEY", "LINQ_PHONE_NUMBER"] as const)(
    "requires %s before any provider request",
    async (field) => {
      configuration[field] = undefined;
      const send = vi.fn<typeof fetch>();
      vi.stubGlobal("fetch", send);
      await expect(
        sendNativeLinqMessage(
          "chat-1",
          {
            parts: [{ type: "text", value: "Fixture reply" }],
          },
          undefined,
          scope
        )
      ).rejects.toThrow("not configured");
      expect(send).not.toHaveBeenCalled();
    }
  );

  it("blocks a revoked owner before native send and rechecks after SDK preparation", async () => {
    const send = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", send);
    authorization.mockRejectedValue(
      new Error("Private Plause access unavailable")
    );
    await expect(
      sendNativeLinqMessage(
        "chat-1",
        { parts: [{ type: "text", value: "Private fixture" }] },
        undefined,
        scope
      )
    ).rejects.toThrow("Private Plause access unavailable");
    expect(send).not.toHaveBeenCalled();
    authorization
      .mockReset()
      .mockResolvedValueOnce("+15550100011")
      .mockRejectedValueOnce(new Error("Private Plause access unavailable"));
    await expect(
      sendNativeLinqMessage(
        "chat-1",
        { parts: [{ type: "text", value: "Private fixture" }] },
        undefined,
        scope
      )
    ).rejects.toThrow("Connection error");
    expect(authorization).toHaveBeenCalledTimes(2);
    expect(send).not.toHaveBeenCalled();
  });
});
