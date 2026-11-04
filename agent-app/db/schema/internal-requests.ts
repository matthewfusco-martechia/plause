import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

// Content-free, short-lived replay receipts. They contain no callback body or identity.
export const internalRequestReceipts = pgTable(
  "internal_request_receipts",
  {
    requestId: uuid("request_id").primaryKey(),
    signatureDigest: text("signature_digest").notNull(),
    path: text("path", {
      enum: [
        "/internal/scheduled-run/report",
        "/internal/scheduled-run/respond",
        "/internal/schedules/tick",
        "/internal/linq/dispatch",
        "/internal/inkbox/dispatch",
      ],
    }).notNull(),
    expiresAt: timestamp("expires_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    }).notNull(),
  },
  (table) => [
    index("internal_request_receipts_expiry_idx").on(table.expiresAt),
    check(
      "internal_request_receipts_signature_check",
      sql`${table.signatureDigest} ~ '^[a-f0-9]{64}$'`
    ),
    check(
      "internal_request_receipts_path_check",
      sql`${table.path} IN ('/internal/scheduled-run/report', '/internal/scheduled-run/respond', '/internal/linq/dispatch', '/internal/inkbox/dispatch', '/internal/schedules/tick')`
    ),
  ]
);
