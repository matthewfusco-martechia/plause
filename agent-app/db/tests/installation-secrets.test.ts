import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authKey = "test-auth-secret-0123456789abcdefghijklmnop";
const encryptionKey = Buffer.alloc(32, 5).toString("base64");

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("DATABASE_URL", "postgresql://user:password@example.com/database");
  vi.stubEnv("KERNEL_API_KEY", "test-kernel-key");
  vi.stubEnv("BETTER_AUTH_URL", "https://example.com");
  vi.stubEnv("VERCEL_ENV", "");
  vi.stubEnv("BETTER_AUTH_SECRET", authKey);
  vi.stubEnv("SECRET_ENCRYPTION_KEY", encryptionKey);
});

afterEach(() => vi.unstubAllEnvs());

describe("installation secret keyring", () => {
  it("preserves explicitly configured independent keys without any storage access", async () => {
    const { getInstallationSecrets } =
      await import("@db/services/installation-secrets");
    const first = await getInstallationSecrets();
    const second = await getInstallationSecrets();
    expect(first).toEqual({
      betterAuthSecret: authKey,
      secretEncryptionKey: encryptionKey,
      version: 1,
    });
    expect(second).toEqual(first);
  });

  it("fails closed in production instead of generating keys in object storage", async () => {
    vi.stubEnv("BETTER_AUTH_SECRET", "");
    vi.stubEnv("SECRET_ENCRYPTION_KEY", "");
    const { getInstallationSecrets } =
      await import("@db/services/installation-secrets");
    await expect(getInstallationSecrets()).rejects.toThrow(
      "Installation keys are never provisioned automatically"
    );
    await expect(getInstallationSecrets()).rejects.toThrow(
      "deployment secret keyring"
    );
  });

  it.each(["BETTER_AUTH_SECRET", "SECRET_ENCRYPTION_KEY"])(
    "rejects an incomplete %s keyring",
    async (name) => {
      vi.stubEnv(name, "");
      const { getInstallationSecrets } =
        await import("@db/services/installation-secrets");
      await expect(getInstallationSecrets()).rejects.toThrow(
        "Set both BETTER_AUTH_SECRET and SECRET_ENCRYPTION_KEY"
      );
    }
  );
});
