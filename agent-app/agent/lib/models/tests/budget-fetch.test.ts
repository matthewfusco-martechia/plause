import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Budget from "@db/services/model-budget";
import type { AccessScope } from "@shared/identity/access-scope";
import type { JsonObject } from "eve/events";
type ModelAttempt = NonNullable<
  Awaited<ReturnType<typeof Budget.readModelAttempt>>
>;

const ledger = vi.hoisted(() => ({
  read: vi.fn<typeof Budget.readModelAttempt>(),
  reserve: vi.fn<typeof Budget.reserveModelAttempt>(),
  start: vi.fn<typeof Budget.startModelAttempt>(),
  hold: vi.fn<typeof Budget.holdUnknownModelAttempt>(),
  settle: vi.fn<typeof Budget.settleModelAttempt>(),
  lease: vi.fn<() => Promise<boolean>>(),
  enrolled: vi.fn<(scope: AccessScope) => Promise<void>>(),
  decrypt:
    vi.fn<
      (scope: AccessScope, purpose: string, value: string) => Promise<string>
    >(),
}));
vi.mock("@db/services/model-budget", () => ({
  readModelAttempt: ledger.read,
  reserveModelAttempt: ledger.reserve,
  startModelAttempt: ledger.start,
  holdUnknownModelAttempt: ledger.hold,
  settleModelAttempt: ledger.settle,
}));
vi.mock("@shared/environment", () => ({
  env: { LIVE_MODEL_ENABLED: "true", OPENAI_API_KEY: "test-openai-key" },
}));
vi.mock("@db/services/scheduled-agent-run-leases", () => ({
  isScheduledAgentRunLeaseActive: ledger.lease,
}));
vi.mock("@db/services/auth/phone-user", () => ({
  assertEnrolledWorkspaceUser: ledger.enrolled,
}));
vi.mock("@db/services/protected-values", () => ({
  encryptWorkspaceValue: async (
    _scope: AccessScope,
    _purpose: string,
    value: string
  ) => `sealed:${value}`,
  decryptWorkspaceValue: ledger.decrypt,
}));
import { budgetedOpenAIFetch } from "../budget-fetch";

const context = {
  userId: "test-user",
  workspaceId: "test-workspace",
  sessionId: "session",
  rootSessionId: "root",
  turnId: "turn",
  modelRunId: "model-call",
  role: "root" as const,
};
const policy = {
  model: "gpt-6-luna" as const,
  maxInputTokens: 20_000,
  maxOutputTokens: 2_000,
  timeoutMs: 20_000,
  inputRateMicroUsdPerMillion: 250_000,
  outputRateMicroUsdPerMillion: 500_000,
  maxRetries: 0,
} as const;
const payload = {
  model: "gpt-6-luna",
  input: [{ role: "user", content: "Fictional request" }],
  store: false,
  max_output_tokens: 2_000,
  stream: false,
  tools: [
    { type: "function", name: "read_calendar", parameters: { type: "object" } },
  ],
};
const completed = {
  id: "resp_fixture",
  object: "response",
  model: "gpt-6-luna",
  status: "completed",
  usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
  output: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  ledger.read.mockResolvedValue(undefined);
  ledger.reserve.mockResolvedValue({ admitted: true, attempt: attempt() });
  ledger.start.mockResolvedValue(undefined);
  ledger.hold.mockResolvedValue(undefined);
  ledger.settle.mockResolvedValue(undefined);
  ledger.lease.mockResolvedValue(true);
  ledger.enrolled.mockResolvedValue(undefined);
  ledger.decrypt.mockImplementation(async (_scope, _purpose, value) =>
    value.slice(7)
  );
});
afterEach(() => {
  vi.restoreAllMocks();
});

