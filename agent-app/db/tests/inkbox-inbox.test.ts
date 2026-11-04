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
  claimInkboxInbox,
  decryptInkboxInbox,
  finishInkboxInbox,
  inkboxDigest,
  markInkboxInboxDispatched,
  readInkboxRelayScope,
  recordInkboxInbound,
} from "@db/services/inkbox-inbox";
import { parseInkboxInboundBody } from "@shared/messaging/inkbox";
import { createHash } from "node:crypto";
import type * as Environment from "@shared/environment";

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

const identityId = "10000000-0000-4000-8000-000000000001";
const client = new PGlite();
await client.waitReady;
const database = drizzle(client, { schema });
beforeAll(initializeDatabase);
beforeEach(async () => {
  // Keep the real schema and deletion trigger, but isolate every case's rows.
  // TRUNCATE also clears retained replay tombstones without firing that trigger.
  await client.exec('TRUNCATE TABLE inkbox_webhook_inbox, "user" CASCADE');
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

describe("durable Inkbox ingress", () => {
  it("allows the signed Inkbox dispatch path in the actual migrated replay-receipt constraint", async () => {
    const [receipt] = await database
      .insert(schema.internalRequestReceipts)
      .values({
        requestId: "80000000-0000-4000-8000-000000000001",
        signatureDigest: "a".repeat(64),
        path: "/internal/inkbox/dispatch",
        expiresAt: new Date(now.getTime() + 60_000),
      })
      .returning();
    expect(receipt?.path).toBe("/internal/inkbox/dispatch");
  });
  it("atomically deduplicates ingress, encrypts payloads and retains global tombstones after acceptance", async () => {
    const { body, envelope } = event();
    const results = await Promise.all([
      recordInkboxInbound(body, envelope, "user-a", now),
      recordInkboxInbound(body, envelope, "user-a", now),
    ]);
    expect(results.filter((result) => result === "recorded")).toHaveLength(1);
    expect(results.filter((result) => result === "duplicate")).toHaveLength(1);
    const [stored] = await database.select().from(schema.inkboxWebhookInbox);
    if (!stored) throw new Error("Inbox row missing");
    expect(stored.bodyCiphertext).not.toContain("private fixture text");
    expect(await decryptInkboxInbox(stored)).toBe(body);
    const [claim] = await claimInkboxInbox(5, now);
    if (!claim?.leaseToken) throw new Error("Claim missing");
    expect(
      await markInkboxInboxDispatched(
        claim.eventKey,
        claim.leaseToken,
        "+15550100011",
        now
      )
    ).toBe(true);
    expect(
      await finishInkboxInbox(claim.eventKey, claim.leaseToken, "accepted", now)
    ).toBe(true);
    expect(await recordInkboxInbound(body, envelope, "user-a", now)).toBe(
      "duplicate"
    );
    expect(await claimInkboxInbox(5, now)).toEqual([]);
    expect(
      await database.select().from(schema.inkboxWebhookInbox)
    ).toMatchObject([
      { status: "accepted", bodyCiphertext: null, leaseToken: null },
    ]);
  });

  it("rejects event or message reuse with changed content without overwriting the original", async () => {
    const original = event();
    await recordInkboxInbound(original.body, original.envelope, "user-a", now);
    const changed = event({ text: "changed private fixture" });
    expect(
      await recordInkboxInbound(changed.body, changed.envelope, "user-a", now)
    ).toBe("conflict");
    const newEvent = event({ eventId: "event-2" });
    expect(
      await recordInkboxInbound(newEvent.body, newEvent.envelope, "user-a", now)
    ).toBe("conflict");
    const [stored] = await database.select().from(schema.inkboxWebhookInbox);
    if (!stored) throw new Error("Inbox row missing");
    expect(await decryptInkboxInbox(stored)).toBe(original.body);
  });

  it("recovers only unsent claims and holds uncertain dispatches across restarts", async () => {
    const { body, envelope } = event();
    await recordInkboxInbound(body, envelope, "user-a", now);
    const [first] = await claimInkboxInbox(5, now);
    if (!first?.leaseToken) throw new Error("First claim missing");
    const recoveredAt = new Date(now.getTime() + 300_001);
    const [recovered] = await claimInkboxInbox(5, recoveredAt);
    if (!recovered?.leaseToken) throw new Error("Recovered claim missing");
    expect(recovered.leaseToken).not.toBe(first.leaseToken);
    expect(
      await markInkboxInboxDispatched(
        first.eventKey,
        first.leaseToken,
        "+15550100011",
        recoveredAt
      )
    ).toBe(false);
    expect(
      await markInkboxInboxDispatched(
        recovered.eventKey,
        recovered.leaseToken,
        "+15550100011",
        recoveredAt
      )
    ).toBe(true);
    expect(
      await claimInkboxInbox(5, new Date(recoveredAt.getTime() + 300_001))
    ).toEqual([]);
    expect(
      await database.select().from(schema.inkboxWebhookInbox)
    ).toMatchObject([{ status: "unknown", errorCode: "admission_unknown" }]);
    expect(
      await recordInkboxInbound(body, envelope, "user-a", recoveredAt)
    ).toBe("duplicate");
    expect(
      await claimInkboxInbox(5, new Date(now.getTime() + 86_400_001))
    ).toEqual([]);
    expect(
      await database.select().from(schema.inkboxWebhookInbox)
    ).toMatchObject([{ status: "unknown", bodyCiphertext: null }]);
  });

  it("requires the exact live lease, payload and verified-phone owner at relay time", async () => {
    const { body, envelope } = event();
    await recordInkboxInbound(body, envelope, "user-a", now);
    const [claim] = await claimInkboxInbox(5, now);
    if (!claim?.leaseToken) throw new Error("Claim missing");
    expect(
      await markInkboxInboxDispatched(
        claim.eventKey,
        claim.leaseToken,
        "+15550100999",
        now
      )
    ).toBe(false);
    expect(
      await markInkboxInboxDispatched(
        claim.eventKey,
        claim.leaseToken,
        "+15550100011",
        now
      )
    ).toBe(true);
    expect(
      await readInkboxRelayScope(
        claim.eventKey,
        claim.leaseToken,
        inkboxDigest(body),
        "+15550100011",
        now
      )
    ).toMatchObject({ userId: "user-a" });
    expect(
      await readInkboxRelayScope(
        claim.eventKey,
        "00000000-0000-4000-8000-000000000099",
        inkboxDigest(body),
        "+15550100011",
        now
      )
    ).toBeUndefined();
    expect(
      await readInkboxRelayScope(
        claim.eventKey,
        claim.leaseToken,
        inkboxDigest(`${body} `),
        "+15550100011",
        now
      )
    ).toBeUndefined();
    await database
      .update(schema.user)
      .set({ phoneNumberVerified: false })
      .where(eq(schema.user.id, "user-a"));
    expect(
      await readInkboxRelayScope(
        claim.eventKey,
        claim.leaseToken,
        inkboxDigest(body),
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
        recordInkboxInbound(entry.body, entry.envelope, "user-a", now)
      ),
      recordInkboxInbound(
        b.body,
        b.envelope,
        "user-b",
        new Date(now.getTime() + 1)
      ),
    ]);
    const claims = await claimInkboxInbox(5, new Date(now.getTime() + 2));
    expect(claims).toHaveLength(2);
    expect(new Set(claims.map((row) => row.conversationKey)).size).toBe(2);
    expect(await claimInkboxInbox(5, now)).toEqual([]);
  });

  it("purges deleted-user payloads immediately and keeps replay tombstones", async () => {
    const { body, envelope } = event();
    await recordInkboxInbound(body, envelope, "user-a", now);
    const [claim] = await claimInkboxInbox(5, now);
    if (!claim?.leaseToken) throw new Error("Claim missing");
    await markInkboxInboxDispatched(
      claim.eventKey,
      claim.leaseToken,
      "+15550100011",
      now
    );
    await database.delete(schema.user).where(eq(schema.user.id, "user-a"));
    expect(
      await database.select().from(schema.inkboxWebhookInbox)
    ).toMatchObject([
      {
        status: "unknown",
        bodyCiphertext: null,
        userId: null,
        leaseToken: null,
        errorCode: "user_deleted",
      },
    ]);
    expect(
      await finishInkboxInbox(claim.eventKey, claim.leaseToken, "accepted", now)
    ).toBe(false);
    expect(await claimInkboxInbox(5, now)).toEqual([]);
    expect(await recordInkboxInbound(body, envelope, "user-b", now)).toBe(
      "duplicate"
    );
  });

  it("holds later inputs behind uncertain admission without blocking a new assignment", async () => {
    const first = event();
    await recordInkboxInbound(first.body, first.envelope, "user-a", now);
    const [claim] = await claimInkboxInbox(5, now);
    if (!claim?.leaseToken) throw new Error("Missing claim");
    await markInkboxInboxDispatched(
      claim.eventKey,
      claim.leaseToken,
      "+15550100011",
      now
    );
    const later = new Date(now.getTime() + 300_001);
    await claimInkboxInbox(5, later);
    const second = event({
      eventId: "later-event",
      messageId: "later-message",
    });
    const reconnect = event({
      eventId: "reconnect-event",
      messageId: "reconnect-message",
      assignmentId: "90000000-0000-4000-8000-000000000001",
    });
    await recordInkboxInbound(second.body, second.envelope, "user-a", now);
    await recordInkboxInbound(
      reconnect.body,
      reconnect.envelope,
      "user-a",
      now
    );
    const claims = await claimInkboxInbox(5, later);
    expect(claims).toHaveLength(1);
    expect(claims[0]?.eventKey).toBe(
      inkboxDigest(`inkbox:event:${reconnect.envelope.eventId}`)
    );
  });

  it("rejects mismatched normalized payloads and a different verified account", async () => {
    const entry = event();
    await expect(
      recordInkboxInbound(
        entry.body,
        {
          ...entry.envelope,
          conversationId: "90000000-0000-4000-8000-000000000001",
        },
        "user-a",
        now
      )
    ).rejects.toThrow("binding");
    await expect(
      recordInkboxInbound(entry.body, entry.envelope, "user-b", now)
    ).rejects.toThrow("ownership");
    expect(await database.select().from(schema.inkboxWebhookInbox)).toEqual([]);
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

function uuid(value: string) {
  const hex = createHash("sha256").update(value).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
function event(
  options: {
    eventId?: string;
    messageId?: string;
    chatId?: string;
    text?: string;
    sender?: string;
    assignmentId?: string;
  } = {}
) {
  const value = {
    id: `evt_${uuid(options.eventId ?? "event-1")}`,
    event_type: "imessage.received",
    timestamp: now.toISOString(),
    data: {
      message: {
        id: uuid(options.messageId ?? "message-1"),
        conversation_id: uuid(options.chatId ?? "chat-a"),
        assignment_id:
          options.assignmentId ?? "10000000-0000-4000-8000-000000000002",
        direction: "inbound",
        remote_number: options.sender ?? "+15550100011",
        sender_number: null,
        is_group: false,
        content: options.text ?? "private fixture text",
        media: null,
        message_type: "message",
        service: "imessage",
        status: "received",
        reply_to_message_id: null,
        created_at: now.toISOString(),
        updated_at: now.toISOString(),
      },
      reaction: null,
      contacts: [],
      agent_identities: [],
    },
  };
  const body = JSON.stringify(value);
  const envelope = parseInkboxInboundBody(body, identityId, now.getTime());
  if (!envelope) throw new Error("Invalid Inkbox fixture");
  return { body, envelope };
}
