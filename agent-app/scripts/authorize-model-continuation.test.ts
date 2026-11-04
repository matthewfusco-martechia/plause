import { createHash } from "node:crypto";
import type { readFile } from "node:fs/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { accessScopeForUser } from "@shared/identity/access-scope";
import type { authorizeModelContinuation } from "@db/services/model-budget";

const services = vi.hoisted(() => ({
  read: vi.fn<typeof readFile>(),
  authorize: vi.fn<typeof authorizeModelContinuation>(),
  env: {
    DATABASE_URL: "postgresql://runtime:fictional@127.0.0.1:9/fixture",
    LIVE_MODEL_ENABLED: "false",
    MODEL_GLOBAL_MONTHLY_ATTEMPT_LIMIT: 6,
    MODEL_GLOBAL_MONTHLY_BUDGET_MICRO_USD: 30_000,
    MODEL_USER_MONTHLY_BUDGET_MICRO_USD: 30_000,
  },
}));
const controls = { ...services.env };
vi.mock("node:fs/promises", () => ({ readFile: services.read }));
vi.mock("@shared/environment", () => ({ env: services.env }));
vi.mock("@db/services/model-budget", () => ({
  authorizeModelContinuation: services.authorize,
}));

const originalArguments = process.argv;
const scope = accessScopeForUser("better-auth:fixture-owner");
const reviewedScope =
  "Fictional bounded Calendar test; three additional generations.";
const review = {
  status: "approved",
  purpose: "fresh-model-work-with-unknown-cost-held",
  ownerReply: "Approve the bounded Calendar iMessage test",
  approvedAt: new Date(Date.now() - 1_000).toISOString(),
  reviewFile: "/fictional/reviewed-scope.md",
  reviewSha256: createHash("sha256").update(reviewedScope).digest("hex"),
  expectedDatabaseHost: "127.0.0.1",
  expectedDatabaseUser: "runtime",
  expectedDatabaseName: "fixture",
  ...scope,
  attemptId: "a".repeat(64),
  rootSessionId: "fixture-root",
  reservedMicroUsd: 4_005,
  baselineAttemptCount: 3,
  additionalAttemptAllowance: 3,
  globalAttemptCeiling: 6,
  monthlyBudgetMicroUsd: 30_000,
  expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
};

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  Object.assign(services.env, controls);
  services.read.mockImplementation(async (path) =>
    path === review.reviewFile ? reviewedScope : JSON.stringify(review)
  );
  services.authorize.mockResolvedValue({ authorized: true });
  process.argv = ["node", "operator", "--review", "/fictional/review.json"];
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("Operator completed");
  });
});
afterEach(() => {
  process.argv = originalArguments;
  vi.restoreAllMocks();
});

it("binds the mutation to the exact reviewed record and emits no private identity", async () => {
  await expect(import("./authorize-model-continuation")).rejects.toThrow(
    "Operator completed"
  );
  expect(services.authorize).toHaveBeenCalledExactlyOnceWith(scope, {
    attemptId: review.attemptId,
    rootSessionId: review.rootSessionId,
    reservedMicroUsd: 4_005,
    authorizationHash: createHash("sha256")
      .update(JSON.stringify(review))
      .digest("hex"),
    expiresAt: new Date(review.expiresAt),
  });
  expect(console.log).toHaveBeenCalledExactlyOnceWith(
    JSON.stringify({
      authorized: true,
      unknownOutcomePreserved: true,
      fullReservationPreserved: true,
      modelCallsMade: 0,
    })
  );
});

it("refuses a prepared but unapproved record before any database mutation", async () => {
  services.read.mockResolvedValue(
    JSON.stringify({ ...review, status: "prepared_not_approved" })
  );
  await expect(import("./authorize-model-continuation")).rejects.toThrow(
    /approved/u
  );
  expect(services.authorize).not.toHaveBeenCalled();
});

it("accepts a separately reviewed combined test bound to its exact allowance and budgets", async () => {
  const combined = {
    ...review,
    ownerReply: "Approve the combined iMessage workflow test",
    baselineAttemptCount: 8,
    additionalAttemptAllowance: 40,
    globalAttemptCeiling: 48,
    monthlyBudgetMicroUsd: 250_000,
  };
  Object.assign(services.env, {
    MODEL_GLOBAL_MONTHLY_ATTEMPT_LIMIT: 48,
    MODEL_GLOBAL_MONTHLY_BUDGET_MICRO_USD: 250_000,
    MODEL_USER_MONTHLY_BUDGET_MICRO_USD: 250_000,
  });
  services.read.mockImplementation(async (path) =>
    path === review.reviewFile ? reviewedScope : JSON.stringify(combined)
  );
  await expect(import("./authorize-model-continuation")).rejects.toThrow(
    "Operator completed"
  );
  expect(services.authorize).toHaveBeenCalledTimes(1);
});

it.each([
  { approvedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() },
  { approvedAt: new Date(Date.now() + 60_000).toISOString() },
  { reviewSha256: "0".repeat(64) },
  { baselineAttemptCount: 2 },
  { additionalAttemptAllowance: 51 },
  { monthlyBudgetMicroUsd: 250_001 },
  { ownerReply: "" },
])("refuses stale, changed or unbounded review %j", async (changed) => {
  services.read.mockImplementation(async (path) =>
    path === review.reviewFile
      ? reviewedScope
      : JSON.stringify({ ...review, ...changed })
  );
  await expect(import("./authorize-model-continuation")).rejects.toThrow(
    /fresh approval|Too big|Too small/u
  );
  expect(services.authorize).not.toHaveBeenCalled();
});

it.each([
  { DATABASE_URL: "postgresql://runtime:fictional@other.example.test/fixture" },
  { DATABASE_URL: "postgresql://other:fictional@127.0.0.1:9/fixture" },
  { DATABASE_URL: "postgresql://runtime:fictional@127.0.0.1:9/other" },
  { LIVE_MODEL_ENABLED: "true" },
  { MODEL_GLOBAL_MONTHLY_ATTEMPT_LIMIT: 7 },
  { MODEL_GLOBAL_MONTHLY_BUDGET_MICRO_USD: 30_001 },
])("refuses changed targets or controls %j", async (changed) => {
  Object.assign(services.env, changed);
  await expect(import("./authorize-model-continuation")).rejects.toThrow(
    "differ from review"
  );
  expect(services.authorize).not.toHaveBeenCalled();
});
