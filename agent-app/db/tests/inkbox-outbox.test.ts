import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
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
import * as Database from "@db";
import * as schema from "@db/schema";
import * as ProtectedValues from "@db/services/protected-values";
import type * as Environment from "@shared/environment";
import { accessScopeForUser } from "@shared/identity/access-scope";
import {
  assertInkboxDestinationAvailable,
  assertInkboxOutboundDispatch,
  decryptInkboxOutbound,
  expireInkboxOutboundPayloads,
  finishInkboxOutbound,
  holdInkboxOutboundUnknown,
  readInkboxOutbound,
  reconcileInkboxOutbound,
  startInkboxOutbound,
} from "@db/services/inkbox-outbox";

vi.mock("@shared/environment", async (original) => {
  const loaded = await original<typeof Environment>();
  return {
    ...loaded,
    env: {
      ...loaded.env,
      INKBOX_IDENTITY_ID: "10000000-0000-4000-8000-000000000001",
    },
  };
});
const client = new PGlite();
await client.waitReady;
const database = drizzle(client, { schema });
const scope = accessScopeForUser("better-auth:user-a");
const otherScope = accessScopeForUser("better-auth:user-b");
const now = new Date();
const messageId = "20000000-0000-4000-8000-000000000001";
const conversationId = "30000000-0000-4000-8000-000000000001";
const assignmentId = "40000000-0000-4000-8000-000000000001";
const input = {
  scope,
  idempotencyKey: "logical-send-1",
  phoneNumber: "+15550100011",
  conversationId,
  assignmentId,
  intentDigest: "a".repeat(64),
  body: JSON.stringify({
    conversation_id: conversationId,
    text: "private fictional message",
  }),
};

