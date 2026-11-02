import { describe, expect, it, vi } from "vitest";
import { accessScopeForUser } from "@shared/identity/access-scope";

vi.mock("@db/services/installation-secrets", () => ({
  getInstallationSecrets: async () => ({
    secretEncryptionKey: Buffer.alloc(32, 2).toString("base64"),
  }),
}));

import {
  decryptWorkspaceValue,
  encryptWorkspaceValue,
} from "@db/services/protected-values";

const owner = accessScopeForUser("better-auth:private-owner");

describe("private workspace values", () => {
  it.each(["secret refresh token", ""])(
    "round trips an authenticated value with a fresh nonce",
    async (value) => {
      const first = await encryptWorkspaceValue(owner, "oauth", value);
      const second = await encryptWorkspaceValue(owner, "oauth", value);
      expect(first).not.toBe(second);
      await expect(decryptWorkspaceValue(owner, "oauth", first)).resolves.toBe(
        value
      );
    }
  );

  it("cannot move ciphertext to another workspace or purpose", async () => {
    const encrypted = await encryptWorkspaceValue(
      owner,
      "oauth",
      "private-token"
    );
    await expect(
      decryptWorkspaceValue(
        accessScopeForUser("better-auth:other"),
        "oauth",
        encrypted
      )
    ).rejects.toThrow("authenticate");
    await expect(
      decryptWorkspaceValue(owner, "model-result", encrypted)
    ).rejects.toThrow("authenticate");
  });

  it("rejects changed ciphertext and malformed envelopes", async () => {
    const encrypted = await encryptWorkspaceValue(
      owner,
      "oauth",
      "private-token"
    );
    const parts = encrypted.split(".");
    parts[3] = Buffer.from("changed").toString("base64url");
    await expect(
      decryptWorkspaceValue(owner, "oauth", parts.join("."))
    ).rejects.toThrow("authenticate");
    await expect(
      decryptWorkspaceValue(owner, "oauth", "v1.bad.bad.data")
    ).rejects.toThrow("Stored private data is invalid");
  });
});
