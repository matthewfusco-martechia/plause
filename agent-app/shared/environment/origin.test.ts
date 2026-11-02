import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("BETTER_AUTH_URL", "");
  vi.stubEnv("DATABASE_URL", "postgresql://user:password@example.com/database");
  vi.stubEnv("KERNEL_API_KEY", "test-kernel-key");
  vi.stubEnv("VERCEL_BRANCH_URL", "");
  vi.stubEnv("VERCEL_ENV", undefined);
  vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "");
  vi.stubEnv("VERCEL_URL", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("application origin", () => {
  it("uses an explicit origin outside Vercel", async () => {
    vi.stubEnv("BETTER_AUTH_URL", "https://assistant.example/path");

    const { applicationOrigin, betterAuthBaseURL } =
      await import("@shared/environment/origin");

    expect(applicationOrigin()).toBe("https://assistant.example");
    expect(betterAuthBaseURL()).toBe("https://assistant.example");
  });

  it("does not trust a provider-derived wildcard origin", async () => {
    vi.stubEnv("BETTER_AUTH_URL", "https://plause.example");
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("VERCEL_URL", "unrelated.vercel.app");
    const { applicationOrigin, betterAuthBaseURL } =
      await import("@shared/environment/origin");
    expect(applicationOrigin()).toBe("https://plause.example");
    expect(betterAuthBaseURL()).toBe("https://plause.example");
  });

  it("fails clearly when a non-Vercel production host has no URL", async () => {
    vi.stubEnv("VERCEL_URL", "stale-preview.vercel.app");

    const { applicationOrigin } = await import("@shared/environment/origin");

    expect(() => applicationOrigin()).toThrow("Set BETTER_AUTH_URL");
  });
});
