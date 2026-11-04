import type {
  DurableObjectState,
  Request as PlatformRequest,
} from "@cloudflare/workers-types";
import { describe, expect, it, vi } from "vitest";
import { PlauseRuntime } from "./worker";

// The Node test runner uses native Fetch while production uses Workers Fetch.
/* oxlint-disable anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- Platform-only request/container fields are not read in these transport tests. */
function fixture(
  running = false,
  revision?: string,
  overrides: Partial<ConstructorParameters<typeof PlauseRuntime>[1]> = {}
) {
  let initialization: Promise<unknown> = Promise.resolve();
  let alarmAt: number | null = null;
  const storage = {
    getAlarm: vi.fn<() => Promise<number | null>>(async () => alarmAt),
    setAlarm: vi.fn<(at: number | Date) => Promise<void>>(async (at) => {
      alarmAt = Number(at);
    }),
    get: vi.fn<(key: string) => Promise<number | undefined>>(),
    put: vi.fn<(key: string, value: number) => Promise<void>>(),
  };
  const fetch = vi
    .fn<(url: string, init: PlatformRequest) => Promise<Response>>()
    .mockResolvedValue(new Response(null, { status: 200 }));
  const container = {
    running,
    start: vi
      .fn<NonNullable<DurableObjectState["container"]>["start"]>()
      .mockImplementation((options) => {
        for (const [name, value] of Object.entries(options?.labels ?? {})) {
          if (Buffer.byteLength(name) > 16 || Buffer.byteLength(value) > 64)
            throw new Error("Platform label limit exceeded");
        }
      }),
    inspect: vi
      .fn<NonNullable<DurableObjectState["container"]>["inspect"]>()
      .mockResolvedValue({
        image: "fictional-image",
        labels: revision ? { "plause-env": revision } : {},
      }),
    destroy: vi
      .fn<NonNullable<DurableObjectState["container"]>["destroy"]>()
      .mockImplementation(async () => {
        container.running = false;
      }),
    getTcpPort: vi.fn<(port: number) => { fetch: typeof fetch }>(() => ({
      fetch,
    })),
    setInactivityTimeout: vi
      .fn<(duration: number) => Promise<void>>()
      .mockResolvedValue(undefined),
  };
  const runtime = new PlauseRuntime(
    {
      // SAFETY: Runtime uses a single numeric retry-count key; bulk storage overloads are not exercised.
      storage: storage as unknown as ConstructorParameters<
        typeof PlauseRuntime
      >[0]["storage"],
      // SAFETY: This fixture implements every Container member read by PlauseRuntime; ensureRunning is stubbed below.
      container: container as unknown as NonNullable<
        DurableObjectState["container"]
      >,
      blockConcurrencyWhile: (callback) => {
        const result = callback();
        initialization = result;
        return result;
      },
    },
    {
      PLAUSE_HOSTING_ENABLED: "true",
      PLAUSE_WORKFLOW_BACKEND: "postgres",
      LIVE_MODEL_ENABLED: "false",
      ...overrides,
      PLAUSE_RUNTIME: {
        getByName:
          vi.fn<
            ConstructorParameters<
              typeof PlauseRuntime
            >[1]["PLAUSE_RUNTIME"]["getByName"]
          >(),
      },
    }
  );
  const readiness = vi
    .spyOn(runtime, "ensureRunning")
    .mockResolvedValue(undefined);
  return {
    runtime,
    storage,
    container,
    fetch,
    readiness,
    initialized: () => initialization,
  };
}

describe("Cloudflare internal container transport", () => {
  it("forwards a signed POST once over HTTP without changing its body or headers", async () => {
    const { runtime, fetch } = fixture();
    const request = new Request(
      "https://agent.plause.si/webhooks/linq?version=2026-02-03",
      {
        method: "POST",
        headers: { "webhook-signature": "fictional-signature" },
        body: "café 👋",
      }
    );
    // SAFETY: Node Request provides the URL and RequestInit fields used by this forwarding path.
    expect(
      (await runtime.fetch(request as unknown as PlatformRequest)).status
    ).toBe(200);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      "http://agent.plause.si/webhooks/linq?version=2026-02-03",
      request
    );
    expect(await request.text()).toBe("café 👋");
    expect(request.headers.get("webhook-signature")).toBe(
      "fictional-signature"
    );
  });

  it("does not retry a forwarded POST after an uncertain transport failure", async () => {
    const { runtime, fetch } = fixture();
    fetch.mockRejectedValue(new Error("connection lost"));
    const request = new Request("https://agent.plause.si/api/action", {
      method: "POST",
      body: "{}",
    });
    // SAFETY: Node Request provides the URL and RequestInit fields used by this forwarding path.
    expect(
      (await runtime.fetch(request as unknown as PlatformRequest)).status
    ).toBe(503);
    expect(fetch).toHaveBeenCalledOnce();
  });
});

