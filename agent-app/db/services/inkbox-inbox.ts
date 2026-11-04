import { randomUUID } from "node:crypto";
import { and, asc, count, eq, gt, isNotNull, lte, or, sql } from "drizzle-orm";
import { db, inkboxWebhookInbox, user } from "@db";
import {
  inkboxDigest,
  parseInkboxInboundBody,
  type InkboxInboundEnvelope,
} from "@shared/messaging/inkbox";
import { isPhoneEnrollmentAllowed } from "@shared/identity/enrollment";
import { env } from "@shared/environment";
import {
  decryptWorkspaceValue,
  encryptWorkspaceValue,
} from "./protected-values";

const inboxScope = {
  userId: "service:inkbox-inbox",
  workspaceId: "service:inkbox-inbox",
};
const leaseMs = 300_000;
const maximumRetainedBodies = 250;
export type InkboxInboxRow = typeof inkboxWebhookInbox.$inferSelect;

export { inkboxDigest } from "@shared/messaging/inkbox";

export async function recordInkboxInbound(
  body: string,
  envelope: InkboxInboundEnvelope,
  userId: string,
  now = new Date()
): Promise<"recorded" | "duplicate" | "conflict" | "full"> {
  if (Buffer.byteLength(body, "utf8") > 262_144)
    throw new Error("Inkbox payload is too large.");
  const eventKey = inkboxDigest(`inkbox:event:${envelope.eventId}`);
  const messageKey = inkboxDigest(`inkbox:message:${envelope.messageId}`);
  const bodyDigest = inkboxDigest(body);
  const bodyCiphertext = await encryptWorkspaceValue(
    inboxScope,
    `inkbox-inbox:${eventKey}`,
    body
  );
  return db.transaction(async (transaction) => {
    await transaction.execute(sql`SELECT pg_advisory_xact_lock(827645013)`);
    const [existing] = await transaction
      .select()
      .from(inkboxWebhookInbox)
      .where(
        or(
          eq(inkboxWebhookInbox.eventKey, eventKey),
          eq(inkboxWebhookInbox.messageKey, messageKey)
        )
      )
      .limit(1);
    if (existing)
      return existing.bodyDigest === bodyDigest &&
        existing.messageKey === messageKey
        ? "duplicate"
        : "conflict";
    const parsed = parseInkboxInboundBody(
      body,
      env.INKBOX_IDENTITY_ID ?? "",
      now.getTime()
    );
    if (!parsed || JSON.stringify(parsed) !== JSON.stringify(envelope))
      throw new Error("Inkbox payload binding is invalid.");
    if (!isPhoneEnrollmentAllowed(envelope.senderPhoneNumber))
      throw new Error("Inkbox sender is not enrolled.");
    const [owner] = await transaction
      .select({ id: user.id })
      .from(user)
      .where(
        and(
          eq(user.id, userId),
          eq(user.phoneNumber, envelope.senderPhoneNumber),
          eq(user.phoneNumberVerified, true)
        )
      )
      .for("key share");
    if (!owner) throw new Error("Inkbox sender ownership is invalid.");
    const [capacity] = await transaction
      .select({ value: count() })
      .from(inkboxWebhookInbox)
      .where(isNotNull(inkboxWebhookInbox.bodyCiphertext));
    if ((capacity?.value ?? 0) >= maximumRetainedBodies) return "full";
    await transaction.insert(inkboxWebhookInbox).values({
      eventKey,
      messageKey,
      conversationKey: inkboxDigest(
        `${envelope.identityId}:${envelope.conversationId}:${envelope.assignmentId}`
      ),
      identityDigest: inkboxDigest(env.INKBOX_IDENTITY_ID ?? ""),
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

export async function claimInkboxInbox(limit = 5, now = new Date()) {
  return db.transaction(async (transaction) => {
    await transaction.execute(sql`SELECT pg_advisory_xact_lock(827645013)`);
    await transaction
      .update(inkboxWebhookInbox)
      .set({
        status: "unknown",
        errorCode: "admission_unknown",
        updatedAt: now,
        leaseToken: null,
        leaseExpiresAt: null,
      })
      .where(
        and(
          eq(inkboxWebhookInbox.status, "dispatching"),
          lte(inkboxWebhookInbox.leaseExpiresAt, now)
        )
      );
    await transaction
      .update(inkboxWebhookInbox)
      .set({
        status: "pending",
        updatedAt: now,
        leaseToken: null,
        leaseExpiresAt: null,
      })
      .where(
        and(
          eq(inkboxWebhookInbox.status, "claimed"),
          lte(inkboxWebhookInbox.leaseExpiresAt, now)
        )
      );
    await transaction
      .update(inkboxWebhookInbox)
      .set({
        bodyCiphertext: null,
        status: sql`CASE WHEN ${inkboxWebhookInbox.status} = 'unknown' THEN 'unknown' ELSE 'cancelled' END`,
        errorCode: "inbox_expired",
        updatedAt: now,
        leaseToken: null,
        leaseExpiresAt: null,
      })
      .where(
        and(
          isNotNull(inkboxWebhookInbox.bodyCiphertext),
          lte(inkboxWebhookInbox.expiresAt, now)
        )
      );
    const ready = await transaction
      .select()
      .from(inkboxWebhookInbox)
      .where(
        and(
          eq(inkboxWebhookInbox.status, "pending"),
          isNotNull(inkboxWebhookInbox.bodyCiphertext),
          gt(inkboxWebhookInbox.expiresAt, now),
          sql`NOT EXISTS (SELECT 1 FROM ${inkboxWebhookInbox} AS active WHERE active.conversation_key = ${inkboxWebhookInbox.conversationKey} AND active.status IN ('claimed','dispatching','unknown'))`,
          sql`NOT EXISTS (SELECT 1 FROM ${inkboxWebhookInbox} AS earlier WHERE earlier.conversation_key = ${inkboxWebhookInbox.conversationKey} AND earlier.status = 'pending' AND (earlier.created_at < ${inkboxWebhookInbox.createdAt} OR (earlier.created_at = ${inkboxWebhookInbox.createdAt} AND earlier.event_key < ${inkboxWebhookInbox.eventKey})))`
        )
      )
      .orderBy(asc(inkboxWebhookInbox.createdAt))
      .limit(Math.min(25, Math.max(1, limit)))
      .for("update", { skipLocked: true });
    // Select one head per conversation before the batch limit, so a busy sender
    // cannot hide another tenant's ready work. The transaction lock fences peers.
    return Promise.all(
      ready.map(async (row) => {
        const leaseToken = randomUUID();
        const [claimed] = await transaction
          .update(inkboxWebhookInbox)
          .set({
            status: "claimed",
            leaseToken,
            leaseExpiresAt: new Date(now.getTime() + leaseMs),
            updatedAt: now,
          })
          .where(eq(inkboxWebhookInbox.eventKey, row.eventKey))
          .returning();
        if (!claimed) throw new Error("Inkbox inbox claim unavailable.");
        return claimed;
      })
    );
  });
}

export function decryptInkboxInbox(row: InkboxInboxRow) {
  if (!row.bodyCiphertext) throw new Error("Inkbox inbox payload unavailable.");
  return decryptWorkspaceValue(
    inboxScope,
    `inkbox-inbox:${row.eventKey}`,
    row.bodyCiphertext
  );
}

export async function markInkboxInboxDispatched(
  eventKey: string,
  leaseToken: string,
  phoneNumber: string,
  now = new Date()
) {
  if (!isPhoneEnrollmentAllowed(phoneNumber) || !env.INKBOX_IDENTITY_ID)
    return false;
  const [row] = await db
    .update(inkboxWebhookInbox)
    .set({ status: "dispatching", updatedAt: now })
    .where(
      and(
        eq(inkboxWebhookInbox.eventKey, eventKey),
        eq(inkboxWebhookInbox.leaseToken, leaseToken),
        eq(inkboxWebhookInbox.status, "claimed"),
        eq(
          inkboxWebhookInbox.identityDigest,
          inkboxDigest(env.INKBOX_IDENTITY_ID)
        ),
        gt(inkboxWebhookInbox.leaseExpiresAt, now),
        gt(inkboxWebhookInbox.expiresAt, now),
        isNotNull(inkboxWebhookInbox.bodyCiphertext),
        sql`EXISTS (SELECT 1 FROM ${user} WHERE ${user.id} = ${inkboxWebhookInbox.userId} AND ${user.phoneNumberVerified} = true AND ${user.phoneNumber} = ${phoneNumber})`
      )
    )
    .returning({ eventKey: inkboxWebhookInbox.eventKey });
  return row !== undefined;
}

export async function readInkboxRelayScope(
  eventKey: string,
  leaseToken: string,
  bodyDigest: string,
  phoneNumber: string,
  now = new Date()
) {
  if (!isPhoneEnrollmentAllowed(phoneNumber) || !env.INKBOX_IDENTITY_ID)
    return undefined;
  const [row] = await db
    .select()
    .from(inkboxWebhookInbox)
    .where(
      and(
        eq(inkboxWebhookInbox.eventKey, eventKey),
        eq(inkboxWebhookInbox.leaseToken, leaseToken),
        eq(inkboxWebhookInbox.bodyDigest, bodyDigest),
        eq(inkboxWebhookInbox.status, "dispatching"),
        eq(
          inkboxWebhookInbox.identityDigest,
          inkboxDigest(env.INKBOX_IDENTITY_ID ?? "")
        ),
        gt(inkboxWebhookInbox.leaseExpiresAt, now),
        gt(inkboxWebhookInbox.expiresAt, now),
        isNotNull(inkboxWebhookInbox.bodyCiphertext),
        sql`EXISTS (SELECT 1 FROM ${user} WHERE ${user.id} = ${inkboxWebhookInbox.userId} AND ${user.phoneNumberVerified} = true AND ${user.phoneNumber} = ${phoneNumber})`
      )
    )
    .limit(1);
  return row;
}

export async function finishInkboxInbox(
  eventKey: string,
  leaseToken: string,
  status: "accepted" | "ignored",
  now = new Date()
) {
  const [row] = await db
    .update(inkboxWebhookInbox)
    .set({
      status,
      bodyCiphertext: null,
      updatedAt: now,
      leaseToken: null,
      leaseExpiresAt: null,
    })
    .where(
      and(
        eq(inkboxWebhookInbox.eventKey, eventKey),
        eq(inkboxWebhookInbox.leaseToken, leaseToken),
        eq(inkboxWebhookInbox.status, "dispatching"),
        gt(inkboxWebhookInbox.leaseExpiresAt, now)
      )
    )
    .returning({ eventKey: inkboxWebhookInbox.eventKey });
  return row !== undefined;
}

export async function holdInkboxInboxUnknown(
  eventKey: string,
  leaseToken: string,
  now = new Date()
) {
  await db
    .update(inkboxWebhookInbox)
    .set({
      status: "unknown",
      errorCode: "admission_unknown",
      updatedAt: now,
      leaseToken: null,
      leaseExpiresAt: null,
    })
    .where(
      and(
        eq(inkboxWebhookInbox.eventKey, eventKey),
        eq(inkboxWebhookInbox.leaseToken, leaseToken),
        eq(inkboxWebhookInbox.status, "dispatching")
      )
    );
}

export async function cancelUnsentInkboxInbox(
  eventKey: string,
  leaseToken: string,
  now = new Date()
) {
  await db
    .update(inkboxWebhookInbox)
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
        eq(inkboxWebhookInbox.eventKey, eventKey),
        eq(inkboxWebhookInbox.leaseToken, leaseToken),
        eq(inkboxWebhookInbox.status, "claimed")
      )
    );
}
