import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  integer,
  index,
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
    continuationAuthorizedAt: timestamp("continuation_authorized_at", {
      withTimezone: true,
      mode: "date",
    }),
    continuationExpiresAt: timestamp("continuation_expires_at", {
      withTimezone: true,
      mode: "date",
    }),
    continuationAuthorizationHash: text("continuation_authorization_hash"),
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
    check(
      "model_provider_continuation_authorization",
      sql`(${table.continuationAuthorizedAt} IS NULL AND ${table.continuationExpiresAt} IS NULL AND ${table.continuationAuthorizationHash} IS NULL) OR (${table.status} = 'unknown' AND ${table.continuationAuthorizedAt} IS NOT NULL AND ${table.continuationExpiresAt} IS NOT NULL AND ${table.continuationAuthorizationHash} IS NOT NULL AND ${table.continuationExpiresAt} > ${table.continuationAuthorizedAt} AND ${table.continuationExpiresAt} <= ${table.continuationAuthorizedAt} + interval '1 hour' AND ${table.continuationAuthorizationHash} ~ '^[a-f0-9]{64}$')`
    ),
  ]
);

// Separate permissions preserve the first recovery record on the attempt.
// Only the operator command inserts these; there is no application mutation.
export const modelContinuationGrants = pgTable(
  "model_continuation_grants",
  {
    authorizationHash: text("authorization_hash").primaryKey(),
    attemptId: text("attempt_id")
      .notNull()
      .references(() => modelProviderAttempts.id),
    authorizedAt: timestamp("authorized_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("model_continuation_grants_attempt_idx").on(table.attemptId),
    check(
      "model_continuation_grant_authority",
      sql`${table.authorizationHash} ~ '^[a-f0-9]{64}$' AND ${table.expiresAt} > ${table.authorizedAt} AND ${table.expiresAt} <= ${table.authorizedAt} + interval '1 hour'`
    ),
  ]
);
