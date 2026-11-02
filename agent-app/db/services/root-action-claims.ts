import { and, eq, inArray, sql } from "drizzle-orm";
import { type db, browserActionAttempts, googleActionDispatches } from "@db";

type ActionTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type RootActionScope = Pick<
  typeof browserActionAttempts.$inferInsert,
  "workspaceId" | "rootSessionId"
>;

// Every external-write claim takes this lock before provider-specific locks.
// Holding it only for the admission transaction serializes vendors without
// keeping a database transaction open across provider work.
export async function lockRootActionClaims(
  tx: ActionTransaction,
  scope: RootActionScope
) {
  const key = JSON.stringify([scope.workspaceId, scope.rootSessionId]);
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`
  );
}

export async function hasUnresolvedRootAction(
  tx: ActionTransaction,
  scope: RootActionScope
) {
  const [browser, google] = await Promise.all([
    tx
      .select({ id: browserActionAttempts.id })
      .from(browserActionAttempts)
      .where(
        and(
          eq(browserActionAttempts.workspaceId, scope.workspaceId),
          eq(browserActionAttempts.rootSessionId, scope.rootSessionId),
          inArray(browserActionAttempts.status, ["started", "unknown"])
        )
      )
      .limit(1),
    tx
      .select({ id: googleActionDispatches.approvalId })
      .from(googleActionDispatches)
      .where(
        and(
          eq(googleActionDispatches.workspaceId, scope.workspaceId),
          eq(googleActionDispatches.rootSessionId, scope.rootSessionId),
          inArray(googleActionDispatches.state, ["started", "unknown"])
        )
      )
      .limit(1),
  ]);
  return browser.length > 0 || google.length > 0;
}
