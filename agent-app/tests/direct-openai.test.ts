import type * as RuntimeModel from "../node_modules/eve/dist/src/runtime/agent/resolve-model.js";
import type { budgetedOpenAIFetch } from "@agent/lib/models/budget-fetch";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createDirectOpenAIModel } from "@agent/lib/models/client";
import { resolveDirectOpenAIModel } from "@agent/lib/models/openai";
import {
  directOpenAIPolicy,
  openAIModelCatalog,
  openAIModelIdSchema,
} from "@shared/models/openai";
import { dynamicContextFor } from "@tests/helpers/dynamic";

const services = vi.hoisted(() => ({
  getModel: vi.fn<() => Promise<string>>().mockResolvedValue("gpt-6-luna"),
  isActive: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
  transport: vi.fn<typeof fetch>(),
  budgetFetch: vi.fn<typeof budgetedOpenAIFetch>(),
}));
vi.mock("@db/services/settings", () => ({ getOpenAIModel: services.getModel }));
vi.mock("@db/services/scheduled-agent-run-leases", () => ({
  isScheduledAgentRunLeaseActive: services.isActive,
}));
vi.mock("@agent/lib/models/budget-fetch", () => ({
  budgetedOpenAIFetch: services.budgetFetch,
}));

const { resolveRuntimeModelSelection } = await vi.importActual<
  typeof RuntimeModel
>(
  new URL("./runtime/agent/resolve-model.js", import.meta.resolve("eve"))
    .pathname
);

beforeEach(() => {
  vi.clearAllMocks();
  services.getModel.mockResolvedValue("gpt-6-luna");
  services.isActive.mockResolvedValue(true);
  services.budgetFetch.mockReturnValue(services.transport);
  services.transport.mockImplementation(async () => Response.json(response()));
});

describe("direct OpenAI routing", () => {
  it.each(["root", "browser"] as const)(
    "routes %s to Responses with enforced retention and output bounds",
    async (role) => {
      const selected = await resolveDirectOpenAIModel(context(), role);
      const result = await selected.model.doGenerate({
        prompt: [
          {
            role: "user",
            content: [{ type: "text", text: "What is six times seven?" }],
          },
        ],
        maxOutputTokens: 99_999,
        providerOptions: { openai: { store: true, truncation: "auto" } },
      });
      expect(result.content).toContainEqual(
        expect.objectContaining({ type: "text", text: "42" })
      );
      expect(services.transport).toHaveBeenCalledOnce();
      const request = sentRequest();
      expect(request.url).toBe("https://api.openai.com/v1/responses");
      expect(await request.json()).toMatchObject({
        model: "gpt-6-luna",
        max_output_tokens: 2_000,
        store: false,
        truncation: "disabled",
        service_tier: "default",
      });
      expect(services.budgetFetch).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "user-1",
          workspaceId: "workspace-1",
          sessionId: "test-session",
          rootSessionId: "test-session",
          role,
          modelRunId: "resolve:0",
        }),
        expect.objectContaining({ maxRetries: 0 })
      );
    }
  );

  it("uses the installed live model-selection boundary without a catalog lookup", async () => {
    const selection = await resolveDirectOpenAIModel(context());
    const metadata = vi.fn<
      Parameters<typeof resolveRuntimeModelSelection>[0]["modelMetadata"]
    >(async () => {
      throw new Error("A direct model must not need Gateway metadata.");
    });
    const normalized = await resolveRuntimeModelSelection({
      durability: "live",
      modelMetadata: metadata,
      selection,
    });
    expect(normalized.reference).toMatchObject({
      id: "openai/gpt-6-luna",
      contextWindowTokens: 20_000,
    });
    expect(normalized.model).toMatchObject({ provider: "openai.responses" });
    expect(metadata).not.toHaveBeenCalled();
  });

  it("keeps lower requested output limits", async () => {
    const selected = await resolveDirectOpenAIModel(context());
    await selected.model.doGenerate({ prompt: [], maxOutputTokens: 100 });
    expect(
      z
        .object({ max_output_tokens: z.number() })
        .parse(await sentRequest().json()).max_output_tokens
    ).toBe(100);
  });

  it("does not add an SDK retry when the provider fails", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(
          { error: { message: "Fixture failure", type: "server_error" } },
          { status: 500 }
        )
      );
    const model = createDirectOpenAIModel(
      directOpenAIPolicy(),
      transport,
      "fixture-only"
    );
    await expect(model.doGenerate({ prompt: [] })).rejects.toThrow(
      "Fixture failure"
    );
    expect(transport).toHaveBeenCalledOnce();
  });

  it("rejects Gateway and unpriced selections instead of falling back", async () => {
    services.getModel.mockResolvedValue("meta/muse-spark-1.3");
    await expect(resolveDirectOpenAIModel(context())).rejects.toThrow(
      "gpt-6-luna"
    );
    expect(services.budgetFetch).not.toHaveBeenCalled();
    expect(openAIModelIdSchema.safeParse("openai/gpt-6-luna").success).toBe(
      false
    );
    expect(openAIModelCatalog()).toEqual([
      {
        id: "gpt-6-luna",
        name: "GPT-6 Luna",
        ownedBy: "openai",
        pricing: { input: 0.1, output: 0.5 },
      },
    ]);
    expect(services.transport).not.toHaveBeenCalled();
  });

  it("requires an authenticated user before opening model transport", async () => {
    await expect(resolveDirectOpenAIModel(dynamicContextFor())).rejects.toThrow(
      "An authenticated user is required."
    );
    expect(services.budgetFetch).not.toHaveBeenCalled();
  });

  it("blocks scheduled-report browser use before any provider work", async () => {
    await expect(
      resolveDirectOpenAIModel(context("scheduled-result"), "browser")
    ).rejects.toThrow("Browser execution is unavailable");
    expect(services.budgetFetch).not.toHaveBeenCalled();
  });

  it("fails closed on a scheduled worker with malformed lease claims", async () => {
    await expect(
      resolveDirectOpenAIModel(context("scheduled-worker"))
    ).rejects.toThrow("The scheduled run lease is no longer active.");
    expect(services.budgetFetch).not.toHaveBeenCalled();
  });
});

function context(authenticator = "linq-message") {
  return dynamicContextFor({
    auth: {
      current: {
        attributes: { workspaceId: "workspace-1" },
        authenticator,
        principalId: "user-1",
        principalType: "user",
      },
      initiator: null,
    },
  });
}

function response() {
  return {
    id: "resp_fixture",
    created_at: 1_700_000_000,
    model: "gpt-6-luna",
    object: "response",
    status: "completed",
    output: [
      {
        type: "message",
        id: "msg_fixture",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: "42", annotations: [] }],
      },
    ],
    usage: {
      input_tokens: 20,
      output_tokens: 1,
      total_tokens: 21,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  };
}

function sentRequest() {
  const call = services.transport.mock.calls.at(0);
  if (!call) throw new Error("No fixture provider request was recorded.");
  return new Request(call[0], call[1]);
}
