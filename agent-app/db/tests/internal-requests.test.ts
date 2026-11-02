import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Database from "@db";
import * as schema from "@db/schema";
import { claimInternalRequest } from "@db/services/internal-requests";

const clients: PGlite[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

describe("durable internal callback receipts", () => {
  it("allows only one concurrent nonce claim and keeps the body out of storage", async () => {
    const client = new PGlite();
    clients.push(client);
    await client.exec(
      `CREATE TABLE internal_request_receipts (request_id uuid PRIMARY KEY, signature_digest text NOT NULL, path text NOT NULL, expires_at timestamptz NOT NULL)`
    );
    const database = drizzle(client, { schema });
    // SAFETY: PGlite exercises the same owning Drizzle schema and transactional query surface.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Only the database driver changes for this fixture.
    vi.spyOn(Database, "db", "get").mockReturnValue(database as never);
    const now = new Date("2026-11-02T12:00:00Z");
    const receipt = {
      requestId: "00000000-0000-4000-8000-000000000001",
      signatureDigest: "a".repeat(64),
      path: "/internal/scheduled-run/respond" as const,
      expiresAt: new Date(now.getTime() + 300_000),
    };
    const results = await Promise.all([
      claimInternalRequest(receipt, now),
      claimInternalRequest(receipt, now),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(
      await claimInternalRequest(
        { ...receipt, signatureDigest: "b".repeat(64) },
        now
      )
    ).toBe(false);
    const rows = await database.select().from(schema.internalRequestReceipts);
    expect(rows).toEqual([receipt]);
    expect(
      await claimInternalRequest(
        {
          ...receipt,
          requestId: "00000000-0000-4000-8000-000000000002",
          expiresAt: now,
        },
        now
      )
    ).toBe(false);
    expect(
      await database.select().from(schema.internalRequestReceipts)
    ).toHaveLength(1);
  });
});
