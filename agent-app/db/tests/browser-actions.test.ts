import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { readFile } from "node:fs/promises";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import * as Database from "@db";
import * as schema from "@db/schema";
import {
  startBrowserAction,
  completeBrowserAction,
  markBrowserActionUnknown,
} from "@db/services/browser-actions";

const client = new PGlite();
await client.waitReady;
beforeAll(async () => {
  await client.exec(
    await readFile(
      new URL(
        "../migrations/0016_google_action_authority.sql",
        import.meta.url
      ),
      "utf8"
    )
  );
  await client.exec(
    await readFile(
      new URL(
        "../migrations/0017_browser_action_authority.sql",
        import.meta.url
      ),
      "utf8"
    )
  );
  const database = drizzle(client, { schema });
  // SAFETY: The embedded driver implements the exercised Drizzle contract;
  // only the nominal database driver type differs from production Postgres.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Exercise actual migration and durable SQL with PGlite.
  vi.spyOn(Database, "db", "get").mockReturnValue(database as never);
}, 15_000);
afterAll(async () => {
  vi.restoreAllMocks();
  await client.close();
});
afterEach(async () => {
  await client.exec(
    "TRUNCATE browser_action_attempts, google_action_dispatches, google_action_approvals"
  );
});

const alice = { userId: "alice", workspaceId: "workspace-alice" };
const bob = { userId: "bob", workspaceId: "workspace-bob" };
const input = {
  workerSessionId: "worker",
  rootSessionId: "root",
  callId: "call",
  toolName: "computer_action",
  browserSessionId: "browser",
  observationId: "observation",
  inputHash: "exact-input-digest",
};
async function rows() {
  return (
    await client.query<{ id: string; status: string }>(
      "SELECT id,status FROM browser_action_attempts ORDER BY id"
    )
  ).rows;
}

describe("durable browser action receipts", () => {
  it("checks durable Google uncertainty without leaking or altering another vendor's record", async () => {
    await Database.db.insert(schema.googleActionApprovals).values({
      ...alice,
      id: "google-approval",
      sessionId: "google-session",
      rootSessionId: input.rootSessionId,
      callId: "google-call",
      toolName: "gmail-send",
      inputHash: "google-digest",
      principalHash: "owner-digest",
      grantVersion: 1,
      state: "approved",
      expiresAt: new Date(Date.now() + 300_000),
    });
    await Database.db.insert(schema.googleActionDispatches).values({
      ...alice,
      approvalId: "google-approval",
      rootSessionId: input.rootSessionId,
      grantVersion: 1,
      state: "unknown",
    });
    await expect(startBrowserAction(alice, input)).rejects.toThrow(
      "uncertain external action"
    );
    expect(await rows()).toHaveLength(0);
    await startBrowserAction(alice, {
      ...input,
      rootSessionId: "other-root",
      callId: "other-call",
    });
    await startBrowserAction(bob, input);
    expect(await rows()).toHaveLength(2);
    expect(
      (await Database.db.select().from(schema.googleActionDispatches))[0]?.state
    ).toBe("unknown");
  });
  it("commits the started tombstone before returning permission to mutate", async () => {
    const id = await startBrowserAction(alice, input);
    expect(await rows()).toEqual([{ id, status: "started" }]);
  });

  it("atomically admits only one concurrent call in a worker", async () => {
    const results = await Promise.allSettled([
      startBrowserAction(alice, input),
      startBrowserAction(alice, { ...input, callId: "another-call" }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled")
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected")
    ).toHaveLength(1);
    expect(await rows()).toHaveLength(1);
  });

  it("admits an exact call once under concurrent replay", async () => {
    const results = await Promise.allSettled([
      startBrowserAction(alice, input),
      startBrowserAction(alice, input),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled")
    ).toHaveLength(1);
    expect(await rows()).toHaveLength(1);
  });

  it("retains a crash marker and blocks a new call without process-local state", async () => {
    await startBrowserAction(alice, input);
    await expect(
      startBrowserAction(alice, {
        ...input,
        callId: "after-restart",
        observationId: "new-observation",
      })
    ).rejects.toThrow("uncertain");
    expect((await rows())[0]?.status).toBe("started");
  });

  it("blocks delegating a fresh worker to bypass an unresolved action", async () => {
    await startBrowserAction(alice, input);
    await expect(
      startBrowserAction(alice, {
        ...input,
        workerSessionId: "replacement-worker",
        callId: "replacement-call",
      })
    ).rejects.toThrow("uncertain");
    expect(await rows()).toHaveLength(1);
  });

  it("never repeats an unknown action, including under a new call id", async () => {
    const id = await startBrowserAction(alice, input);
    await markBrowserActionUnknown(alice, id);
    await expect(startBrowserAction(alice, input)).rejects.toThrow("uncertain");
    await expect(
      startBrowserAction(alice, { ...input, callId: "retry" })
    ).rejects.toThrow("uncertain");
    expect(await rows()).toEqual([{ id, status: "unknown" }]);
  });

  it("blocks completed replay but permits the next distinct approved call", async () => {
    const id = await startBrowserAction(alice, input);
    await completeBrowserAction(alice, id);
    await expect(startBrowserAction(alice, input)).rejects.toThrow(
      "already completed"
    );
    const next = await startBrowserAction(alice, { ...input, callId: "next" });
    expect(await rows()).toEqual(
      expect.arrayContaining([
        { id, status: "completed" },
        { id: next, status: "started" },
      ])
    );
  });

  it("rejects changes to approved arguments, tool, browser, or observation", async () => {
    const id = await startBrowserAction(alice, input);
    await completeBrowserAction(alice, id);
    for (const change of [
      { inputHash: "changed" },
      { toolName: "playwright_execute" },
      { browserSessionId: "other" },
      { observationId: "invented" },
    ]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Replays deliberately target the same already completed receipt.
      await expect(
        startBrowserAction(alice, { ...input, ...change })
      ).rejects.toThrow("identity conflict");
    }
    expect(await rows()).toHaveLength(1);
  });

  it("isolates workers and tenants, and refuses cross-tenant settlement", async () => {
    const id = await startBrowserAction(alice, input);
    await Promise.all([
      startBrowserAction(alice, {
        ...input,
        workerSessionId: "another-worker",
        rootSessionId: "another-root",
      }),
      startBrowserAction(bob, input),
    ]);
    await expect(completeBrowserAction(bob, id)).rejects.toThrow(
      "could not be recorded"
    );
    await markBrowserActionUnknown(bob, id);
    expect((await rows()).find((row) => row.id === id)?.status).toBe("started");
    expect(await rows()).toHaveLength(3);
  });

  it("does not turn an already completed receipt into an unknown one", async () => {
    const id = await startBrowserAction(alice, input);
    await completeBrowserAction(alice, id);
    await markBrowserActionUnknown(alice, id);
    expect(await rows()).toEqual([{ id, status: "completed" }]);
  });
});
