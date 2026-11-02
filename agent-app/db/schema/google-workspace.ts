import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  integer,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export const googleWorkspaceConnections = pgTable(
  "google_workspace_connections",
  {
    workspaceId: text("workspace_id").primaryKey(),
    userId: text("user_id").notNull(),
    version: integer("version").notNull().default(0),
    revocationPending: boolean("revocation_pending").notNull().default(false),
    status: text("status", {
      enum: ["pending", "connected", "disconnected"],
    }).notNull(),
    accountSubject: text("account_subject"),
    accountLabel: text("account_label"),
    grantedScopes: text("granted_scopes"),
    encryptedTokens: text("encrypted_tokens"),
    accessExpiresAt: timestamp("access_expires_at", {
      withTimezone: true,
      mode: "date",
    }),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "google_workspace_connection_status",
      sql`${table.status} IN ('pending','connected','disconnected')`
    ),
  ]
);

export const googleWorkspaceOAuthStates = pgTable(
  "google_workspace_oauth_states",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    userId: text("user_id").notNull(),
    sessionHash: text("session_hash").notNull(),
    browserHash: text("browser_hash").notNull(),
    connectionVersion: integer("connection_version").notNull(),
    encryptedVerifier: text("encrypted_verifier").notNull(),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
  }
);
