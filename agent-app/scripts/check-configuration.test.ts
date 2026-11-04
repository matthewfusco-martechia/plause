import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const fixture = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://fixture:fixture@127.0.0.1:9/fixture",
  BETTER_AUTH_URL: "https://fixture.example",
  BETTER_AUTH_SECRET: "fictional-auth-secret-0123456789abcdef",
  SECRET_ENCRYPTION_KEY: "fictional-encryption-value",
  INTERNAL_SERVICE_SECRET: "fictional-internal-value",
  PRIVATE_ALLOWED_PHONE_NUMBERS: "+12025550123",
  R2_ACCOUNT_ID: "fictional-r2-account",
  R2_ACCESS_KEY_ID: "fictional-r2-access",
  R2_SECRET_ACCESS_KEY: "fictional-r2-secret",
  R2_BUCKET: "fictional-bucket",
  OPENAI_API_KEY: "fictional-openai-key",
  GOOGLE_CLIENT_ID: "fictional-google-client",
  GOOGLE_CLIENT_SECRET: "fictional-google-secret",
  KERNEL_API_KEY: "fictional-kernel-key",
} satisfies NodeJS.ProcessEnv;
const inkbox = {
  MESSAGING_PROVIDER: "inkbox",
  INKBOX_API_KEY: "private-inkbox-key",
  INKBOX_IDENTITY_ID: "da3f6e14-5915-4cf8-b100-130846fa3f5e",
  INKBOX_AGENT_HANDLE: "private-agent-handle",
  INKBOX_WEBHOOK_SIGNING_KEY: "private-inkbox-signing-value",
};
const linq = {
  MESSAGING_PROVIDER: "linq",
  LINQ_API_KEY: "private-linq-key",
  LINQ_PHONE_NUMBER: "+15550100000",
  LINQ_WEBHOOK_SIGNING_SECRET: "private-linq-signing-value",
};

function check(configuration: Record<string, string>) {
  return spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      fileURLToPath(new URL("./check-configuration.ts", import.meta.url)),
    ],
    { env: { ...fixture, ...configuration }, encoding: "utf8", timeout: 5_000 }
  );
}

describe("read-only configuration report", () => {
  it("checks only selected Inkbox credentials without exposing any configured values", () => {
    const result = check(inkbox);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "Messaging (inkbox): configured (unverified)"
    );
    expect(result.stdout).not.toContain("LINQ_");
    for (const value of [
      ...Object.entries(fixture)
        .filter(([key]) => key !== "NODE_ENV")
        .map(([, configured]) => configured),
      ...Object.values(inkbox).filter((configured) => configured !== "inkbox"),
    ])
      expect(result.stdout).not.toContain(value);
    expect(result.stderr).toBe("");
  });

  it("preserves explicitly selected Linq without demanding Inkbox keys", () => {
    const result = check(linq);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "Messaging (linq): configured (unverified)"
    );
    expect(result.stdout).not.toContain("INKBOX_");
  });

  it("reports missing Inkbox key names without selecting another configured provider", () => {
    const result = check({ ...linq, MESSAGING_PROVIDER: "inkbox" });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "missing INKBOX_API_KEY, INKBOX_IDENTITY_ID, INKBOX_AGENT_HANDLE, INKBOX_WEBHOOK_SIGNING_KEY"
    );
    expect(result.stdout).not.toContain("Messaging (linq)");
    expect(result.stdout).not.toContain(linq.LINQ_API_KEY);
  });

  it("defaults to disabled even if credentials for both providers exist", () => {
    const { MESSAGING_PROVIDER: _provider, ...keys } = { ...linq, ...inkbox };
    const result = check(keys);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Messaging: disabled");
    expect(result.stdout).not.toContain("Messaging (inkbox)");
    expect(result.stdout).not.toContain("Messaging (linq)");
  });

  it("rejects a malformed provider choice without reflecting its value", () => {
    const result = check({ MESSAGING_PROVIDER: "private-invalid-selection" });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("invalid MESSAGING_PROVIDER");
    expect(result.stdout).not.toContain("private-invalid-selection");
  });
});
