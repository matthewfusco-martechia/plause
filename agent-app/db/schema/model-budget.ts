import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  integer,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export const modelBudgetAccounts = pgTable(
  "model_budget_accounts",
  {
    id: text("id").primaryKey(),
    spentMicroUsd: bigint("spent_micro_usd", { mode: "number" })
      .notNull()
      .default(0),
    heldMicroUsd: bigint("held_micro_usd", { mode: "number" })
      .notNull()
      .default(0),
  },
  (table) => [
    check(
      "model_budget_nonnegative",
      sql`${table.spentMicroUsd} >= 0 AND ${table.heldMicroUsd} >= 0`
    ),
  ]
);

export const modelProviderAttempts = pgTable(
  "model_provider_attempts",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    rootSessionId: text("root_session_id").notNull(),
    requestHash: text("request_hash").notNull(),
    model: text("model").notNull(),
    globalAccountId: text("global_account_id").notNull(),
    userAccountId: text("user_account_id").notNull(),
    reservedMicroUsd: bigint("reserved_micro_usd", {
      mode: "number",
    }).notNull(),
    actualMicroUsd: bigint("actual_micro_usd", { mode: "number" }),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    status: text("status", {
      enum: ["reserved", "started", "completed", "unknown"],
    }).notNull(),
    encryptedResult: text("encrypted_result"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    settledAt: timestamp("settled_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    check(
      "model_provider_attempt_status",
      sql`${table.status} IN ('reserved','started','completed','unknown')`
    ),
    check(
      "model_provider_attempt_cost",
      sql`${table.reservedMicroUsd} > 0 AND (${table.actualMicroUsd} IS NULL OR ${table.actualMicroUsd} >= 0)`
    ),
  ]
);
