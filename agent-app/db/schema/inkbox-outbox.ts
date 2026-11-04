import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth";

export const inkboxMessageOutbox = pgTable(
  "inkbox_message_outbox",
  {
    key: text("key").primaryKey(),
    idempotencyKey: text("idempotency_key").notNull(),
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    workspaceId: text("workspace_id").notNull(),
    identityDigest: text("identity_digest").notNull(),
    ownerDigest: text("owner_digest").notNull(),
    destinationDigest: text("destination_digest").notNull(),
    bodyDigest: text("body_digest").notNull(),
    intentDigest: text("intent_digest").notNull(),
    bodyCiphertext: text("body_ciphertext"),
    providerMessageId: text("provider_message_id"),
    status: text("status", {
      enum: [
        "started",
        "accepted",
        "delivered",
        "failed",
        "unknown",
        "cancelled",
      ],
    }).notNull(),
    attemptToken: uuid("attempt_token").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, precision: 3 })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      precision: 3,
    }).notNull(),
    errorCode: text("error_code"),
  },
  (table) => [
    uniqueIndex("inkbox_message_outbox_unresolved_destination")
      .on(table.destinationDigest)
      .where(sql`${table.status} IN ('started','unknown')`),
    index("inkbox_message_outbox_owner_idx").on(
      table.userId,
      table.workspaceId
    ),
    index("inkbox_message_outbox_retained_idx")
      .on(table.expiresAt)
      .where(sql`${table.bodyCiphertext} IS NOT NULL`),
    check(
      "inkbox_message_outbox_status_check",
      sql`${table.status} IN ('started','accepted','delivered','failed','unknown','cancelled')`
    ),
    check(
      "inkbox_message_outbox_digests_check",
      sql`${table.key} ~ '^[a-f0-9]{64}$' AND ${table.identityDigest} ~ '^[a-f0-9]{64}$' AND ${table.ownerDigest} ~ '^[a-f0-9]{64}$' AND ${table.destinationDigest} ~ '^[a-f0-9]{64}$' AND ${table.bodyDigest} ~ '^[a-f0-9]{64}$' AND ${table.intentDigest} ~ '^[a-f0-9]{64}$'`
    ),
  ]
);
