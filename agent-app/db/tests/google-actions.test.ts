/* oxlint-disable eslint/no-await-in-loop -- Apply the actual migrations in their declared order. */
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { z } from "zod";
import * as Database from "@db";
import * as schema from "@db/schema";
import {
  googleActionApprovals,
  googleActionDispatches,
} from "@db/schema/google-actions";
import { googleWorkspaceConnections } from "@db/schema/google-workspace";
import * as service from "@db/services/google-actions";
import { disconnectGoogleWorkspace } from "@db/services/google-workspace";
import { decryptWorkspaceValue } from "@db/services/protected-values";
import * as ProtectedValues from "@db/services/protected-values";
import * as Enrollment from "@db/services/auth/phone-user";
import { accessScopeForUser } from "@shared/identity/access-scope";
import {
  startBrowserAction,
  markBrowserActionUnknown,
} from "@db/services/browser-actions";
import { browserActionAttempts } from "@db/schema/browser-actions";

const enrollment = vi.hoisted(() => ({ allowed: true, checks: 0 }));
vi.mock("@db/services/auth/phone-user", () => ({
  assertEnrolledWorkspaceUser: async () => {
    enrollment.checks += 1;
    if (!enrollment.allowed) throw new Error("Account access removed.");
  },
}));

const database = new PGlite();
const alice = accessScopeForUser("better-auth:alice");
const bob = accessScopeForUser("better-auth:bob");
const resultSchema = z.object({ id: z.string() });
const operation = vi.fn<() => Promise<{ id: string }>>(async () => ({
  id: "fictional-provider-object",
}));

function binding(
  overrides: Partial<service.GoogleActionBinding> = {}
): service.GoogleActionBinding {
  return {
    ...alice,
    callId: "call-1",
    sessionId: "session-1",
    rootSessionId: "session-1",
    toolName: "gmail-send",
    principalHash: createHash("sha256").update("fictional-owner").digest("hex"),
    input: {
      to: ["fictional@example.com"],
      subject: "Private subject",
      body: "Private body",
    },
    ...overrides,
  };
}

beforeAll(async () => {
  const connectionMigration = await readFile(
    "db/migrations/0015_direct_providers.sql",
    "utf8"
  );
  for (const statement of connectionMigration.split(
    "--> statement-breakpoint"
  )) {
    if (statement.includes('CREATE TABLE "google_workspace_'))
      await database.exec(statement);
  }
  const migration = await readFile(
    "db/migrations/0016_google_action_authority.sql",
    "utf8"
  );
  await database.exec(migration.replaceAll("--> statement-breakpoint", ""));
  await database.exec(
    await readFile("db/migrations/0017_browser_action_authority.sql", "utf8")
  );
  const fixture = drizzle(database, { schema });
  // SAFETY: Only the database driver changes; queries use the real schema and transaction implementation.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- PGlite supplies the exercised Drizzle surface.
  vi.spyOn(Database, "db", "get").mockReturnValue(fixture as never);
});

beforeEach(async () => {
  await database.exec(
    "DELETE FROM browser_action_attempts; DELETE FROM google_action_dispatches; DELETE FROM google_action_approvals; DELETE FROM google_workspace_connections"
  );
  await Database.db.insert(googleWorkspaceConnections).values([
    { ...alice, version: 7, status: "connected" },
    { ...bob, version: 7, status: "connected" },
  ]);
  enrollment.allowed = true;
  enrollment.checks = 0;
  operation.mockReset().mockResolvedValue({ id: "fictional-provider-object" });
});

afterAll(async () => {
  vi.restoreAllMocks();
  await database.close();
});

async function approved(value = binding()) {
  await service.requestGoogleActionApproval(value, 7);
  await service.respondGoogleActionApproval(
    value,
    7,
    "interaction-1",
    "approve"
  );
  return value;
}

async function run(value = binding()) {
  return service.executeGoogleAction(value, 7, resultSchema, operation);
}

function browserInput(rootSessionId = "session-1") {
  return {
    rootSessionId,
    workerSessionId: "browser-worker",
    callId: "browser-call",
    toolName: "computer_action",
    browserSessionId: "browser",
    observationId: "server-observation",
    inputHash: "exact-browser-input",
  };
}