function request(fetcher: typeof fetch, body: JsonObject = payload) {
  return fetcher("https://api.openai.com/v1/responses", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("direct model budget transport", () => {
  it("preflights the exact input and tools, settles, and caches only encrypted results", async () => {
    const transport = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({ object: "response.input_tokens", input_tokens: 100 })
      )
      .mockResolvedValueOnce(Response.json(completed));
    const response = await request(budgetedOpenAIFetch(context, policy));
    expect(await response.json()).toEqual(completed);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(await sentRequest(transport.mock.calls, 0).json()).toEqual({
      model: payload.model,
      input: payload.input,
      tools: payload.tools,
    });
    expect(await sentRequest(transport.mock.calls, 1).json()).toEqual(payload);
    expect(ledger.reserve).toHaveBeenCalledWith(
      expect.objectContaining({ reservedMicroUsd: 1_025 })
    );
    expect(ledger.settle).toHaveBeenCalledWith(
      context,
      expect.any(String),
      expect.objectContaining({
        actualMicroUsd: 30,
      })
    );
    expect(ledger.settle.mock.calls.at(0)?.[2].encryptedResult).toMatch(
      /^sealed:/u
    );
    expect(ledger.hold).not.toHaveBeenCalled();
  });

  it("holds a lost send outcome and makes no automatic paid retry", async () => {
    const transport = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({ object: "response.input_tokens", input_tokens: 100 })
      )
      .mockRejectedValueOnce(new Error("connection reset"));
    await expect(request(budgetedOpenAIFetch(context, policy))).rejects.toThrow(
      "reserved cost remains held"
    );
    expect(transport).toHaveBeenCalledTimes(2);
    expect(ledger.hold).toHaveBeenCalledOnce();
    expect(ledger.settle).not.toHaveBeenCalled();
  });

  it("rejects an oversized input before reserving or generating", async () => {
    const transport = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        Response.json({ object: "response.input_tokens", input_tokens: 20_001 })
      );
    await expect(request(budgetedOpenAIFetch(context, policy))).rejects.toThrow(
      "input limit"
    );
    expect(transport).toHaveBeenCalledOnce();
    expect(ledger.reserve).not.toHaveBeenCalled();
  });

  it("does not let hosted tools or another endpoint bypass priced calls", async () => {
    const transport = vi.spyOn(globalThis, "fetch");
    await expect(
      request(budgetedOpenAIFetch(context, policy), {
        ...payload,
        tools: [{ type: "web_search", name: "search", parameters: {} }],
      })
    ).rejects.toThrow("function");
    await expect(
      budgetedOpenAIFetch(context, policy)("https://example.com", {
        method: "POST",
      })
    ).rejects.toThrow("Only direct");
    expect(transport).not.toHaveBeenCalled();
  });

  it("buffers streaming output until a complete usage record has settled", async () => {
    const body = `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hello" })}\n\ndata: ${JSON.stringify({ type: "response.completed", response: completed })}\n\n`;
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({ object: "response.input_tokens", input_tokens: 100 })
      )
      .mockResolvedValueOnce(
        new Response(body, { headers: { "content-type": "text/event-stream" } })
      );
    const response = await request(budgetedOpenAIFetch(context, policy), {
      ...payload,
      stream: true,
    });
    expect(await response.text()).toBe(body);
    expect(ledger.settle).toHaveBeenCalledOnce();
  });

  it("returns a completed encrypted cache without another provider request", async () => {
    ledger.read.mockResolvedValue(
      attempt({ status: "completed", encryptedResult: cached() })
    );
    const transport = vi.spyOn(globalThis, "fetch");
    const response = await request(budgetedOpenAIFetch(context, policy));
    expect(await response.json()).toEqual(completed);
    expect(transport).not.toHaveBeenCalled();
    expect(ledger.reserve).not.toHaveBeenCalled();
  });

  it("blocks an unknown outcome before preflight or a paid retry", async () => {
    ledger.read.mockResolvedValue(attempt({ status: "unknown" }));
    const transport = vi.spyOn(globalThis, "fetch");
    await expect(request(budgetedOpenAIFetch(context, policy))).rejects.toThrow(
      "previous model request is unresolved"
    );
    expect(transport).not.toHaveBeenCalled();
  });

  it("rechecks a scheduled lease after decrypting a cached response", async () => {
    ledger.read.mockResolvedValue(
      attempt({ status: "completed", encryptedResult: cached() })
    );
    ledger.decrypt.mockImplementationOnce(async (_scope, _purpose, value) => {
      ledger.lease.mockResolvedValue(false);
      return value.slice(7);
    });
    const transport = vi.spyOn(globalThis, "fetch");
    await expect(
      request(budgetedOpenAIFetch(scheduledContext(), policy))
    ).rejects.toThrow("no longer authorized");
    expect(transport).not.toHaveBeenCalled();
    expect(ledger.hold).not.toHaveBeenCalled();
  });

  it("rechecks after the durable dispatch marker before making the paid request", async () => {
    const transport = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(counted());
    ledger.start.mockImplementationOnce(async () => {
      ledger.lease.mockResolvedValue(false);
    });
    await expect(
      request(budgetedOpenAIFetch(scheduledContext(), policy))
    ).rejects.toThrow("reserved cost remains held");
    expect(transport).toHaveBeenCalledOnce();
    expect(ledger.hold).toHaveBeenCalledOnce();
    expect(ledger.settle).not.toHaveBeenCalled();
  });

  it("suppresses a revoked result after settlement without relabeling its known cost", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(counted())
      .mockResolvedValueOnce(Response.json(completed));
    ledger.settle.mockImplementationOnce(async () => {
      ledger.lease.mockResolvedValue(false);
    });
    await expect(
      request(budgetedOpenAIFetch(scheduledContext(), policy))
    ).rejects.toThrow("no longer authorized");
    expect(ledger.settle).toHaveBeenCalledOnce();
    expect(ledger.hold).not.toHaveBeenCalled();
  });

  it("blocks a removed phone enrollment before any provider request", async () => {
    const transport = vi.spyOn(globalThis, "fetch");
    ledger.enrolled.mockRejectedValue(new Error("Enrollment revoked."));
    await expect(request(budgetedOpenAIFetch(context, policy))).rejects.toThrow(
      "Enrollment revoked"
    );
    expect(transport).not.toHaveBeenCalled();
    expect(ledger.reserve).not.toHaveBeenCalled();
  });

  it("rechecks enrollment after token counting and before paid generation", async () => {
    const transport = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(async () => {
        ledger.enrolled.mockRejectedValue(new Error("Enrollment revoked."));
        return counted();
      });
    await expect(request(budgetedOpenAIFetch(context, policy))).rejects.toThrow(
      "reserved cost remains held"
    );
    expect(transport).toHaveBeenCalledOnce();
    expect(ledger.start).not.toHaveBeenCalled();
    expect(ledger.hold).toHaveBeenCalledOnce();
  });

  it("suppresses a cached result when enrollment is revoked during decryption", async () => {
    const transport = vi.spyOn(globalThis, "fetch");
    ledger.read.mockResolvedValue(
      attempt({ status: "completed", encryptedResult: cached() })
    );
    ledger.decrypt.mockImplementationOnce(async (_scope, _purpose, value) => {
      ledger.enrolled.mockRejectedValue(new Error("Enrollment revoked."));
      return value.slice(7);
    });
    await expect(request(budgetedOpenAIFetch(context, policy))).rejects.toThrow(
      "Enrollment revoked"
    );
    expect(transport).not.toHaveBeenCalled();
    expect(ledger.hold).not.toHaveBeenCalled();
  });

  it("preserves settled costs but suppresses output after enrollment revocation", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(counted())
      .mockResolvedValueOnce(Response.json(completed));
    ledger.settle.mockImplementationOnce(async () => {
      ledger.enrolled.mockRejectedValue(new Error("Enrollment revoked."));
    });
    await expect(request(budgetedOpenAIFetch(context, policy))).rejects.toThrow(
      "Enrollment revoked"
    );
    expect(ledger.settle).toHaveBeenCalledOnce();
    expect(ledger.hold).not.toHaveBeenCalled();
  });

  it.each([
    { input_tokens: 99, output_tokens: 10, total_tokens: 109 },
    { input_tokens: 100, output_tokens: 10, total_tokens: 999 },
  ])("retains the reservation for inconsistent usage %j", async (usage) => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(counted())
      .mockResolvedValueOnce(Response.json({ ...completed, usage }));
    await expect(request(budgetedOpenAIFetch(context, policy))).rejects.toThrow(
      "reserved cost remains held"
    );
    expect(ledger.hold).toHaveBeenCalledOnce();
    expect(ledger.settle).not.toHaveBeenCalled();
  });

  it("rejects a repeated stream completion rather than exposing unaccounted output", async () => {
    const event = `data: ${JSON.stringify({ type: "response.completed", response: completed })}\n\n`;
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(counted())
      .mockResolvedValueOnce(
        new Response(event + event, {
          headers: { "content-type": "text/event-stream" },
        })
      );
    await expect(
      request(budgetedOpenAIFetch(context, policy), {
        ...payload,
        stream: true,
      })
    ).rejects.toThrow("reserved cost remains held");
    expect(ledger.hold).toHaveBeenCalledOnce();
    expect(ledger.settle).not.toHaveBeenCalled();
  });
});

