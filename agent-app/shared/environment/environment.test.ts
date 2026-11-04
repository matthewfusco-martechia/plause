import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requiredEnvironment = {
  BETTER_AUTH_SECRET: "test-auth-secret-0123456789abcdefghijklmnop",
  BETTER_AUTH_URL: "https://example.com",
  DATABASE_URL: "postgresql://user:password@example.com/database",
  KERNEL_API_KEY: "test-kernel-key",
  SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
};

describe("environment", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const [name, value] of Object.entries(requiredEnvironment)) {
      vi.stubEnv(name, value);
    }
    vi.stubEnv("LINQ_API_KEY", "");
    vi.stubEnv("LINQ_PHONE_NUMBER", "");
    vi.stubEnv("MESSAGING_PROVIDER", undefined);
    for (const key of [
      "INKBOX_API_KEY",
      "INKBOX_IDENTITY_ID",
      "INKBOX_AGENT_HANDLE",
      "INKBOX_WEBHOOK_SIGNING_KEY",
    ])
      vi.stubEnv(key, "");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("exports the validated environment", async () => {
    const { env } = await import("@shared/environment");

    expect(env).toMatchObject(requiredEnvironment);
  });

  it("keeps inference and provider writes disabled by default", async () => {
    const { env } = await import("@shared/environment");
    expect(env.GOOGLE_WORKSPACE_WRITES_ENABLED).toBe("false");
    expect(env.LIVE_MODEL_ENABLED).toBe("false");
    expect(env.BROWSER_ACTIONS_ENABLED).toBe("false");
    expect(env.WEB_RESEARCH_ENABLED).toBe("false");
    expect(env.LINQ_API_KEY).toBeUndefined();
    expect(env.LINQ_PHONE_NUMBER).toBeUndefined();
    expect(env.MESSAGING_PROVIDER).toBe("disabled");
    expect(env.PLAUSE_WORKFLOW_BACKEND).toBe("local");
    expect(env.INKBOX_API_KEY).toBeUndefined();
    expect(env.MODEL_GLOBAL_MONTHLY_BUDGET_MICRO_USD).toBe(30_000);
  });

  it("accepts explicitly selected PostgreSQL workflow storage with bounded worker settings", async () => {
    vi.stubEnv("PLAUSE_WORKFLOW_BACKEND", "postgres");
    vi.stubEnv(
      "WORKFLOW_POSTGRES_URL",
      "postgresql://fixture:fixture@example.com/workflow"
    );
    vi.stubEnv("WORKFLOW_POSTGRES_WORKER_CONCURRENCY", "4");
    vi.stubEnv("WORKFLOW_POSTGRES_MAX_POOL_SIZE", "10");
    vi.stubEnv("WORKFLOW_POSTGRES_POLL_INTERVAL_MS", "2000");
    const { env } = await import("@shared/environment");
    expect(env.PLAUSE_WORKFLOW_BACKEND).toBe("postgres");
    expect(env.WORKFLOW_POSTGRES_WORKER_CONCURRENCY).toBe(4);
    expect(env.WORKFLOW_POSTGRES_MAX_POOL_SIZE).toBe(10);
    expect(env.WORKFLOW_POSTGRES_POLL_INTERVAL_MS).toBe(2000);
  });

  it.each([
    ["PLAUSE_WORKFLOW_BACKEND", "d1"],
    ["WORKFLOW_POSTGRES_URL", "https://example.com"],
    ["WORKFLOW_POSTGRES_WORKER_CONCURRENCY", "0"],
    ["WORKFLOW_POSTGRES_WORKER_CONCURRENCY", "51"],
    ["WORKFLOW_POSTGRES_MAX_POOL_SIZE", "2"],
    ["WORKFLOW_POSTGRES_POLL_INTERVAL_MS", "0"],
  ])("rejects malformed workflow setting %s", async (name, value) => {
    vi.stubEnv(name, value);
    await expect(import("@shared/environment")).rejects.toThrow(
      "Invalid environment variables"
    );
  });

  it("supports explicitly selected Inkbox with canonical owned-identity configuration", async () => {
    vi.stubEnv("MESSAGING_PROVIDER", "inkbox");
    vi.stubEnv("INKBOX_API_KEY", "fictional-inkbox-key");
    vi.stubEnv("INKBOX_IDENTITY_ID", "da3f6e14-5915-4cf8-b100-130846fa3f5e");
    vi.stubEnv("INKBOX_AGENT_HANDLE", "plause_test");
    vi.stubEnv(
      "INKBOX_WEBHOOK_SIGNING_KEY",
      "whsec_fictional-identity-signing-key-0123456789"
    );
    const { env } = await import("@shared/environment");
    expect(env.MESSAGING_PROVIDER).toBe("inkbox");
    expect(env.INKBOX_IDENTITY_ID).toBe("da3f6e14-5915-4cf8-b100-130846fa3f5e");
    expect(env.INKBOX_AGENT_HANDLE).toBe("plause_test");
  });

  it.each(["INKBOX", "auto", "inkbox "])(
    "rejects unsupported provider selection %s",
    async (value) => {
      vi.stubEnv("MESSAGING_PROVIDER", value);
      await expect(import("@shared/environment")).rejects.toThrow(
        "Invalid environment variables"
      );
    }
  );

  it.each([
    ["INKBOX_IDENTITY_ID", "not-a-uuid"],
    ["INKBOX_AGENT_HANDLE", "@plause"],
    ["INKBOX_AGENT_HANDLE", "Plause"],
    ["INKBOX_AGENT_HANDLE", "plause/path"],
    ["INKBOX_WEBHOOK_SIGNING_KEY", "too-short"],
    ["INKBOX_WEBHOOK_SIGNING_KEY", "whsec_" + "a".repeat(31)],
    ["INKBOX_WEBHOOK_SIGNING_KEY", "a".repeat(513)],
    ["INKBOX_WEBHOOK_SIGNING_KEY", "a".repeat(32) + "\n"],
  ])(
    "rejects malformed %s without falling back to Linq",
    async (key, value) => {
      vi.stubEnv("MESSAGING_PROVIDER", "inkbox");
      vi.stubEnv(key, value);
      await expect(import("@shared/environment")).rejects.toThrow(
        "Invalid environment variables"
      );
    }
  );

  it("allows selected Inkbox to remain unconfigured with blank credentials", async () => {
    vi.stubEnv("MESSAGING_PROVIDER", "inkbox");
    const { env } = await import("@shared/environment");
    expect(env.MESSAGING_PROVIDER).toBe("inkbox");
    expect(env.INKBOX_IDENTITY_ID).toBeUndefined();
    expect(env.INKBOX_API_KEY).toBeUndefined();
  });

  it("accepts only an explicit Google Workspace write capability switch", async () => {
    vi.stubEnv("GOOGLE_WORKSPACE_WRITES_ENABLED", "true");
    const { env } = await import("@shared/environment");
    expect(env.GOOGLE_WORKSPACE_WRITES_ENABLED).toBe("true");
  });

  it.each(["TRUE", "1", "yes", " true "])(
    "rejects malformed Google Workspace write capability %s",
    async (value) => {
      vi.stubEnv("GOOGLE_WORKSPACE_WRITES_ENABLED", value);
      await expect(import("@shared/environment")).rejects.toThrow(
        "Invalid environment variables"
      );
    }
  );

  it("provides stable auth and encryption defaults in local development", async () => {
    vi.stubEnv("BETTER_AUTH_SECRET", "");
    vi.stubEnv("BETTER_AUTH_URL", "");
    vi.stubEnv("SECRET_ENCRYPTION_KEY", "");
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VERCEL_ENV", undefined);

    const { env, localPhoneAuthBypassEnabled } =
      await import("@shared/environment");

    expect(env).toMatchObject({
      BETTER_AUTH_SECRET: "openinstinct-local-auth-development-secret",
      BETTER_AUTH_URL: "http://localhost:3000",
      SECRET_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    });
    expect(localPhoneAuthBypassEnabled).toBe(true);
  });

  it.each([
    ["test-auth-secret-0123456789abcdefghijklmnop", ""],
    ["", Buffer.alloc(32, 2).toString("base64")],
  ])(
    "rejects asymmetric local installation-secret overrides",
    async (betterAuthSecret, secretEncryptionKey) => {
      vi.stubEnv("BETTER_AUTH_SECRET", betterAuthSecret);
      vi.stubEnv("SECRET_ENCRYPTION_KEY", secretEncryptionKey);
      vi.stubEnv("NODE_ENV", "development");
      vi.stubEnv("VERCEL_ENV", undefined);

      await expect(import("@shared/environment")).rejects.toThrow(
        "Set both BETTER_AUTH_SECRET and SECRET_ENCRYPTION_KEY"
      );
    }
  );

  it("accepts explicit direct provider configuration", async () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", "google-client");
    vi.stubEnv("LINQ_API_KEY", "test-linq");
    vi.stubEnv("LINQ_PHONE_NUMBER", "+12025550123");
    const { env } = await import("@shared/environment");
    expect(env.GOOGLE_CLIENT_ID).toBe("google-client");
    expect(env.LINQ_API_KEY).toBe("test-linq");
    expect(env.LINQ_PHONE_NUMBER).toBe("+12025550123");
  });

  it("does not provide local defaults in a Vercel development environment", async () => {
    vi.stubEnv("BETTER_AUTH_SECRET", "");
    vi.stubEnv("BETTER_AUTH_URL", "");
    vi.stubEnv("SECRET_ENCRYPTION_KEY", "");
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VERCEL_ENV", "development");
    vi.stubEnv("VERCEL_URL", "open-instinct-preview.vercel.app");

    const { env } = await import("@shared/environment");

    expect(env.BETTER_AUTH_SECRET).toBeUndefined();
    expect(env.BETTER_AUTH_URL).toBeUndefined();
    expect(env.SECRET_ENCRYPTION_KEY).toBeUndefined();
  });

  it("requires unique installation secrets for a hosted development origin", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VERCEL_ENV", undefined);
    vi.stubEnv("BETTER_AUTH_URL", "https://private.example.test");
    vi.stubEnv("BETTER_AUTH_SECRET", "");
    vi.stubEnv("SECRET_ENCRYPTION_KEY", "");
    const { env, localPhoneAuthBypassEnabled } =
      await import("@shared/environment");
    expect(env.BETTER_AUTH_SECRET).toBeUndefined();
    expect(env.SECRET_ENCRYPTION_KEY).toBeUndefined();
    expect(localPhoneAuthBypassEnabled).toBe(false);
  });

  it.each(["DATABASE_URL", "KERNEL_API_KEY"])(
    "keeps %s required in local development",
    async (name) => {
      vi.stubEnv(name, "");
      vi.stubEnv("NODE_ENV", "development");
      vi.stubEnv("VERCEL_ENV", undefined);

      await expect(import("@shared/environment")).rejects.toThrow(
        "Invalid environment variables"
      );
    }
  );

  it.each([
    requiredEnvironment.SECRET_ENCRYPTION_KEY.slice(0, -1),
    Buffer.alloc(32, 255).toString("base64url"),
  ])("accepts a Node-compatible 32-byte encryption key", async (key) => {
    vi.stubEnv("SECRET_ENCRYPTION_KEY", key);

    const { env } = await import("@shared/environment");
    expect(env.SECRET_ENCRYPTION_KEY).toBe(key);
  });

  it.each([
    ["DATABASE_URL", "Invalid environment variables"],
    ["KERNEL_API_KEY", "Invalid environment variables"],
  ])(
    "rejects a missing required %s value during import",
    async (name, errorMessage) => {
      vi.stubEnv(name, "");

      await expect(import("@shared/environment")).rejects.toThrow(errorMessage);
    }
  );

  it("rejects an encryption key that does not decode to 32 bytes", async () => {
    vi.stubEnv("SECRET_ENCRYPTION_KEY", Buffer.alloc(31, 1).toString("base64"));

    await expect(import("@shared/environment")).rejects.toThrow(
      "Invalid environment variables"
    );
  });

  it("rejects a non-Postgres database URL", async () => {
    vi.stubEnv("DATABASE_URL", "https://example.com/database");

    await expect(import("@shared/environment")).rejects.toThrow(
      "Invalid environment variables"
    );
  });

  it("rejects a Linq phone number outside E.164 format", async () => {
    vi.stubEnv("LINQ_PHONE_NUMBER", "(202) 555-0123");

    await expect(import("@shared/environment")).rejects.toThrow(
      "Invalid environment variables"
    );
  });

  it.each([
    ["http://localhost:3000", "development", undefined, true],
    ["https://openinstinct.localhost", "development", undefined, true],
    ["http://localhost:3000", "production", undefined, false],
    ["http://localhost:3000", "development", "development", false],
    ["https://preview.example.com", "development", undefined, false],
  ] as const)(
    "resolves local phone auth bypass for %s in %s",
    async (url, nodeEnv, vercelEnv, expected) => {
      vi.stubEnv("BETTER_AUTH_URL", url);
      vi.stubEnv("NODE_ENV", nodeEnv);
      vi.stubEnv("VERCEL_ENV", vercelEnv);

      const { localPhoneAuthBypassEnabled } =
        await import("@shared/environment");

      expect(localPhoneAuthBypassEnabled).toBe(expected);
    }
  );
});
