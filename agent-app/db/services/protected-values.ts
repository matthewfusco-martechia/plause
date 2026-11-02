import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { AccessScope } from "@shared/identity/access-scope";
import { getInstallationSecrets } from "./installation-secrets";

export async function encryptWorkspaceValue(
  scope: AccessScope,
  purpose: string,
  value: string
) {
  const { secretEncryptionKey } = await getInstallationSecrets();
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    Buffer.from(secretEncryptionKey, "base64"),
    iv
  );
  cipher.setAAD(
    Buffer.from(
      JSON.stringify(["plause-private-v1", scope.workspaceId, purpose])
    )
  );
  const ciphertext = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export async function decryptWorkspaceValue(
  scope: AccessScope,
  purpose: string,
  value: string
) {
  const [version, iv, tag, ciphertext, extra] = value.split(".");
  if (
    version !== "v1" ||
    !iv ||
    !tag ||
    ciphertext === undefined ||
    extra !== undefined ||
    Buffer.from(iv, "base64url").length !== 12 ||
    Buffer.from(tag, "base64url").length !== 16
  ) {
    throw new Error("Stored private data is invalid.");
  }
  const { secretEncryptionKey } = await getInstallationSecrets();
  const decipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(secretEncryptionKey, "base64"),
    Buffer.from(iv, "base64url")
  );
  decipher.setAAD(
    Buffer.from(
      JSON.stringify(["plause-private-v1", scope.workspaceId, purpose])
    )
  );
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
