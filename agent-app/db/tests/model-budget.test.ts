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
  authorizeModelContinuation,
} from "../services/model-budget";

const limits = vi.hoisted(() => ({
  user: 30_000,
  global: 30_000,
  attempts: 0,
}));
vi.mock("@shared/environment", () => ({
  env: {
    DATABASE_URL: "postgresql://fixture:fixture@127.0.0.1:9/fixture",
    get MODEL_USER_MONTHLY_BUDGET_MICRO_USD() {
      return limits.user;
    },
    get MODEL_GLOBAL_MONTHLY_ATTEMPT_LIMIT() {
      return limits.attempts || undefined;
    },
    get MODEL_GLOBAL_MONTHLY_BUDGET_MICRO_USD() {
      return limits.global;
    },
  },
}));

const client = new PGlite();
await client.waitReady;
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
  await client.exec(
    await readFile(
      new URL(
        "../migrations/0020_model_continuation_grants.sql",
        import.meta.url
      ),
      "utf8"
    )
  );
  await client.exec(
    await readFile(
      new URL(
        "../migrations/0019_model_continuation_authority.sql",
        import.meta.url
      ),
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
  await client.exec(
    "TRUNCATE model_continuation_grants, model_provider_attempts, model_budget_accounts"
  );
  await client.exec(
    "INSERT INTO \"user\"(id) VALUES ('alice'),('bob') ON CONFLICT DO NOTHING"
  );
  limits.user = 30_000;
  limits.global = 30_000;
  limits.attempts = 0;
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
  const authorization = () => ({
    attemptId: "uncertain",
    rootSessionId: "root-a",
    reservedMicroUsd: 80,
    authorizationHash: "a".repeat(64),
    expiresAt: new Date(date.getTime() + 30 * 60 * 1000),
  });

  async function unknownAttempt() {
    await reserveModelAttempt(input("uncertain"), date);
    await startModelAttempt(alice, "uncertain");
    await holdUnknownModelAttempt(alice, "uncertain");
  }

  it("permits distinct approved work while retaining the unknown request and full hold", async () => {
    await unknownAttempt();
    await expect(reserveModelAttempt(input("fresh"), date)).rejects.toThrow(
      "unresolved model charge"
    );
    expect(
      await authorizeModelContinuation(alice, authorization(), date)
    ).toEqual({
      authorized: true,
    });
    expect((await reserveModelAttempt(input("uncertain"), date)).admitted).toBe(
      false
    );
    expect((await reserveModelAttempt(input("fresh"), date)).admitted).toBe(
      true
    );
    expect(await readModelAttempt(alice, "uncertain")).toMatchObject({
      status: "unknown",
      reservedMicroUsd: 80,
      actualMicroUsd: null,
      encryptedResult: null,
      continuationAuthorizationHash: "a".repeat(64),
      continuationAuthorizedAt: date,
    });
    expect(
      (
        await client.query(
          "SELECT held_micro_usd::text AS held,spent_micro_usd::text AS spent FROM model_budget_accounts ORDER BY id"
        )
      ).rows
    ).toEqual([
      { held: "160", spent: "0" },
      { held: "160", spent: "0" },
    ]);
  });

  it("restores the conversation fence when the continuation authorization expires", async () => {
    await unknownAttempt();
    await authorizeModelContinuation(alice, authorization(), date);
    await expect(
      reserveModelAttempt(input("late"), authorization().expiresAt)
    ).rejects.toThrow("unresolved model charge");
    expect((await readModelAttempt(alice, "uncertain"))?.status).toBe(
      "unknown"
    );
  });

  it("does not authorize a later unknown outcome or bypass spending and call ceilings", async () => {
    await unknownAttempt();
    await authorizeModelContinuation(alice, authorization(), date);
    limits.attempts = 1;
    await expect(
      reserveModelAttempt(input("over-ceiling"), date)
    ).rejects.toThrow("attempt limit");
    limits.attempts = 6;
    limits.user = 80;
    await expect(
      reserveModelAttempt(input("over-budget"), date)
    ).rejects.toThrow("spending limit");
    limits.user = 30_000;
    await reserveModelAttempt(input("second-uncertain"), date);
    await startModelAttempt(alice, "second-uncertain");
    await holdUnknownModelAttempt(alice, "second-uncertain");
    await expect(reserveModelAttempt(input("third"), date)).rejects.toThrow(
      "unresolved model charge"
    );
  });

  it.each(["reserved", "started"] as const)(
    "refuses to authorize %s model work",
    async (state) => {
      await reserveModelAttempt(input("uncertain"), date);
      if (state === "started") await startModelAttempt(alice, "uncertain");
      await expect(
        authorizeModelContinuation(alice, authorization(), date)
      ).rejects.toThrow("no longer matches");
      expect((await readModelAttempt(alice, "uncertain"))?.status).toBe(state);
    }
  );

  it("requires the exact owner, root, amount and a bounded recorded authorization", async () => {
    await unknownAttempt();
    await expect(
      authorizeModelContinuation(bob, authorization(), date)
    ).rejects.toThrow("Unknown model request");
    await expect(
      authorizeModelContinuation(
        alice,
        { ...authorization(), rootSessionId: "other-root" },
        date
      )
    ).rejects.toThrow("no longer matches");
    await expect(
      authorizeModelContinuation(
        alice,
        { ...authorization(), reservedMicroUsd: 81 },
        date
      )
    ).rejects.toThrow("no longer matches");
    await expect(
      authorizeModelContinuation(
        alice,
        { ...authorization(), authorizationHash: "not-reviewed" },
        date
      )
    ).rejects.toThrow("valid owner");
    await expect(
      authorizeModelContinuation(
        alice,
        {
          ...authorization(),
          expiresAt: new Date(date.getTime() + 60 * 60 * 1000 + 1),
        },
        date
      )
    ).rejects.toThrow("valid owner");
    expect(
      (await readModelAttempt(alice, "uncertain"))?.continuationAuthorizedAt
    ).toBeNull();
  });

  it("deduplicates an authorization without extending its deadline", async () => {
    await unknownAttempt();
    const results = await Promise.all([
      authorizeModelContinuation(alice, authorization(), date),
      authorizeModelContinuation(alice, authorization(), date),
    ]);
    expect(results.filter((result) => result.authorized)).toHaveLength(1);
    expect(results.filter((result) => !result.authorized)).toHaveLength(1);
    await expect(
      authorizeModelContinuation(
        alice,
        {
          ...authorization(),
          expiresAt: new Date(date.getTime() + 40 * 60 * 1000),
        },
        date
      )
    ).rejects.toThrow("already authorized");
    expect(
      (await readModelAttempt(alice, "uncertain"))?.continuationExpiresAt
    ).toEqual(authorization().expiresAt);
  });

  it("rejects partial authorization metadata at the database boundary", async () => {
    await unknownAttempt();
    await expect(
      client.exec(
        "UPDATE model_provider_attempts SET continuation_authorized_at = now() WHERE id='uncertain'"
      )
    ).rejects.toThrow("model_provider_continuation_authorization");
    expect(
      (await readModelAttempt(alice, "uncertain"))?.continuationAuthorizedAt
    ).toBeNull();
  });

  it("records separately approved windows without changing the original permission or charge", async () => {
    await unknownAttempt();
    await authorizeModelContinuation(alice, authorization(), date);
    const original = await readModelAttempt(alice, "uncertain");
    const later = new Date(date.getTime() + 60 * 60 * 1000);
    const renewal = {
      ...authorization(),
      authorizationHash: "b".repeat(64),
      expiresAt: new Date(later.getTime() + 30 * 60 * 1000),
    };
    const results = await Promise.all([
      authorizeModelContinuation(alice, renewal, later),
      authorizeModelContinuation(alice, renewal, later),
    ]);
    expect(results.filter((result) => result.authorized)).toHaveLength(1);
    expect(await readModelAttempt(alice, "uncertain")).toEqual(original);
    expect(
      (await reserveModelAttempt(input("uncertain"), later)).admitted
    ).toBe(false);
    limits.attempts = 1;
    await expect(reserveModelAttempt(input("ceiling"), later)).rejects.toThrow(
      "attempt limit"
    );
    limits.attempts = 6;
    limits.user = 80;
    await expect(reserveModelAttempt(input("budget"), later)).rejects.toThrow(
      "spending limit"
    );
    limits.user = 30_000;
    expect((await reserveModelAttempt(input("renewed"), later)).admitted).toBe(
      true
    );
    await startModelAttempt(alice, "renewed");
    await holdUnknownModelAttempt(alice, "renewed");
    await expect(
      reserveModelAttempt(input("later-unknown"), later)
    ).rejects.toThrow("unresolved model charge");
    expect(
      (
        await client.query(
          "SELECT held_micro_usd::int AS held FROM model_budget_accounts"
        )
      ).rows
    ).toEqual([{ held: 160 }, { held: 160 }]);
  });

  it("expires each new window and refuses overlapping or reused review hashes", async () => {
    await unknownAttempt();
    await authorizeModelContinuation(alice, authorization(), date);
    const later = authorization().expiresAt;
    const renewal = {
      ...authorization(),
      authorizationHash: "b".repeat(64),
      expiresAt: new Date(later.getTime() + 30 * 60 * 1000),
    };
    await expect(
      authorizeModelContinuation(alice, renewal, date)
    ).rejects.toThrow("still active");
    await authorizeModelContinuation(alice, renewal, later);
    await expect(
      authorizeModelContinuation(
        alice,
        { ...renewal, expiresAt: new Date(renewal.expiresAt.getTime() + 1) },
        later
      )
    ).rejects.toThrow("already authorized");
    await expect(
      authorizeModelContinuation(
        alice,
        { ...renewal, authorizationHash: "c".repeat(64) },
        later
      )
    ).rejects.toThrow("still active");
    await expect(
      reserveModelAttempt(input("expired-renewal"), renewal.expiresAt)
    ).rejects.toThrow("unresolved model charge");
    const third = {
      ...renewal,
      authorizationHash: "c".repeat(64),
      expiresAt: new Date(renewal.expiresAt.getTime() + 30 * 60 * 1000),
    };
    await authorizeModelContinuation(alice, third, renewal.expiresAt);
    expect(
      (
        await client.query(
          "SELECT count(*)::int AS count FROM model_continuation_grants"
        )
      ).rows
    ).toEqual([{ count: 2 }]);
    expect(
      (await readModelAttempt(alice, "uncertain"))
        ?.continuationAuthorizationHash
    ).toBe("a".repeat(64));
    expect(
      (await reserveModelAttempt(input("third-window"), renewal.expiresAt))
        .admitted
    ).toBe(true);
  });

  it("binds new permissions to the reviewed owner and attempt, and rejects active work", async () => {
    await unknownAttempt();
    await authorizeModelContinuation(alice, authorization(), date);
    const later = authorization().expiresAt;
    const renewal = {
      ...authorization(),
      authorizationHash: "b".repeat(64),
      expiresAt: new Date(later.getTime() + 30 * 60 * 1000),
    };
    await expect(
      authorizeModelContinuation(bob, renewal, later)
    ).rejects.toThrow("Unknown model request");
    await expect(
      authorizeModelContinuation(
        alice,
        { ...renewal, rootSessionId: "other" },
        later
      )
    ).rejects.toThrow("no longer matches");
    await expect(
      authorizeModelContinuation(
        alice,
        { ...renewal, reservedMicroUsd: 81 },
        later
      )
    ).rejects.toThrow("no longer matches");
    await reserveModelAttempt(input("active"), date);
    await expect(
      authorizeModelContinuation(alice, renewal, later)
    ).rejects.toThrow("active model work");
    expect(
      (
        await client.query(
          "SELECT count(*)::int AS count FROM model_continuation_grants"
        )
      ).rows
    ).toEqual([{ count: 0 }]);
  });

  it("cannot reuse another attempt's review hash or insert an unbounded grant", async () => {
    await unknownAttempt();
    await authorizeModelContinuation(alice, authorization(), date);
    const later = authorization().expiresAt;
    const renewal = {
      ...authorization(),
      authorizationHash: "b".repeat(64),
      expiresAt: new Date(later.getTime() + 30 * 60 * 1000),
    };
    await authorizeModelContinuation(alice, renewal, later);
    await reserveModelAttempt(
      { ...input("other"), rootSessionId: "other-root" },
      date
    );
    await holdUnknownModelAttempt(alice, "other");
    await expect(
      authorizeModelContinuation(
        alice,
        { ...renewal, attemptId: "other", rootSessionId: "other-root" },
        later
      )
    ).rejects.toThrow("already authorized");
    await expect(
      client.exec(
        "INSERT INTO model_continuation_grants VALUES ('" +
          "c".repeat(64) +
          "','uncertain','2026-11-02T13:00:00Z','2026-11-02T14:00:01Z')"
      )
    ).rejects.toThrow("model_continuation_grant_authority");
    expect(
      (
        await client.query(
          "SELECT count(*)::int AS count FROM model_continuation_grants"
        )
      ).rows
    ).toEqual([{ count: 1 }]);
  });

  it("atomically limits generation attempts across competing users", async () => {
    limits.attempts = 3;
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, index) =>
        reserveModelAttempt(
          {
            ...input(
              `bounded-${String(index)}`,
              index % 2 ? alice.workspaceId : bob.workspaceId
            ),
            rootSessionId: `root-${String(index)}`,
          },
          date
        )
      )
    );
    expect(
      results.filter((result) => result.status === "fulfilled")
    ).toHaveLength(3);
    expect(
      results.filter((result) => result.status === "rejected")
    ).toHaveLength(2);
    expect(
      (
        await client.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM model_provider_attempts"
        )
      ).rows[0]?.count
    ).toBe(3);
  });

  it("counts uncertain attempts but allows replay lookup without another reservation", async () => {
    limits.attempts = 1;
    await reserveModelAttempt(input("unknown-at-limit"), date);
    await startModelAttempt(alice, "unknown-at-limit");
    await holdUnknownModelAttempt(alice, "unknown-at-limit");
    expect(
      (await reserveModelAttempt(input("unknown-at-limit"), date)).admitted
    ).toBe(false);
    await expect(
      reserveModelAttempt(
        {
          ...input("another-attempt", bob.workspaceId),
          rootSessionId: "other-root",
        },
        date
      )
    ).rejects.toThrow("attempt limit");
    const nextMonth = new Date("2026-12-01T00:00:00Z");
    expect(
      (
        await reserveModelAttempt(
          {
            ...input("next-month", bob.workspaceId),
            rootSessionId: "next-month-root",
          },
          nextMonth
        )
      ).admitted
    ).toBe(true);
  });

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
