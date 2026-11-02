import { createHash } from "node:crypto";
import type { ToolContext } from "eve/tools";
import type { ApprovalResponseContext } from "eve/tools/approval";
import type * as Budget from "@db/services/model-budget";
import type { AccessScope } from "@shared/identity/access-scope";
import { accessScopeForUser } from "@shared/identity/access-scope";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { toolContextFor } from "@tests/helpers/tool-context";
import tool from "@agent/tools/web_search";
import { searchApproval, searchInputSchema, searchPublicWeb } from "./search";
import { createDirectOpenAIModel } from "@agent/lib/models/client";

type Attempt = NonNullable<Awaited<ReturnType<typeof Budget.readModelAttempt>>>;
interface SearchFixtureConfiguration {
  key: string | undefined;
}
const boundaries = vi.hoisted(() => {
  const configuration: SearchFixtureConfiguration = {
    key: "fixture-search-key",
  };
  return {
    enabled: "true",
    ...configuration,
    enrolled: true,
    lease: true,
    read: vi.fn<typeof Budget.readModelAttempt>(),
    reserve: vi.fn<typeof Budget.reserveModelAttempt>(),
    start: vi.fn<typeof Budget.startModelAttempt>(),
    settle: vi.fn<typeof Budget.settleModelAttempt>(),
    hold: vi.fn<typeof Budget.holdUnknownModelAttempt>(),
    decrypt:
      vi.fn<
        (scope: AccessScope, purpose: string, body: string) => Promise<string>
      >(),
  };
});
vi.mock("@shared/environment", () => ({
  env: {
    get WEB_RESEARCH_ENABLED() {
      return boundaries.enabled;
    },
    get TAVILY_API_KEY() {
      return boundaries.key;
    },
  },
}));
vi.mock("@db/services/model-budget", () => ({
  readModelAttempt: boundaries.read,
  reserveModelAttempt: boundaries.reserve,
  startModelAttempt: boundaries.start,
  settleModelAttempt: boundaries.settle,
  holdUnknownModelAttempt: boundaries.hold,
}));
vi.mock("@db/services/auth/phone-user", () => ({
  assertEnrolledWorkspaceUser: async () => {
    if (!boundaries.enrolled)
      throw new Error("Private account access removed.");
  },
}));
vi.mock("@db/services/scheduled-agent-run-leases", () => ({
  isScheduledAgentRunLeaseActive: async () => boundaries.lease,
}));
vi.mock("@db/services/protected-values", () => ({
  encryptWorkspaceValue: async (
    _scope: AccessScope,
    _purpose: string,
    body: string
  ) => `encrypted:${body}`,
  decryptWorkspaceValue: boundaries.decrypt,
}));

const query = { query: "fictional public query", max_results: 5 };
const principal = {
  principalId: "better-auth:alice",
  principalType: "user",
  authenticator: "linq-message",
  issuer: "plause",
  attributes: {
    workspaceId: accessScopeForUser("better-auth:alice").workspaceId,
  },
};
const result = {
  sources: [
    {
      title: "Fictional source",
      url: "https://example.com/article",
      content: "A public excerpt.",
      truncated: false,
    },
  ],
  credits: 1,
  estimatedMicroUsd: 8_000,
};

function context(approved = true): ToolContext {
  const ctx = toolContextFor({
    toolName: "web_search",
    sessionId: "research-session",
    callId: "research-call",
    auth: { current: principal, initiator: principal },
  });
  return approved
    ? {
        ...ctx,
        approval: {
          responder: {
            ...principal,
            getToken: (...args) => ctx.getToken(...args),
          },
        },
      }
    : ctx;
}

function scheduledContext(): ToolContext {
  const ctx = context();
  return {
    ...ctx,
    session: {
      ...ctx.session,
      auth: {
        ...ctx.session.auth,
        initiator: {
          ...principal,
          authenticator: "scheduled-worker",
          attributes: {
            ...principal.attributes,
            scheduledRunId: "f1911791-65a9-4e8f-8d22-a6585272f1ee",
            scheduledRunLeaseToken: "1caf16f9-0f9f-4fa2-a9d2-7cb72b1dfd28",
          },
        },
      },
    },
  };
}

