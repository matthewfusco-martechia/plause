import type { InkboxClient } from "@shared/messaging/inkbox";
import type * as InkboxProtocol from "@shared/messaging/inkbox";
import type * as Environment from "@shared/environment";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendPhoneCode } from "@db/services/auth";
import {
  inkboxSignInConfigured,
  readInkboxOnboarding,
  sendInkboxPhoneCode,
} from "@db/services/auth/inkbox";

interface MessagingAuthFixture {
  provider: "disabled" | "inkbox" | "linq";
  apiKey: string | undefined;
  identityId: string | undefined;
  agentHandle: string | undefined;
  signingKey: string | undefined;
  internalSecret: string | undefined;
  enrolled: boolean;
}
const configuration = vi.hoisted(() => {
  const value: MessagingAuthFixture = {
    provider: "inkbox",
    apiKey: "fictional-inkbox-key",
    identityId: "da3f6e14-5915-4cf8-b100-130846fa3f5e",
    agentHandle: "plause",
    signingKey: "fictional-signing-key",
    internalSecret: "fictional-internal-secret-0123456789abcdef",
    enrolled: true,
  };
  return value;
});
const provider = vi.hoisted(() => ({
  router: vi.fn<InkboxClient["getRouter"]>(),
  find: vi.fn<InkboxClient["findActiveConversation"]>(),
  send: vi.fn<InkboxClient["sendMessage"]>(),
}));
vi.mock("@shared/environment", async (importOriginal) => {
  const original = await importOriginal<typeof Environment>();
  return {
    ...original,
    localPhoneAuthBypassEnabled: false,
    env: {
      ...original.env,
      get MESSAGING_PROVIDER() {
        return configuration.provider;
      },
      get INKBOX_API_KEY() {
        return configuration.apiKey;
      },
      get INKBOX_IDENTITY_ID() {
        return configuration.identityId;
      },
      get INKBOX_AGENT_HANDLE() {
        return configuration.agentHandle;
      },
      get INKBOX_WEBHOOK_SIGNING_KEY() {
        return configuration.signingKey;
      },
      get INTERNAL_SERVICE_SECRET() {
        return configuration.internalSecret;
      },
      get PRIVATE_ALLOWED_PHONE_NUMBERS() {
        return configuration.enrolled ? "+12025550123" : "";
      },
      LINQ_API_KEY: "fictional-linq-key",
      LINQ_PHONE_NUMBER: "+15550100000",
    },
  };
});
vi.mock("@shared/messaging/inkbox", async (importOriginal) => {
  const original = await importOriginal<typeof InkboxProtocol>();
  return {
    ...original,
    InkboxClient: class extends original.InkboxClient {
      override getRouter = provider.router;
      override findActiveConversation = provider.find;
      override sendMessage = provider.send;
    },
  };
});

const conversation = {
  conversationId: "3af93ec3-38ec-481b-b03c-dc1ce52aa4fa",
  assignmentId: "19d0dff6-3cf4-4054-8cb8-c9b8bedbd6ad",
  identityId: "da3f6e14-5915-4cf8-b100-130846fa3f5e",
  remotePhoneNumber: "+12025550123",
  assignmentStatus: "active" as const,
};
const message = {
  messageId: "7bdc4fb5-7840-408e-ab27-9e19fe2b48b7",
  conversationId: conversation.conversationId,
  assignmentId: conversation.assignmentId,
  recipientPhoneNumber: conversation.remotePhoneNumber,
  status: "accepted" as const,
  errorCode: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  configuration.provider = "inkbox";
  configuration.apiKey = "fictional-inkbox-key";
  configuration.identityId = conversation.identityId;
  configuration.agentHandle = "plause";
  configuration.signingKey = "fictional-signing-key";
  configuration.internalSecret = "fictional-internal-secret-0123456789abcdef";
  configuration.enrolled = true;
  provider.router.mockResolvedValue({
    number: "+15550100022",
    connectCommand: "connect @plause",
    smsLink: "sms:+15550100022?&body=connect%20%40plause",
  });
  provider.find.mockResolvedValue(conversation);
  provider.send.mockImplementation(async (input) => {
    await input.beforeSend();
    return message;
  });
  vi.spyOn(globalThis, "fetch");
});
afterEach(() => {
  vi.mocked(globalThis.fetch).mockRestore();
});