function sentRequest(
  calls: readonly Parameters<typeof fetch>[],
  index: number
) {
  const call = calls.at(index);
  if (!call) throw new Error("No fixture provider request was recorded.");
  return new Request(call[0], call[1]);
}

function counted() {
  return Response.json({ object: "response.input_tokens", input_tokens: 100 });
}

function scheduledContext() {
  return {
    ...context,
    scheduledRunId: "scheduled-run",
    scheduledLeaseToken: "scheduled-lease",
  };
}

function cached() {
  return `sealed:${JSON.stringify({ body: JSON.stringify(completed), contentType: "application/json" })}`;
}

function attempt(overrides: Partial<ModelAttempt> = {}): ModelAttempt {
  return {
    id: "attempt",
    workspaceId: context.workspaceId,
    rootSessionId: context.rootSessionId,
    requestHash: "request-hash",
    model: "gpt-6-luna",
    globalAccountId: "global:2026-11",
    userAccountId: "workspace:test:2026-11",
    reservedMicroUsd: 1_025,
    actualMicroUsd: null,
    inputTokens: null,
    outputTokens: null,
    status: "reserved",
    encryptedResult: null,
    createdAt: new Date("2026-11-02T00:00:00Z"),
    settledAt: null,
    ...overrides,
  };
}
