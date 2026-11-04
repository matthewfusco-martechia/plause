import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { ToolContext } from "eve/tools";
import type * as Environment from "@shared/environment";
import * as Database from "@db";
import * as schema from "@db/schema";
import {
  reserveModelAttempt,
  startModelAttempt,
  settleModelAttempt,
} from "@db/services/model-budget";
import { decryptWorkspaceValue } from "@db/services/protected-values";
import { accessScopeForUser } from "@shared/identity/access-scope";
import { toolContextFor } from "@tests/helpers/tool-context";
import { searchPublicWeb } from "./search";

vi.mock("@shared/environment", async (importOriginal) => {
  const original = await importOriginal<typeof Environment>();
  return {
    ...original,
    env: {
      ...original.env,
      WEB_RESEARCH_ENABLED: "true",
      TAVILY_API_KEY: "fictional-search-key",
      MODEL_USER_MONTHLY_BUDGET_MICRO_USD: 100_000,
      MODEL_GLOBAL_MONTHLY_BUDGET_MICRO_USD: 100_000,
    },
  };
});
vi.mock("@db/services/auth/phone-user", () => ({
  assertEnrolledWorkspaceUser: async () => undefined,
}));

const database = new PGlite();
await database.waitReady;
const scope = accessScopeForUser("better-auth:alice");
const principal = {
  principalId: scope.userId,
  principalType: "user",
  authenticator: "linq-message",
  attributes: { workspaceId: scope.workspaceId },
};
const query = { query: "a fictional public question", max_results: 1 };

function context(callId = "search-call"): ToolContext {
  const ctx = toolContextFor({
    sessionId: "root-conversation",
    callId,
    toolName: "web_search",
    auth: { current: principal, initiator: principal },
  });
  return {
    ...ctx,
    approval: {
      responder: { ...principal, getToken: (...args) => ctx.getToken(...args) },
    },
  };
}

beforeAll(async () => {
  await database.exec(
    "CREATE TABLE settings (key text CONSTRAINT settings_key_check CHECK (key = 'gateway_model')); CREATE TABLE \"user\" (id text PRIMARY KEY); INSERT INTO \"user\"(id) VALUES ('alice')"
  );
  await database.exec(
    await readFile("db/migrations/0015_direct_providers.sql", "utf8")
  );
  await database.exec(
    await readFile(
      "db/migrations/0019_model_continuation_authority.sql",
      "utf8"
    )
  );
  await database.exec(
    await readFile("db/migrations/0020_model_continuation_grants.sql", "utf8")
  );
  const fixture = drizzle(database, { schema });
  // SAFETY: The real schema and query/transaction implementation are retained; only the driver is embedded.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- PGlite supplies the exercised Drizzle surface.
  vi.spyOn(Database, "db", "get").mockReturnValue(fixture as never);
});
beforeEach(async () => {
  await database.exec(
    "TRUNCATE model_continuation_grants, model_provider_attempts, model_budget_accounts"
  );
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({
      results: [
        {
          title: "Fictional reference",
          url: "https://example.com/source",
          content: "A bounded public excerpt",
        },
      ],
      usage: { credits: 1 },
    })
  );
});
afterEach(() => {
  vi.mocked(globalThis.fetch).mockRestore();
});
afterAll(async () => {
  vi.restoreAllMocks();
  await database.close();
});

describe("research on the shared durable provider ledger", () => {
  it("runs after a settled parent model call and caches encrypted results without plaintext query storage", async () => {
    await reserveModelAttempt({
      id: "parent-model",
      workspaceId: scope.workspaceId,
      rootSessionId: "root-conversation",
      requestHash: "fictional-parent-hash",
      model: "gpt-6-luna",
      reservedMicroUsd: 100,
    });
    await startModelAttempt(scope, "parent-model");
    await settleModelAttempt(scope, "parent-model", {
      actualMicroUsd: 100,
      inputTokens: 5,
      outputTokens: 5,
      encryptedResult: "fictional-parent-cache",
    });
    const first = await searchPublicWeb(query, context());
    const replay = await searchPublicWeb(query, context());
    expect(replay).toEqual(first);
    expect(globalThis.fetch).toHaveBeenCalledOnce();
    const attempts = await Database.db
      .select()
      .from(Database.modelProviderAttempts);
    const search = attempts.find(
      (attempt) => attempt.model === "tavily/basic-search"
    );
    expect(search).toMatchObject({
      status: "completed",
      reservedMicroUsd: 8_000,
      actualMicroUsd: 8_000,
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(JSON.stringify(attempts)).not.toContain(query.query);
    expect(search?.encryptedResult).not.toContain("A bounded public excerpt");
    if (!search?.encryptedResult)
      throw new Error("Expected encrypted search cache.");
    expect(
      JSON.parse(
        await decryptWorkspaceValue(
          scope,
          `research:${search.id}`,
          search.encryptedResult
        )
      )
    ).toEqual(first);
    const accounts = await database.query<{ held: string; spent: string }>(
      "SELECT held_micro_usd::text AS held,spent_micro_usd::text AS spent FROM model_budget_accounts ORDER BY id"
    );
    expect(accounts.rows).toEqual([
      { held: "0", spent: "8100" },
      { held: "0", spent: "8100" },
    ]);
  });

  it("retains an uncertain search reservation and blocks a fresh call ID or model retry in the same conversation", async () => {
    vi.mocked(globalThis.fetch).mockRejectedValueOnce(
      new Error("fictional network loss")
    );
    await expect(searchPublicWeb(query, context())).rejects.toThrow(
      "cost remains held"
    );
    await expect(
      searchPublicWeb(query, context("different-call"))
    ).rejects.toThrow("unresolved model charge");
    await expect(
      reserveModelAttempt({
        id: "next-model",
        workspaceId: scope.workspaceId,
        rootSessionId: "root-conversation",
        requestHash: "different-model-call",
        model: "gpt-6-luna",
        reservedMicroUsd: 100,
      })
    ).rejects.toThrow("unresolved model charge");
    expect(globalThis.fetch).toHaveBeenCalledOnce();
    const rows = await Database.db
      .select()
      .from(Database.modelProviderAttempts);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "unknown",
      reservedMicroUsd: 8_000,
      actualMicroUsd: null,
    });
  });
});