const token = "fictional-edge-token-0123456789abcdefghijk";
const settings = {
  SCHEDULED_TASKS_ENABLED: "true",
  PLAUSE_EDGE_INTERNAL_TOKEN: token,
  INTERNAL_SERVICE_SECRET: "fictional-service-secret-0123456789abcdefghijk",
};
const hint = (at: number, bearer = token) =>
  // SAFETY: Node Request implements the URL/body/header fields this gate reads.
  new Request("https://agent.plause.si/internal/schedules/wake", {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ at }),
  }) as unknown as PlatformRequest;

describe("on-demand scheduled task wakeups", () => {
  it("durably arms the earliest hint without starting a Container", async () => {
    const f = fixture(false, undefined, settings),
      at = Date.now() + 3_600_000;
    expect((await f.runtime.fetch(hint(at))).status).toBe(204);
    expect((await f.runtime.fetch(hint(at + 60_000))).status).toBe(204);
    expect(f.storage.setAlarm).toHaveBeenCalledTimes(1);
    expect(f.storage.setAlarm).toHaveBeenCalledWith(at);
    expect(f.readiness).not.toHaveBeenCalled();
    expect(f.container.start).not.toHaveBeenCalled();
  });
  it("rejects unauthenticated, disabled and oversized hints before waking", async () => {
    const f = fixture(false, undefined, settings);
    expect((await f.runtime.fetch(hint(Date.now(), "wrong"))).status).toBe(401);
    const request = new Request(
      "https://agent.plause.si/internal/schedules/wake",
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: " ".repeat(129),
      }
    );
    // SAFETY: Node Request supplies the body and header fields this gate reads.
    const oversized = request as unknown as PlatformRequest;
    expect((await f.runtime.fetch(oversized)).status).toBe(413);
    expect((await fixture(false).runtime.fetch(hint(Date.now()))).status).toBe(
      401
    );
    expect(f.storage.setAlarm).not.toHaveBeenCalled();
    expect(f.readiness).not.toHaveBeenCalled();
  });
  it("wakes once for a signed app tick and rearms only the returned deadline", async () => {
    const f = fixture(false, undefined, settings),
      next = Date.now() + 3_600_000;
    f.fetch.mockResolvedValue(
      Response.json({ nextWakeAt: new Date(next).toISOString() })
    );
    await f.runtime.alarm();
    expect(f.readiness).toHaveBeenCalledTimes(1);
    expect(f.fetch).toHaveBeenCalledTimes(1);
    const call = f.fetch.mock.calls[0];
    if (!call) throw new Error("Missing tick");
    const [url, request] = call;
    expect(url).toBe("http://container/internal/schedules/tick");
    expect(request.body).toBe("{}");
    // SAFETY: This fixture receives ordinary Node Fetch initialization headers.
    const headers = request.headers as unknown as HeadersInit;
    expect(new Headers(headers).get("x-plause-internal-signature")).toMatch(
      /^v1=[a-f0-9]{64}$/u
    );
    expect(f.storage.setAlarm).toHaveBeenCalledExactlyOnceWith(next);
  });
  it("does not postpone a concurrent new task while the old alarm awaits the app", async () => {
    const f = fixture(false, undefined, settings),
      early = Date.now() + 60_000,
      later = early + 3_600_000;
    f.fetch.mockImplementation(async () => {
      await f.runtime.fetch(hint(early));
      return Response.json({ nextWakeAt: new Date(later).toISOString() });
    });
    await f.runtime.alarm();
    expect(f.storage.setAlarm).toHaveBeenCalledExactlyOnceWith(early);
  });
  it("stops waking when no work remains and uses backoff on an unavailable app", async () => {
    const empty = fixture(false, undefined, settings);
    empty.fetch.mockResolvedValue(Response.json({ nextWakeAt: null }));
    await empty.runtime.alarm();
    expect(empty.storage.setAlarm).not.toHaveBeenCalled();
    const failed = fixture(false, undefined, settings),
      before = Date.now();
    failed.fetch.mockRejectedValue(new Error("fictional offline app"));
    await failed.runtime.alarm();
    expect(failed.fetch).toHaveBeenCalledTimes(1);
    expect(failed.storage.setAlarm.mock.calls[0]?.[0]).toBeGreaterThanOrEqual(
      before + 60_000
    );
    expect(failed.storage.setAlarm.mock.calls[0]?.[0]).toBeLessThanOrEqual(
      Date.now() + 60_000
    );
  });
  it("does not wake or schedule new work when the feature is disabled", async () => {
    const f = fixture(false);
    await f.runtime.alarm();
    expect(f.readiness).not.toHaveBeenCalled();
    expect(f.storage.setAlarm).not.toHaveBeenCalled();
  });

  it("shares one startup between a due alarm and an arriving web request", async () => {
    const f = fixture(false, undefined, settings),
      ready = Promise.withResolvers<undefined>();
    f.readiness.mockReturnValue(ready.promise);
    f.fetch.mockImplementation(async (url) =>
      url.endsWith("/internal/schedules/tick")
        ? Response.json({ nextWakeAt: null })
        : new Response(null, { status: 200 })
    );
    // SAFETY: Node Request supplies the fields used by the internal transport.
    const request = new Request(
      "https://agent.plause.si/sign-in"
    ) as unknown as PlatformRequest;
    const incoming = f.runtime.fetch(request),
      alarm = f.runtime.alarm();
    expect(f.readiness).toHaveBeenCalledTimes(1);
    ready.resolve(undefined);
    await Promise.all([incoming, alarm]);
    expect(f.readiness).toHaveBeenCalledTimes(1);
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });
});

