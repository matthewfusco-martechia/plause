import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, browserActionAttempts } from "@db";
import type { AccessScope } from "@shared/identity/access-scope";
import {
  lockRootActionClaims,
  hasUnresolvedRootAction,
} from "./root-action-claims";

export async function startBrowserAction(
  scope: AccessScope,
  input: Pick<
    typeof browserActionAttempts.$inferInsert,
    | "workerSessionId"
    | "rootSessionId"
    | "callId"
    | "toolName"
    | "browserSessionId"
    | "observationId"
    | "inputHash"
  >
) {
  const id = createHash("sha256")
    .update(
      JSON.stringify([scope.workspaceId, input.workerSessionId, input.callId])
    )
    .digest("hex");
  return db.transaction(async (tx) => {
    await lockRootActionClaims(tx, {
      ...scope,
      rootSessionId: input.rootSessionId,
    });
    const existing = await tx.query.browserActionAttempts.findFirst({
      where: eq(browserActionAttempts.id, id),
    });
    if (
      existing &&
      (existing.userId !== scope.userId ||
        existing.workspaceId !== scope.workspaceId ||
        existing.rootSessionId !== input.rootSessionId ||
        existing.toolName !== input.toolName ||
        existing.inputHash !== input.inputHash ||
        existing.browserSessionId !== (input.browserSessionId ?? null) ||
        existing.observationId !== (input.observationId ?? null))
    )
      throw new Error(
        "Browser action identity conflict. Nothing new was dispatched."
      );
    if (existing?.status === "completed")
      throw new Error(
        "This browser action already completed. Its saved Eve result is unavailable; inspect the browser instead of repeating it."
      );
    if (
      existing ||
      (await hasUnresolvedRootAction(tx, {
        ...scope,
        rootSessionId: input.rootSessionId,
      }))
    )
      throw new Error(
        "This conversation has a started or uncertain external action. Automatic repeat actions are blocked; inspect and reconcile the existing outcome."
      );
    const [created] = await tx
      .insert(browserActionAttempts)
      .values({
        ...scope,
        ...input,
        id,
        status: "started",
      })
      .onConflictDoNothing()
      .returning({ id: browserActionAttempts.id });
    if (!created)
      throw new Error(
        "Browser action identity conflict. Nothing new was dispatched."
      );
    return created.id;
  });
}

export async function completeBrowserAction(scope: AccessScope, id: string) {
  const rows = await db
    .update(browserActionAttempts)
    .set({ status: "completed", settledAt: new Date() })
    .where(
      and(
        eq(browserActionAttempts.id, id),
        eq(browserActionAttempts.userId, scope.userId),
        eq(browserActionAttempts.workspaceId, scope.workspaceId),
        eq(browserActionAttempts.status, "started")
      )
    )
    .returning({ id: browserActionAttempts.id });
  if (rows.length !== 1)
    throw new Error(
      "Browser action completion could not be recorded. Do not repeat the action."
    );
}

export async function markBrowserActionUnknown(scope: AccessScope, id: string) {
  await db
    .update(browserActionAttempts)
    .set({ status: "unknown", settledAt: new Date() })
    .where(
      and(
        eq(browserActionAttempts.id, id),
        eq(browserActionAttempts.userId, scope.userId),
        eq(browserActionAttempts.workspaceId, scope.workspaceId),
        eq(browserActionAttempts.status, "started")
      )
    );
}
