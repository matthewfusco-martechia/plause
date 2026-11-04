import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { z } from "zod";
import { env } from "@shared/environment";
import { accessScopeForUser } from "@shared/identity/access-scope";
import { authorizeModelContinuation } from "@db/services/model-budget";

// No application route or agent tool calls this operator-only command.
const [option, path, ...extra] = process.argv.slice(2);
if (option !== "--review" || !path || extra.length)
  throw new Error(
    "Usage: model:authorize-continuation --review <approved-file>"
  );
const raw = await readFile(path, "utf8");
const review = z
  .object({
    status: z.literal("approved"),
    purpose: z.literal("fresh-model-work-with-unknown-cost-held"),
    ownerReply: z.string().trim().min(10),
    approvedAt: z.iso.datetime(),
    reviewFile: z.string().min(1),
    reviewSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    expectedDatabaseHost: z.string().min(1),
    expectedDatabaseUser: z.string().min(1),
    expectedDatabaseName: z.string().min(1),
    userId: z.string().startsWith("better-auth:"),
    workspaceId: z.string().min(1),
    attemptId: z.string().regex(/^[a-f0-9]{64}$/u),
    rootSessionId: z.string().min(1),
    reservedMicroUsd: z.number().int().positive(),
    baselineAttemptCount: z.number().int().nonnegative(),
    additionalAttemptAllowance: z.number().int().min(1).max(50),
    globalAttemptCeiling: z.number().int().positive(),
    monthlyBudgetMicroUsd: z.number().int().positive().max(250_000),
    expiresAt: z.iso.datetime(),
  })
  .strict()
  .parse(JSON.parse(raw));
const approvedAt = new Date(review.approvedAt).getTime();
if (
  approvedAt > Date.now() ||
  Date.now() - approvedAt > 24 * 60 * 60 * 1000 ||
  review.globalAttemptCeiling !==
    review.baselineAttemptCount + review.additionalAttemptAllowance ||
  createHash("sha256")
    .update(await readFile(review.reviewFile))
    .digest("hex") !== review.reviewSha256
)
  throw new Error(
    "A fresh approval bound to the unchanged review and allowance is required."
  );
const scope = accessScopeForUser(review.userId);
const database = new URL(env.DATABASE_URL);
if (
  scope.workspaceId !== review.workspaceId ||
  database.hostname !== review.expectedDatabaseHost ||
  decodeURIComponent(database.username) !== review.expectedDatabaseUser ||
  database.pathname !== `/${review.expectedDatabaseName}` ||
  env.LIVE_MODEL_ENABLED !== "false" ||
  env.MODEL_GLOBAL_MONTHLY_ATTEMPT_LIMIT !== review.globalAttemptCeiling ||
  env.MODEL_GLOBAL_MONTHLY_BUDGET_MICRO_USD !== review.monthlyBudgetMicroUsd ||
  env.MODEL_USER_MONTHLY_BUDGET_MICRO_USD !== review.monthlyBudgetMicroUsd
)
  throw new Error(
    "The host, owner or disabled budget controls differ from review."
  );
const result = await authorizeModelContinuation(scope, {
  attemptId: review.attemptId,
  rootSessionId: review.rootSessionId,
  reservedMicroUsd: review.reservedMicroUsd,
  authorizationHash: createHash("sha256").update(raw).digest("hex"),
  expiresAt: new Date(review.expiresAt),
});
console.log(
  JSON.stringify({
    authorized: result.authorized,
    unknownOutcomePreserved: true,
    fullReservationPreserved: true,
    modelCallsMade: 0,
  })
);
process.exit(0);