beforeAll(async () => {
  const directory = new URL("../migrations/", import.meta.url);
  const names = (await readdir(directory))
    .filter((name) => name.endsWith(".sql"))
    .toSorted();
  await client.exec(
    (
      await Promise.all(
        names.map((name) => readFile(new URL(name, directory), "utf8"))
      )
    ).join("\n")
  );
});
beforeEach(async () => {
  await client.exec('TRUNCATE TABLE inkbox_message_outbox, "user" CASCADE');
  await database.insert(schema.user).values([
    {
      id: "user-a",
      name: "Fixture A",
      email: "a@example.invalid",
      phoneNumber: "+15550100011",
      phoneNumberVerified: true,
    },
    {
      id: "user-b",
      name: "Fixture B",
      email: "b@example.invalid",
      phoneNumber: "+15550100022",
      phoneNumberVerified: true,
    },
  ]);
  // SAFETY: Embedded Postgres exercises the actual transactional schema and service SQL.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Only the database driver changes.
  vi.spyOn(Database, "db", "get").mockReturnValue(database as never);
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => client.close());

describe("durable Inkbox outbound requests", () => {
  it("serializes distinct keys at the same destination and blocks a fresh key after uncertainty", async () => {
    const results = await Promise.allSettled([
      startInkboxOutbound(input, now),
      startInkboxOutbound(
        { ...input, idempotencyKey: "concurrent-other" },
        now
      ),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled")
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected")
    ).toHaveLength(1);
    const [row] = await database.select().from(schema.inkboxMessageOutbox);
    if (!row) throw new Error("Missing receipt");
    await holdInkboxOutboundUnknown(
      scope,
      row.idempotencyKey,
      row.attemptToken,
      now
    );
    await expect(
      startInkboxOutbound({ ...input, idempotencyKey: "fresh-model-call" }, now)
    ).rejects.toThrow("unresolved");
    expect(
      await startInkboxOutbound(
        {
          ...input,
          idempotencyKey: "new-assignment-call",
          assignmentId: "90000000-0000-4000-8000-000000000001",
        },
        now
      )
    ).toMatchObject({ kind: "started" });
  });

  it("checks the destination before media upload and allows a later logical send after acceptance", async () => {
    await assertInkboxDestinationAvailable(
      scope,
      input.phoneNumber,
      conversationId,
      assignmentId,
      input.idempotencyKey
    );
    const { row } = await startInkboxOutbound(input, now);
    await expect(
      assertInkboxDestinationAvailable(
        scope,
        input.phoneNumber,
        conversationId,
        assignmentId,
        "next-call"
      )
    ).rejects.toThrow("unresolved");
    await expect(
      assertInkboxDestinationAvailable(
        scope,
        input.phoneNumber,
        conversationId,
        assignmentId,
        input.idempotencyKey
      )
    ).rejects.toThrow("recorded");
    await finishInkboxOutbound(
      scope,
      input.idempotencyKey,
      row.attemptToken,
      messageId
    );
    await assertInkboxDestinationAvailable(
      scope,
      input.phoneNumber,
      conversationId,
      assignmentId,
      "next-call"
    );
    expect(
      await startInkboxOutbound({ ...input, idempotencyKey: "next-call" }, now)
    ).toMatchObject({ kind: "started" });
  });
  it("commits one started receipt under concurrent claims and encrypts its exact request", async () => {
    const results = await Promise.all([
      startInkboxOutbound(input, now),
      startInkboxOutbound(input, now),
    ]);
    expect(results.map((result) => result.kind).toSorted()).toEqual([
      "existing",
      "started",
    ]);
    expect(results[0].row.bodyCiphertext).not.toContain(
      "private fictional message"
    );
    expect(await decryptInkboxOutbound(scope, input.idempotencyKey)).toBe(
      input.body
    );
    const row = results[0].row;
    expect(
      await assertInkboxOutboundDispatch(
        scope,
        input.idempotencyKey,
        row.attemptToken,
        row.bodyDigest,
        input.phoneNumber,
        now
      )
    ).toBe(true);
  });

  it("rejects reused keys with changed body, destination, account or workspace", async () => {
    await startInkboxOutbound(input, now);
    await expect(
      startInkboxOutbound(
        {
          ...input,
          body: JSON.stringify({
            conversation_id: conversationId,
            text: "changed",
          }),
        },
        now
      )
    ).rejects.toThrow("reused");
    await expect(
      startInkboxOutbound(
        { ...input, scope: otherScope, phoneNumber: "+15550100022" },
        now
      )
    ).rejects.toThrow("reused");
    await expect(
      startInkboxOutbound(
        { ...input, scope: { ...scope, workspaceId: otherScope.workspaceId } },
        now
      )
    ).rejects.toThrow("workspace");
    await expect(
      startInkboxOutbound({ ...input, conversationId: messageId }, now)
    ).rejects.toThrow("destination");
    await expect(
      startInkboxOutbound({ ...input, intentDigest: "b".repeat(64) }, now)
    ).rejects.toThrow("logical intent");
  });

  it("requires the current enrolled verified phone before claim and final dispatch", async () => {
    const { row } = await startInkboxOutbound(input, now);
    expect(
      await assertInkboxOutboundDispatch(
        scope,
        input.idempotencyKey,
        messageId,
        row.bodyDigest,
        input.phoneNumber,
        now
      )
    ).toBe(false);
    expect(
      await assertInkboxOutboundDispatch(
        scope,
        input.idempotencyKey,
        row.attemptToken,
        "changed",
        input.phoneNumber,
        now
      )
    ).toBe(false);
    await database
      .update(schema.user)
      .set({ phoneNumberVerified: false })
      .where(eq(schema.user.id, "user-a"));
    await expect(
      assertInkboxOutboundDispatch(
        scope,
        input.idempotencyKey,
        row.attemptToken,
        row.bodyDigest,
        input.phoneNumber,
        now
      )
    ).rejects.toThrow("verified");
    await expect(
      startInkboxOutbound({ ...input, idempotencyKey: "different" }, now)
    ).rejects.toThrow("verified");
  });

  it("does not bind one enrolled account to another allowlisted recipient", async () => {
    await expect(
      startInkboxOutbound({ ...input, phoneNumber: "+15550100022" }, now)
    ).rejects.toThrow("verified");
    expect(await database.select().from(schema.inkboxMessageOutbox)).toEqual(
      []
    );
  });

  it("rechecks current ownership after an asynchronous request decrypt", async () => {
    await startInkboxOutbound(input, now);
    let decrypted!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      decrypted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(ProtectedValues, "decryptWorkspaceValue").mockImplementation(
      async () => {
        decrypted();
        await gate;
        return input.body;
      }
    );
    const pending = decryptInkboxOutbound(scope, input.idempotencyKey);
    await entered;
    await database.delete(schema.user).where(eq(schema.user.id, "user-a"));
    release();
    await expect(pending).rejects.toThrow("verified");
  });

  it("records acceptance without claiming delivery and replays the original message identifier", async () => {
    const { row } = await startInkboxOutbound(input, now);
    expect(
      await finishInkboxOutbound(
        scope,
        input.idempotencyKey,
        row.attemptToken,
        messageId
      )
    ).toBe(true);
    const replay = await startInkboxOutbound(input, now);
    expect(replay).toMatchObject({
      kind: "existing",
      row: { status: "accepted", providerMessageId: messageId },
    });
    expect(
      await reconcileInkboxOutbound(
        scope,
        input.idempotencyKey,
        row.bodyDigest,
        messageId,
        "delivered"
      )
    ).toBe(true);
    expect(
      await reconcileInkboxOutbound(
        scope,
        input.idempotencyKey,
        row.bodyDigest,
        messageId,
        "accepted"
      )
    ).toBe(false);
    expect(
      await readInkboxOutbound(otherScope, input.idempotencyKey)
    ).toBeUndefined();
  });

  it("holds uncertain sends without granting another attempt after restart or seven days", async () => {
    const { row } = await startInkboxOutbound(input, now);
    await holdInkboxOutboundUnknown(
      scope,
      input.idempotencyKey,
      row.attemptToken,
      now
    );
    const later = new Date(now.getTime() + 7 * 86_400_000 + 1);
    await expireInkboxOutboundPayloads(later);
    expect(await startInkboxOutbound(input, later)).toMatchObject({
      kind: "existing",
      row: { status: "unknown", bodyCiphertext: null },
    });
    expect(
      await assertInkboxOutboundDispatch(
        scope,
        input.idempotencyKey,
        row.attemptToken,
        row.bodyDigest,
        input.phoneNumber,
        later
      )
    ).toBe(false);
    expect(
      await reconcileInkboxOutbound(
        scope,
        input.idempotencyKey,
        "wrong digest",
        messageId,
        "accepted",
        later
      )
    ).toBe(false);
    expect(
      await reconcileInkboxOutbound(
        scope,
        input.idempotencyKey,
        row.bodyDigest,
        messageId,
        "accepted",
        later
      )
    ).toBe(true);
  });

  it("purges deleted-user routing/content and retains an unknown tombstone against late completion", async () => {
    const { row } = await startInkboxOutbound(input, now);
    await database.delete(schema.user).where(eq(schema.user.id, "user-a"));
    expect(
      await database.select().from(schema.inkboxMessageOutbox)
    ).toMatchObject([
      {
        key: row.key,
        status: "unknown",
        bodyCiphertext: null,
        providerMessageId: null,
        userId: null,
      },
    ]);
    await expect(
      finishInkboxOutbound(
        scope,
        input.idempotencyKey,
        row.attemptToken,
        messageId
      )
    ).rejects.toThrow("verified");
    await expect(
      startInkboxOutbound({
        ...input,
        scope: otherScope,
        phoneNumber: "+15550100022",
      })
    ).rejects.toThrow("reused");
    expect(
      await database.select().from(schema.inkboxMessageOutbox)
    ).toHaveLength(1);
  });
});
