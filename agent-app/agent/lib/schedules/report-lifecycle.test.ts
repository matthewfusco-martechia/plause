import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Jobs from "@db/services/scheduled-agent-jobs";
import type * as PhoneAuth from "@db/services/auth/phone-user";
import { toolContextFor } from "@tests/helpers/tool-context";
import { accessScopeForUser } from "@shared/identity/access-scope";
import { assertScheduledReportDelivery } from "./report-lifecycle";

const controls = vi.hoisted(() => ({
  enrolled: vi.fn<typeof PhoneAuth.assertEnrolledWorkspaceUser>(),
  active: vi.fn<typeof Jobs.isScheduledReportDeliveryActive>(),
}));
vi.mock("@db/services/auth/phone-user", () => ({
  assertEnrolledWorkspaceUser: controls.enrolled,
}));
vi.mock("@db/services/scheduled-agent-jobs", () => ({
  isScheduledReportDeliveryActive: controls.active,
  finalizeScheduledReport: vi.fn<typeof Jobs.finalizeScheduledReport>(),
  holdScheduledReport: vi.fn<typeof Jobs.holdScheduledReport>(),
  releaseScheduledReport: vi.fn<typeof Jobs.releaseScheduledReport>(),
}));

beforeEach(() => vi.clearAllMocks());

describe("scheduled report dispatch boundary", () => {
  it("queries current lease authority after an awaited owner lookup rather than retaining earlier permission", async () => {
    const entered = Promise.withResolvers<undefined>();
    const gate = Promise.withResolvers<undefined>();
    let current = true;
    controls.enrolled.mockImplementation(async () => {
      entered.resolve(undefined);
      await gate.promise;
      return "+15550100011";
    });
    controls.active.mockImplementation(async () => current);
    const scope = accessScopeForUser("better-auth:fixture-owner");
    const context = toolContextFor({
      auth: {
        current: {
          principalType: "user",
          principalId: scope.userId,
          authenticator: "scheduled-result",
          attributes: {
            workspaceId: scope.workspaceId,
            conversationChannel: "inkbox",
            scheduleId: "10000000-0000-4000-8000-000000000001",
            scheduledRunId: "20000000-0000-4000-8000-000000000001",
            scheduledReportSequence: "1",
            scheduledReportLeaseToken: "30000000-0000-4000-8000-000000000001",
          },
        },
        initiator: null,
      },
    });
    const pending = assertScheduledReportDelivery(context);
    await entered.promise;
    current = false;
    gate.resolve(undefined);
    await expect(pending).rejects.toThrow("no longer authorized");
    expect(controls.active).toHaveBeenCalledExactlyOnceWith(
      scope,
      "20000000-0000-4000-8000-000000000001",
      "30000000-0000-4000-8000-000000000001",
      1
    );
  });
});
