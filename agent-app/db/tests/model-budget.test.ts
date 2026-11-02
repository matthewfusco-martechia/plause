import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
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
import * as schema from "../schema";
import { accessScopeForUser } from "@shared/identity/access-scope";
import {
  readModelAttempt,
  reserveModelAttempt,
  startModelAttempt,
  holdUnknownModelAttempt,
  settleModelAttempt,
} from "../services/model-budget";

const limits = vi.hoisted(() => ({ user: 30_000, global: 30_000 }));
vi.mock("@shared/environment", () => ({
  env: {
    DATABASE_URL: "postgresql://fixture:fixture@127.0.0.1:9/fixture",
    get MODEL_USER_MONTHLY_BUDGET_MICRO_USD() {
      return limits.user;
    },
    get MODEL_GLOBAL_MONTHLY_BUDGET_MICRO_USD() {
      return limits.global;
    },
  },
}));

const client = new PGlite();
beforeAll(async () => {
  // Exercise the actual generated migration. The pre-existing settings table
  // satisfies its final alteration; these tests need only the new provider tables.
  await client.exec(
    "CREATE TABLE settings (key text CONSTRAINT settings_key_check CHECK (key = 'gateway_model'))"
  );
  await client.exec('CREATE TABLE "user" (id text PRIMARY KEY)');
  await client.exec("INSERT INTO \"user\"(id) VALUES ('alice'),('bob')");
  await client.exec(
    await readFile(
      new URL("../migrations/0015_direct_providers.sql", import.meta.url),
      "utf8"
    )
  );
  const database = drizzle(client, { schema });
  // SAFETY: PGlite implements the exercised Drizzle transaction/query contract;
  // only the driver type differs from the production node-postgres instance.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Embedded driver tests the actual schema and transaction queries.
  vi.spyOn(Database, "db", "get").mockReturnValue(database as never);
}, 15_000);
afterAll(async () => {
  vi.restoreAllMocks();
  await client.close();
});
afterEach(async () => {
  await client.exec("TRUNCATE model_provider_attempts, model_budget_accounts");
  await client.exec(
    "INSERT INTO \"user\"(id) VALUES ('alice'),('bob') ON CONFLICT DO NOTHING"
  );
  limits.user = 30_000;
  limits.global = 30_000;
});

const alice = accessScopeForUser("better-auth:alice");
const bob = accessScopeForUser("better-auth:bob");
const date = new Date("2026-11-02T12:00:00Z");
function input(id: string, workspaceId = alice.workspaceId, amount = 80) {
  return {
    id,
    workspaceId,
    rootSessionId: "root-a",
    requestHash: `hash:${id}`,
    model: "gpt-6-luna",
    reservedMicroUsd: amount,
  };
}

