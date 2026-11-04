import type * as Eve from "eve";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  dynamicContextFor,
  evaluateDynamic,
  withEvaluableDynamic,
} from "@tests/helpers/dynamic";
import type { isScheduledAgentRunLeaseActive } from "@db/services/scheduled-agent-run-leases";
import type { getOpenAIModel } from "@db/services/settings";
import type { budgetedOpenAIFetch } from "@agent/lib/models/budget-fetch";

const services = vi.hoisted(() => ({
  getModel: vi.fn<typeof getOpenAIModel>(),
  isActive: vi.fn<typeof isScheduledAgentRunLeaseActive>(),
  budgetFetch: vi.fn<typeof budgetedOpenAIFetch>(() => vi.fn<typeof fetch>()),
}));

vi.mock("eve", async (importOriginal) =>
  withEvaluableDynamic(await importOriginal<typeof Eve>())
);
vi.mock("@db/services/scheduled-agent-run-leases", () => ({
  isScheduledAgentRunLeaseActive: services.isActive,
}));
vi.mock("@db/services/settings", () => ({
  getOpenAIModel: services.getModel,
}));
vi.mock("@agent/lib/models/budget-fetch", () => ({
  budgetedOpenAIFetch: services.budgetFetch,
}));

import agent from "@agent/agent";

const runId = "00000000-0000-4000-8000-000000000001";
const oldLeaseToken = "00000000-0000-4000-8000-000000000002";
const retryLeaseToken = "00000000-0000-4000-8000-000000000003";

beforeEach(() => {
  vi.clearAllMocks();
  services.getModel.mockResolvedValue("gpt-6-luna");
});

describe("root agent model resolution", () => {
  it("keeps the captured short-turn context below compaction while preserving the input cap", async () => {
    services.isActive.mockResolvedValue(true);
    const model = await resolveModel();
    const observedShortTurnTokens = 13_796;
    const checkpointHeadroom = 1_000;
    const window = model.modelContextWindowTokens;
    const threshold = agent.compaction.threshold;
    if (!window || !threshold)
      throw new Error("Expected an explicit compaction policy");
    expect(observedShortTurnTokens + checkpointHeadroom).toBeLessThan(
      window * threshold
    );
    expect(19_500 + checkpointHeadroom).toBeGreaterThan(window * threshold);
    expect(services.budgetFetch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ maxInputTokens: 20_000 })
    );
  });

  it("accepts a valid retry lease forwarded into an older Eve session", async () => {
    services.isActive.mockImplementation(async (_runId, leaseToken) => {
      return leaseToken === retryLeaseToken;
    });

    const model = await resolveModel();

    expect(services.isActive).toHaveBeenCalledExactlyOnceWith(
      runId,
      retryLeaseToken
    );
    expect(services.getModel).toHaveBeenCalledExactlyOnceWith({
      userId: "user-1",
      workspaceId: "workspace-1",
    });
    expect(model.model.modelId).toBe("gpt-6-luna");
    expect(model.model.provider).toBe("openai.responses");
    expect(model.modelContextWindowTokens).toBe(20_000);
    expect(services.budgetFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        workspaceId: "workspace-1",
        role: "root",
        scheduledLeaseToken: retryLeaseToken,
      }),
      expect.objectContaining({ model: "gpt-6-luna", maxRetries: 0 })
    );
  });

  it("rejects a scheduled worker after its lease is replaced", async () => {
    services.isActive.mockResolvedValue(false);

    await expect(resolveModel()).rejects.toThrow(
      "The scheduled run lease is no longer active."
    );
    expect(services.getModel).not.toHaveBeenCalled();
  });
});

async function resolveModel() {
  return evaluateDynamic(agent.model, scheduledWorkerContext());
}

function scheduledWorkerContext() {
  return dynamicContextFor({
    auth: {
      current: {
        attributes: {
          scheduledRunId: runId,
          scheduledRunLeaseToken: retryLeaseToken,
          workspaceId: "workspace-1",
        },
        authenticator: "scheduled-worker",
        principalId: "user-1",
        principalType: "user",
      },
      initiator: {
        attributes: {
          scheduledRunId: runId,
          scheduledRunLeaseToken: oldLeaseToken,
          workspaceId: "workspace-1",
        },
        authenticator: "scheduled-worker",
        principalId: "user-1",
        principalType: "user",
      },
    },
    sessionId: "worker-session",
  });
}
