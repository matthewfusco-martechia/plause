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
import {
  claimLinqInbox,
  decryptLinqInbox,
  finishLinqInbox,
  linqDigest,
  markLinqInboxDispatched,
  readLinqRelayScope,
  recordLinqInbound,
} from "@db/services/linq-inbox";
import { linqInboundEnvelopeSchema } from "@shared/chat/linq-inbound";
import type * as Environment from "@shared/environment";

vi.mock("@shared/environment", async (original) => {
  const loaded = await original<typeof Environment>();
  return {
    ...loaded,
    env: { ...loaded.env, LINQ_PHONE_NUMBER: "+15550100000" },
  };
});

const client = new PGlite();
await client.waitReady;
const database = drizzle(client, { schema });
beforeAll(initializeDatabase);
beforeEach(async () => {
  // Keep the real schema and deletion trigger, but isolate every case's rows.
  // TRUNCATE also clears retained replay tombstones without firing that trigger.
  await client.exec('TRUNCATE TABLE linq_webhook_inbox, "user" CASCADE');
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
  // SAFETY: The embedded driver runs the real schema/migrations and transactional query surface.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Only the driver changes for this fixture.
  vi.spyOn(Database, "db", "get").mockReturnValue(database as never);
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => client.close());
const now = new Date("2026-11-02T12:00:00Z");

describe("durable Linq ingress", () => {
  it("atomically deduplicates ingress, encrypts payloads and retains global tombstones after acceptance", async () => {
    const { body, envelope } = event();
    const results = await Promise.all([
      recordLinqInbound(body, envelope, "user-a", now),
      recordLinqInbound(body, envelope, "user-a", now),
    ]);
    expect(results.filter((result) => result === "recorded")).toHaveLength(1);
    expect(results.filter((result) => result === "duplicate")).toHaveLength(1);
    const [stored] = await database.select().from(schema.linqWebhookInbox);
    if (!stored) throw new Error("Inbox row missing");
    expect(stored.bodyCiphertext).not.toContain("private fixture text");
    expect(await decryptLinqInbox(stored)).toBe(body);
    const [claim] = await claimLinqInbox(5, now);
    if (!claim?.leaseToken) throw new Error("Claim missing");
    expect(
      await markLinqInboxDispatched(
        claim.eventKey,
        claim.leaseToken,
        "+15550100011",
        now
      )
    ).toBe(true);
    expect(
      await finishLinqInbox(claim.eventKey, claim.leaseToken, "accepted", now)
    ).toBe(true);
    expect(await recordLinqInbound(body, envelope, "user-a", now)).toBe(
      "duplicate"
    );
    expect(await claimLinqInbox(5, now)).toEqual([]);
    expect(await database.select().from(schema.linqWebhookInbox)).toMatchObject(
      [{ status: "accepted", bodyCiphertext: null, leaseToken: null }]
    );
  });

  it("rejects event or message reuse with changed content without overwriting the original", async () => {
    const original = event();
    await recordLinqInbound(original.body, original.envelope, "user-a", now);
    const changed = event({ text: "changed private fixture" });
    expect(
      await recordLinqInbound(changed.body, changed.envelope, "user-a", now)
    ).toBe("conflict");
    const newEvent = event({ eventId: "event-2" });
    expect(
      await recordLinqInbound(newEvent.body, newEvent.envelope, "user-a", now)
    ).toBe("conflict");
    const [stored] = await database.select().from(schema.linqWebhookInbox);
    if (!stored) throw new Error("Inbox row missing");
    expect(await decryptLinqInbox(stored)).toBe(original.body);
  });

  it("recovers only unsent claims and holds uncertain dispatches across restarts", async () => {
    const { body, envelope } = event();
    await recordLinqInbound(body, envelope, "user-a", now);
    const [first] = await claimLinqInbox(5, now);
    if (!first?.leaseToken) throw new Error("First claim missing");
    const recoveredAt = new Date(now.getTime() + 300_001);
    const [recovered] = await claimLinqInbox(5, recoveredAt);
    if (!recovered?.leaseToken) throw new Error("Recovered claim missing");
    expect(recovered.leaseToken).not.toBe(first.leaseToken);
    expect(
      await markLinqInboxDispatched(
        first.eventKey,
        first.leaseToken,
        "+15550100011",
        recoveredAt
      )
    ).toBe(false);
    expect(
      await markLinqInboxDispatched(
        recovered.eventKey,
        recovered.leaseToken,
        "+15550100011",
        recoveredAt
      )
    ).toBe(true);
    expect(
      await claimLinqInbox(5, new Date(recoveredAt.getTime() + 300_001))
    ).toEqual([]);
    expect(await database.select().from(schema.linqWebhookInbox)).toMatchObject(
      [{ status: "unknown", errorCode: "admission_unknown" }]
    );
    expect(await recordLinqInbound(body, envelope, "user-a", recoveredAt)).toBe(
      "duplicate"
    );
    expect(
      await claimLinqInbox(5, new Date(now.getTime() + 86_400_001))
    ).toEqual([]);
    expect(await database.select().from(schema.linqWebhookInbox)).toMatchObject(
      [{ status: "unknown", bodyCiphertext: null }]
    );
  });

  it("requires the exact live lease, payload and verified-phone owner at relay time", async () => {
    const { body, envelope } = event();
    await recordLinqInbound(body, envelope, "user-a", now);
    const [claim] = await claimLinqInbox(5, now);
    if (!claim?.leaseToken) throw new Error("Claim missing");
    expect(
      await markLinqInboxDispatched(
        claim.eventKey,
        claim.leaseToken,
        "+15550100999",
        now
      )
    ).toBe(false);
    expect(
      await markLinqInboxDispatched(
        claim.eventKey,
        claim.leaseToken,
        "+15550100011",
        now
      )
    ).toBe(true);
    expect(
      await readLinqRelayScope(
        claim.eventKey,
        claim.leaseToken,
        linqDigest(body),
        "+15550100011",
        now
      )
    ).toMatchObject({ userId: "user-a" });
    expect(
      await readLinqRelayScope(
        claim.eventKey,
        "00000000-0000-4000-8000-000000000099",
        linqDigest(body),
        "+15550100011",
        now
      )
    ).toBeUndefined();
    expect(
      await readLinqRelayScope(
        claim.eventKey,
        claim.leaseToken,
        linqDigest(`${body} `),
        "+15550100011",
        now
      )
    ).toBeUndefined();
    await database
      .update(schema.user)
      .set({ phoneNumberVerified: false })
      .where(eq(schema.user.id, "user-a"));
    expect(
      await readLinqRelayScope(
        claim.eventKey,
        claim.leaseToken,
        linqDigest(body),
        "+15550100011",
        now
      )
    ).toBeUndefined();
  });

  it("serializes a conversation while allowing another user's inbox to progress", async () => {
    const backlog = Array.from({ length: 6 }, (_, index) =>
      event({
        eventId: `event-a-${String(index)}`,
        messageId: `message-a-${String(index)}`,
      })
    );
    const b = event({
      eventId: "event-b",
      messageId: "message-b",
      chatId: "chat-b",
      sender: "+15550100022",
    });
    await Promise.all([
      ...backlog.map((entry) =>
        recordLinqInbound(entry.body, entry.envelope, "user-a", now)
      ),
      recordLinqInbound(
        b.body,
        b.envelope,
        "user-b",
        new Date(now.getTime() + 1)
      ),
    ]);
    const claims = await claimLinqInbox(5, new Date(now.getTime() + 2));
    expect(claims).toHaveLength(2);
    expect(new Set(claims.map((row) => row.conversationKey)).size).toBe(2);
    expect(await claimLinqInbox(5, now)).toEqual([]);
  });

  it("purges deleted-user payloads immediately and keeps replay tombstones", async () => {
    const { body, envelope } = event();
    await recordLinqInbound(body, envelope, "user-a", now);
    const [claim] = await claimLinqInbox(5, now);
    if (!claim?.leaseToken) throw new Error("Claim missing");
    await markLinqInboxDispatched(
      claim.eventKey,
      claim.leaseToken,
      "+15550100011",
      now
    );
    await database.delete(schema.user).where(eq(schema.user.id, "user-a"));
    expect(await database.select().from(schema.linqWebhookInbox)).toMatchObject(
      [
        {
          status: "unknown",
          bodyCiphertext: null,
          userId: null,
          leaseToken: null,
          errorCode: "user_deleted",
        },
      ]
    );
    expect(
      await finishLinqInbox(claim.eventKey, claim.leaseToken, "accepted", now)
    ).toBe(false);
    expect(await claimLinqInbox(5, now)).toEqual([]);
    expect(await recordLinqInbound(body, envelope, "user-b", now)).toBe(
      "duplicate"
    );
  });
});

async function initializeDatabase() {
  const directory = new URL("../migrations/", import.meta.url);
  const names = (await readdir(directory))
    .filter((name) => name.endsWith(".sql"))
    .toSorted();
  const migrations = await Promise.all(
    names.map((name) => readFile(new URL(name, directory), "utf8"))
  );
  await client.exec(migrations.join("\n"));
}

function event(
  options: {
    eventId?: string;
    messageId?: string;
    chatId?: string;
    text?: string;
    sender?: string;
  } = {}
) {
  const value = {
    webhook_version: "2026-02-03",
    event_type: "message.received",
    event_id: options.eventId ?? "event-1",
    data: {
      id: options.messageId ?? "message-1",
      direction: "inbound",
      sender_handle: { handle: options.sender ?? "+15550100011", is_me: false },
      chat: {
        id: options.chatId ?? "chat-a",
        is_group: false,
        owner_handle: { handle: "+15550100000", is_me: true },
      },
      parts: [{ type: "text", value: options.text ?? "private fixture text" }],
    },
  };
  return {
    body: JSON.stringify(value),
    envelope: linqInboundEnvelopeSchema.parse(value),
  };
}
