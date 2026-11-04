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

export const inkboxWebhookInbox = pgTable(
  "inkbox_webhook_inbox",
  {
    eventKey: text("event_key").primaryKey(),
    messageKey: text("message_key").notNull(),
    conversationKey: text("conversation_key").notNull(),
    identityDigest: text("identity_digest").notNull(),
    bodyDigest: text("body_digest").notNull(),
    bodyCiphertext: text("body_ciphertext"),
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    status: text("status", {
      enum: [
        "pending",
        "claimed",
        "dispatching",
        "accepted",
        "ignored",
        "unknown",
        "cancelled",
      ],
    })
      .notNull()
      .default("pending"),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    }),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    }).notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
    errorCode: text("error_code"),
  },
  (table) => [
    uniqueIndex("inkbox_webhook_inbox_message_uidx").on(table.messageKey),
    index("inkbox_webhook_inbox_pending_idx").on(table.status, table.createdAt),
    index("inkbox_webhook_inbox_conversation_idx").on(
      table.conversationKey,
      table.status
    ),
    index("inkbox_webhook_inbox_user_idx").on(table.userId),
    index("inkbox_webhook_inbox_retained_idx")
      .on(table.expiresAt)
      .where(sql`${table.bodyCiphertext} IS NOT NULL`),
    check(
      "inkbox_webhook_inbox_status_check",
      sql`${table.status} IN ('pending','claimed','dispatching','accepted','ignored','unknown','cancelled')`
    ),
    check(
      "inkbox_webhook_inbox_digests_check",
      sql`${table.eventKey} ~ '^[a-f0-9]{64}$' AND ${table.messageKey} ~ '^[a-f0-9]{64}$' AND ${table.conversationKey} ~ '^[a-f0-9]{64}$' AND ${table.identityDigest} ~ '^[a-f0-9]{64}$' AND ${table.bodyDigest} ~ '^[a-f0-9]{64}$'`
    ),
  ]
);
