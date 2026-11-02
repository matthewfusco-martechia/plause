import { sql } from "drizzle-orm";
import {
  check,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const googleActionApprovals = pgTable(
  "google_action_approvals",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    userId: text("user_id").notNull(),
    sessionId: text("session_id").notNull(),
    rootSessionId: text("root_session_id").notNull(),
    callId: text("call_id").notNull(),
    toolName: text("tool_name").notNull(),
    inputHash: text("input_hash").notNull(),
    encryptedInput: text("encrypted_input"),
    principalHash: text("principal_hash").notNull(),
    grantVersion: integer("grant_version").notNull(),
    state: text("state", {
      enum: ["pending", "approved", "denied", "revoked"],
    }).notNull(),
    interactionId: text("interaction_id"),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "google_action_approval_state",
      sql`${table.state} IN ('pending','approved','denied','revoked')`
    ),
    check(
      "google_action_approval_tool",
      sql`${table.toolName} IN ('gmail-send','gmail-update','calendar-create-event')`
    ),
  ]
);

export const googleActionDispatches = pgTable(
  "google_action_dispatches",
  {
    approvalId: text("approval_id")
      .primaryKey()
      .references(() => googleActionApprovals.id),
    workspaceId: text("workspace_id").notNull(),
    userId: text("user_id").notNull(),
    rootSessionId: text("root_session_id").notNull(),
    grantVersion: integer("grant_version").notNull(),
    state: text("state", {
      enum: ["started", "completed", "unknown"],
    }).notNull(),
    encryptedResult: text("encrypted_result"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", {
      withTimezone: true,
      mode: "date",
    }),
  },
  (table) => [
    check(
      "google_action_dispatch_state",
      sql`${table.state} IN ('started','completed','unknown')`
    ),
    uniqueIndex("google_action_unresolved_conversation")
      .on(table.workspaceId, table.rootSessionId)
      .where(sql`${table.state} IN ('started','unknown')`),
  ]
);
