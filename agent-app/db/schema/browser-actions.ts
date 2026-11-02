import { sql } from "drizzle-orm";
import {
  check,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// No foreign keys: erasing an account must not remove uncertain-operation
// tombstones and permit a write to be repeated after a restore or replay.
export const browserActionAttempts = pgTable(
  "browser_action_attempts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    rootSessionId: text("root_session_id").notNull(),
    workerSessionId: text("worker_session_id").notNull(),
    callId: text("call_id").notNull(),
    toolName: text("tool_name").notNull(),
    browserSessionId: text("browser_session_id"),
    observationId: text("observation_id"),
    inputHash: text("input_hash").notNull(),
    status: text("status", {
      enum: ["started", "completed", "unknown"],
    }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    settledAt: timestamp("settled_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    check(
      "browser_action_attempt_status",
      sql`${table.status} IN ('started','completed','unknown')`
    ),
    uniqueIndex("browser_action_root_unresolved")
      .on(table.workspaceId, table.rootSessionId)
      .where(sql`${table.status} IN ('started','unknown')`),
  ]
);
