import { beforeEach, expect, it, vi } from "vitest";
import type { ScheduleToFn } from "eve/schedules";
import type { authenticateScheduledRequest } from "@agent/lib/schedules/internal-auth";
import type { dispatchDueWork } from "@agent/lib/schedules/dispatch";
import type { readNextScheduledWake } from "@db/services/scheduled-agent-jobs";
const services = vi.hoisted(() => ({
  enabled: "true",
  authenticate: vi.fn<typeof authenticateScheduledRequest>(),
  dispatch: vi.fn<typeof dispatchDueWork>(),
  next: vi.fn<typeof readNextScheduledWake>(),
}));
vi.mock("@shared/environment", () => ({
  env: {
    get SCHEDULED_TASKS_ENABLED() {
      return services.enabled;
    },
  },
}));
vi.mock("@agent/lib/schedules/internal-auth", () => ({
  authenticateScheduledRequest: services.authenticate,
}));
vi.mock("@agent/lib/schedules/dispatch", () => ({
  dispatchDueWork: services.dispatch,
}));
vi.mock("@db/services/scheduled-agent-jobs", () => ({
  readNextScheduledWake: services.next,
}));
import scheduler from "@agent/channels/scheduler";
beforeEach(() => {
  vi.clearAllMocks();
  services.enabled = "true";
  services.authenticate.mockResolvedValue({ body: "{}" });
  services.dispatch.mockResolvedValue(undefined);
  services.next.mockResolvedValue(null);
});
async function tick() {
  const route = scheduler.routes.find(
    (r) => r.transport !== "websocket" && r.path === "/internal/schedules/tick"
  );
  if (!route || route.transport === "websocket")
    throw new Error("Missing scheduler route");
  const context = { to: vi.fn<ScheduleToFn>() };
  // SAFETY: This handler reads only to, and dispatch is mocked at its owning boundary.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Unused channel context members are outside this focused route test.
  const handlerContext = context as never;
  return route.handler(
    new Request("https://fixture.invalid/internal/schedules/tick", {
      method: "POST",
      body: "{}",
    }),
    handlerContext
  );
}
it("dispatches a verified tick and returns its next durable wake deadline", async () => {
  services.next.mockResolvedValue(new Date("2026-11-05T14:00:00Z"));
  const response = await tick();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    nextWakeAt: "2026-11-05T14:00:00.000Z",
  });
  expect(services.dispatch).toHaveBeenCalledTimes(1);
});
it("returns no next alarm when all due work has finished", async () => {
  expect(await (await tick()).json()).toEqual({ nextWakeAt: null });
});
it("does not dispatch a disabled, unauthenticated or malformed tick", async () => {
  services.enabled = "false";
  expect((await tick()).status).toBe(503);
  expect(services.authenticate).not.toHaveBeenCalled();
  services.enabled = "true";
  services.authenticate.mockResolvedValue(new Response(null, { status: 401 }));
  expect((await tick()).status).toBe(401);
  services.authenticate.mockResolvedValue({ body: '{"prompt":"untrusted"}' });
  expect((await tick()).status).toBe(400);
  expect(services.dispatch).not.toHaveBeenCalled();
});
