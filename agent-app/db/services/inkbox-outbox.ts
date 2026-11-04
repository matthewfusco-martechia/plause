import { randomUUID } from "node:crypto";
import { and, eq, gt, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { db, inkboxMessageOutbox, user } from "@db";
import { env } from "@shared/environment";
import { inkboxDigest } from "@shared/messaging/inkbox";
import {
  accessScopeForUser,
  type AccessScope,
} from "@shared/identity/access-scope";
import { isPhoneEnrollmentAllowed } from "@shared/identity/enrollment";
import {
  encryptWorkspaceValue,
  decryptWorkspaceValue,
} from "./protected-values";

export type InkboxOutboxRow = typeof inkboxMessageOutbox.$inferSelect;
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
const retentionMs = 7 * 86_400_000;
const keySchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[\x20-\x7e]+$/u)
  .refine((key) => key.trim().length > 0);
const providerMessageIdSchema = z.uuid();

function ownerId(scope: AccessScope) {
  if (
    !scope.userId.startsWith("better-auth:") ||
    accessScopeForUser(scope.userId).workspaceId !== scope.workspaceId
  )
    throw new Error("Inkbox delivery requires the enrolled workspace owner.");
  return scope.userId.slice("better-auth:".length);
}

function currentIdentity() {
  return z.uuid().parse(env.INKBOX_IDENTITY_ID);
}

function outboxKey(identityId: string, idempotencyKey: string) {
  return inkboxDigest(
    JSON.stringify(["inkbox:send", identityId, keySchema.parse(idempotencyKey)])
  );
}

function destinationKey(
  identityId: string,
  conversationId: string,
  assignmentId: string,
  phoneNumber: string
) {
  return inkboxDigest(
    JSON.stringify([
      identityId,
      z.uuid().parse(conversationId),
      z.uuid().parse(assignmentId),
      phoneNumber,
    ])
  );
}