describe("shared model spending reservations", () => {
  it("settles known usage without resurrecting private cache after account erasure", async () => {
    await reserveModelAttempt(input("erased"), date);
    await startModelAttempt(alice, "erased");
    await client.exec("DELETE FROM \"user\" WHERE id='alice'");
    await settleModelAttempt(alice, "erased", {
      actualMicroUsd: 20,
      inputTokens: 10,
      outputTokens: 5,
      encryptedResult: "must-not-return",
    });
    expect(await readModelAttempt(alice, "erased")).toMatchObject({
      status: "completed",
      actualMicroUsd: 20,
      encryptedResult: null,
    });
  });

  it("enforces the user's cap independently of available global capacity", async () => {
    limits.user = 100;
    limits.global = 500;
    await reserveModelAttempt(input("alice-first"), date);
    await expect(
      reserveModelAttempt(
        { ...input("alice-second"), rootSessionId: "root-b" },
        date
      )
    ).rejects.toThrow("spending limit");
    expect(
      (await reserveModelAttempt(input("bob-first", bob.workspaceId), date))
        .admitted
    ).toBe(true);
    const accounts = await client.query<{ held: string }>(
      "SELECT held_micro_usd::text AS held FROM model_budget_accounts WHERE id='global:2026-11'"
    );
    expect(accounts.rows).toEqual([{ held: "160" }]);
  });
  it.each(["reserved", "started"] as const)(
    "blocks a different replay key after a crash leaves %s work",
    async (state) => {
      await reserveModelAttempt(input("crashed"), date);
      if (state === "started") await startModelAttempt(alice, "crashed");
      await expect(
        reserveModelAttempt(
          input("different-key"),
          new Date("2026-12-01T00:00:00Z")
        )
      ).rejects.toThrow("unresolved model charge");
      expect((await readModelAttempt(alice, "crashed"))?.status).toBe(state);
      expect(await readModelAttempt(alice, "different-key")).toBeUndefined();
    }
  );

  it("permits independently bounded conversations while serializing one root", async () => {
    const result = await Promise.all([
      reserveModelAttempt(input("root-one"), date),
      reserveModelAttempt(
        { ...input("root-two"), rootSessionId: "root-b" },
        date
      ),
    ]);
    expect(result.every((item) => item.admitted)).toBe(true);
    const accounts = await client.query<{ held: string }>(
      "SELECT held_micro_usd::text AS held FROM model_budget_accounts WHERE id='global:2026-11'"
    );
    expect(accounts.rows).toEqual([{ held: "160" }]);
  });

  it("admits a concurrent duplicate once and debits its settlement once", async () => {
    const result = await Promise.all([
      reserveModelAttempt(input("duplicate"), date),
      reserveModelAttempt(input("duplicate"), date),
    ]);
    expect(result.filter((item) => item.admitted)).toHaveLength(1);
    await startModelAttempt(alice, "duplicate");
    const settled = await Promise.allSettled([
      settleModelAttempt(alice, "duplicate", {
        actualMicroUsd: 20,
        inputTokens: 10,
        outputTokens: 5,
        encryptedResult: "encrypted",
      }),
      settleModelAttempt(alice, "duplicate", {
        actualMicroUsd: 20,
        inputTokens: 10,
        outputTokens: 5,
        encryptedResult: "encrypted",
      }),
    ]);
    expect(settled.filter((item) => item.status === "fulfilled")).toHaveLength(
      1
    );
    const accounts = await client.query<{ held: string; spent: string }>(
      "SELECT held_micro_usd::text AS held,spent_micro_usd::text AS spent FROM model_budget_accounts WHERE id='global:2026-11'"
    );
    expect(accounts.rows).toEqual([{ held: "0", spent: "20" }]);
  });

  it("rejects reuse of an attempt ID for a different conversation", async () => {
    await reserveModelAttempt(input("same-id"), date);
    await expect(
      reserveModelAttempt(
        { ...input("same-id"), rootSessionId: "different-root" },
        date
      )
    ).rejects.toThrow("identity conflict");
  });
  it("atomically caps competing users against one global budget", async () => {
    // Two 20,000 reservations cannot both fit the configured 30,000 cap.
    const result = await Promise.allSettled([
      reserveModelAttempt(input("alice-call", alice.workspaceId, 20_000), date),
      reserveModelAttempt(input("bob-call", bob.workspaceId, 20_000), date),
    ]);
    expect(result.filter((item) => item.status === "fulfilled")).toHaveLength(
      1
    );
    expect(result.filter((item) => item.status === "rejected")).toHaveLength(1);
    const accounts = await client.query<{ held: string }>(
      "SELECT held_micro_usd::text AS held FROM model_budget_accounts WHERE id='global:2026-11'"
    );
    expect(accounts.rows).toEqual([{ held: "20000" }]);
  });

  it("does not reserve or submit the same attempt twice and isolates tenants", async () => {
    expect((await reserveModelAttempt(input("same"), date)).admitted).toBe(
      true
    );
    expect((await reserveModelAttempt(input("same"), date)).admitted).toBe(
      false
    );
    expect(await readModelAttempt(bob, "same")).toBeUndefined();
    await expect(startModelAttempt(bob, "same")).rejects.toThrow(
      "already been submitted"
    );
    await startModelAttempt(alice, "same");
    await expect(startModelAttempt(alice, "same")).rejects.toThrow(
      "already been submitted"
    );
  });

  it("settles unused capacity once and retains unknown charge reservations", async () => {
    await reserveModelAttempt(input("known"), date);
    await startModelAttempt(alice, "known");
    const result = {
      actualMicroUsd: 20,
      inputTokens: 10,
      outputTokens: 5,
      encryptedResult: "encrypted",
    };
    await settleModelAttempt(alice, "known", result);
    await expect(settleModelAttempt(alice, "known", result)).rejects.toThrow(
      "twice"
    );
    await reserveModelAttempt(input("unknown", alice.workspaceId, 100), date);
    await startModelAttempt(alice, "unknown");
    await holdUnknownModelAttempt(alice, "unknown");
    await expect(reserveModelAttempt(input("new-key"), date)).rejects.toThrow(
      "unresolved model charge"
    );
    const accounts = await client.query<{ spent: string; held: string }>(
      "SELECT spent_micro_usd::text AS spent,held_micro_usd::text AS held FROM model_budget_accounts WHERE id='global:2026-11'"
    );
    expect(accounts.rows).toEqual([{ spent: "20", held: "100" }]);
  });
});