describe("effective container configuration across Worker deploys", () => {
  async function startedRevision(
    overrides: Partial<ConstructorParameters<typeof PlauseRuntime>[1]> = {}
  ) {
    const f = fixture(false, undefined, overrides);
    f.readiness.mockRestore();
    await f.runtime.ensureRunning();
    const options = f.container.start.mock.calls[0]?.[0];
    const revision = options?.labels?.["plause-env"];
    if (!revision) throw new Error("Expected a startup revision label");
    return { revision, options };
  }

  it("starts with a fingerprint label and forwards only allowed environment values", async () => {
    const { revision, options } = await startedRevision({
      PLAUSE_HOST: "private.example",
      LIVE_MODEL_ENABLED: "false",
    });
    expect(revision).toMatch(/^[a-f0-9]{64}$/u);
    expect(options.env?.LIVE_MODEL_ENABLED).toBe("false");
    expect(options.env).not.toHaveProperty("PLAUSE_HOST");
  });

  it("keeps a surviving container when its effective environment is unchanged", async () => {
    const { revision } = await startedRevision();
    const f = fixture(true, revision);
    await f.initialized();
    expect(f.container.destroy).not.toHaveBeenCalled();
    expect(f.container.setInactivityTimeout).toHaveBeenCalledExactlyOnceWith(
      600_000
    );
  });

  it.each([
    ["false", "true"],
    ["true", "false"],
  ])(
    "replaces stale model settings from %s to %s before new startup",
    async (before, after) => {
      const { revision } = await startedRevision({
        LIVE_MODEL_ENABLED: before,
      });
      const f = fixture(true, revision, { LIVE_MODEL_ENABLED: after });
      await f.initialized();
      expect(f.container.destroy).toHaveBeenCalledOnce();
      f.readiness.mockRestore();
      await f.runtime.ensureRunning();
      expect(
        f.container.start.mock.calls[0]?.[0]?.env?.LIVE_MODEL_ENABLED
      ).toBe(after);
      expect(
        f.container.start.mock.calls[0]?.[0]?.labels?.["plause-env"]
      ).not.toBe(revision);
    }
  );

  it("replaces an old secret without writing its value into labels", async () => {
    const oldKey = "fictional-old-model-key";
    const newKey = "fictional-new-model-key";
    const { revision } = await startedRevision({ OPENAI_API_KEY: oldKey });
    const f = fixture(true, revision, { OPENAI_API_KEY: newKey });
    await f.initialized();
    expect(f.container.destroy).toHaveBeenCalledOnce();
    f.readiness.mockRestore();
    await f.runtime.ensureRunning();
    const options = f.container.start.mock.calls[0]?.[0];
    expect(options?.env?.OPENAI_API_KEY).toBe(newKey);
    expect(JSON.stringify(options?.labels)).not.toContain(newKey);
    expect(JSON.stringify(options?.labels)).not.toContain(oldKey);
  });

  it("replaces an unlabeled container from the older gateway once", async () => {
    const f = fixture(true);
    await f.initialized();
    expect(f.container.destroy).toHaveBeenCalledOnce();
  });

  it("keeps admission fenced if stopping a stale process fails", async () => {
    const f = fixture(true, "stale-revision");
    f.container.destroy.mockRejectedValue(new Error("stop failed"));
    await expect(f.initialized()).rejects.toThrow("stop failed");
    expect(f.container.start).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
  });
});
