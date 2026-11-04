import {
  and,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import {
  db,
  modelBudgetAccounts,
  modelContinuationGrants,
  modelProviderAttempts,
  user,
} from "@db";
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
    const attemptLimit = env.MODEL_GLOBAL_MONTHLY_ATTEMPT_LIMIT;
    if (attemptLimit !== undefined) {
      // The global budget row is already locked, so competing users cannot
      // oversubscribe the call ceiling. Failed/unknown reservations still count.
      const [attempts] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(modelProviderAttempts)
        .where(eq(modelProviderAttempts.globalAccountId, globalAccountId));
      if (!attempts || attempts.count >= attemptLimit)
        throw new Error("The model attempt limit has been reached.");
    }
    const [uncertain] = await tx
      .select({ id: modelProviderAttempts.id })
      .from(modelProviderAttempts)
      .where(
        and(
          eq(modelProviderAttempts.workspaceId, input.workspaceId),
          eq(modelProviderAttempts.rootSessionId, input.rootSessionId),
          or(
            inArray(modelProviderAttempts.status, ["reserved", "started"]),
            and(
              eq(modelProviderAttempts.status, "unknown"),
              or(
                isNull(modelProviderAttempts.continuationExpiresAt),
                lte(modelProviderAttempts.continuationExpiresAt, now)
              ),
              notExists(
                tx
                  .select({ hash: modelContinuationGrants.authorizationHash })
                  .from(modelContinuationGrants)
                  .where(
                    and(
                      eq(
                        modelContinuationGrants.attemptId,
                        modelProviderAttempts.id
                      ),
                      lte(modelContinuationGrants.authorizedAt, now),
                      gt(modelContinuationGrants.expiresAt, now)
                    )
                  )
              )
            )
          )
        )
      )
      .limit(1);
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

// Operator-only recovery: no HTTP route or model tool exposes this mutation.
// The unknown attempt, held amount and exact-request replay fence stay intact.
export async function authorizeModelContinuation(
  scope: AccessScope,
  input: {
    attemptId: string;
    rootSessionId: string;
    reservedMicroUsd: number;
    authorizationHash: string;
    expiresAt: Date;
  },
  now = new Date()
) {
  if (
    !scope.userId.startsWith("better-auth:") ||
    accessScopeForUser(scope.userId).workspaceId !== scope.workspaceId ||
    !/^[a-f0-9]{64}$/u.test(input.authorizationHash) ||
    !Number.isSafeInteger(input.reservedMicroUsd) ||
    input.reservedMicroUsd <= 0 ||
    !(input.expiresAt > now) ||
    input.expiresAt.getTime() - now.getTime() > 60 * 60 * 1000
  )
    throw new Error("A valid owner continuation authorization is required.");
  return db.transaction(async (tx) => {
    const [owner] = await tx
      .select({ id: user.id })
      .from(user)
      .where(eq(user.id, scope.userId.slice("better-auth:".length)))
      .for("key share");
    if (!owner) throw new Error("The workspace owner no longer exists.");
    const observed = await tx.query.modelProviderAttempts.findFirst({
      where: and(
        eq(modelProviderAttempts.id, input.attemptId),
        eq(modelProviderAttempts.workspaceId, scope.workspaceId)
      ),
    });
    if (!observed) throw new Error("Unknown model request.");
    const accounts = await tx
      .select()
      .from(modelBudgetAccounts)
      .where(
        inArray(modelBudgetAccounts.id, [
          observed.globalAccountId,
          observed.userAccountId,
        ])
      )
      .orderBy(modelBudgetAccounts.id)
      .for("update");
    const [attempt] = await tx
      .select()
      .from(modelProviderAttempts)
      .where(
        and(
          eq(modelProviderAttempts.id, input.attemptId),
          eq(modelProviderAttempts.workspaceId, scope.workspaceId)
        )
      )
      .for("update");
    if (
      attempt?.status !== "unknown" ||
      attempt.model !== "gpt-6-luna" ||
      attempt.rootSessionId !== input.rootSessionId ||
      attempt.reservedMicroUsd !== input.reservedMicroUsd ||
      attempt.encryptedResult !== null ||
      accounts.length !== 2 ||
      accounts.some((account) => account.heldMicroUsd < input.reservedMicroUsd)
    )
      throw new Error("The unresolved request no longer matches the review.");
    if (attempt.continuationAuthorizationHash !== null) {
      if (attempt.continuationAuthorizationHash === input.authorizationHash) {
        if (
          attempt.continuationExpiresAt?.getTime() !== input.expiresAt.getTime()
        )
          throw new Error("This continuation was already authorized.");
        return { authorized: false };
      }
      if (attempt.continuationExpiresAt && attempt.continuationExpiresAt > now)
        throw new Error("A continuation authorization is still active.");
    }
    const existingGrant = await tx.query.modelContinuationGrants.findFirst({
      where: eq(
        modelContinuationGrants.authorizationHash,
        input.authorizationHash
      ),
    });
    if (existingGrant) {
      if (
        existingGrant.attemptId !== input.attemptId ||
        existingGrant.expiresAt.getTime() !== input.expiresAt.getTime()
      )
        throw new Error("This continuation was already authorized.");
      return { authorized: false };
    }
    const activeGrant = await tx.query.modelContinuationGrants.findFirst({
      where: and(
        eq(modelContinuationGrants.attemptId, input.attemptId),
        gt(modelContinuationGrants.expiresAt, now)
      ),
    });
    if (activeGrant)
      throw new Error("A continuation authorization is still active.");
    const active = await tx.query.modelProviderAttempts.findFirst({
      where: and(
        eq(modelProviderAttempts.workspaceId, scope.workspaceId),
        eq(modelProviderAttempts.rootSessionId, input.rootSessionId),
        inArray(modelProviderAttempts.status, ["reserved", "started"])
      ),
    });
    if (active)
      throw new Error("The conversation still has active model work.");
    if (attempt.continuationAuthorizationHash !== null) {
      await tx.insert(modelContinuationGrants).values({
        authorizationHash: input.authorizationHash,
        attemptId: input.attemptId,
        authorizedAt: now,
        expiresAt: input.expiresAt,
      });
      return { authorized: true };
    }
    await tx
      .update(modelProviderAttempts)
      .set({
        continuationAuthorizedAt: now,
        continuationExpiresAt: input.expiresAt,
        continuationAuthorizationHash: input.authorizationHash,
      })
      .where(eq(modelProviderAttempts.id, input.attemptId));
    return { authorized: true };
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