describe("durable exact Google action authority", () => {
  it("blocks browser fallback after an unknown Google write without refunding its tombstone", async () => {
    const value = await approved();
    operation.mockRejectedValueOnce(new Error("Uncertain Google response."));
    await expect(run(value)).rejects.toThrow("unconfirmed outcome");
    await expect(startBrowserAction(alice, browserInput())).rejects.toThrow(
      "uncertain external action"
    );
    expect(await Database.db.select().from(browserActionAttempts)).toHaveLength(
      0
    );
    expect(
      (await Database.db.select().from(googleActionDispatches))[0]?.state
    ).toBe("unknown");
    expect(operation).toHaveBeenCalledOnce();
  });

  it("blocks a pre-approved Google action and new approvals after an unknown browser action", async () => {
    const value = await approved();
    const id = await startBrowserAction(alice, browserInput());
    await markBrowserActionUnknown(alice, id);
    await expect(run(value)).rejects.toThrow("unconfirmed outcome");
    await expect(
      service.requestGoogleActionApproval(binding({ callId: "fallback" }), 7)
    ).rejects.toThrow("unconfirmed outcome");
    expect(operation).not.toHaveBeenCalled();
    expect(
      await Database.db.select().from(googleActionDispatches)
    ).toHaveLength(0);
  });

  it("blocks browser claims while a Google provider write is still in flight", async () => {
    const value = await approved();
    const held = Promise.withResolvers<{ id: string }>();
    operation.mockImplementationOnce(() => held.promise);
    const running = run(value);
    try {
      await vi.waitFor(async () => {
        expect(
          await Database.db.select().from(googleActionDispatches)
        ).toHaveLength(1);
      });
      await expect(startBrowserAction(alice, browserInput())).rejects.toThrow(
        "uncertain external action"
      );
    } finally {
      held.resolve({ id: "completed" });
    }
    await running;
    expect(operation).toHaveBeenCalledOnce();
  });

  it("admits only one concurrent cross-vendor claim for a root conversation", async () => {
    const value = await approved();
    const held = Promise.withResolvers<{ id: string }>();
    operation.mockImplementationOnce(() => held.promise);
    const google = run(value).then(
      () => "fulfilled",
      () => "rejected"
    );
    const browser = await startBrowserAction(alice, browserInput()).then(
      () => "fulfilled",
      () => "rejected"
    );
    held.resolve({ id: "completed" });
    const outcomes = [await google, browser];
    expect(outcomes.toSorted()).toEqual(["fulfilled", "rejected"]);
    const [googleRows, browserRows] = await Promise.all([
      Database.db.select().from(googleActionDispatches),
      Database.db.select().from(browserActionAttempts),
    ]);
    expect(googleRows.length + browserRows.length).toBe(1);
  });

  it("returns completed Google cache without a new action when another vendor is uncertain", async () => {
    const value = await approved();
    await run(value);
    const id = await startBrowserAction(alice, browserInput());
    await markBrowserActionUnknown(alice, id);
    await expect(run(value)).resolves.toEqual({
      id: "fictional-provider-object",
    });
    expect(operation).toHaveBeenCalledOnce();
    expect(
      (await Database.db.select().from(browserActionAttempts))[0]?.status
    ).toBe("unknown");
  });
  it("encrypts the complete payload and preserves the original five-minute expiry on policy rechecks", async () => {
    const value = binding();
    await service.requestGoogleActionApproval(value, 7);
    const [first] = await Database.db.select().from(googleActionApprovals);
    if (!first?.encryptedInput) throw new Error("Expected encrypted approval.");
    expect(first.expiresAt.getTime() - first.createdAt.getTime()).toBe(300_000);
    expect(first.encryptedInput).not.toContain("Private body");
    expect(first.encryptedInput).not.toContain("fictional@example.com");
    expect(
      JSON.parse(
        await decryptWorkspaceValue(
          alice,
          `google-action-input:${first.id}`,
          first.encryptedInput
        )
      )
    ).toEqual(value.input);
    await service.requestGoogleActionApproval(value, 7);
    const rows = await Database.db.select().from(googleActionApprovals);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.expiresAt).toEqual(first.expiresAt);
    expect(operation).not.toHaveBeenCalled();
  });

  it("treats object-key order consistently without changing reviewed array order", async () => {
    await service.requestGoogleActionApproval(
      binding({ input: { a: 1, b: 2 } }),
      7
    );
    await service.respondGoogleActionApproval(
      binding({ input: { b: 2, a: 1 } }),
      7,
      "interaction-1",
      "approve"
    );
    await expect(
      service.requestGoogleActionApproval(binding({ input: { a: 2, b: 1 } }), 7)
    ).rejects.toThrow("exact Google action");
    expect(operation).not.toHaveBeenCalled();
  });

  it.each([
    { name: "payload", change: { input: { body: "changed" } } },
    { name: "workspace", change: bob },
    { name: "call", change: { callId: "call-2" } },
    { name: "session", change: { sessionId: "session-2" } },
    { name: "root conversation", change: { rootSessionId: "other-root" } },
    { name: "tool", change: { toolName: "gmail-update" as const } },
    { name: "principal", change: { principalHash: "a".repeat(64) } },
  ])("rejects a changed $name binding before dispatch", async ({ change }) => {
    await approved();
    await expect(run(binding(change))).rejects.toThrow("exact Google action");
    expect(operation).not.toHaveBeenCalled();
    expect(await Database.db.select().from(googleActionDispatches)).toEqual([]);
  });

  it("rejects pending, denied, expired and replayed-with-a-different-interaction approvals", async () => {
    const value = binding();
    await service.requestGoogleActionApproval(value, 7);
    await expect(run(value)).rejects.toThrow("exact Google action");
    await service.respondGoogleActionApproval(
      value,
      7,
      "interaction-1",
      "deny"
    );
    await expect(
      service.respondGoogleActionApproval(value, 7, "interaction-2", "approve")
    ).rejects.toThrow("exact Google action");
    await expect(run(value)).rejects.toThrow("exact Google action");
    expect(operation).not.toHaveBeenCalled();
  });

  it("does not renew expired approval by asking again or dispatch after expiration", async () => {
    const value = await approved();
    await Database.db
      .update(googleActionApprovals)
      .set({ expiresAt: new Date(Date.now() - 1_000) });
    await expect(service.requestGoogleActionApproval(value, 7)).rejects.toThrow(
      "exact Google action"
    );
    await expect(
      service.respondGoogleActionApproval(value, 7, "interaction-1", "approve")
    ).rejects.toThrow("exact Google action");
    await expect(run(value)).rejects.toThrow("exact Google action");
    expect(operation).not.toHaveBeenCalled();
  });

  it("does not dispatch when approval expires during a final awaited authority check", async () => {
    const value = await approved();
    let checks = 0;
    const guard = vi
      .spyOn(Enrollment, "assertEnrolledWorkspaceUser")
      .mockImplementation(async () => {
        checks += 1;
        if (checks === 2)
          await Database.db
            .update(googleActionApprovals)
            .set({ expiresAt: new Date(Date.now() - 1000) });
      });
    try {
      await expect(run(value)).rejects.toThrow("unconfirmed outcome");
      expect(operation).not.toHaveBeenCalled();
      expect(await Database.db.select().from(googleActionDispatches)).toEqual([
        expect.objectContaining({ state: "unknown" }),
      ]);
    } finally {
      guard.mockRestore();
    }
  });

  it("records a dispatch before executing and replays only the encrypted completed result", async () => {
    const value = await approved();
    operation.mockImplementationOnce(async () => {
      const [receipt] = await Database.db.select().from(googleActionDispatches);
      expect(receipt?.state).toBe("started");
      return { id: "fictional-provider-object" };
    });
    expect(await run(value)).toEqual({ id: "fictional-provider-object" });
    expect(await run(value)).toEqual({ id: "fictional-provider-object" });
    expect(operation).toHaveBeenCalledOnce();
    const [receipt] = await Database.db.select().from(googleActionDispatches);
    expect(receipt?.state).toBe("completed");
    expect(receipt?.encryptedResult).not.toContain("fictional-provider-object");
    expect(enrollment.checks).toBeGreaterThanOrEqual(7);
  });

  it("blocks concurrent duplicate dispatch and another call in the same conversation", async () => {
    const value = await approved();
    const other = binding({ callId: "call-2" });
    await approved(other);
    const held = Promise.withResolvers<{ id: string }>();
    operation.mockImplementationOnce(() => held.promise);
    const first = run(value);
    await vi.waitFor(async () => {
      expect(
        await Database.db.select().from(googleActionDispatches)
      ).toHaveLength(1);
    });
    await expect(run(value)).rejects.toThrow("unconfirmed outcome");
    await expect(run(other)).rejects.toThrow("unconfirmed outcome");
    held.resolve({ id: "fictional-provider-object" });
    await first;
    expect(operation).toHaveBeenCalledOnce();
    await run(other);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("retains unknown outcome metadata across replay, new call IDs and disconnect", async () => {
    const value = await approved();
    operation.mockRejectedValueOnce(
      new Error("raw token=private provider error")
    );
    await expect(run(value)).rejects.toThrow("unconfirmed outcome");
    await expect(run(value)).rejects.toThrow("unconfirmed outcome");
    await expect(
      service.requestGoogleActionApproval(binding({ callId: "new-call" }), 7)
    ).rejects.toThrow("unconfirmed outcome");
    await disconnectGoogleWorkspace(alice);
    const [receipt] = await Database.db.select().from(googleActionDispatches);
    expect(receipt).toMatchObject({ state: "unknown", encryptedResult: null });
    expect(operation).toHaveBeenCalledOnce();
  });

  it("fences changed connection versions without dispatching", async () => {
    const value = await approved();
    await Database.db
      .update(googleWorkspaceConnections)
      .set({ version: 8 })
      .where(eq(googleWorkspaceConnections.workspaceId, alice.workspaceId));
    await expect(run(value)).rejects.toThrow("exact Google action");
    expect(operation).not.toHaveBeenCalled();
  });

  it("purges review payloads and completed output atomically on disconnect", async () => {
    const value = await approved();
    await run(value);
    await disconnectGoogleWorkspace(alice);
    const [approval] = await Database.db.select().from(googleActionApprovals);
    const [receipt] = await Database.db.select().from(googleActionDispatches);
    expect(approval).toMatchObject({ state: "revoked", encryptedInput: null });
    expect(receipt).toMatchObject({
      state: "completed",
      encryptedResult: null,
    });
    await expect(run(value)).rejects.toThrow("exact Google action");
    expect(operation).toHaveBeenCalledOnce();
  });

  it("does not restore a completed result when disconnect wins during provider work", async () => {
    const value = await approved();
    operation.mockImplementationOnce(async () => {
      await disconnectGoogleWorkspace(alice);
      return { id: "late-private-result" };
    });
    await expect(run(value)).rejects.toThrow("unconfirmed outcome");
    const [receipt] = await Database.db.select().from(googleActionDispatches);
    expect(receipt).toMatchObject({ state: "unknown", encryptedResult: null });
    expect(operation).toHaveBeenCalledOnce();
  });

  it("rechecks enrollment after decrypting a completed result", async () => {
    const value = await approved();
    await run(value);
    const original = ProtectedValues.decryptWorkspaceValue;
    const held = vi
      .spyOn(ProtectedValues, "decryptWorkspaceValue")
      .mockImplementationOnce(async (...args) => {
        const result = await original(...args);
        enrollment.allowed = false;
        return result;
      });
    try {
      await expect(run(value)).rejects.toThrow("access removed");
      expect(operation).toHaveBeenCalledOnce();
    } finally {
      held.mockRestore();
    }
  });

  it("keeps a corrupt completed cache content-free and never re-dispatches", async () => {
    const value = await approved();
    await run(value);
    const [receipt] = await Database.db.select().from(googleActionDispatches);
    if (!receipt) throw new Error("Expected dispatch receipt.");
    await Database.db.update(googleActionDispatches).set({
      encryptedResult: await ProtectedValues.encryptWorkspaceValue(
        alice,
        `google-action-result:${receipt.approvalId}`,
        "not json: private provider body"
      ),
    });
    await expect(run(value)).rejects.toThrow("unconfirmed outcome");
    expect(operation).toHaveBeenCalledOnce();
    expect(
      (await Database.db.select().from(googleActionDispatches))[0]?.state
    ).toBe("completed");
  });

  it("blocks enrollment removal before approval, dispatch and completed-cache disclosure", async () => {
    enrollment.allowed = false;
    await expect(
      service.requestGoogleActionApproval(binding(), 7)
    ).rejects.toThrow("access removed");
    enrollment.allowed = true;
    const value = await approved();
    enrollment.allowed = false;
    await expect(run(value)).rejects.toThrow("access removed");
    enrollment.allowed = true;
    await run(value);
    enrollment.allowed = false;
    await expect(run(value)).rejects.toThrow("access removed");
    expect(operation).toHaveBeenCalledOnce();
  });

  it("rejects an oversized complete review instead of silently truncating it", async () => {
    await expect(
      service.requestGoogleActionApproval(
        binding({ input: { body: "x".repeat(3_001) } }),
        7
      )
    ).rejects.toThrow("exact Google action");
    expect(await Database.db.select().from(googleActionApprovals)).toEqual([]);
    expect(operation).not.toHaveBeenCalled();
  });
});
