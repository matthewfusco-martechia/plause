import { APIError } from "better-auth/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const linqApiErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
});

describe("Linq phone authentication", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("returns fixed client copy without provider diagnostics or secrets", async () => {
    vi.stubEnv(
      "BETTER_AUTH_SECRET",
      "0123456789abcdefghijklmnopqrstuvwxyzABCD"
    );
    vi.stubEnv("PRIVATE_ALLOWED_PHONE_NUMBERS", "+12025550123");
    vi.stubEnv("LINQ_API_KEY", "direct-test-api-key");
    vi.stubEnv("LINQ_PHONE_NUMBER", "+15550100000");
    vi.stubEnv("MESSAGING_PROVIDER", "linq");
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        Response.json(
          {
            error: {
              code: 2015,
              message: "no eligible sending line available",
              status: 409,
            },
            success: false,
            trace_id: "trace-123",
          },
          { status: 409 }
        )
      )
    );

    const { sendPhoneCode } = await import("@db/services/auth");
    const error: unknown = await sendPhoneCode({
      code: "123456",
      to: "+12025550123",
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(APIError);
    if (!(error instanceof APIError)) throw new TypeError("Expected APIError");

    const body = linqApiErrorSchema.parse(error.body);
    expect(body).toMatchObject({
      code: "MESSAGING_UNAVAILABLE",
    });
    expect(body.message).toContain("Review its connection");
    expect(error.body).not.toHaveProperty("linqError");
    expect(JSON.stringify(error.body)).not.toContain("trace-123");
  });
});
