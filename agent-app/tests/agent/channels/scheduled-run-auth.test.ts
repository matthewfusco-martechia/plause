import type {
  ChannelResolveSession,
  ChannelSource,
  RouteHandlerArgs,
} from "eve/channels";
import type { Delivery } from "eve/sessions";
import { beforeEach, describe, expect, it, vi } from "vitest";
import scheduledRunChannel from "@agent/channels/scheduled-run";
import type * as EnvModule from "@shared/environment";
import { signScheduledRequest } from "@agent/lib/schedules/internal-auth";
import type { claimInternalRequest } from "@db/services/internal-requests";
import type { dispatchScheduledReport } from "@agent/lib/schedules/report";

const callbacks = vi.hoisted(() => ({
  seen: new Set<string>(),
  claim: vi.fn<typeof claimInternalRequest>(),
  report: vi.fn<typeof dispatchScheduledReport>(),
}));
vi.mock("@db/services/internal-requests", () => ({
  claimInternalRequest: callbacks.claim,
}));
vi.mock("@agent/lib/schedules/report", () => ({
  dispatchScheduledReport: callbacks.report,
}));

vi.mock("@shared/environment", async (importOriginal) => {
  const original = await importOriginal<typeof EnvModule>();
  return {
    ...original,
    env: {
      ...original.env,
      INTERNAL_SERVICE_SECRET: "fixture-internal-secret-0123456789abcdef",
    },
  };
});

const scheduledRunPaths = [
  "/internal/scheduled-run/report",
  "/internal/scheduled-run/respond",
] as const;

describe("scheduled run channel authentication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callbacks.seen.clear();
    callbacks.report.mockResolvedValue(undefined);
    callbacks.claim.mockImplementation(async ({ requestId }) => {
      if (callbacks.seen.has(requestId)) return false;
      callbacks.seen.add(requestId);
      return true;
    });
  });
  for (const path of scheduledRunPaths) {
    it(`rejects an unauthenticated request to ${path}`, async () => {
      const route = scheduledRunChannel.routes.find(
        (candidate) =>
          candidate.transport !== "websocket" &&
          candidate.method === "POST" &&
          candidate.path === path
      );
      if (!route || route.transport === "websocket") {
        throw new Error(`The scheduled run route ${path} is unavailable.`);
      }

      const response = await route.handler(
        new Request(`https://assistant.example${path}`, {
          body: "not valid JSON",
          method: "POST",
        }),
        unexpectedRouteContext()
      );

      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("no-store");
    });
  }

  it("dispatches a signed report once and rejects an exact callback replay", async () => {
    const route = scheduledRunChannel.routes.find(
      (candidate) =>
        candidate.transport !== "websocket" &&
        candidate.path === "/internal/scheduled-run/report"
    );
    if (!route || route.transport === "websocket")
      throw new Error("Report route missing");
    const body = JSON.stringify({
      runId: "00000000-0000-4000-8000-000000000001",
    });
    const headers = signScheduledRequest(
      "/internal/scheduled-run/report",
      body
    );
    const waitUntil = vi.fn<RouteHandlerArgs["waitUntil"]>();
    const context = { ...unexpectedRouteContext(), waitUntil };
    const request = new Request(
      "https://self-hosted.example/internal/scheduled-run/report",
      { method: "POST", body, headers }
    );
    const replay = request.clone();
    expect((await route.handler(request, context)).status).toBe(202);
    expect((await route.handler(replay, context)).status).toBe(409);
    expect(callbacks.report).toHaveBeenCalledExactlyOnceWith(
      { attachSession: unexpectedRouteRequest, to: unexpectedRouteRequest },
      "00000000-0000-4000-8000-000000000001"
    );
    expect(waitUntil).toHaveBeenCalledOnce();
  });

  it("does not accept a signed response that supplies its own principal", async () => {
    const route = scheduledRunChannel.routes.find(
      (candidate) =>
        candidate.transport !== "websocket" &&
        candidate.path === "/internal/scheduled-run/respond"
    );
    if (!route || route.transport === "websocket")
      throw new Error("Response route missing");
    const body = JSON.stringify({
      runId: "00000000-0000-4000-8000-000000000001",
      leaseToken: "00000000-0000-4000-8000-000000000002",
      answer: "Fixture answer",
      userId: "untrusted-user",
    });
    const request = new Request(
      "https://self-hosted.example/internal/scheduled-run/respond",
      {
        method: "POST",
        body,
        headers: signScheduledRequest("/internal/scheduled-run/respond", body),
      }
    );
    expect(
      (await route.handler(request, unexpectedRouteContext())).status
    ).toBe(400);
  });
});

describe("scheduled run channel handoff", () => {
  it("starts a scheduled worker from the channel's native receive hook", async () => {
    const send = vi
      .fn<ChannelSource["send"]>()
      .mockResolvedValue(workerDelivery());
    const end = vi.fn<ChannelSource["end"]>();
    const source: ChannelSource = {
      cancel: vi.fn<ChannelSource["cancel"]>(),
      clear: vi.fn<ChannelSource["clear"]>(),
      compact: vi.fn<ChannelSource["compact"]>(),
      create: vi.fn<ChannelSource["create"]>(),
      end,
      respond: vi.fn<ChannelSource["respond"]>(),
      send,
    };
    const from = vi.fn<(address: string) => ChannelSource>(() => source);
    const receive = scheduledRunChannel.receive;
    if (!receive) throw new Error("The scheduled-run channel cannot receive.");
    const auth = {
      attributes: { scheduledRunId: "00000000-0000-4000-8000-000000000001" },
      authenticator: "scheduled-worker",
      principalId: "user-1",
      principalType: "user" as const,
    };

    const result = await receive(
      {
        auth,
        message: "Run the scheduled task.",
        target: {
          restart: true,
          runId: "00000000-0000-4000-8000-000000000001",
        },
      },
      {
        from,
        resolveSession: vi
          .fn<ChannelResolveSession>()
          .mockResolvedValue(undefined),
      }
    );

    expect(from).toHaveBeenCalledExactlyOnceWith(
      "scheduled-run:00000000-0000-4000-8000-000000000001"
    );
    expect(end).toHaveBeenCalledExactlyOnceWith({
      reason: "Scheduled worker exceeded its runtime.",
    });
    expect(send).toHaveBeenCalledWith(
      "Run the scheduled task.",
      expect.objectContaining({
        auth,
        title: "Scheduled run 00000000-0000-4000-8000-000000000001",
      })
    );
    expect(result.sessionId).toBe("worker-session");
  });
});

function unexpectedRouteContext() {
  return {
    attachSession: unexpectedRouteRequest,
    describe: unexpectedRouteRequest,
    from: unexpectedRouteRequest,
    invokeTool: unexpectedRouteRequest,
    listSkillFiles: unexpectedRouteRequest,
    params: {},
    readSkill: unexpectedRouteRequest,
    requestIp: null,
    resolveSession: unexpectedRouteRequest,
    to: unexpectedRouteRequest,
    waitUntil: unexpectedRouteRequest,
  } satisfies RouteHandlerArgs;
}

function unexpectedRouteRequest(): never {
  throw new Error("The request should stop at authentication.");
}

function workerDelivery(): Delivery {
  return {
    deliveryId: "worker-delivery",
    result: vi.fn<Delivery["result"]>(),
    sessionId: "worker-session",
    stream: vi.fn<Delivery["stream"]>(),
  };
}
