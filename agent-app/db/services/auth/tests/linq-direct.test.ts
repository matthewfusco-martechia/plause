import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readLinqOnboardingPhoneNumber,
  sendLinqText,
} from "@db/services/auth/linq";

interface DirectLinqTestConfiguration {
  LINQ_API_KEY: string | undefined;
  LINQ_PHONE_NUMBER: string | undefined;
}

const configuration = vi.hoisted(() => {
  const value: DirectLinqTestConfiguration = {
    LINQ_API_KEY: "direct-test-api-key",
    LINQ_PHONE_NUMBER: "+15550100000",
  };
  return value;
});
vi.mock("@shared/environment", () => ({ env: configuration }));

describe("direct Linq phone authentication delivery", () => {
  beforeEach(() => {
    configuration.LINQ_API_KEY = "direct-test-api-key";
    configuration.LINQ_PHONE_NUMBER = "+15550100000";
  });
  afterEach(() => vi.unstubAllGlobals());

  it("returns only the explicitly configured line without remote auto-selection", async () => {
    const send = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", send);
    expect(await readLinqOnboardingPhoneNumber()).toBe("+15550100000");
    configuration.LINQ_PHONE_NUMBER = undefined;
    expect(await readLinqOnboardingPhoneNumber()).toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });

  it("pins the from line and recipient while preserving the OTP idempotency key", async () => {
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", send);
    await sendLinqText({
      to: "+15550100011",
      message: "Fixture code: 123456",
      idempotencyKey: "auth-otp-fixture",
    });
    expect(send).toHaveBeenCalledOnce();
    const [input, init] = send.mock.calls[0] ?? [];
    const request = new Request(input ?? "https://invalid.test", init);
    expect(request.url).toBe("https://api.linqapp.com/api/partner/v3/chats");
    expect(request.headers.get("authorization")).toBe(
      "Bearer direct-test-api-key"
    );
    expect(request.headers.get("idempotency-key")).toBe("auth-otp-fixture");
    expect(await request.json()).toEqual({
      from: "+15550100000",
      to: ["+15550100011"],
      message: {
        idempotency_key: "auth-otp-fixture",
        parts: [{ type: "text", value: "Fixture code: 123456" }],
      },
    });
    expect(request.redirect).toBe("error");
  });

  it("fails before HTTP when the key or assigned line is absent", async () => {
    const send = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", send);
    configuration.LINQ_API_KEY = undefined;
    await expect(
      sendLinqText({
        to: "+15550100011",
        message: "Fixture",
        idempotencyKey: "fixture-1",
      })
    ).rejects.toThrow("required");
    configuration.LINQ_API_KEY = "direct-test-api-key";
    configuration.LINQ_PHONE_NUMBER = undefined;
    await expect(
      sendLinqText({
        to: "+15550100011",
        message: "Fixture",
        idempotencyKey: "fixture-2",
      })
    ).rejects.toThrow("required");
    expect(send).not.toHaveBeenCalled();
  });

  it("does not blindly retry a network-unknown OTP send", async () => {
    const send = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("fixture network loss"));
    vi.stubGlobal("fetch", send);
    await expect(
      sendLinqText({
        to: "+15550100011",
        message: "Fixture",
        idempotencyKey: "fixture-1",
      })
    ).rejects.toThrow("fixture network loss");
    expect(send).toHaveBeenCalledOnce();
  });
});
