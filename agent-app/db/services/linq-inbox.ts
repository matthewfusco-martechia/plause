import { createHash, randomUUID } from "node:crypto";
import { and, asc, count, eq, gt, isNotNull, lte, or, sql } from "drizzle-orm";
import { db, linqWebhookInbox, user } from "@db";
import type { LinqInboundEnvelope } from "@shared/chat/linq-inbound";
import { env } from "@shared/environment";
import {
  decryptWorkspaceValue,
  encryptWorkspaceValue,
} from "./protected-values";

const inboxScope = {
  userId: "service:linq-inbox",
  workspaceId: "service:linq-inbox",
};
const leaseMs = 300_000;
const maximumRetainedBodies = 250;
export type LinqInboxRow = typeof linqWebhookInbox.$inferSelect;

export function linqDigest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export async function recordLinqInbound(
  body: string,
  envelope: LinqInboundEnvelope,
  userId: string,
  now = new Date()
): Promise<"recorded" | "duplicate" | "conflict" | "full"> {
  const eventKey = linqDigest(`linq:event:${envelope.event_id}`);
  const messageKey = linqDigest(
    `linq:message:${envelope.data.chat.id}:${envelope.data.id}`
  );
  const bodyDigest = linqDigest(body);
  const bodyCiphertext = await encryptWorkspaceValue(
    inboxScope,
    `linq-inbox:${eventKey}`,
    body
  );
  return db.transaction(async (transaction) => {
    await transaction.execute(sql`SELECT pg_advisory_xact_lock(827645012)`);
    const [existing] = await transaction
      .select()
      .from(linqWebhookInbox)
      .where(
        or(
          eq(linqWebhookInbox.eventKey, eventKey),
          eq(linqWebhookInbox.messageKey, messageKey)
        )
      )
      .limit(1);
    if (existing)
      return existing.bodyDigest === bodyDigest &&
        existing.messageKey === messageKey
        ? "duplicate"
        : "conflict";
    const [capacity] = await transaction
      .select({ value: count() })
      .from(linqWebhookInbox)
      .where(isNotNull(linqWebhookInbox.bodyCiphertext));
    if ((capacity?.value ?? 0) >= maximumRetainedBodies) return "full";
    await transaction.insert(linqWebhookInbox).values({
      eventKey,
      messageKey,
      conversationKey: linqDigest(envelope.data.chat.id),
      lineDigest: linqDigest(env.LINQ_PHONE_NUMBER ?? ""),
      bodyDigest,
      bodyCiphertext,
      userId,
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(now.getTime() + 86_400_000),
    });
    return "recorded";
  });
}

export async function claimLinqInbox(limit = 5, now = new Date()) {
  return db.transaction(async (transaction) => {
    await transaction.execute(sql`SELECT pg_advisory_xact_lock(827645012)`);
    await transaction
      .update(linqWebhookInbox)
      .set({
        status: "unknown",
        errorCode: "admission_unknown",
        updatedAt: now,
        leaseToken: null,
        leaseExpiresAt: null,
      })
      .where(
        and(
          eq(linqWebhookInbox.status, "dispatching"),
          lte(linqWebhookInbox.leaseExpiresAt, now)
        )
      );
    await transaction
      .update(linqWebhookInbox)
      .set({
        status: "pending",
        updatedAt: now,
        leaseToken: null,
        leaseExpiresAt: null,
      })
      .where(
        and(
          eq(linqWebhookInbox.status, "claimed"),
          lte(linqWebhookInbox.leaseExpiresAt, now)
        )
      );
    await transaction
      .update(linqWebhookInbox)
      .set({
        bodyCiphertext: null,
        status: sql`CASE WHEN ${linqWebhookInbox.status} = 'unknown' THEN 'unknown' ELSE 'cancelled' END`,
        errorCode: "inbox_expired",
        updatedAt: now,
        leaseToken: null,
        leaseExpiresAt: null,
      })
      .where(
        and(
          isNotNull(linqWebhookInbox.bodyCiphertext),
          lte(linqWebhookInbox.expiresAt, now)
        )
      );
    const ready = await transaction
      .select()
      .from(linqWebhookInbox)
      .where(
        and(
          eq(linqWebhookInbox.status, "pending"),
          isNotNull(linqWebhookInbox.bodyCiphertext),
          gt(linqWebhookInbox.expiresAt, now),
          sql`NOT EXISTS (SELECT 1 FROM ${linqWebhookInbox} AS active WHERE active.conversation_key = ${linqWebhookInbox.conversationKey} AND active.status IN ('claimed','dispatching'))`,
          sql`NOT EXISTS (SELECT 1 FROM ${linqWebhookInbox} AS earlier WHERE earlier.conversation_key = ${linqWebhookInbox.conversationKey} AND earlier.status = 'pending' AND (earlier.created_at < ${linqWebhookInbox.createdAt} OR (earlier.created_at = ${linqWebhookInbox.createdAt} AND earlier.event_key < ${linqWebhookInbox.eventKey})))`
        )
      )
      .orderBy(asc(linqWebhookInbox.createdAt))
      .limit(Math.min(25, Math.max(1, limit)))
      .for("update", { skipLocked: true });
    // Select one head per conversation before the batch limit, so a busy sender
    // cannot hide another tenant's ready work. The transaction lock fences peers.
    return Promise.all(
      ready.map(async (row) => {
        const leaseToken = randomUUID();
        const [claimed] = await transaction
          .update(linqWebhookInbox)
          .set({
            status: "claimed",
            leaseToken,
            leaseExpiresAt: new Date(now.getTime() + leaseMs),
            updatedAt: now,
          })
          .where(eq(linqWebhookInbox.eventKey, row.eventKey))
          .returning();
        if (!claimed) throw new Error("Linq inbox claim unavailable.");
        return claimed;
      })
    );
  });
}

