import { and, eq, inArray, sql } from "drizzle-orm";
import { db, modelBudgetAccounts, modelProviderAttempts, user } from "@db";
import { env } from "@shared/environment";
import {
  accessScopeForUser,
  type AccessScope,
} from "@shared/identity/access-scope";

export async function readModelAttempt(scope: AccessScope, id: string) {
  return db.query.modelProviderAttempts.findFirst({
    where: and(
      eq(modelProviderAttempts.id, id),
      eq(modelProviderAttempts.workspaceId, scope.workspaceId)
    ),
  });
}

export async function reserveModelAttempt(
  input: Pick<
    typeof modelProviderAttempts.$inferInsert,
    | "id"
    | "workspaceId"
    | "rootSessionId"
    | "requestHash"
    | "model"
    | "reservedMicroUsd"
  >,
  now = new Date()
) {
  const month = now.toISOString().slice(0, 7);
  const globalAccountId = `global:${month}`;
  const userAccountId = `workspace:${input.workspaceId}:${month}`;
  const ids = [globalAccountId, userAccountId];
  return db.transaction(async (tx) => {
    await tx
      .insert(modelBudgetAccounts)
      .values(ids.map((id) => ({ id })))
      .onConflictDoNothing();
    const accounts = await tx
      .select()
      .from(modelBudgetAccounts)
      .where(inArray(modelBudgetAccounts.id, ids))
      .orderBy(modelBudgetAccounts.id)
      .for("update");
    const existing = await tx.query.modelProviderAttempts.findFirst({
      where: eq(modelProviderAttempts.id, input.id),
    });
    if (existing) {
      if (
        existing.workspaceId !== input.workspaceId ||
        existing.requestHash !== input.requestHash ||
        existing.rootSessionId !== input.rootSessionId ||
        existing.model !== input.model
      ) {
        throw new Error("Model request identity conflict.");
      }
      return { admitted: false, attempt: existing };
    }
    const uncertain = await tx.query.modelProviderAttempts.findFirst({
      where: and(
        eq(modelProviderAttempts.workspaceId, input.workspaceId),
        eq(modelProviderAttempts.rootSessionId, input.rootSessionId),
        inArray(modelProviderAttempts.status, [
          "reserved",
          "started",
          "unknown",
        ])
      ),
    });
    if (uncertain)
      throw new Error(
        "This conversation has an unresolved model charge or call in progress. Automatic retries are blocked."
      );
    for (const account of accounts) {
      const limit =
        account.id === globalAccountId
          ? env.MODEL_GLOBAL_MONTHLY_BUDGET_MICRO_USD
          : env.MODEL_USER_MONTHLY_BUDGET_MICRO_USD;
      if (
        !Number.isSafeInteger(input.reservedMicroUsd) ||
        input.reservedMicroUsd <= 0 ||
        account.spentMicroUsd + account.heldMicroUsd + input.reservedMicroUsd >
          limit
      ) {
        throw new Error("The model spending limit has been reached.");
      }
    }
    if (accounts.length !== 2)
      throw new Error("Model accounting is unavailable.");
    const [attempt] = await tx
      .insert(modelProviderAttempts)
      .values({
        ...input,
        globalAccountId,
        userAccountId,
        status: "reserved",
        createdAt: now,
      })
      .returning();
    if (!attempt) throw new Error("Model accounting is unavailable.");
    await tx
      .update(modelBudgetAccounts)
      .set({
        heldMicroUsd: sql`${modelBudgetAccounts.heldMicroUsd} + ${input.reservedMicroUsd}`,
      })
      .where(inArray(modelBudgetAccounts.id, ids));
    return { admitted: true, attempt };
  });
}

export async function startModelAttempt(scope: AccessScope, id: string) {
  const rows = await db
    .update(modelProviderAttempts)
    .set({ status: "started" })
    .where(
      and(
        eq(modelProviderAttempts.id, id),
        eq(modelProviderAttempts.workspaceId, scope.workspaceId),
        eq(modelProviderAttempts.status, "reserved")
      )
    )
    .returning({ id: modelProviderAttempts.id });
  if (rows.length !== 1)
    throw new Error("This model request has already been submitted.");
}

export async function holdUnknownModelAttempt(scope: AccessScope, id: string) {
  await db
    .update(modelProviderAttempts)
    .set({ status: "unknown" })
    .where(
      and(
        eq(modelProviderAttempts.id, id),
        eq(modelProviderAttempts.workspaceId, scope.workspaceId),
        inArray(modelProviderAttempts.status, ["reserved", "started"])
      )
    );
}

export async function settleModelAttempt(
  scope: AccessScope,
  id: string,
  result: {
    actualMicroUsd: number;
    inputTokens: number;
    outputTokens: number;
    encryptedResult: string;
  }
) {
  const observed = await readModelAttempt(scope, id);
  if (!observed) throw new Error("Unknown model request.");
  if (
    !scope.userId.startsWith("better-auth:") ||
    accessScopeForUser(scope.userId).workspaceId !== scope.workspaceId
  ) {
    throw new Error("An authenticated workspace is required for accounting.");
  }
  return db.transaction(async (tx) => {
    // DELETE must wait until settlement commits, then its erasure trigger purges
    // this cache. If deletion already committed, settle known cost without data.
    const [owner] = await tx
      .select({ id: user.id })
      .from(user)
      .where(eq(user.id, scope.userId.slice("better-auth:".length)))
      .for("key share");
    const ids = [observed.globalAccountId, observed.userAccountId];
    await tx
      .select()
      .from(modelBudgetAccounts)
      .where(inArray(modelBudgetAccounts.id, ids))
      .orderBy(modelBudgetAccounts.id)
      .for("update");
    const [attempt] = await tx
      .select()
      .from(modelProviderAttempts)
      .where(
        and(
          eq(modelProviderAttempts.id, id),
          eq(modelProviderAttempts.workspaceId, scope.workspaceId)
        )
      )
      .for("update");
    if (attempt?.status !== "started")
      throw new Error("Model request cannot be settled twice.");
    if (
      !Number.isSafeInteger(result.actualMicroUsd) ||
      result.actualMicroUsd < 0 ||
      result.actualMicroUsd > attempt.reservedMicroUsd ||
      !Number.isSafeInteger(result.inputTokens) ||
      result.inputTokens < 0 ||
      !Number.isSafeInteger(result.outputTokens) ||
      result.outputTokens < 0
    ) {
      throw new Error("Model usage exceeded its reservation.");
    }
    await tx
      .update(modelBudgetAccounts)
      .set({
        heldMicroUsd: sql`${modelBudgetAccounts.heldMicroUsd} - ${attempt.reservedMicroUsd}`,
        spentMicroUsd: sql`${modelBudgetAccounts.spentMicroUsd} + ${result.actualMicroUsd}`,
      })
      .where(inArray(modelBudgetAccounts.id, ids));
    await tx
      .update(modelProviderAttempts)
      .set({
        ...result,
        encryptedResult: owner ? result.encryptedResult : null,
        status: "completed",
        settledAt: new Date(),
      })
      .where(eq(modelProviderAttempts.id, id));
  });
}