describe("selected-provider phone authentication", () => {
  it("resolves the current router and never treats its number as the owned conversation", async () => {
    expect(await readInkboxOnboarding()).toMatchObject({
      number: "+15550100022",
      connectCommand: "connect @plause",
    });
    expect(provider.router).toHaveBeenCalledOnce();
    expect(provider.find).not.toHaveBeenCalled();
    expect(provider.send).not.toHaveBeenCalled();
  });

  it("sends an OTP only to the active exact-phone conversation with a stable explicit key", async () => {
    await sendPhoneCode({ to: "+12025550123", code: "123456" });
    await sendPhoneCode({ to: "+12025550123", code: "123456" });
    expect(provider.find).toHaveBeenNthCalledWith(1, "+12025550123");
    const first = provider.send.mock.calls[0]?.[0];
    const replay = provider.send.mock.calls[1]?.[0];
    expect(first).toMatchObject({
      conversationId: conversation.conversationId,
      recipientPhoneNumber: "+12025550123",
      text: "Plause sign-in code: 123456. Expires in 5 minutes.",
    });
    expect(first?.idempotencyKey).toMatch(/^auth-otp-[a-f0-9]{64}$/u);
    expect(replay?.idempotencyKey).toBe(first?.idempotencyKey);
    expect(first).not.toHaveProperty("to");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("refuses a missing or released conversation instead of creating a cold contact", async () => {
    provider.find.mockResolvedValueOnce(null);
    await expect(
      sendPhoneCode({ to: "+12025550123", code: "123456" })
    ).rejects.toMatchObject({ body: { code: "MESSAGING_CONNECT_REQUIRED" } });
    expect(provider.send).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("checks the closed enrollment list before any provider lookup", async () => {
    await expect(
      sendPhoneCode({ to: "+12025550456", code: "123456" })
    ).rejects.toMatchObject({ body: { code: "PRIVATE_ENROLLMENT_REQUIRED" } });
    expect(provider.find).not.toHaveBeenCalled();
    expect(provider.send).not.toHaveBeenCalled();
  });

  it("rechecks enrollment immediately before send when revocation wins during lookup", async () => {
    provider.find.mockImplementationOnce(async () => {
      configuration.enrolled = false;
      return conversation;
    });
    await expect(
      sendPhoneCode({ to: "+12025550123", code: "123456" })
    ).rejects.toMatchObject({ body: { code: "PRIVATE_ENROLLMENT_REQUIRED" } });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it.each(["identityId", "apiKey", "agentHandle"] as const)(
    "fences %s changes before send",
    async (key) => {
      provider.find.mockImplementationOnce(async () => {
        configuration[key] =
          key === "identityId"
            ? "7585d9d9-3e38-4c72-9be8-a8d30e48ca5c"
            : "changed";
        return conversation;
      });
      await expect(
        sendPhoneCode({ to: "+12025550123", code: "123456" })
      ).rejects.toMatchObject({ body: { code: "MESSAGING_NOT_CONFIGURED" } });
      expect(globalThis.fetch).not.toHaveBeenCalled();
    }
  );

  it.each([
    "apiKey",
    "identityId",
    "agentHandle",
    "signingKey",
    "internalSecret",
  ] as const)(
    "leaves partial Inkbox setup unavailable when %s is missing",
    async (key) => {
      configuration[key] = undefined;
      expect(inkboxSignInConfigured()).toBe(false);
      await expect(
        sendPhoneCode({ to: "+12025550123", code: "123456" })
      ).rejects.toMatchObject({ body: { code: "MESSAGING_NOT_CONFIGURED" } });
      expect(provider.find).not.toHaveBeenCalled();
      expect(provider.send).not.toHaveBeenCalled();
      expect(globalThis.fetch).not.toHaveBeenCalled();
    }
  );

  it("does not expose raw provider errors or fall back to another provider after uncertainty", async () => {
    provider.send.mockRejectedValueOnce(
      new Error("raw private API key, URL and provider diagnostics")
    );
    await expect(
      sendPhoneCode({ to: "+12025550123", code: "123456" })
    ).rejects.toMatchObject({
      body: {
        code: "MESSAGING_CODE_UNCONFIRMED",
        message:
          "Plause could not confirm delivery of the sign-in code. Review the Messages connection before requesting another code.",
      },
    });
    expect(provider.send).toHaveBeenCalledOnce();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("does not report a provider-declined OTP as successfully accepted", async () => {
    provider.send.mockResolvedValueOnce({
      ...message,
      status: "declined",
      errorCode: "private-provider-code",
    });
    await expect(
      sendPhoneCode({ to: "+12025550123", code: "123456" })
    ).rejects.toMatchObject({ body: { code: "MESSAGING_UNAVAILABLE" } });
  });

  it("keeps an ambiguous provider outcome uncertain rather than claiming a confirmed rejection", async () => {
    provider.send.mockResolvedValueOnce({
      ...message,
      status: "error",
      errorCode: "send_outcome_ambiguous",
    });
    await expect(
      sendPhoneCode({ to: "+12025550123", code: "123456" })
    ).rejects.toMatchObject({ body: { code: "MESSAGING_CODE_UNCONFIRMED" } });
    expect(provider.send).toHaveBeenCalledOnce();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("keeps disabled messaging closed despite credentials for both providers", async () => {
    configuration.provider = "disabled";
    await expect(
      sendPhoneCode({ to: "+12025550123", code: "123456" })
    ).rejects.toMatchObject({ body: { code: "MESSAGING_DISABLED" } });
    expect(provider.find).not.toHaveBeenCalled();
    expect(provider.send).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("preserves explicit Linq selection without invoking Inkbox", async () => {
    configuration.provider = "linq";
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response(null, { status: 202 })
    );
    await sendPhoneCode({ to: "+12025550123", code: "123456" });
    expect(globalThis.fetch).toHaveBeenCalledOnce();
    expect(vi.mocked(globalThis.fetch).mock.calls[0]?.[0]).toBe(
      "https://api.linqapp.com/api/partner/v3/chats"
    );
    expect(provider.find).not.toHaveBeenCalled();
    expect(provider.send).not.toHaveBeenCalled();
  });

  it("rejects invalid OTP material before lookup or transport", async () => {
    await expect(
      sendInkboxPhoneCode({
        to: "+12025550123",
        code: "not-an-otp",
        idempotencyKey: "stable-key",
      })
    ).rejects.toMatchObject({ body: { code: "INVALID_SIGN_IN_CODE" } });
    expect(provider.find).not.toHaveBeenCalled();
    expect(provider.send).not.toHaveBeenCalled();
  });
});