function attempt(overrides: Partial<Attempt> = {}): Attempt {
  return {
    id: "attempt",
    workspaceId: principal.attributes.workspaceId,
    rootSessionId: "research-session",
    requestHash: createHash("sha256")
      .update(JSON.stringify(query))
      .digest("hex"),
    model: "tavily/basic-search",
    globalAccountId: "global:2026-11",
    userAccountId: "workspace:fixture:2026-11",
    reservedMicroUsd: 8_000,
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

function providerResponse() {
  return Response.json({
    results: result.sources,
    usage: { credits: 1 },
    query: query.query,
    answer: "Must not be cached",
    raw_content: "Must not be cached",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  boundaries.enabled = "true";
  boundaries.key = "fixture-search-key";
  boundaries.enrolled = true;
  boundaries.lease = true;
  boundaries.read.mockResolvedValue(undefined);
  boundaries.reserve.mockResolvedValue({ admitted: true, attempt: attempt() });
  boundaries.start.mockResolvedValue(undefined);
  boundaries.settle.mockResolvedValue(undefined);
  boundaries.hold.mockResolvedValue(undefined);
  boundaries.decrypt.mockImplementation(async (_scope, _purpose, body) =>
    body.slice("encrypted:".length)
  );
  vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    providerResponse()
  );
});
afterEach(() => vi.restoreAllMocks());

describe("bounded direct public search", () => {
  it("sends the authored search schema through direct OpenAI as a function, without a hosted web-search tool", async () => {
    const transport = vi.fn<typeof fetch>(async () =>
      Response.json({
        id: "resp_offline",
        object: "response",
        created_at: 1_700_000_000,
        status: "completed",
        model: "gpt-6-luna",
        output: [],
        usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
      })
    );
    const model = createDirectOpenAIModel(
      {
        model: "gpt-6-luna",
        maxInputTokens: 20_000,
        maxOutputTokens: 2_000,
        timeoutMs: 20_000,
        inputRateMicroUsdPerMillion: 250_000,
        outputRateMicroUsdPerMillion: 500_000,
        maxRetries: 0,
      },
      transport,
      "fictional-openai-key"
    );
    const functionSchema = z
      .object({
        type: z.literal("object"),
        properties: z.record(
          z.string(),
          z.object({
            type: z.enum(["string", "integer"]),
            minLength: z.number().optional(),
            maxLength: z.number().optional(),
            minimum: z.number().optional(),
            maximum: z.number().optional(),
            default: z.number().optional(),
          })
        ),
        required: z.array(z.string()).optional(),
        additionalProperties: z.literal(false),
      })
      .parse(z.toJSONSchema(searchInputSchema, { target: "draft-7" }));
    await model.doGenerate({
      prompt: [],
      tools: [
        {
          type: "function",
          name: "web_search",
          description: tool.description,
          inputSchema: functionSchema,
        },
      ],
    });
    expect(transport).toHaveBeenCalledOnce();
    const call = transport.mock.calls[0];
    if (!call) throw new Error("Expected offline OpenAI request.");
    const body = z
      .object({
        tools: z.array(
          z.object({
            type: z.literal("function"),
            name: z.literal("web_search"),
            parameters: z.object({
              properties: z.object({
                query: z.object({
                  type: z.literal("string"),
                  maxLength: z.literal(1_000),
                }),
              }),
            }),
          })
        ),
      })
      .parse(await new Request(call[0], call[1]).json());
    expect(body.tools).toHaveLength(1);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("authors a normal executable function tool instead of a native hosted-provider definition", async () => {
    expect(tool.execute).toBe(searchPublicWeb);
    expect(tool.inputSchema).toBe(searchInputSchema);
    expect(tool).not.toHaveProperty("provider");
    expect(tool).not.toHaveProperty("type", "web_search");
    expect(tool.approval).toBe(searchApproval);
    expect(searchInputSchema.safeParse({ query: "" }).success).toBe(false);
    expect(
      searchInputSchema.safeParse({ query: "x".repeat(1_001) }).success
    ).toBe(false);
    expect(
      searchInputSchema.safeParse({ query: "q", max_results: 6 }).success
    ).toBe(false);
    expect(
      await searchApproval.request({ ...context(false), toolInput: query })
    ).toBe("user-approval");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("shows the entire exact query and cost estimate and admits only the requesting owner response", async () => {
    const input = { ...query, query: 'A public query\nwith "quoted" terms' };
    const prompt =
      searchApproval.prompt?.({
        input,
        toolName: "web_search",
        callId: "call",
      }) ?? "";
    expect(prompt).toContain(JSON.stringify(input.query));
    expect(prompt).toContain("$0.008 (not an invoice)");
    const ctx = context();
    const response: ApprovalResponseContext<typeof query> = {
      auth: {
        getToken: (...args) => ctx.getToken(...args),
        requireAuth: (...args) => ctx.requireAuth(...args),
      },
      session: { ...ctx.session, initiator: principal },
      request: {
        callId: ctx.callId,
        interactionId: "interaction",
        principal,
        toolInput: query,
        toolName: "web_search",
      },
      response: { decision: "approve", principal },
    };
    expect(await searchApproval.response?.(response)).toEqual({
      status: "allowed",
    });
    expect(
      await searchApproval.response?.({
        ...response,
        response: {
          decision: "approve",
          principal: { ...principal, principalId: "better-auth:bob" },
        },
      })
    ).toMatchObject({ status: "rejected" });
  });

  it.each(["disabled", "missing key"])(
    "blocks %s before reservation or transport",
    async (mode) => {
      if (mode === "disabled") boundaries.enabled = "false";
      else boundaries.key = undefined;
      await expect(searchPublicWeb(query, context())).rejects.toThrow(
        "disabled or not configured"
      );
      expect(boundaries.reserve).not.toHaveBeenCalled();
      expect(globalThis.fetch).not.toHaveBeenCalled();
    }
  );

  it("requires an owner-approved call even on direct execution", async () => {
    await expect(searchPublicWeb(query, context(false))).rejects.toThrow(
      "approve this exact public query"
    );
    expect(boundaries.reserve).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("reserves before one fixed-host POST, minimizes output and debits conservative credit cost with zero model tokens", async () => {
    vi.mocked(globalThis.fetch).mockImplementationOnce(async () => {
      expect(boundaries.start).toHaveBeenCalledOnce();
      return providerResponse();
    });
    expect(await searchPublicWeb(query, context())).toEqual(result);
    expect(boundaries.reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "tavily/basic-search",
        reservedMicroUsd: 8_000,
      })
    );
    expect(JSON.stringify(boundaries.reserve.mock.calls)).not.toContain(
      query.query
    );
    expect(globalThis.fetch).toHaveBeenCalledOnce();
    const request = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(request?.[0]).toBe("https://api.tavily.com/search");
    expect(request?.[1]).toMatchObject({
      method: "POST",
      redirect: "error",
      headers: { authorization: "Bearer fixture-search-key" },
    });
    const body = z.string().parse(request?.[1]?.body);
    expect(JSON.parse(body)).toEqual({
      ...query,
      search_depth: "basic",
      auto_parameters: false,
      include_answer: false,
      include_raw_content: false,
      include_images: false,
      include_usage: true,
      topic: "general",
    });
    expect(body).not.toContain("fixture-search-key");
    expect(boundaries.settle).toHaveBeenCalledOnce();
    const settled = boundaries.settle.mock.calls[0]?.[2];
    expect(settled).toMatchObject({
      actualMicroUsd: 8_000,
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(settled?.encryptedResult).toMatch(/^encrypted:/u);
    expect(
      JSON.parse(settled?.encryptedResult.slice("encrypted:".length) ?? "null")
    ).toEqual(result);
    expect(boundaries.hold).not.toHaveBeenCalled();
  });

  it("bounds visible sources and explicitly marks excerpt truncation", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      Response.json({
        results: [
          {
            title: "t".repeat(500),
            url: "https://example.com",
            content: "x".repeat(4_000),
          },
        ],
        usage: { credits: 1 },
      })
    );
    const output = await searchPublicWeb(query, context());
    expect(output.sources[0]?.content).toHaveLength(2_000);
    expect(output.sources[0]?.title).toHaveLength(300);
    expect(output.sources[0]?.truncated).toBe(true);
  });

  it("does not dispatch when the shared monthly quota rejects admission", async () => {
    boundaries.reserve.mockRejectedValueOnce(
      new Error("The model spending limit has been reached.")
    );
    await expect(searchPublicWeb(query, context())).rejects.toThrow(
      "spending limit"
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(boundaries.start).not.toHaveBeenCalled();
    expect(boundaries.hold).not.toHaveBeenCalled();
  });

  it.each([302, 401, 429, 500])(
    "holds status %s without following redirects or retrying",
    async (status) => {
      vi.mocked(globalThis.fetch).mockResolvedValueOnce(
        new Response(null, {
          status,
          headers: { location: "https://attacker.invalid/secret" },
        })
      );
      await expect(searchPublicWeb(query, context())).rejects.toThrow(
        "cost remains held"
      );
      expect(globalThis.fetch).toHaveBeenCalledOnce();
      expect(boundaries.hold).toHaveBeenCalledOnce();
      expect(boundaries.settle).not.toHaveBeenCalled();
    }
  );

  it("holds a provider timeout once and never prints the underlying provider exception", async () => {
    const timeout = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(timeout.signal);
    vi.mocked(globalThis.fetch).mockImplementationOnce(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              reject(new Error("private provider token and body"));
            },
            { once: true }
          );
        })
    );
    const pending = searchPublicWeb(query, context());
    const failed = pending.then(
      () => false,
      () => true
    );
    await vi.waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledOnce();
    });
    timeout.abort(new DOMException("Timeout", "TimeoutError"));
    expect(await failed).toBe(true);
    await expect(pending).rejects.toThrow("cost remains held");
    expect(boundaries.hold).toHaveBeenCalledOnce();
    expect(boundaries.settle).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "unexpected credit charge",
      body: { results: [], usage: { credits: 2 } },
    },
    {
      name: "too many results",
      body: {
        results: Array.from({ length: 6 }, () => result.sources[0]),
        usage: { credits: 1 },
      },
    },
    {
      name: "non-web URL",
      body: {
        results: [{ ...result.sources[0], url: "javascript:alert(1)" }],
        usage: { credits: 1 },
      },
    },
    {
      name: "credential-bearing URL",
      body: {
        results: [
          { ...result.sources[0], url: "https://user:password@example.com" },
        ],
        usage: { credits: 1 },
      },
    },
  ])("holds $name without caching an untrusted response", async ({ body }) => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(Response.json(body));
    await expect(searchPublicWeb(query, context())).rejects.toThrow(
      "cost remains held"
    );
    expect(boundaries.hold).toHaveBeenCalledOnce();
    expect(boundaries.settle).not.toHaveBeenCalled();
  });

  it("bounds a streaming body even when no size header is supplied", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response("x".repeat(131_073))
    );
    await expect(searchPublicWeb(query, context())).rejects.toThrow(
      "cost remains held"
    );
    expect(boundaries.settle).not.toHaveBeenCalled();
  });

  it("replays only a completed encrypted result with the same query and call identity", async () => {
    boundaries.read.mockResolvedValueOnce(
      attempt({
        status: "completed",
        encryptedResult: `encrypted:${JSON.stringify(result)}`,
      })
    );
    expect(await searchPublicWeb(query, context())).toEqual(result);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(boundaries.reserve).not.toHaveBeenCalled();
    boundaries.read.mockResolvedValueOnce(
      attempt({
        status: "completed",
        encryptedResult: `encrypted:${JSON.stringify(result)}`,
      })
    );
    await expect(
      searchPublicWeb({ ...query, query: "changed public query" }, context())
    ).rejects.toThrow("original approved query");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("blocks reserved, started and unknown attempts before any provider retry", async () => {
    for (const status of ["reserved", "started", "unknown"] as const) {
      boundaries.read.mockResolvedValueOnce(attempt({ status }));
      // oxlint-disable-next-line eslint/no-await-in-loop -- Verify every durable unresolved state with the same exact call.
      await expect(searchPublicWeb(query, context())).rejects.toThrow(
        "outcome is unresolved"
      );
    }
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(boundaries.reserve).not.toHaveBeenCalled();
  });

  it("rejects enrollment removal before transport and suppresses a result revoked during provider work", async () => {
    boundaries.enrolled = false;
    await expect(searchPublicWeb(query, context())).rejects.toThrow(
      "access removed"
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
    boundaries.enrolled = true;
    vi.mocked(globalThis.fetch).mockImplementationOnce(async () => {
      boundaries.enrolled = false;
      return providerResponse();
    });
    await expect(searchPublicWeb(query, context())).rejects.toThrow(
      "access removed"
    );
    expect(boundaries.settle).toHaveBeenCalledOnce();
    expect(boundaries.hold).not.toHaveBeenCalled();
  });

  it("checks scheduled leases before dispatch and after cache decryption, and rejects scheduled reports", async () => {
    boundaries.lease = false;
    await expect(searchPublicWeb(query, scheduledContext())).rejects.toThrow(
      "run is no longer authorized"
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
    boundaries.lease = true;
    boundaries.read.mockResolvedValueOnce(
      attempt({
        status: "completed",
        encryptedResult: `encrypted:${JSON.stringify(result)}`,
      })
    );
    boundaries.decrypt.mockImplementationOnce(
      async (_scope, _purpose, body) => {
        boundaries.lease = false;
        return body.slice("encrypted:".length);
      }
    );
    await expect(searchPublicWeb(query, scheduledContext())).rejects.toThrow(
      "run is no longer authorized"
    );
    const ctx = context();
    await expect(
      searchPublicWeb(query, {
        ...ctx,
        session: {
          ...ctx.session,
          auth: {
            ...ctx.session.auth,
            initiator: { ...principal, authenticator: "scheduled-result" },
          },
        },
      })
    ).rejects.toThrow("Scheduled reports cannot");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
