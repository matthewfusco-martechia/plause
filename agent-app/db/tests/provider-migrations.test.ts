import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { z } from "zod";
import * as schema from "../schema";
import { accessScopeForUser } from "@shared/identity/access-scope";

const client = new PGlite();
// Start the embedded engine separately from the migration/erasure assertions.
beforeAll(() => client.waitReady);
afterAll(() => client.close());

it("applies the full migration chain and erases provider payloads while retaining uncertainty tombstones", async () => {
  const journal = z
    .object({
      entries: z.array(
        z.object({ tag: z.string().regex(/^\d{4}_[a-z_-]+$/u) })
      ),
    })
    .parse(
      JSON.parse(
        await readFile(
          new URL("../migrations/meta/_journal.json", import.meta.url),
          "utf8"
        )
      )
    );
  /* oxlint-disable eslint/no-await-in-loop -- Ordered SQL history must be applied sequentially to verify real installation compatibility. */
  for (const { tag } of journal.entries)
    await client.exec(
      await readFile(
        new URL(`../migrations/${tag}.sql`, import.meta.url),
        "utf8"
      )
    );
  /* oxlint-enable eslint/no-await-in-loop */
  const db = drizzle(client, { schema });
  const scope = accessScopeForUser("better-auth:fixture-owner");
  await db.insert(schema.user).values({
    id: "fixture-owner",
    name: "Fictional Owner",
    email: "owner@example.test",
  });
  await db.insert(schema.googleWorkspaceConnections).values({
    ...scope,
    status: "connected",
    encryptedTokens: "private-grant",
    version: 1,
  });
  await db.insert(schema.googleWorkspaceOAuthStates).values({
    ...scope,
    id: "state",
    sessionHash: "session",
    browserHash: "browser",
    connectionVersion: 1,
    encryptedVerifier: "private-pkce",
    expiresAt: new Date(Date.now() + 10000),
  });
  await db.insert(schema.linqWebhookInbox).values({
    eventKey: "a".repeat(64),
    messageKey: "b".repeat(64),
    conversationKey: "c".repeat(64),
    lineDigest: "d".repeat(64),
    bodyDigest: "e".repeat(64),
    bodyCiphertext: "private-message",
    userId: "fixture-owner",
    status: "dispatching",
    expiresAt: new Date(Date.now() + 10000),
  });
  await db.insert(schema.modelProviderAttempts).values({
    id: "model-attempt",
    workspaceId: scope.workspaceId,
    rootSessionId: "conversation",
    requestHash: "request",
    model: "gpt-6-luna",
    globalAccountId: "global",
    userAccountId: "user",
    reservedMicroUsd: 100,
    actualMicroUsd: 80,
    status: "completed",
    encryptedResult: "private-model-result",
  });
  await db.insert(schema.googleActionApprovals).values({
    ...scope,
    id: "approval",
    sessionId: "session",
    rootSessionId: "conversation",
    callId: "call",
    toolName: "gmail-send",
    inputHash: "input",
    encryptedInput: "private-email",
    principalHash: "principal",
    grantVersion: 1,
    state: "approved",
    expiresAt: new Date(Date.now() + 10000),
  });
  await db.insert(schema.googleActionDispatches).values({
    ...scope,
    approvalId: "approval",
    rootSessionId: "conversation",
    grantVersion: 1,
    state: "started",
    encryptedResult: "private-action-result",
  });

  await db.delete(schema.user).where(eq(schema.user.id, "fixture-owner"));
  expect(await db.select().from(schema.googleWorkspaceConnections)).toEqual([]);
  expect(await db.select().from(schema.googleWorkspaceOAuthStates)).toEqual([]);
  expect(await db.select().from(schema.linqWebhookInbox)).toEqual([
    expect.objectContaining({
      status: "unknown",
      bodyCiphertext: null,
      userId: null,
      errorCode: "user_deleted",
    }),
  ]);
  expect(await db.select().from(schema.modelProviderAttempts)).toEqual([
    expect.objectContaining({
      status: "completed",
      encryptedResult: null,
      actualMicroUsd: 80,
      reservedMicroUsd: 100,
    }),
  ]);
  expect(await db.select().from(schema.googleActionApprovals)).toEqual([
    expect.objectContaining({ state: "revoked", encryptedInput: null }),
  ]);
  expect(await db.select().from(schema.googleActionDispatches)).toEqual([
    expect.objectContaining({ state: "unknown", encryptedResult: null }),
  ]);
});