async function lockDestination(
  transaction: Transaction,
  destinationDigest: string
) {
  await transaction.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`inkbox:destination:${destinationDigest}`}, 0))`
  );
}

async function assertNoUnresolvedDestination(
  transaction: Transaction,
  destinationDigest: string
) {
  const [held] = await transaction
    .select({ key: inkboxMessageOutbox.key })
    .from(inkboxMessageOutbox)
    .where(
      and(
        eq(inkboxMessageOutbox.destinationDigest, destinationDigest),
        inArray(inkboxMessageOutbox.status, ["started", "unknown"])
      )
    )
    .limit(1);
  if (held)
    throw new Error("Inkbox delivery is held for an unresolved prior send.");
}

/** Read-only pre-upload guard. It grants no POST permission; the atomic start must still succeed. */
export async function assertInkboxDestinationAvailable(
  scope: AccessScope,
  phoneNumber: string,
  conversationId: string,
  assignmentId: string,
  idempotencyKey: string
) {
  const identityId = currentIdentity();
  const destinationDigest = destinationKey(
    identityId,
    conversationId,
    assignmentId,
    phoneNumber
  );
  const key = outboxKey(identityId, idempotencyKey);
  await db.transaction(async (transaction) => {
    await lockOwner(transaction, scope, phoneNumber);
    await lockDestination(transaction, destinationDigest);
    const [existing] = await transaction
      .select({ key: inkboxMessageOutbox.key })
      .from(inkboxMessageOutbox)
      .where(eq(inkboxMessageOutbox.key, key));
    if (existing)
      throw new Error(
        "Inkbox request is already recorded; reconcile its original key."
      );
    await assertNoUnresolvedDestination(transaction, destinationDigest);
  });
}

async function lockOwner(
  transaction: Transaction,
  scope: AccessScope,
  phoneNumber?: string
) {
  const id = ownerId(scope);
  const [owner] = await transaction
    .select({
      phoneNumber: user.phoneNumber,
      verified: user.phoneNumberVerified,
    })
    .from(user)
    .where(eq(user.id, id))
    .for("key share");
  if (
    !owner?.verified ||
    !owner.phoneNumber ||
    !isPhoneEnrollmentAllowed(owner.phoneNumber) ||
    (phoneNumber !== undefined && owner.phoneNumber !== phoneNumber)
  )
    throw new Error(
      "Inkbox delivery requires the current verified phone owner."
    );
  return { id, phoneNumber: owner.phoneNumber };
}

function binding(scope: AccessScope, phoneNumber: string, identityId: string) {
  return {
    userId: ownerId(scope),
    workspaceId: scope.workspaceId,
    identityDigest: inkboxDigest(identityId),
    ownerDigest: inkboxDigest(
      JSON.stringify([scope.userId, scope.workspaceId, phoneNumber])
    ),
  };
}

function matchingOwner(
  scope: AccessScope,
  phoneNumber: string,
  identityId: string
) {
  const expected = binding(scope, phoneNumber, identityId);
  return and(
    eq(inkboxMessageOutbox.userId, expected.userId),
    eq(inkboxMessageOutbox.workspaceId, expected.workspaceId),
    eq(inkboxMessageOutbox.identityDigest, expected.identityDigest),
    eq(inkboxMessageOutbox.ownerDigest, expected.ownerDigest)
  );
}

/** A successful fresh claim commits before its caller is permitted to POST. */
export async function startInkboxOutbound(
  input: {
    readonly scope: AccessScope;
    readonly idempotencyKey: string;
    readonly body: string;
    readonly intentDigest: string;
    readonly phoneNumber: string;
    readonly conversationId: string;
    readonly assignmentId: string;
  },
  now = new Date()
) {
  const identityId = currentIdentity();
  keySchema.parse(input.idempotencyKey);
  z.string()
    .regex(/^[a-f0-9]{64}$/u)
    .parse(input.intentDigest);
  if (Buffer.byteLength(input.body, "utf8") > 262_144)
    throw new Error("Inkbox request is too large.");
  const request = z
    .strictObject({
      conversation_id: z.uuid(),
      text: z.string().min(1).max(18_995).optional(),
      media_urls: z.array(z.url()).length(1).optional(),
      reply_to_message_id: z.uuid().optional(),
      plain_reply_fallback: z.boolean().optional(),
    })
    .parse(JSON.parse(input.body));
  if (
    request.conversation_id !== input.conversationId ||
    (!request.text && !request.media_urls)
  )
    throw new Error("Inkbox request destination or content is invalid.");
  const key = outboxKey(identityId, input.idempotencyKey);
  const bodyDigest = inkboxDigest(input.body);
  const destinationDigest = destinationKey(
    identityId,
    input.conversationId,
    input.assignmentId,
    input.phoneNumber
  );
  const expected = binding(input.scope, input.phoneNumber, identityId);
  const bodyCiphertext = await encryptWorkspaceValue(
    input.scope,
    `inkbox-outbox:${key}`,
    input.body
  );
  return db.transaction(async (transaction) => {
    await lockOwner(transaction, input.scope, input.phoneNumber);
    await lockDestination(transaction, destinationDigest);
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`
    );
    const [existing] = await transaction
      .select()
      .from(inkboxMessageOutbox)
      .where(eq(inkboxMessageOutbox.key, key));
    if (existing) {
      if (
        existing.userId !== expected.userId ||
        existing.workspaceId !== expected.workspaceId ||
        existing.ownerDigest !== expected.ownerDigest ||
        existing.identityDigest !== expected.identityDigest ||
        existing.bodyDigest !== bodyDigest ||
        existing.destinationDigest !== destinationDigest
      )
        throw new Error(
          "Inkbox idempotency key was reused with different input or ownership."
        );
      if (existing.intentDigest !== input.intentDigest)
        throw new Error(
          "Inkbox idempotency key was reused with a different logical intent."
        );
      return { kind: "existing" as const, row: existing };
    }
    await assertNoUnresolvedDestination(transaction, destinationDigest);
    const [row] = await transaction
      .insert(inkboxMessageOutbox)
      .values({
        key,
        idempotencyKey: input.idempotencyKey,
        ...expected,
        destinationDigest,
        bodyDigest,
        bodyCiphertext,
        intentDigest: input.intentDigest,
        status: "started",
        attemptToken: randomUUID(),
        createdAt: now,
        updatedAt: now,
        expiresAt: new Date(now.getTime() + retentionMs),
      })
      .returning();
    if (!row) throw new Error("Inkbox outbox claim is unavailable.");
    return { kind: "started" as const, row };
  });
}

export async function readInkboxOutbound(
  scope: AccessScope,
  idempotencyKey: string
) {
  const identityId = currentIdentity();
  return db.transaction(async (transaction) => {
    const owner = await lockOwner(transaction, scope);
    const [row] = await transaction
      .select()
      .from(inkboxMessageOutbox)
      .where(
        and(
          eq(inkboxMessageOutbox.key, outboxKey(identityId, idempotencyKey)),
          matchingOwner(scope, owner.phoneNumber, identityId)
        )
      );
    return row;
  });
}

export async function decryptInkboxOutbound(
  scope: AccessScope,
  idempotencyKey: string
) {
  const row = await readInkboxOutbound(scope, idempotencyKey);
  if (!row?.bodyCiphertext || row.expiresAt.getTime() <= Date.now())
    throw new Error("Inkbox request payload is unavailable.");
  const body = await decryptWorkspaceValue(
    scope,
    `inkbox-outbox:${row.key}`,
    row.bodyCiphertext
  );
  const current = await readInkboxOutbound(scope, idempotencyKey);
  if (
    !current?.bodyCiphertext ||
    current.bodyCiphertext !== row.bodyCiphertext ||
    inkboxDigest(body) !== row.bodyDigest
  )
    throw new Error("Inkbox request ownership changed.");
  return body;
}