export function decryptLinqInbox(row: LinqInboxRow) {
  if (!row.bodyCiphertext) throw new Error("Linq inbox payload unavailable.");
  return decryptWorkspaceValue(
    inboxScope,
    `linq-inbox:${row.eventKey}`,
    row.bodyCiphertext
  );
}

export async function markLinqInboxDispatched(
  eventKey: string,
  leaseToken: string,
  phoneNumber: string,
  now = new Date()
) {
  const [row] = await db
    .update(linqWebhookInbox)
    .set({ status: "dispatching", updatedAt: now })
    .where(
      and(
        eq(linqWebhookInbox.eventKey, eventKey),
        eq(linqWebhookInbox.leaseToken, leaseToken),
        eq(linqWebhookInbox.status, "claimed"),
        gt(linqWebhookInbox.leaseExpiresAt, now),
        gt(linqWebhookInbox.expiresAt, now),
        isNotNull(linqWebhookInbox.bodyCiphertext),
        sql`EXISTS (SELECT 1 FROM ${user} WHERE ${user.id} = ${linqWebhookInbox.userId} AND ${user.phoneNumberVerified} = true AND ${user.phoneNumber} = ${phoneNumber})`
      )
    )
    .returning({ eventKey: linqWebhookInbox.eventKey });
  return row !== undefined;
}

export async function readLinqRelayScope(
  eventKey: string,
  leaseToken: string,
  bodyDigest: string,
  phoneNumber: string,
  now = new Date()
) {
  const [row] = await db
    .select()
    .from(linqWebhookInbox)
    .where(
      and(
        eq(linqWebhookInbox.eventKey, eventKey),
        eq(linqWebhookInbox.leaseToken, leaseToken),
        eq(linqWebhookInbox.bodyDigest, bodyDigest),
        eq(linqWebhookInbox.status, "dispatching"),
        eq(
          linqWebhookInbox.lineDigest,
          linqDigest(env.LINQ_PHONE_NUMBER ?? "")
        ),
        gt(linqWebhookInbox.leaseExpiresAt, now),
        gt(linqWebhookInbox.expiresAt, now),
        isNotNull(linqWebhookInbox.bodyCiphertext),
        sql`EXISTS (SELECT 1 FROM ${user} WHERE ${user.id} = ${linqWebhookInbox.userId} AND ${user.phoneNumberVerified} = true AND ${user.phoneNumber} = ${phoneNumber})`
      )
    )
    .limit(1);
  return row;
}

export async function finishLinqInbox(
  eventKey: string,
  leaseToken: string,
  status: "accepted" | "ignored",
  now = new Date()
) {
  const [row] = await db
    .update(linqWebhookInbox)
    .set({
      status,
      bodyCiphertext: null,
      updatedAt: now,
      leaseToken: null,
      leaseExpiresAt: null,
    })
    .where(
      and(
        eq(linqWebhookInbox.eventKey, eventKey),
        eq(linqWebhookInbox.leaseToken, leaseToken),
        eq(linqWebhookInbox.status, "dispatching"),
        gt(linqWebhookInbox.leaseExpiresAt, now)
      )
    )
    .returning({ eventKey: linqWebhookInbox.eventKey });
  return row !== undefined;
}

export async function holdLinqInboxUnknown(
  eventKey: string,
  leaseToken: string,
  now = new Date()
) {
  await db
    .update(linqWebhookInbox)
    .set({
      status: "unknown",
      errorCode: "admission_unknown",
      updatedAt: now,
      leaseToken: null,
      leaseExpiresAt: null,
    })
    .where(
      and(
        eq(linqWebhookInbox.eventKey, eventKey),
        eq(linqWebhookInbox.leaseToken, leaseToken),
        eq(linqWebhookInbox.status, "dispatching")
      )
    );
}

export async function cancelUnsentLinqInbox(
  eventKey: string,
  leaseToken: string,
  now = new Date()
) {
  await db
    .update(linqWebhookInbox)
    .set({
      status: "cancelled",
      bodyCiphertext: null,
      errorCode: "binding_or_payload_invalid",
      updatedAt: now,
      leaseToken: null,
      leaseExpiresAt: null,
    })
    .where(
      and(
        eq(linqWebhookInbox.eventKey, eventKey),
        eq(linqWebhookInbox.leaseToken, leaseToken),
        eq(linqWebhookInbox.status, "claimed")
      )
    );
}