export async function assertInkboxOutboundDispatch(
  scope: AccessScope,
  idempotencyKey: string,
  attemptToken: string,
  bodyDigest: string,
  phoneNumber: string,
  now = new Date()
) {
  const identityId = currentIdentity();
  return db.transaction(async (transaction) => {
    await lockOwner(transaction, scope, phoneNumber);
    const [row] = await transaction
      .select({ key: inkboxMessageOutbox.key })
      .from(inkboxMessageOutbox)
      .where(
        and(
          eq(inkboxMessageOutbox.key, outboxKey(identityId, idempotencyKey)),
          matchingOwner(scope, phoneNumber, identityId),
          eq(inkboxMessageOutbox.attemptToken, attemptToken),
          eq(inkboxMessageOutbox.bodyDigest, bodyDigest),
          eq(inkboxMessageOutbox.status, "started"),
          isNotNull(inkboxMessageOutbox.bodyCiphertext),
          gt(inkboxMessageOutbox.expiresAt, now)
        )
      );
    return row !== undefined;
  });
}

export async function holdInkboxOutboundUnknown(
  scope: AccessScope,
  idempotencyKey: string,
  attemptToken: string,
  now = new Date()
) {
  // This transition deliberately also works after owner deletion; it cannot restore content.
  await db
    .update(inkboxMessageOutbox)
    .set({ status: "unknown", errorCode: "send_unknown", updatedAt: now })
    .where(
      and(
        eq(
          inkboxMessageOutbox.key,
          outboxKey(currentIdentity(), idempotencyKey)
        ),
        eq(inkboxMessageOutbox.workspaceId, scope.workspaceId),
        eq(inkboxMessageOutbox.attemptToken, attemptToken),
        eq(inkboxMessageOutbox.status, "started")
      )
    );
}

export async function finishInkboxOutbound(
  scope: AccessScope,
  idempotencyKey: string,
  attemptToken: string,
  providerMessageId: string,
  status: "accepted" | "delivered" | "failed" = "accepted",
  now = new Date()
) {
  return settle(
    scope,
    idempotencyKey,
    providerMessageId,
    status,
    { attemptToken },
    now
  );
}

/** Only a read-only provider lookup or authenticated lifecycle receipt may call this. */
export async function reconcileInkboxOutbound(
  scope: AccessScope,
  idempotencyKey: string,
  bodyDigest: string,
  providerMessageId: string,
  status: "accepted" | "delivered" | "failed",
  now = new Date()
) {
  return settle(
    scope,
    idempotencyKey,
    providerMessageId,
    status,
    { bodyDigest },
    now
  );
}

async function settle(
  scope: AccessScope,
  idempotencyKey: string,
  providerMessageId: string,
  status: "accepted" | "delivered" | "failed",
  proof: { attemptToken: string } | { bodyDigest: string },
  now: Date
) {
  providerMessageIdSchema.parse(providerMessageId);
  const identityId = currentIdentity();
  return db.transaction(async (transaction) => {
    const owner = await lockOwner(transaction, scope);
    const [row] = await transaction
      .update(inkboxMessageOutbox)
      .set({
        status,
        providerMessageId,
        updatedAt: now,
        errorCode: status === "failed" ? "provider_failed" : null,
      })
      .where(
        and(
          eq(inkboxMessageOutbox.key, outboxKey(identityId, idempotencyKey)),
          matchingOwner(scope, owner.phoneNumber, identityId),
          "attemptToken" in proof
            ? eq(inkboxMessageOutbox.attemptToken, proof.attemptToken)
            : eq(inkboxMessageOutbox.bodyDigest, proof.bodyDigest),
          inArray(
            inkboxMessageOutbox.status,
            status === "accepted"
              ? ["started", "unknown", "accepted"]
              : ["started", "unknown", "accepted", status]
          ),
          sql`(${inkboxMessageOutbox.providerMessageId} IS NULL OR ${inkboxMessageOutbox.providerMessageId} = ${providerMessageId})`
        )
      )
      .returning({ key: inkboxMessageOutbox.key });
    return row !== undefined;
  });
}

export async function expireInkboxOutboundPayloads(now = new Date()) {
  // Expiration never resets a key or authorizes another POST, even beyond the provider's seven-day window.
  return db
    .update(inkboxMessageOutbox)
    .set({
      bodyCiphertext: null,
      updatedAt: now,
      status: sql`CASE WHEN ${inkboxMessageOutbox.status} = 'started' THEN 'unknown' ELSE ${inkboxMessageOutbox.status} END`,
    })
    .where(
      and(
        lte(inkboxMessageOutbox.expiresAt, now),
        isNotNull(inkboxMessageOutbox.bodyCiphertext)
      )
    )
    .returning({ key: inkboxMessageOutbox.key });
}
